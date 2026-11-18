import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockVoys } from './mock-voys.js';
import { createApp, normalizeNumber, toE164, contactPayload } from '../src/server.js';
import { loadConfig } from '../src/config.js';

let mock, app, base;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

before(async () => {
  mock = createMockVoys();
  const mockBase = await listen(mock.server);
  const config = loadConfig({ VOYS_API_BASE: mockBase, HOLODECK_API_BASE: mockBase, LOGIN_MAX_ATTEMPTS: '5' });
  app = createApp(config);
  base = await listen(app);
});

after(() => {
  app.closeAllConnections(); app.close();
  mock.server.closeAllConnections(); mock.server.close();
});

// Mini-client die cookies onthoudt, zoals een browser.
function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, csrf = true, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (csrf && method !== 'GET') h['X-Requested-With'] = 'fetch';
    const res = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null, cookie: set };
  };
}

async function loggedIn(email = 'jan@example.com') {
  const c = client();
  const r = await c('/api/login', { method: 'POST', body: { email, password: 'geheim' } });
  assert.equal(r.status, 200);
  return c;
}

test('normalizeNumber', () => {
  assert.equal(normalizeNumber('+31 6 1234-5678'), '+31612345678');
  assert.equal(normalizeNumber('0031 (20) 123.4567'), '+31201234567');
  assert.equal(normalizeNumber('201'), '201');
  assert.equal(normalizeNumber('abc'), null);
  assert.equal(normalizeNumber('+'), null);
  assert.equal(normalizeNumber(undefined), null);
});

test('statische bestanden en security headers', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const html = await r.text();
  assert.match(html, /<title>Contacten &amp; Bellen<\/title>/);
  assert.equal((await fetch(base + '/../package.json')).status, 404);
  assert.equal((await fetch(base + '/src/server.js')).status, 404);
});

test('niet ingelogd -> 401', async () => {
  const c = client();
  assert.equal((await c('/api/me')).status, 401);
  assert.equal((await c('/api/contacts')).status, 401);
});

test('verkeerd wachtwoord', async () => {
  const c = client();
  const r = await c('/api/login', { method: 'POST', body: { email: 'jan@example.com', password: 'fout' } });
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'invalid_credentials');
});

test('login zonder CSRF-header wordt geweigerd', async () => {
  const c = client();
  const r = await c('/api/login', { method: 'POST', body: { email: 'jan@example.com', password: 'geheim' }, csrf: false });
  assert.equal(r.status, 403);
});

test('login, profiel en toestellen; token komt nooit bij de browser', async () => {
  const c = client();
  const r = await c('/api/login', { method: 'POST', body: { email: 'jan@example.com', password: 'geheim' } });
  assert.equal(r.status, 200);
  assert.match(r.cookie, /HttpOnly/);
  assert.match(r.cookie, /SameSite=Strict/);
  assert.equal(r.data.name, 'Jan Jansen');
  assert.ok(!JSON.stringify(r.data).includes('tok-jan'));
  const kinds = Object.fromEntries(r.data.devices.map((d) => [d.number, d.kind]));
  assert.deepEqual(kinds, { 310: 'phone', 510: 'app', 410: 'webphone', '+31687654321': 'fixed' });

  const me = await c('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.email, 'jan@example.com');
});

test('2FA-flow', async () => {
  const c = client();
  let r = await c('/api/login', { method: 'POST', body: { email: 'piet@example.com', password: 'geheim' } });
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'otp_required');
  r = await c('/api/login', { method: 'POST', body: { email: 'piet@example.com', password: 'geheim', otp: '000000' } });
  assert.equal(r.data.error, 'otp_invalid');
  r = await c('/api/login', { method: 'POST', body: { email: 'piet@example.com', password: 'geheim', otp: '123 456' } });
  assert.equal(r.status, 200);
  // Piet mag geen gebruikers en geen v2 VoIP-accounts zien -> klassieke phoneaccount-lijst (gepagineerd).
  const col = await c('/api/colleagues');
  assert.equal(col.data.source, 'phoneaccount');
  assert.deepEqual(col.data.items.map((u) => [u.name, u.internalNumber, u.registered]), [
    ['Kantoor 610', '610', false], ['Kantoor 611', '611', true], ['Receptie', '604', false],
  ]);
  assert.equal(col.data.items.find((u) => u.internalNumber === '610').self, true); // eigen nummer van de gebruiker
});

