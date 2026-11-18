// Yealink Remote Phone Book: per klant een XML-telefoonboek met de gedeelde contacten (Contactbook)
// en optioneel de collega's (interne nummers), zodat bureautoestellen ze onder "Directory" tonen.
//
// Elk telefoonboek staat in een configuratiebestand (standaard config/phonebooks.json) met:
//   - het API-token van een (service)gebruiker van die klant (alleen op de server, nooit naar het toestel)
//   - de client_uuid van die klant (de server controleert dat het token écht bij die klant hoort)
//   - een lange willekeurige sleutel die het toestel meestuurt (in de URL of als HTTP Basic-wachtwoord)

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mapContact, fetchColleagues } from './directory.js';
import { RateLimiter } from './sessions.js';

const CONTEXT_TTL_MS = 60 * 60_000;
const KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALLING_CODES = { nl: '31', be: '32', de: '49', lu: '352', fr: '33', gb: '44', uk: '44', es: '34', at: '43', ch: '41', za: '27' };

export function generateKey() {
  return randomBytes(32).toString('base64url');
}

const hashKey = (key) => createHash('sha256').update(String(key)).digest();

// ---------- configuratie ----------

export class PhonebookConfigError extends Error {}

export function parsePhonebookConfig(json, env = process.env) {
  const list = Array.isArray(json) ? json : json?.phonebooks;
  if (!Array.isArray(list)) throw new PhonebookConfigError('Verwacht { "phonebooks": [ ... ] }.');
  const seenKeys = new Set();
  const seenNames = new Set();

  return list.map((raw, i) => {
    const where = `phonebooks[${i}]${raw?.name ? ` (${raw.name})` : ''}`;
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (!name) throw new PhonebookConfigError(`${where}: "name" ontbreekt.`);
    if (seenNames.has(name)) throw new PhonebookConfigError(`${where}: naam komt dubbel voor.`);
    seenNames.add(name);

    if (!KEY_RE.test(raw.key || '')) {
      throw new PhonebookConfigError(`${where}: "key" moet 32-128 tekens zijn (A-Z, a-z, 0-9, _ of -). Maak er een met: npm run phonebook:key`);
    }
    if (seenKeys.has(raw.key)) throw new PhonebookConfigError(`${where}: "key" komt dubbel voor.`);
    seenKeys.add(raw.key);

    const apiToken = raw.apiTokenEnv ? env[raw.apiTokenEnv] : raw.apiToken;
    if (!apiToken || typeof apiToken !== 'string') {
      throw new PhonebookConfigError(`${where}: "apiToken" ontbreekt${raw.apiTokenEnv ? ` (omgevingsvariabele ${raw.apiTokenEnv} is leeg)` : ''}.`);
    }
    if (!UUID_RE.test(raw.clientUuid || '')) throw new PhonebookConfigError(`${where}: "clientUuid" is geen geldige UUID.`);

    const numberFormat = raw.numberFormat || 'e164';
    if (!['e164', 'national'].includes(numberFormat)) {
      throw new PhonebookConfigError(`${where}: "numberFormat" moet "e164" of "national" zijn.`);
    }
    const allowedIps = Array.isArray(raw.allowedIps) ? raw.allowedIps.map(String) : [];
    for (const ip of allowedIps) {
      if (!parseIpRule(ip)) throw new PhonebookConfigError(`${where}: ongeldig IP-adres of -bereik "${ip}".`);
    }

    return {
      name,
      keyHash: hashKey(raw.key),
      apiToken: apiToken.trim(),
      clientUuid: raw.clientUuid.toLowerCase(),
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : name,
      contactsGroup: raw.contactsGroup || 'Contacten',
      colleaguesGroup: raw.colleaguesGroup || "Collega's",
      colleagues: raw.colleagues !== false,
      showCompany: raw.showCompany !== false,
      numberFormat,
      allowedIps,
    };
  });
}

// ---------- IP-allowlist (IPv4 met CIDR, IPv6 exact) ----------

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

