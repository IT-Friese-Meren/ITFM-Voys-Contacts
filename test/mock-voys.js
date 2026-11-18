// Nagebootste Voys-API voor tests en lokale demo's (zonder echte inloggegevens).
// Gebruik: node test/mock-voys.js  -> start op poort 4010
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const USERS = {
  'jan@example.com': { password: 'geheim', token: 'tok-jan' },
  'piet@example.com': { password: 'geheim', token: 'tok-piet', otp: '123456' },
  'partner@example.com': { password: 'geheim', token: 'tok-partner', partner: true },
  // Gewone gebruiker zonder beheerrechten: gebruikerslijst is leeg, VoIP-accounts wel zichtbaar.
  'kim@example.com': { password: 'geheim', token: 'tok-kim' },
};

const CLIENT_UUID = 'b2a1430d-00fc-40c2-9882-93eab4df58fe';
const USER_UUID = '0596da13-824e-4ed5-a1cc-713709e0750f';

const CONTACTS = [
  { id: '00000000-0000-0000-0000-000000000001', given_name: 'Anna', family_name: 'de Vries', company_name: 'Bakkerij Zoet', note: '', phone_numbers: [{ phone_number_flat: '+31201234567', phone_number_pretty: '+31 20 123 4567', calling_code: '31' }, { phone_number_flat: '+31612345678', phone_number_pretty: '+31 6 12345678', calling_code: '31' }] },
  { id: '00000000-0000-0000-0000-000000000002', given_name: '', family_name: '', company_name: 'Gemeente Utrecht', note: 'Algemeen nummer', phone_numbers: [{ phone_number_flat: '+3114030', phone_number_pretty: '14 030', calling_code: '31' }] },
  { id: '00000000-0000-0000-0000-000000000003', given_name: 'Émile', family_name: 'Janssens', company_name: 'Brussels BV', note: '', phone_numbers: [{ phone_number_flat: '+3225551234', phone_number_pretty: '+32 2 555 12 34', calling_code: '32' }] },
  { id: '00000000-0000-0000-0000-000000000004', given_name: 'Zonder', family_name: 'Nummer', company_name: '', note: '', phone_numbers: [] },
];

const DETAILS = {
  id: '668679',
  uuid: USER_UUID,
  client: { id: '369779', uuid: CLIENT_UUID, name: 'Voorbeeld BV' },
  first_name: 'Jan', last_name: 'Jansen', preposition: null, internal_number: '610',
  selected_destination: { id: '1', voip_account: { id: '1013179' }, fixed_destination: null },
  app: { voip_account: { id: '1013169' } },
  webphone: { voip_account: { id: '1013179' } },
  destinations: {
    voip_accounts: [
      { id: '1013159', description: 'Yealink bureau', internal_number: '310', status: 'active' },
      { id: '1013169', description: 'Jan Vialer App', internal_number: '510', status: 'active' },
      { id: '1013179', description: 'Jan Webphone', internal_number: '410', status: 'active' },
    ],
    fixed_destinations: [{ id: '77', description: 'Mobiel', phone_number: '+31687654321' }],
  },
};

const COLLEAGUES = [
  { id: USER_UUID, name: 'Jan Jansen', internal_number: '610', email_address: 'jan@example.com' },
  { id: 'u2', name: 'Kees Bakker', internal_number: '611', email_address: 'kees@example.com' },
  // Veel voorkomend in de praktijk: geen eigen intern nummer, wel via het VoIP-account van de bestemming.
  { id: 'u3', name: 'Lotte Smit', internal_number: null, email_address: 'lotte@example.com', selected_destination: { voip_account: { internal_number: '241' } } },
  { id: 'u4', name: 'Mo Haddou', internal_number: null, email_address: 'mo@example.com', selected_destination: { voip_account: null, fixed_destination: null } },
];