test('partnergebruiker wordt geweigerd', async () => {
  const c = client();
  const r = await c('/api/login', { method: 'POST', body: { email: 'partner@example.com', password: 'geheim' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'not_client_user');
});

test('contacten uit Contactbook, gesorteerd en opgeschoond', async () => {
  const c = await loggedIn();
  const r = await c('/api/contacts');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.items.map((x) => x.name), ['Anna de Vries', 'Émile Janssens', 'Gemeente Utrecht', 'Zonder Nummer']);
  const anna = r.data.items[0];
  assert.equal(anna.company, 'Bakkerij Zoet');
  assert.deepEqual(anna.numbers[1], { flat: '+31612345678', pretty: '+31 6 12345678' });
  const gemeente = r.data.items[2];
  assert.equal(gemeente.company, '');
  const auth = mock.log.findLast((l) => l.path.includes('/contactbook/')).auth;
  assert.equal(auth, 'Bearer tok-jan');
});

test("collega's", async () => {
  const c = await loggedIn();
  const r = await c('/api/colleagues');
  assert.equal(r.data.available, true);
  assert.deepEqual(r.data.items.map((u) => [u.name, u.internalNumber, u.self]), [
    ['Jan Jansen', '610', true],
    ['Kees Bakker', '611', false],
    ['Lotte Smit', '241', false], // nummer via VoIP-account van de bestemming
    ['Mo Haddou', '', false], // zonder nummer: wel tonen, niet bellen
  ]);
});

test('click-to-dial naar bureautoestel, status pollen en ophangen', async () => {
  const c = await loggedIn();
  let r = await c('/api/calls', { method: 'POST', body: { number: '+31 6 1234 5678', device: 'va:1013159' } });
  assert.equal(r.status, 201);
  const callId = r.data.callId;
  const sent = mock.log.findLast((l) => l.path === '/api/clicktodial/' && l.method === 'POST');
  assert.equal(sent.auth, 'Token jan@example.com:tok-jan');
  assert.deepEqual(sent.body, { b_number: '+31612345678', a_number: '310' });

  r = await c(`/api/calls/${callId}`);
  assert.equal(r.data.status, 'dialing_a');
  r = await c(`/api/calls/${callId}`);
  assert.equal(r.data.status, 'dialing_b');

  r = await c(`/api/calls/${callId}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal(mock.calls.get(callId).status, 'disconnected');
});

test('standaardtoestel: geen a_number meesturen', async () => {
  const c = await loggedIn();
  const r = await c('/api/calls', { method: 'POST', body: { number: '0201234567' } });
  assert.equal(r.status, 201);
  const sent = mock.log.findLast((l) => l.path === '/api/clicktodial/' && l.method === 'POST');
  assert.deepEqual(sent.body, { b_number: '0201234567' });
});

test('ongeldig nummer, onbekend toestel, geweigerd nummer', async () => {
  const c = await loggedIn();
  assert.equal((await c('/api/calls', { method: 'POST', body: { number: 'bel mij' } })).data.error, 'invalid_number');
  assert.equal((await c('/api/calls', { method: 'POST', body: { number: '0201234567', device: 'va:999' } })).data.error, 'invalid_device');
  const r = await c('/api/calls', { method: 'POST', body: { number: '+31900000000' } });
  assert.equal(r.status, 400);
  assert.equal(r.data.message, 'This number is not permitted.');
});

test('andermans gesprek opvragen kan niet', async () => {
  const a = await loggedIn();
  const call = await a('/api/calls', { method: 'POST', body: { number: '0201234567' } });
  const b = await loggedIn();
  assert.equal((await b(`/api/calls/${call.data.callId}`)).status, 404);
});

test("collega's: lege gebruikerslijst -> VoIP-accounts, zonder gevoelige velden", async () => {
  const c = await loggedIn('kim@example.com');
  const r = await c('/api/colleagues');
  assert.equal(r.data.available, true);
  assert.equal(r.data.source, 'voip-accounts');
  // inactief toestel weggelaten; eigen toestel (310) gemarkeerd
  assert.deepEqual(r.data.items.map((u) => [u.name, u.internalNumber, u.self, u.registered]), [
    ['Magazijn', '607', false, false], ['Receptie', '604', false, true], ['Yealink bureau', '310', true, false],
  ]);
  const raw = JSON.stringify(r.data);
  assert.ok(!raw.includes('192.0.2') && !raw.includes('Yealink SIP') && !raw.includes('497920001'));
});

test('toE164 en contactvalidatie', () => {
  assert.equal(toE164('06 1234 5678', 'nl'), '+31612345678');
  assert.equal(toE164('02 555 12 34', 'be'), '+3225551234');
  assert.equal(toE164('0031 20 1234567', 'nl'), '+31201234567');
  assert.equal(toE164('+44 20 7946 0958', 'nl'), '+442079460958');
  assert.equal(toE164('201', 'nl'), null);
  assert.equal(toE164('0612345678', 'xx'), null);
  assert.throws(() => contactPayload({ note: 'x' }, 'nl'), /voornaam, achternaam of bedrijfsnaam/);
  assert.throws(() => contactPayload({ givenName: 'A' }, 'nl'), /minimaal 2 tekens/);
  assert.throws(() => contactPayload({ companyName: 'X', phoneNumbers: ['abc'] }, 'nl'), /geen geldig telefoonnummer/);
  assert.deepEqual(contactPayload({ givenName: ' Sara ', phoneNumbers: ['0612345678', '+31 6 12345678', ''] }, 'nl'), {
    given_name: 'Sara', family_name: '', company_name: '', note: '',
    phone_numbers: [{ phone_number_flat: '+31612345678' }],
  });
});

test('contact toevoegen, bewerken en verwijderen', async () => {
  const c = await loggedIn();
  await c('/api/contacts'); // vult de cache

  let r = await c('/api/contacts', { method: 'POST', body: { givenName: 'Sara', familyName: 'Visser', companyName: 'Visser & Zn', phoneNumbers: ['06 11 22 33 44'] } });
  assert.equal(r.status, 201);
  assert.equal(r.data.name, 'Sara Visser');
  assert.equal(r.data.numbers[0].flat, '+31611223344');
  const sent = mock.log.findLast((l) => l.method === 'POST' && l.path.includes('/contactbook/'));
  assert.equal(sent.auth, 'Bearer tok-jan');
  assert.deepEqual(sent.body.phone_numbers, [{ phone_number_flat: '+31611223344' }]);
  const id = r.data.id;

  // cache is ververst: nieuw contact staat direct in de lijst
  r = await c('/api/contacts');
  assert.ok(r.data.items.some((x) => x.id === id));

  r = await c(`/api/contacts/${id}`, { method: 'PUT', body: { givenName: 'Sara', familyName: 'de Visser', companyName: '', phoneNumbers: ['+31 20 765 4321'] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Sara de Visser');
  assert.equal(r.data.company, '');
  assert.deepEqual(r.data.numbers.map((n) => n.flat), ['+31207654321']);

  // verwijderen zonder bevestigingsheader wordt geweigerd
  r = await c(`/api/contacts/${id}`, { method: 'DELETE' });
  assert.equal(r.status, 428);
  assert.ok(mock.contacts.some((x) => x.id === id));

  r = await c(`/api/contacts/${id}`, { method: 'DELETE', headers: { 'X-Confirm-Delete': 'yes' } });
  assert.equal(r.status, 200);
  assert.ok(!mock.contacts.some((x) => x.id === id));
  r = await c('/api/contacts');
  assert.ok(!r.data.items.some((x) => x.id === id));
});

test('contactbeheer: validatie, onbekend contact en geen rechten', async () => {
  const c = await loggedIn();
  let r = await c('/api/contacts', { method: 'POST', body: { note: 'alleen notitie' } });
  assert.equal(r.status, 400);
  r = await c('/api/contacts/00000000-0000-0000-0000-999999999999', { method: 'PUT', body: { companyName: 'X' } });
  assert.equal(r.status, 404);
  r = await c('/api/contacts/geen%20uuid%3B', { method: 'DELETE', headers: { 'X-Confirm-Delete': 'yes' } });
  assert.equal(r.status, 404);
  r = await c('/api/contacts', { method: 'POST', body: { companyName: 'X' }, csrf: false });
  assert.equal(r.status, 403);

  const piet = client();
  await piet('/api/login', { method: 'POST', body: { email: 'piet@example.com', password: 'geheim', otp: '123456' } });
  r = await piet('/api/contacts', { method: 'POST', body: { companyName: 'Test BV' } });
  assert.equal(r.status, 403);
  assert.match(r.data.message, /geen contacten aanmaken/);
});

test('ingetrokken token beëindigt de sessie', async () => {
  const c = await loggedIn();
  mock.revoke('tok-jan');
  const r = await c('/api/contacts?refresh=1');
  assert.equal(r.status, 401);
  assert.equal((await c('/api/me')).status, 401);
});

test('uitloggen', async () => {
  const c = client();
  // tok-jan is in de vorige test ingetrokken; gebruik piet (met 2FA)
  await c('/api/login', { method: 'POST', body: { email: 'piet@example.com', password: 'geheim', otp: '123456' } });
  assert.equal((await c('/api/me')).status, 200);
  assert.equal((await c('/api/logout', { method: 'POST' })).status, 200);
  assert.equal((await c('/api/me')).status, 401);
});

test('rate limiting op inlogpogingen', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 7; i++) {
    last = await c('/api/login', { method: 'POST', body: { email: 'brute@example.com', password: 'x' } });
  }
  assert.equal(last.status, 429);
});

test('PWA: manifest, service worker en iconen', async () => {
  const m = await fetch(base + '/manifest.webmanifest');
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /application\/manifest\+json/);
  const manifest = await m.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const i of manifest.icons) {
    const r = await fetch(base + i.src);
    assert.equal(r.status, 200, i.src);
    assert.equal(r.headers.get('content-type'), 'image/png');
  }
  const sw = await fetch(base + '/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.match(await sw.text(), /startsWith\('\/api\/'\)/);
  assert.equal((await fetch(base + '/apple-touch-icon.png')).status, 200);
  assert.match((await fetch(base + '/')).headers.get('content-security-policy'), /worker-src 'self'/);
});

test('debug: describeShape logt geen waarden; extractList vindt de lijst', async () => {
  const { describeShape, extractList } = await import('../src/voys.js');
  const shape = describeShape({ data: [{ name: 'Geheime Naam', email_address: 'x@y.nl', internal_number: 201 }], meta: {} });
  assert.equal(shape, '{ data: array(1) of { name: string, email_address: string, internal_number: number }, meta: {  } }');
  assert.ok(!shape.includes('Geheime') && !shape.includes('x@y.nl'));
  assert.deepEqual(extractList([1]), [1]);
  assert.deepEqual(extractList({ results: [2] }), [2]);
  assert.deepEqual(extractList({ items: [3] }), [3]);
  assert.deepEqual(extractList({ foo: 1 }), []);
});

test('footer: links, bedrijfsnaam en actueel jaartal', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /href="https:\/\/mijnvoip\.itfm\.nl"/);
  assert.match(html, /href="https:\/\/webphone\.vialer\.nl"/);
  assert.match(html, /href="https:\/\/www\.itfm\.nl"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, new RegExp(`extra dienst van IT Friese Meren B\\.V\\. &middot; <span id="footer-year">${new Date().getFullYear()}</span>`));
  assert.ok(!html.includes('{{'), 'alle placeholders ingevuld');

  const { renderTemplate } = await import('../src/server.js');
  const cfg = loadConfig({ PORTAL_URL: 'javascript:alert(1)', COMPANY_NAME: '<b>X</b>' });
  const out = renderTemplate('{{PORTAL_URL}}|{{COMPANY_NAME}}|{{YEAR}}', cfg, new Date('2031-05-01'));
  assert.equal(out, 'https://mijnvoip.itfm.nl|&lt;b&gt;X&lt;/b&gt;|2031');
});