function parseIpRule(rule) {
  const [addr, bitsStr] = rule.trim().split('/');
  const v4 = ipv4ToInt(addr);
  if (v4 !== null) {
    const bits = bitsStr === undefined ? 32 : Number(bitsStr);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return { v4: true, net: (v4 & mask) >>> 0, mask };
  }
  if (addr.includes(':') && bitsStr === undefined) return { v4: false, addr: addr.toLowerCase() };
  return null;
}

export function ipAllowed(ip, rules) {
  if (!rules.length) return true;
  const clean = String(ip || '').replace(/^::ffff:/i, '');
  const v4 = ipv4ToInt(clean);
  return rules.some((r) => {
    const rule = parseIpRule(r);
    if (!rule) return false;
    if (rule.v4) return v4 !== null && ((v4 & rule.mask) >>> 0) === rule.net;
    return clean.toLowerCase() === rule.addr;
  });
}

// ---------- XML ----------

function xmlAttr(value) {
  return String(value ?? '')
    // tekens die in XML 1.0 niet zijn toegestaan
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Attributen staan tussen dubbele quotes; een apostrof hoeft dus niet ge-escaped te worden
    // (sommige toestelfirmware kent &apos; niet).
    .replace(/"/g, '&quot;')
    .slice(0, 300);
}

export function formatNumber(number, format, countryCode) {
  const n = String(number || '').trim();
  if (format !== 'national' || !n.startsWith('+')) return n;
  const cc = CALLING_CODES[String(countryCode || '').toLowerCase()];
  if (cc && n.startsWith(`+${cc}`)) return `0${n.slice(cc.length + 1)}`;
  return `00${n.slice(1)}`;
}

/**
 * Yealink-formaat (Remote Phone Book):
 * <YealinkIPPhoneBook><Title/><Menu Name="…"><Unit Name="…" Phone1="…" Phone2="…" Phone3="…"/></Menu></YealinkIPPhoneBook>
 * Een Unit heeft maximaal 3 nummers; contacten met meer nummers krijgen extra regels.
 */
export function renderYealinkXml({ title, groups }) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<YealinkIPPhoneBook>', `<Title>${xmlAttr(title)}</Title>`];
  for (const group of groups) {
    if (!group.entries.length) continue;
    lines.push(`<Menu Name="${xmlAttr(group.name)}">`);
    for (const entry of group.entries) {
      const nums = entry.numbers.filter(Boolean);
      for (let i = 0; i < nums.length; i += 3) {
        const label = i === 0 ? entry.name : `${entry.name} (${i / 3 + 1})`;
        const [p1 = '', p2 = '', p3 = ''] = nums.slice(i, i + 3);
        lines.push(`<Unit Name="${xmlAttr(label)}" Phone1="${xmlAttr(p1)}" Phone2="${xmlAttr(p2)}" Phone3="${xmlAttr(p3)}" default_photo="Resource:"/>`);
      }
    }
    lines.push('</Menu>');
  }
  lines.push('</YealinkIPPhoneBook>');
  return `${lines.join('\n')}\n`;
}

// ---------- service ----------

