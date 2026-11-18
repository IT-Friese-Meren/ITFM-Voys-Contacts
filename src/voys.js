// Dunne client rond de officiële Voys/VoIPGRID-API's.
//
//  Login (API-token ophalen)  POST {voysApi}/api/permission/apitoken/          (zelfde flow als Vialer, incl. 2FA)
//  Gebruikerscontext           GET  {voysApi}/api/v2/users/auth-context         -> uuid, client_uuid
//  Gebruikersdetails           GET  {voysApi}/api/v2/user/{uuid}/details        -> client.id, toestellen (voip_accounts)
//  Collega's                   GET  {voysApi}/api/v2/clients/{client_id}/users
//  Gedeelde contacten          GET  {holodeckApi}/contactbook/clients/{client_uuid}/contacts
//  Klik-en-bel                 POST {voysApi}/api/clicktodial/   + GET/DELETE /api/clicktodial/{callid}/

export class UpstreamError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Beschrijft alleen de vorm van een JSON-antwoord (veldnamen, types, aantallen), nooit de waarden.
// Zo kun je de API debuggen zonder namen, nummers of tokens in de log te krijgen.
export function describeShape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `array(${v.length}) of ${describeShape(v[0], depth + 1)}` : 'array(0)';
  if (typeof v === 'object') {
    if (depth > 3) return 'object';
    const entries = Object.entries(v);
    const parts = entries.slice(0, 25).map(([k, x]) => `${k.slice(0, 40)}: ${describeShape(x, depth + 1)}`);
    if (entries.length > 25) parts.push(`…+${entries.length - 25}`);
    return `{ ${parts.join(', ')} }`;
  }
  return typeof v;
}

