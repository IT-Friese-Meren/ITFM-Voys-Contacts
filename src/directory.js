// Gedeelde logica voor contacten en collega's, gebruikt door de webapp én het Yealink-telefoonboek.
import { UpstreamError } from './voys.js';

export function fullName(...parts) {
  return parts.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()).join(' ');
}

export function mapContact(c) {
  const name = fullName(c.given_name, c.family_name);
  return {
    id: c.id,
    name: name || c.company_name || '(zonder naam)',
    company: name ? (c.company_name || '') : '',
    note: c.note || '',
    // Ruwe velden, nodig voor het bewerkformulier.
    givenName: c.given_name || '',
    familyName: c.family_name || '',
    companyName: c.company_name || '',
    numbers: (c.phone_numbers ?? [])
      .filter((p) => p?.phone_number_flat)
      .map((p) => ({ flat: p.phone_number_flat, pretty: p.phone_number_pretty || p.phone_number_flat })),
  };
}

export function mapColleague(u, selfUuid) {
  // Het toestelnummer staat op de gebruiker zelf óf op het VoIP-account van de gekozen bestemming.
  const ext = u.internal_number ?? u.selected_destination?.voip_account?.internal_number ?? '';
  return {
    id: u.id,
    name: u.name || u.email_address || (ext ? `Toestel ${ext}` : 'Onbekend'),
    internalNumber: ext ? String(ext) : '',
    email: u.email_address || '',
    self: u.id === selfUuid,
  };
}

// Een toestel (VoIP-account) als "collega". IP-adressen, wachtwoorden e.d. gaan bewust niet mee naar de browser.
export function mapPhoneAccount(a, ownNumbers) {
  const ext = a.internal_number != null ? String(a.internal_number) : '';
  const status = typeof a.status === 'string' ? a.status : (a.active === false ? 'inactive' : 'active');
  return {
    id: `va:${a.uuid || a.id || a.account_id || ext}`,
    name: a.description || a.callerid_name || (ext ? `Toestel ${ext}` : 'Toestel'),
    internalNumber: ext,
    email: '',
    self: ext !== '' && ownNumbers.has(ext),
    active: status === 'active',
    // Aangemeld = het toestel is nu geregistreerd bij het platform (kan dus overgaan).
    registered: a.sipreginfo ? true : (a.sipreginfo === null ? false : undefined),
  };
}

export function dedupeByNumber(items) {
  const seen = new Set();
  return items.filter((u) => {
    if (!u.internalNumber) return true;
    if (seen.has(u.internalNumber)) return false;
    seen.add(u.internalNumber);
    return true;
  });
}

export const byName = (a, b) => a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' });

/**
 * Haalt collega's op uit de eerste bron die iets oplevert:
 * gebruikers (v2) → VoIP-accounts (v2) → klassieke phoneaccount-lijst (alleen als het e-mailadres bekend is).
 * Welke bron werkt, hangt af van de rechten van het account; een lege lijst of 403/404 betekent: volgende bron.
 */
export async function fetchColleagues(voys, { token, clientId, userUuid, email, ownNumbers = new Set(), logPrefix = "[collega's]" }) {
  const forbidden = (err) => err instanceof UpstreamError && [403, 404].includes(err.status);
  const sources = [
    ['gebruikers', async () => (clientId ? (await voys.listColleagues(token, clientId)).map((u) => mapColleague(u, userUuid)) : [])],
    ['voip-accounts', async () => (clientId ? (await voys.listVoipAccounts(token, clientId)).map((a) => mapPhoneAccount(a, ownNumbers)) : [])],
    ['phoneaccount', async () => (email ? (await voys.listPhoneAccountsLegacy(email, token)).map((a) => mapPhoneAccount(a, ownNumbers)) : [])],
  ];

  for (const [source, load] of sources) {
    let items;
    try {
      items = await load();
    } catch (err) {
      if (!forbidden(err)) throw err;
      console.info(`${logPrefix} bron ${source}: geen toegang (HTTP ${err.status})`);
      continue;
    }
    // Alleen aantallen loggen (geen persoonsgegevens).
    console.info(`${logPrefix} bron ${source}: ${items.length} ontvangen, ${items.filter((u) => u.internalNumber).length} met toestelnummer`);
    const usable = dedupeByNumber(items.filter((u) => u.active !== false));
    if (usable.length) return { source, items: usable.sort(byName) };
  }
  return { source: null, items: [] };
}