export function createPhonebookService({ voys, file, cacheSeconds = 300, env = process.env, log = console }) {
  let loaded = { mtimeMs: -1, entries: [], error: null };
  const state = new Map(); // naam -> { context, cache, inflight }
  const limiter = new RateLimiter({ max: 120, windowMinutes: 1 });

  // Laadt het bestand opnieuw zodra het gewijzigd is, zonder herstart.
  function entries() {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      if (loaded.mtimeMs !== 0) loaded = { mtimeMs: 0, entries: [], error: null };
      return loaded.entries;
    }
    if (stat.mtimeMs === loaded.mtimeMs) return loaded.entries;
    try {
      const parsed = parsePhonebookConfig(JSON.parse(readFileSync(file, 'utf8')), env);
      loaded = { mtimeMs: stat.mtimeMs, entries: parsed, error: null };
      state.clear();
      log.info(`[telefoonboek] ${parsed.length} telefoonboek(en) geladen uit ${file}`);
      if ((stat.mode & 0o077) !== 0) {
        log.warn(`[telefoonboek] Let op: ${file} is leesbaar voor andere gebruikers. Gebruik: chmod 600 ${file}`);
      }
    } catch (err) {
      // Bij een fout in het bestand blijft de vorige geldige configuratie actief.
      log.error(`[telefoonboek] Configuratiefout in ${file}: ${err.message}`);
      loaded = { ...loaded, mtimeMs: stat.mtimeMs, error: err.message };
    }
    return loaded.entries;
  }

  function findByKey(key) {
    if (!key) return null;
    const h = hashKey(key);
    return entries().find((e) => timingSafeEqual(e.keyHash, h)) || null;
  }

  async function resolveContext(entry, st) {
    if (st.context && Date.now() - st.context.at < CONTEXT_TTL_MS) return st.context;
    const ctx = await voys.authContext(entry.apiToken);
    if (String(ctx?.client_uuid || '').toLowerCase() !== entry.clientUuid) {
      throw new Error(`token hoort niet bij client_uuid ${entry.clientUuid}`);
    }
    let clientId = null;
    let countryCode = 'nl';
    try {
      const details = await voys.userDetails(entry.apiToken, ctx.uuid);
      clientId = details?.client?.id ?? null;
      countryCode = details?.client?.country_code || countryCode;
    } catch (err) {
      log.warn(`[telefoonboek] ${entry.name}: gebruikersdetails niet op te halen (${err.message}); collega's worden overgeslagen`);
    }
    st.context = { at: Date.now(), userUuid: ctx.uuid, clientId, countryCode };
    return st.context;
  }

  async function build(entry, st) {
    const ctx = await resolveContext(entry, st);
    const contacts = (await voys.listContacts(entry.apiToken, entry.clientUuid)).map(mapContact);

    const contactEntries = contacts
      .map((c) => ({
        name: entry.showCompany && c.company ? `${c.name} - ${c.company}` : c.name,
        numbers: c.numbers.map((n) => formatNumber(n.flat, entry.numberFormat, ctx.countryCode)),
      }))
      .filter((c) => c.numbers.length)
      .sort((a, b) => a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' }));

    let colleagueEntries = [];
    if (entry.colleagues) {
      const { items } = await fetchColleagues(voys, {
        token: entry.apiToken, clientId: ctx.clientId, userUuid: null, logPrefix: `[telefoonboek] ${entry.name}:`,
      });
      colleagueEntries = items.filter((u) => u.internalNumber).map((u) => ({ name: u.name, numbers: [u.internalNumber] }));
    }

    const xml = renderYealinkXml({
      title: entry.title,
      groups: [
        { name: entry.contactsGroup, entries: contactEntries },
        { name: entry.colleaguesGroup, entries: colleagueEntries },
      ],
    });
    log.info(`[telefoonboek] ${entry.name}: ${contactEntries.length} contacten, ${colleagueEntries.length} collega's`);
    return { xml, at: Date.now(), counts: { contacts: contactEntries.length, colleagues: colleagueEntries.length } };
  }

  async function getPhonebook(entry) {
    let st = state.get(entry.name);
    if (!st) state.set(entry.name, (st = {}));
    if (st.cache && Date.now() - st.cache.at < cacheSeconds * 1000) return st.cache;
    if (!st.inflight) {
      st.inflight = build(entry, st)
        .then((result) => { st.cache = result; return result; })
        .finally(() => { st.inflight = null; });
    }
    try {
      return await st.inflight;
    } catch (err) {
      // Liever een iets verouderd telefoonboek dan een leeg toestel.
      if (st.cache) {
        log.warn(`[telefoonboek] ${entry.name}: verversen mislukt (${err.message}); vorige versie wordt geleverd`);
        return st.cache;
      }
      throw err;
    }
  }

  return {
    get enabled() { return entries().length > 0; },
    entries,
    findByKey,
    getPhonebook,
    allow: (entry) => limiter.allow(entry.name),
  };
}