// Zoekt de lijst in een antwoord, ongeacht of die als array, data, items of results binnenkomt.
export function extractList(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['data', 'items', 'results', 'users', 'objects']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function createVoysClient({ voysApi, holodeckApi, timeoutMs = 10000, fetchImpl = globalThis.fetch, debug = false }) {
  async function request(url, { method = 'GET', auth, body } = {}) {
    const headers = { Accept: 'application/json' };
    if (auth) headers.Authorization = auth;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new UpstreamError(timedOut ? 504 : 502, 'upstream_unreachable',
        timedOut ? 'Het Voys-platform reageert niet op tijd.' : 'Het Voys-platform is niet bereikbaar.');
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (debug) {
      const where = new URL(url);
      const path = where.pathname.replace(UUID_RE, '<uuid>').replace(/\/clients\/\d+/, '/clients/<id>').replace(/\/clicktodial\/[^/]+/, '/clicktodial/<callid>');
      const query = [...where.searchParams.keys()].join(',');
      console.info(`[upstream] ${method} ${where.host}${path}${query ? `?(${query})` : ''} -> ${res.status} ${data === null ? `(geen JSON, ${text.length} bytes)` : describeShape(data)}`);
      if (res.status >= 300 && res.status < 400) console.info(`[upstream]   redirect naar: ${(res.headers.get('location') || '').replace(UUID_RE, '<uuid>')}`);
    }
    return { status: res.status, ok: res.ok, data };
  }

  function bearer(token) {
    return `Bearer ${token}`;
  }

  // Click-to-dial gebruikt een afwijkend formaat: "Token <email>:<api token>".
  function emailToken(email, token) {
    return `Token ${email}:${token}`;
  }

  function fail(r, what) {
    if (r.status === 401) throw new UpstreamError(401, 'unauthorized', 'Je sessie bij Voys is verlopen. Log opnieuw in.');
    if (r.status === 403) throw new UpstreamError(403, 'forbidden', `Je account heeft geen rechten voor ${what}.`);
    if (r.status === 404) throw new UpstreamError(404, 'not_found', `${what} niet gevonden.`);
    if (r.status === 429) throw new UpstreamError(429, 'rate_limited', 'Te veel verzoeken. Probeer het zo opnieuw.');
    throw new UpstreamError(502, 'upstream_error', `Fout bij ophalen van ${what} (HTTP ${r.status}).`);
  }

  function contactsUrl(clientUuid) {
    return `${holodeckApi}/contactbook/clients/${encodeURIComponent(clientUuid)}/contacts`;
  }

  // Contactbook geeft validatiefouten als { detail: [{ msg }] } (FastAPI-stijl).
  function contactFail(r, action) {
    if (r.status === 400 || r.status === 422) {
      const detail = r.data?.detail;
      const msg = Array.isArray(detail)
        ? detail.map((d) => String(d?.msg || '').replace(/^Value error,\s*/i, '')).filter(Boolean).join(' ')
        : (typeof detail === 'string' ? detail : r.data?.message);
      throw new UpstreamError(400, 'invalid_contact', msg || `Contact ${action} mislukt: ongeldige gegevens.`);
    }
    if (r.status === 403) throw new UpstreamError(403, 'forbidden', `Je account mag geen contacten ${action}.`);
    if (r.status === 404) throw new UpstreamError(404, 'not_found', 'Dit contact bestaat niet (meer). Ververs de lijst.');
    if (r.status === 503) throw new UpstreamError(503, 'unavailable', 'Het adresboek is tijdelijk niet beschikbaar. Probeer het zo opnieuw.');
    fail(r, 'het contact');
  }

  return {
    /**
     * Wisselt e-mail + wachtwoord (+ optionele 2FA-code) in voor het API-token van de gebruiker.
     * Resultaat: { token } | { needOtp: true, otpInvalid } | { invalid: true }
     */
    async login(email, password, otp) {
      const body = { email, password };
      if (otp) body.two_factor_token = otp;
      const r = await request(`${voysApi}/api/permission/apitoken/`, { method: 'POST', body });

      if (r.ok && r.data?.api_token) return { token: r.data.api_token };
      if (r.status === 400 || r.status === 401) {
        const errors = r.data?.apitoken ?? r.data ?? {};
        if (errors && typeof errors === 'object' && 'two_factor_token' in errors) {
          return { needOtp: true, otpInvalid: Boolean(otp) };
        }
        return { invalid: true };
      }
      if (r.status === 429) throw new UpstreamError(429, 'rate_limited', 'Te veel inlogpogingen bij Voys. Wacht even en probeer opnieuw.');
      throw new UpstreamError(502, 'upstream_error', `Inloggen bij Voys mislukt (HTTP ${r.status}).`);
    },

    async authContext(token) {
      const r = await request(`${voysApi}/api/v2/users/auth-context`, { auth: bearer(token) });
      if (!r.ok) fail(r, 'de gebruikerscontext');
      return r.data;
    },

    async userDetails(token, userUuid) {
      const r = await request(`${voysApi}/api/v2/user/${encodeURIComponent(userUuid)}/details`, { auth: bearer(token) });
      if (!r.ok) fail(r, 'je gebruikersgegevens');
      return r.data;
    },

    async listColleagues(token, clientId) {
      const r = await request(`${voysApi}/api/v2/clients/${encodeURIComponent(clientId)}/users`, { auth: bearer(token) });
      if (!r.ok) fail(r, "de collega's");
      return extractList(r.data);
    },

    // VoIP-accounts (toestellen) van de klant via API v2. Vraagt nooit wachtwoorden op.
    async listVoipAccounts(token, clientId) {
      const r = await request(`${voysApi}/api/v2/clients/${encodeURIComponent(clientId)}/voip_accounts`, { auth: bearer(token) });
      if (!r.ok) fail(r, 'de toestellen');
      return extractList(r.data);
    },

    // Klassiek endpoint dat ook de Klik-en-bel-extensie gebruikt voor de lijst met collega-toestellen.
    // Gepagineerd in Tastypie-stijl: { meta: { next }, objects: [...] }.
    async listPhoneAccountsLegacy(email, token) {
      const all = [];
      let next = `${voysApi}/api/phoneaccount/basic/phoneaccount/?limit=200`;
      for (let page = 0; next && page < 25; page++) {
        const r = await request(next, { auth: emailToken(email, token) });
        if (!r.ok) fail(r, 'de toestellen');
        all.push(...extractList(r.data));
        const n = r.data?.meta?.next;
        next = n ? new URL(n, voysApi).href : null;
        if (next && new URL(next).origin !== new URL(voysApi).origin) next = null; // nooit naar een ander domein
      }
      return all;
    },

    async listContacts(token, clientUuid) {
      const r = await request(`${holodeckApi}/contactbook/clients/${encodeURIComponent(clientUuid)}/contacts`, { auth: bearer(token) });
      if (!r.ok) fail(r, 'de contacten');
      return Array.isArray(r.data?.items) ? r.data.items : [];
    },

    async createContact(token, clientUuid, contact) {
      const r = await request(contactsUrl(clientUuid), { method: 'POST', auth: bearer(token), body: contact });
      if (r.ok && r.data?.id) return r.data;
      contactFail(r, 'aanmaken');
    },

    async updateContact(token, clientUuid, contactUuid, contact) {
      const r = await request(`${contactsUrl(clientUuid)}/${encodeURIComponent(contactUuid)}`, { method: 'PUT', auth: bearer(token), body: contact });
      if (r.ok && r.data?.id) return r.data;
      contactFail(r, 'opslaan');
    },

    async deleteContact(token, clientUuid, contactUuid) {
      const r = await request(`${contactsUrl(clientUuid)}/${encodeURIComponent(contactUuid)}`, { method: 'DELETE', auth: bearer(token) });
      if (r.ok || r.status === 204) return;
      contactFail(r, 'verwijderen');
    },

    async startCall(email, token, { bNumber, aNumber }) {
      const body = { b_number: bNumber };
      if (aNumber) body.a_number = aNumber;
      const r = await request(`${voysApi}/api/clicktodial/`, { method: 'POST', auth: emailToken(email, token), body });
      if (r.ok && r.data?.callid) return r.data;
      if (r.status === 400) {
        const msg = r.data?.error
          || Object.values(r.data?.clicktodial ?? {}).flat().join(' ')
          || 'Het gesprek kon niet worden opgezet.';
        throw new UpstreamError(400, 'call_rejected', msg);
      }
      if (r.status === 403) throw new UpstreamError(403, 'forbidden', 'Je mag met dit nummer niet bellen (beller-ID niet toegestaan).');
      fail(r, 'het gesprek');
    },

    async callStatus(email, token, callId) {
      const r = await request(`${voysApi}/api/clicktodial/${encodeURIComponent(callId)}/`, { auth: emailToken(email, token) });
      if (!r.ok) fail(r, 'de gespreksstatus');
      return r.data;
    },

    async hangup(email, token, callId) {
      const r = await request(`${voysApi}/api/clicktodial/${encodeURIComponent(callId)}/`, { method: 'DELETE', auth: emailToken(email, token) });
      if (r.status === 204 || r.ok) return;
      if (r.status === 400) return; // gesprek was al beëindigd
      fail(r, 'het gesprek');
    },
  };
}
