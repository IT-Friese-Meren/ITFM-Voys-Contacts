import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoysClient, UpstreamError } from './voys.js';
import { SessionStore, RateLimiter } from './sessions.js';
import { fullName, mapContact, byName, fetchColleagues } from './directory.js';
import { createPhonebookService, ipAllowed } from './phonebook.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'vcd_sid';
const MAX_BODY = 16 * 1024;

// Alleen deze bestanden worden geserveerd (geen directory traversal mogelijk).
// [bestand, content-type, cache-control]
const REVALIDATE = 'no-cache';
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8', REVALIDATE],
  '/index.html': ['index.html', 'text/html; charset=utf-8', REVALIDATE],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8', REVALIDATE],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8', REVALIDATE],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8', REVALIDATE],
  '/favicon.ico': ['brand/favicon-64.png', 'image/png', 'public, max-age=86400'],
  '/brand/favicon-64.png': ['brand/favicon-64.png', 'image/png', 'public, max-age=86400'],
  '/brand/mark.png': ['brand/mark.png', 'image/png', 'public, max-age=86400'],
  '/brand/logo-light.webp': ['brand/logo-light.webp', 'image/webp', 'public, max-age=86400'],
  '/brand/logo-dark.webp': ['brand/logo-dark.webp', 'image/webp', 'public, max-age=86400'],
  '/fonts/poppins-400.woff2': ['fonts/poppins-400.woff2', 'font/woff2', 'public, max-age=31536000, immutable'],
  '/fonts/poppins-500.woff2': ['fonts/poppins-500.woff2', 'font/woff2', 'public, max-age=31536000, immutable'],
  '/fonts/poppins-600.woff2': ['fonts/poppins-600.woff2', 'font/woff2', 'public, max-age=31536000, immutable'],
  '/fonts/play-700.woff2': ['fonts/play-700.woff2', 'font/woff2', 'public, max-age=31536000, immutable'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png', 'public, max-age=86400'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png', 'public, max-age=86400'],
  '/icons/maskable-512.png': ['icons/maskable-512.png', 'image/png', 'public, max-age=86400'],
  '/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png', 'public, max-age=86400'],
};