const VOIP_ACCOUNTS = [
  { id: '1', uuid: 'a1', account_id: '497920001', internal_number: '604', description: 'Receptie', status: 'active', sipreginfo: { ipaddr: '192.0.2.1', useragent: 'Yealink SIP-T46S' } },
  { id: '2', uuid: 'a2', account_id: '497920002', internal_number: '607', description: 'Magazijn', status: 'active', sipreginfo: null },
  { id: '3', uuid: 'a3', account_id: '497920003', internal_number: '310', description: 'Yealink bureau', status: 'active', sipreginfo: null },
  { id: '4', uuid: 'a4', account_id: '497920004', internal_number: '699', description: 'Oud toestel', status: 'inactive', sipreginfo: null },
];

const LEGACY_ACCOUNTS = [
  { id: 11, account_id: 497920011, internal_number: 610, description: 'Kantoor 610', sipreginfo: null },
  { id: 12, account_id: 497920012, internal_number: 611, description: 'Kantoor 611', sipreginfo: { ipaddr: '192.0.2.9' } },
  { id: 13, account_id: 497920013, internal_number: 604, description: 'Receptie', sipreginfo: null },
];

export function createMockVoys() {
  const calls = new Map();
  const contacts = CONTACTS.map((c) => structuredClone(c));
  let nextId = 100;
  const log = [];
  const revoked = new Set();

  function tokenFromBearer(h = '') {
    const m = h.match(/^(?:Bearer|Token) (.+)$/);
    return m && !m[1].includes(':') ? m[1] : null;
  }
  function tokenFromEmailToken(h = '') {
    const m = h.match(/^Token ([^:]+):(.+)$/);
    if (!m) return null;
    const u = USERS[m[1]];
    return u && u.token === m[2] ? m[2] : null;
  }
  const valid = (t) => t && !revoked.has(t) && Object.values(USERS).some((u) => u.token === t);

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    log.push({ method: req.method, path: p, auth: req.headers.authorization, body });
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };

    if (p === '/api/permission/apitoken/' && req.method === 'POST') {
      const u = USERS[body?.email];
      if (!u || u.password !== body?.password) return json(400, { apitoken: { email: ['invalid email'], password: ['invalid password'] } });
      if (u.otp && body.two_factor_token !== u.otp) return json(400, { apitoken: { two_factor_token: ['invalid two_factor_token'] } });
      return json(200, { api_token: u.token });
    }

    if (p.startsWith('/api/clicktodial/')) {
      if (!valid(tokenFromEmailToken(req.headers.authorization))) return json(401);
      const id = p.split('/')[3];
      if (!id && req.method === 'POST') {
        if (!/^\+?[0-9]+$/.test(body?.b_number || '')) return json(400, { clicktodial: { b_number: ['Number must contain only digits'] } });
        if (body.b_number === '+31900000000') return json(400, { error: 'This number is not permitted.' });
        const callid = `call${calls.size + 1}`;
        calls.set(callid, { polls: 0, status: null, a_number: body.a_number || '310', b_number: body.b_number });
        return json(201, { callid, status: null, a_number: body.a_number || '310', b_number: body.b_number });
      }
      const call = calls.get(id);
      if (!call) return json(404, { error: 'not found' });
      if (req.method === 'GET') {
        const seq = ['dialing_a', 'dialing_b', 'connected', 'disconnected'];
        call.status = call.status === 'disconnected' ? 'disconnected' : seq[Math.min(call.polls++, seq.length - 1)];
        return json(200, { callid: id, status: call.status });
      }
      if (req.method === 'DELETE') {
        if (call.status === 'disconnected') return json(400, { error: 'already disconnected' });
        call.status = 'disconnected';
        res.writeHead(204); return res.end();
      }
    }

    // Klassieke phoneaccount-lijst (Tastypie, gepagineerd), zoals de Klik-en-bel-extensie die gebruikt.
    if (p === '/api/phoneaccount/basic/phoneaccount/') {
      if (!valid(tokenFromEmailToken(req.headers.authorization))) return json(401);
      const offset = Number(url.searchParams.get('offset') || 0);
      const pageSize = 2;
      const objects = LEGACY_ACCOUNTS.slice(offset, offset + pageSize);
      const next = offset + pageSize < LEGACY_ACCOUNTS.length ? `/api/phoneaccount/basic/phoneaccount/?limit=${pageSize}&offset=${offset + pageSize}` : null;
      return json(200, { meta: { limit: pageSize, next, offset, total_count: LEGACY_ACCOUNTS.length }, objects });
    }

    const token = tokenFromBearer(req.headers.authorization);
    if (!valid(token)) return json(401);
    const isPartner = token === USERS['partner@example.com'].token;

    if (p === '/api/v2/users/auth-context') {
      return json(200, isPartner
        ? { uuid: 'p1', partner_uuid: 'pp', client_uuid: null }
        : { uuid: USER_UUID, client_uuid: CLIENT_UUID, partner_uuid: null });
    }
    if (p === `/api/v2/user/${USER_UUID}/details`) return json(200, DETAILS);
    if (p === `/api/v2/clients/${DETAILS.client.id}/users`) {
      if (token === USERS['piet@example.com'].token) return json(403);
      if (token === USERS['kim@example.com'].token) return json(200, { data: [], meta: {} });
      // Let op: het echte platform geeft hier een kale array terug, niet { data: [...] } zoals de spec zegt.
      return json(200, COLLEAGUES);
    }
    if (p === `/api/v2/clients/${DETAILS.client.id}/voip_accounts`) {
      if (token === USERS['piet@example.com'].token) return json(403);
      return json(200, { data: VOIP_ACCOUNTS, meta: {} });
    }
    const base = `/contactbook/clients/${CLIENT_UUID}/contacts`;
    const pretty = (n) => ({ phone_number_flat: n.phone_number_flat, phone_number_pretty: n.phone_number_flat, calling_code: '31' });
    const validate = (b) => {
      if (!b?.given_name && !b?.family_name && !b?.company_name) {
        return { detail: [{ type: 'value_error', loc: ['body'], msg: 'Value error, a given name, family name or company name is required' }], error_code: 'bad_request' };
      }
      if ((b.phone_numbers || []).some((n) => !/^\+[0-9]{8,15}$/.test(n.phone_number_flat))) {
        return { detail: [{ type: 'value_error', loc: ['body', 'phone_numbers'], msg: 'Value error, invalid phone number' }], error_code: 'bad_request' };
      }
      return null;
    };
    const readOnly = token === USERS['piet@example.com'].token;
    if (p === base && req.method === 'GET') return json(200, { items: contacts });
    if (p === base && req.method === 'POST') {
      if (readOnly) return json(403);
      const err = validate(body); if (err) return json(400, err);
      const c = { ...body, id: `00000000-0000-0000-0000-${String(nextId++).padStart(12, '0')}`, phone_numbers: (body.phone_numbers || []).map(pretty) };
      contacts.push(c);
      return json(200, c);
    }
    if (p.startsWith(base + '/')) {
      const id = p.slice(base.length + 1);
      const i = contacts.findIndex((c) => c.id === id);
      if (readOnly && req.method !== 'GET') return json(403);
      if (i < 0) return json(404, { error_code: 'not_found', message: 'not found' });
      if (req.method === 'PUT') {
        const err = validate(body); if (err) return json(400, err);
        contacts[i] = { ...contacts[i], ...body, id, phone_numbers: (body.phone_numbers || []).map(pretty) };
        return json(200, contacts[i]);
      }
      if (req.method === 'DELETE') { contacts.splice(i, 1); res.writeHead(204); return res.end(); }
    }
    return json(404, { error_code: 'not_found', message: 'not found' });
  });

  return { server, log, calls, contacts, revoke: (t) => revoked.add(t) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_PORT || 4010);
  createMockVoys().server.listen(port, () => {
    console.log(`Mock Voys-API op http://localhost:${port}`);
    console.log('Testaccounts: jan@example.com / geheim   |   piet@example.com / geheim (2FA-code 123456)');
  });
}