// Web App Manifest: dynamisch, zodat APP_NAME ook de naam van de geïnstalleerde app bepaalt.
function manifest(appName) {
  return {
    id: '/',
    name: appName,
    short_name: appName.length > 12 ? 'Bellen' : appName,
    description: 'Bel je gedeelde contacten vanaf je eigen toestel.',
    lang: 'nl',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#232525',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------- helpers ----------

export function normalizeNumber(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  let n = String(input).trim().replace(/[\s\-().\/]/g, '');
  if (n.startsWith('00')) n = `+${n.slice(2)}`;
  return /^\+?[0-9]{2,20}$/.test(n) ? n : null;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function buildDevices(details) {
  const appId = details?.app?.voip_account?.id;
  const webphoneId = details?.webphone?.voip_account?.id;
  const selectedVa = details?.selected_destination?.voip_account?.id;
  const selectedFd = details?.selected_destination?.fixed_destination?.id;
  const devices = [];

  for (const va of details?.destinations?.voip_accounts ?? []) {
    if (!va?.internal_number) continue;
    const kind = va.id === appId ? 'app' : va.id === webphoneId ? 'webphone' : 'phone';
    devices.push({
      id: `va:${va.id}`,
      kind,
      label: va.description || `Toestel ${va.internal_number}`,
      number: String(va.internal_number),
      active: !va.status || va.status === 'active',
      selected: va.id === selectedVa,
    });
  }
  for (const fd of details?.destinations?.fixed_destinations ?? []) {
    if (!fd?.phone_number) continue;
    devices.push({
      id: `fd:${fd.id}`,
      kind: 'fixed',
      label: fd.description || fd.phone_number,
      number: String(fd.phone_number),
      active: true,
      selected: fd.id === selectedFd,
    });
  }
  return devices;
}

// Landcode -> internationaal kengetal, om nationale nummers (06…) naar E.164 (+316…) om te zetten.
const CALLING_CODES = { nl: '31', be: '32', de: '49', lu: '352', fr: '33', gb: '44', uk: '44', es: '34', at: '43', ch: '41', za: '27' };

export function toE164(input, countryCode) {
  const n = normalizeNumber(input);
  if (!n) return null;
  if (n.startsWith('+')) return n.length >= 8 ? n : null;
  const cc = CALLING_CODES[String(countryCode || '').toLowerCase()];
  if (cc && /^0[1-9][0-9]{6,12}$/.test(n)) return `+${cc}${n.slice(1)}`;
  return null;
}

// Valideert contactinvoer uit de browser en zet hem om naar het Contactbook-formaat.
export function contactPayload(body, countryCode) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const given = str(body?.givenName, 100);
  const family = str(body?.familyName, 100);
  const company = str(body?.companyName, 200);
  const note = str(body?.note, 1000);

  if (!given && !family && !company) {
    throw new HttpError(400, 'invalid_contact', 'Vul minimaal een voornaam, achternaam of bedrijfsnaam in.');
  }
  for (const [label, v] of [['Voornaam', given], ['Achternaam', family]]) {
    if (v && v.length < 2) throw new HttpError(400, 'invalid_contact', `${label} moet leeg zijn of minimaal 2 tekens hebben.`);
  }

  const raw = Array.isArray(body?.phoneNumbers) ? body.phoneNumbers : [];
  if (raw.length > 20) throw new HttpError(400, 'invalid_contact', 'Maximaal 20 telefoonnummers per contact.');
  const numbers = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const e164 = toE164(entry, countryCode);
    if (!e164) {
      throw new HttpError(400, 'invalid_number',
        `“${entry.trim().slice(0, 40)}” is geen geldig telefoonnummer. Gebruik bijvoorbeeld 0201234567 of +31201234567.`);
    }
    if (!numbers.includes(e164)) numbers.push(e164);
  }

  return {
    given_name: given,
    family_name: family,
    company_name: company,
    note,
    phone_numbers: numbers.map((phone_number_flat) => ({ phone_number_flat })),
  };
}

// ---------- app ----------

export function createApp(config, deps = {}) {
  const voys = deps.voys ?? createVoysClient({
    voysApi: config.voysApi,
    holodeckApi: config.holodeckApi,
    timeoutMs: config.upstreamTimeoutMs,
    debug: config.debugUpstream,
  });
  const sessions = deps.sessions ?? new SessionStore({ idleMinutes: config.sessionIdleMinutes });
  const ipLimiter = new RateLimiter({ max: config.loginMaxAttemptsPerIp, windowMinutes: config.loginWindowMinutes });
  const emailLimiter = new RateLimiter({ max: config.loginMaxAttempts, windowMinutes: config.loginWindowMinutes });
  const staticCache = new Map();
  const phonebooks = deps.phonebooks ?? createPhonebookService({
    voys, file: config.phonebooksFile, cacheSeconds: config.phonebookCacheSeconds,
  });

  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
      "manifest-src 'self'; worker-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  function send(res, status, body, extraHeaders = {}) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(payload);
  }

  function sessionCookie(value, maxAgeSeconds) {
    const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (config.cookieSecure) parts.push('Secure');
    return parts.join('; ');
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  async function readJson(req) {
    const type = req.headers['content-type'] || '';
    if (!type.startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Verwacht JSON.');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'payload_too_large', 'Verzoek is te groot.');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw new HttpError(400, 'invalid_json', 'Ongeldige JSON.');
    }
  }

  function requireSession(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    const session = sessions.get(sid);
    if (!session) throw new HttpError(401, 'not_logged_in', 'Niet ingelogd.');
    return { sid, session };
  }

  // CSRF-bescherming bovenop SameSite=Strict: muterende verzoeken moeten een custom header hebben,
  // die een andere site niet zonder CORS-preflight kan meesturen.
  function requireCsrfHeader(req) {
    if (req.headers['x-requested-with'] !== 'fetch') {
      throw new HttpError(403, 'csrf', 'Ongeldig verzoek.');
    }
  }

  function publicProfile(session) {
    return {
      email: session.email,
      name: session.profile.name,
      internalNumber: session.profile.internalNumber,
      clientName: session.profile.clientName,
      devices: session.devices,
    };
  }

  // ---------- route handlers ----------

  async function login(req, res) {
    requireCsrfHeader(req);
    const body = await readJson(req);
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const otp = typeof body.otp === 'string' ? body.otp.replace(/\s/g, '') : '';

    if (!email || !password || email.length > 254 || password.length > 1024) {
      throw new HttpError(400, 'invalid_input', 'Vul je e-mailadres en wachtwoord in.');
    }
    if (otp && !/^[0-9]{6,8}$/.test(otp)) {
      throw new HttpError(400, 'invalid_otp', 'De verificatiecode bestaat uit 6 cijfers.');
    }

    const ip = clientIp(req);
    const emailKey = email.toLowerCase();
    if (!ipLimiter.allow(ip) || !emailLimiter.allow(emailKey)) {
      throw new HttpError(429, 'rate_limited', 'Te veel inlogpogingen. Probeer het over een kwartier opnieuw.');
    }

    const result = await voys.login(email, password, otp || undefined);
    if (result.needOtp) {
      return send(res, 401, {
        error: result.otpInvalid ? 'otp_invalid' : 'otp_required',
        message: result.otpInvalid ? 'De verificatiecode klopt niet.' : 'Voer de code uit je authenticator-app in.',
      });
    }
    if (result.invalid || !result.token) {
      return send(res, 401, { error: 'invalid_credentials', message: 'E-mailadres of wachtwoord klopt niet.' });
    }

    const token = result.token;
    const ctx = await voys.authContext(token);
    if (!ctx?.client_uuid) {
      throw new HttpError(403, 'not_client_user',
        'Dit is een partneraccount. Log in met een gebruikersaccount van een klant; alleen die kunnen klik-en-bel gebruiken.');
    }
    const details = await voys.userDetails(token, ctx.uuid);

    emailLimiter.reset(emailKey);
    const session = {
      email,
      token,
      userUuid: ctx.uuid,
      clientUuid: ctx.client_uuid,
      clientId: details?.client?.id ?? null,
      countryCode: details?.client?.country_code || 'nl',
      profile: {
        name: fullName(details?.first_name, details?.preposition, details?.last_name) || email,
        internalNumber: details?.internal_number ? String(details.internal_number) : '',
        clientName: details?.client?.name || '',
      },
      devices: buildDevices(details),
      calls: new Set(),
      cache: {},
    };
    const sid = sessions.create(session);
    send(res, 200, publicProfile(session), {
      'Set-Cookie': sessionCookie(sid, Math.round(config.sessionIdleMinutes * 60)),
    });
  }

  async function logout(req, res) {
    requireCsrfHeader(req);
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (sid) sessions.destroy(sid);
    send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  async function me(req, res) {
    const { session } = requireSession(req);
    send(res, 200, publicProfile(session));
  }

  async function cached(session, key, refresh, loader) {
    const entry = session.cache[key];
    const fresh = entry && Date.now() - entry.at < config.contactsCacheSeconds * 1000;
    if (fresh && !refresh) return entry.value;
    const value = await loader();
    session.cache[key] = { at: Date.now(), value };
    return value;
  }

  async function contacts(req, res, url) {
    const { session } = requireSession(req);
    const refresh = url.searchParams.get('refresh') === '1';
    const list = await cached(session, 'contacts', refresh, async () =>
      (await voys.listContacts(session.token, session.clientUuid)).map(mapContact).sort(byName));
    send(res, 200, { items: list });
  }

  async function colleagues(req, res, url) {
    const { session } = requireSession(req);
    const refresh = url.searchParams.get('refresh') === '1';
    const result = await cached(session, 'colleagues', refresh, () => loadColleagues(session));
    send(res, 200, { available: result.items.length > 0, source: result.source, items: result.items });
  }

  async function loadColleagues(session) {
    const ownNumbers = new Set([session.profile.internalNumber, ...session.devices.map((d) => d.number)].filter(Boolean));
    return fetchColleagues(voys, {
      token: session.token, clientId: session.clientId, userUuid: session.userUuid, email: session.email, ownNumbers,
    });
  }

  // ---------- contacten beheren (Contactbook) ----------

  function contactId(id) {
    if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) throw new HttpError(404, 'not_found', 'Contact niet gevonden.');
    return id;
  }

  function dropContactsCache(session) {
    delete session.cache.contacts;
  }

  async function createContact(req, res) {
    requireCsrfHeader(req);
    const { session } = requireSession(req);
    const payload = contactPayload(await readJson(req), session.countryCode);
    const created = await voys.createContact(session.token, session.clientUuid, payload);
    dropContactsCache(session);
    send(res, 201, mapContact(created));
  }

  async function updateContact(req, res, id) {
    requireCsrfHeader(req);
    const { session } = requireSession(req);
    const payload = contactPayload(await readJson(req), session.countryCode);
    const updated = await voys.updateContact(session.token, session.clientUuid, contactId(id), payload);
    dropContactsCache(session);
    send(res, 200, mapContact(updated));
  }

  async function deleteContact(req, res, id) {
    requireCsrfHeader(req);
    const { session } = requireSession(req);
    // Extra vangnet naast de dubbele bevestiging in de interface.
    if (req.headers['x-confirm-delete'] !== 'yes') {
      throw new HttpError(428, 'confirmation_required', 'Verwijderen moet bevestigd worden.');
    }
    await voys.deleteContact(session.token, session.clientUuid, contactId(id));
    dropContactsCache(session);
    send(res, 200, { ok: true });
  }

  async function startCall(req, res) {
    requireCsrfHeader(req);
    const { session } = requireSession(req);
    const body = await readJson(req);
    const bNumber = normalizeNumber(body.number);
    if (!bNumber) throw new HttpError(400, 'invalid_number', 'Ongeldig telefoonnummer.');

    let aNumber;
    if (body.device) {
      const device = session.devices.find((d) => d.id === body.device);
      if (!device) throw new HttpError(400, 'invalid_device', 'Onbekend toestel. Ververs de pagina.');
      aNumber = normalizeNumber(device.number) ?? undefined;
    }

    const call = await voys.startCall(session.email, session.token, { bNumber, aNumber });
    session.calls.add(call.callid);
    if (session.calls.size > 50) session.calls.delete(session.calls.values().next().value);
    send(res, 201, { callId: call.callid, status: call.status ?? null, bNumber: call.b_number, aNumber: call.a_number });
  }

  function ownCall(session, callId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(callId) || !session.calls.has(callId)) {
      throw new HttpError(404, 'not_found', 'Gesprek niet gevonden.');
    }
  }

  async function callStatus(req, res, callId) {
    const { session } = requireSession(req);
    ownCall(session, callId);
    const call = await voys.callStatus(session.email, session.token, callId);
    send(res, 200, { callId, status: call?.status ?? null });
  }

  async function hangup(req, res, callId) {
    requireCsrfHeader(req);
    const { session } = requireSession(req);
    ownCall(session, callId);
    await voys.hangup(session.email, session.token, callId);
    send(res, 200, { ok: true });
  }

  async function serveStatic(req, res, pathname) {
    const entry = STATIC[pathname];
    if (!entry) return send(res, 404, { error: 'not_found' });
    const [file, type, cacheControl] = entry;
    let content = staticCache.get(file);
    if (!content) {
      content = await readFile(path.join(PUBLIC_DIR, file));
      if (process.env.NODE_ENV === 'production') staticCache.set(file, content);
    }
    if (file === 'index.html') content = Buffer.from(renderTemplate(content.toString('utf8'), config));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cacheControl });
    res.end(req.method === 'HEAD' ? undefined : content);
  }

  // ---------- Yealink-telefoonboek ----------

  // De sleutel komt uit de URL (/yealink/<sleutel>/phonebook.xml) of, zodat hij niet in
  // access-logs belandt, als wachtwoord via HTTP Basic (/yealink/phonebook.xml).
  async function yealinkPhonebook(req, res, keyFromPath) {
    const plain = (status, text, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(text);
    };
    let key = keyFromPath;
    if (!key) {
      const auth = req.headers.authorization || '';
      if (auth.startsWith('Basic ')) {
        const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
        key = decoded.slice(decoded.indexOf(':') + 1);
      }
      if (!key) return plain(401, 'Authenticatie vereist', { 'WWW-Authenticate': 'Basic realm="phonebook", charset="UTF-8"' });
    }

    const entry = phonebooks.findByKey(key);
    // Onbekende sleutel en uitgeschakelde functie geven hetzelfde antwoord: niets verraden.
    if (!entry) return plain(404, 'Niet gevonden');
    res.phonebookName = entry.name;
    if (!ipAllowed(clientIp(req), entry.allowedIps)) return plain(403, 'Geen toegang vanaf dit adres');
    if (!phonebooks.allow(entry)) return plain(429, 'Te veel verzoeken', { 'Retry-After': '60' });

    let book;
    try {
      book = await phonebooks.getPhonebook(entry);
    } catch (err) {
      console.error(`[telefoonboek] ${entry.name}: ophalen mislukt: ${err.message}`);
      return plain(503, 'Telefoonboek tijdelijk niet beschikbaar', { 'Retry-After': '300' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/xml; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    res.end(req.method === 'HEAD' ? undefined : book.xml);
  }

  // Eén logregel per toestelverzoek. De sleutel wordt nooit gelogd; alleen hoe hij is meegestuurd.
  function logPhonebookRequest(req, res, pathname) {
    const started = Date.now();
    const via = pathname === '/yealink/phonebook.xml'
      ? (String(req.headers.authorization || '').startsWith('Basic ') ? 'basic' : 'geen-sleutel')
      : (/^\/yealink\/[A-Za-z0-9_-]{32,128}\/phonebook\.xml$/.test(pathname) ? 'url' : 'ongeldig-pad');
    const ua = String(req.headers['user-agent'] || '-').replace(/[^\x20-\x7E]/g, '').slice(0, 160);
    res.on('finish', () => {
      console.info(`[telefoonboek] ${req.method} ${res.statusCode} ${res.phonebookName || '-'} van ${clientIp(req)} via ${via} (${Date.now() - started} ms) "${ua}"`);
    });
  }

  // ---------- router ----------

  async function handle(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const m = req.method;

    if (pathname === '/healthz') return send(res, 200, { ok: true });
    if (pathname.startsWith('/yealink/')) {
      logPhonebookRequest(req, res, pathname);
      if (m !== 'GET' && m !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
        return res.end('Methode niet toegestaan');
      }
      if (pathname === '/yealink/phonebook.xml') return yealinkPhonebook(req, res, null);
      const pb = pathname.match(/^\/yealink\/([A-Za-z0-9_-]{32,128})\/phonebook\.xml$/);
      if (pb) return yealinkPhonebook(req, res, pb[1]);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Niet gevonden');
    }
    if (pathname === '/manifest.webmanifest' && (m === 'GET' || m === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': REVALIDATE });
      return res.end(m === 'HEAD' ? undefined : JSON.stringify(manifest(config.appName)));
    }
    if (pathname === '/api/login' && m === 'POST') return login(req, res);
    if (pathname === '/api/logout' && m === 'POST') return logout(req, res);
    if (pathname === '/api/me' && m === 'GET') return me(req, res);
    if (pathname === '/api/contacts' && m === 'GET') return contacts(req, res, url);
    if (pathname === '/api/colleagues' && m === 'GET') return colleagues(req, res, url);
    if (pathname === '/api/calls' && m === 'POST') return startCall(req, res);
    if (pathname === '/api/contacts' && m === 'POST') return createContact(req, res);

    const contactMatch = pathname.match(/^\/api\/contacts\/([^/]+)$/);
    if (contactMatch) {
      const id = decodeURIComponent(contactMatch[1]);
      if (m === 'PUT') return updateContact(req, res, id);
      if (m === 'DELETE') return deleteContact(req, res, id);
    }

    const callMatch = pathname.match(/^\/api\/calls\/([^/]+)$/);
    if (callMatch) {
      const id = decodeURIComponent(callMatch[1]);
      if (m === 'GET') return callStatus(req, res, id);
      if (m === 'DELETE') return hangup(req, res, id);
    }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not_found', message: 'Onbekend endpoint.' });
    if (m === 'GET' || m === 'HEAD') return serveStatic(req, res, pathname);
    return send(res, 405, { error: 'method_not_allowed' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        return send(res, err.status, { error: err.code, message: err.message });
      }
      if (err instanceof UpstreamError) {
        // Token is ingetrokken of verlopen: sessie opruimen zodat de gebruiker opnieuw inlogt.
        if (err.status === 401) {
          const sid = parseCookies(req.headers.cookie)[COOKIE];
          if (sid) sessions.destroy(sid);
          return send(res, 401, { error: 'not_logged_in', message: err.message }, { 'Set-Cookie': sessionCookie('', 0) });
        }
        return send(res, err.status, { error: err.code, message: err.message });
      }
      console.error('Onverwachte fout:', err);
      send(res, 500, { error: 'internal', message: 'Er ging iets mis.' });
    }
  });

  server.on('close', () => sessions.close?.());
  server.phonebooks = phonebooks;
  return server;
}

// Vult de placeholders in index.html. Alle waarden worden ge-escaped.
export function renderTemplate(html, config, now = new Date()) {
  const vars = {
    APP_NAME: config.appName,
    PORTAL_URL: config.portalUrl,
    PORTAL_HOST: hostOf(config.portalUrl),
    WEBPHONE_URL: config.webphoneUrl,
    WEBSITE_URL: config.websiteUrl,
    WEBSITE_HOST: hostOf(config.websiteUrl),
    COMPANY_NAME: config.companyName,
    YEAR: String(now.getFullYear()),
  };
  return html.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in vars ? escapeHtml(vars[key]) : m));
}

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
