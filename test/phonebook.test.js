import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMockVoys } from './mock-voys.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import {
  renderYealinkXml, formatNumber, ipAllowed, parsePhonebookConfig, PhonebookConfigError, generateKey,
} from '../src/phonebook.js';

const CLIENT_UUID = 'b2a1430d-00fc-40c2-9882-93eab4df58fe';
const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);
const KEY_IP = 'c'.repeat(40);
const KEY_WRONG = 'd'.repeat(40);
const KEY_STALE = 'e'.repeat(40);

let mock, app, base, dir, file;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function writeConfig(phonebooks) {
  writeFileSync(file, JSON.stringify({ phonebooks }));
  chmodSync(file, 0o600);
}

const baseBooks = () => [
  { name: 'Klant A', title: 'Klant A & Co', key: KEY_A, apiToken: 'tok-jan', clientUuid: CLIENT_UUID },
  { name: 'Klant B', key: KEY_B, apiTokenEnv: 'PB_TOKEN_B', clientUuid: CLIENT_UUID, colleagues: false, numberFormat: 'national', showCompany: false },
  { name: 'Alleen kantoor', key: KEY_IP, apiToken: 'tok-jan', clientUuid: CLIENT_UUID, allowedIps: ['10.0.0.0/8'] },
  { name: 'Verkeerde klant', key: KEY_WRONG, apiToken: 'tok-jan', clientUuid: '99999999-9999-9999-9999-999999999999' },
  { name: 'Wordt ingetrokken', key: KEY_STALE, apiToken: 'tok-kim', clientUuid: CLIENT_UUID },
];

before(async () => {
  process.env.PB_TOKEN_B = 'tok-jan';
  dir = mkdtempSync(path.join(tmpdir(), 'phonebook-test-'));
  file = path.join(dir, 'phonebooks.json');
  writeConfig(baseBooks());
  mock = createMockVoys();
  const mockBase = await listen(mock.server);
  // cache 0: elk verzoek haalt opnieuw op (behalve bij een fout: dan de vorige versie)
  app = createApp(loadConfig({ VOYS_API_BASE: mockBase, HOLODECK_API_BASE: mockBase, PHONEBOOKS_FILE: file, PHONEBOOK_CACHE_SECONDS: '0' }));
  base = await listen(app);
});

after(() => {
  app.closeAllConnections(); app.close();
  mock.server.closeAllConnections(); mock.server.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (p, headers = {}) => fetch(base + p, { headers });

test('XML: escaping, groepen en max. 3 nummers per regel', () => {
  const xml = renderYealinkXml({
    title: 'A & B',
    groups: [
      { name: 'Contacten', entries: [{ name: 'Jan "JJ" <de Vries>', numbers: ['1', '2', '3', '4'] }] },
      { name: 'Leeg', entries: [] },
    ],
  });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<YealinkIPPhoneBook>/);
  assert.match(xml, /<Title>A &amp; B<\/Title>/);
  assert.match(xml, /<Unit Name="Jan &quot;JJ&quot; &lt;de Vries&gt;" Phone1="1" Phone2="2" Phone3="3"/);
  assert.match(xml, /<Unit Name="Jan &quot;JJ&quot; &lt;de Vries&gt; \(2\)" Phone1="4" Phone2="" Phone3=""/);
  assert.ok(!xml.includes('Name="Leeg"'), 'lege groep weggelaten');
});

test('nummerformaat en IP-filter', () => {
  assert.equal(formatNumber('+31612345678', 'national', 'nl'), '0612345678');
  assert.equal(formatNumber('+3225551234', 'national', 'nl'), '003225551234');
  assert.equal(formatNumber('+31612345678', 'e164', 'nl'), '+31612345678');
  assert.equal(formatNumber('611', 'national', 'nl'), '611');
  assert.ok(ipAllowed('10.1.2.3', ['10.0.0.0/8']));
  assert.ok(ipAllowed('::ffff:203.0.113.10', ['203.0.113.10']));
  assert.ok(!ipAllowed('11.0.0.1', ['10.0.0.0/8']));
  assert.ok(ipAllowed('anything', []));
});

test('configuratie wordt gevalideerd', () => {
  const ok = { name: 'X', key: KEY_A, apiToken: 't', clientUuid: CLIENT_UUID };
  assert.equal(parsePhonebookConfig({ phonebooks: [ok] }).length, 1);
  assert.throws(() => parsePhonebookConfig({ phonebooks: [{ ...ok, key: 'kort' }] }), PhonebookConfigError);
  assert.throws(() => parsePhonebookConfig({ phonebooks: [{ ...ok, clientUuid: 'nee' }] }), /clientUuid/);
  assert.throws(() => parsePhonebookConfig({ phonebooks: [{ ...ok, apiToken: undefined, apiTokenEnv: 'BESTAAT_NIET' }] }, {}), /BESTAAT_NIET/);
  assert.throws(() => parsePhonebookConfig({ phonebooks: [ok, { ...ok, name: 'Y' }] }), /dubbel/);
  assert.throws(() => parsePhonebookConfig({ phonebooks: [{ ...ok, allowedIps: ['999.1.1.1'] }] }), /IP/);
  assert.match(generateKey(), /^[A-Za-z0-9_-]{43}$/);
});

test('telefoonboek met contacten en collega\'s', async () => {
  const r = await get(`/yealink/${KEY_A}/phonebook.xml`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/xml/);
  const xml = await r.text();
  assert.match(xml, /<Title>Klant A &amp; Co<\/Title>/);
  assert.match(xml, /<Menu Name="Contacten">/);
  assert.match(xml, /<Unit Name="Anna de Vries - Bakkerij Zoet" Phone1="\+31201234567" Phone2="\+31612345678"/);
  assert.ok(!xml.includes('Zonder Nummer'), 'contact zonder nummer weggelaten');
  assert.match(xml, /<Menu Name="Collega's">/);
  assert.match(xml, /<Unit Name="Kees Bakker" Phone1="611"/);
  assert.match(xml, /<Unit Name="Lotte Smit" Phone1="241"/);
  assert.ok(!xml.includes('Mo Haddou'), 'collega zonder toestelnummer weggelaten');
  // de servicegebruiker gebruikt Bearer-auth; het token komt nooit in de XML
  assert.ok(!xml.includes('tok-jan'));
});

test('opties: nationaal formaat, zonder bedrijf, zonder collega\'s, token uit omgevingsvariabele', async () => {
  const xml = await (await get(`/yealink/${KEY_B}/phonebook.xml`)).text();
  assert.match(xml, /<Unit Name="Anna de Vries" Phone1="0201234567" Phone2="0612345678"/);
  assert.match(xml, /Phone1="003225551234"/);
  assert.ok(!xml.includes('Collega'));
});

test('sleutel via HTTP Basic (niet in de URL)', async () => {
  let r = await get('/yealink/phonebook.xml');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /Basic/);
  r = await get('/yealink/phonebook.xml', { Authorization: `Basic ${Buffer.from(`toestel:${KEY_A}`).toString('base64')}` });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Anna de Vries/);
});

test('onbekende sleutel, IP-filter en verkeerde klant', async () => {
  assert.equal((await get(`/yealink/${'z'.repeat(40)}/phonebook.xml`)).status, 404);
  assert.equal((await get('/yealink/kort/phonebook.xml')).status, 404);
  assert.equal((await get(`/yealink/${KEY_IP}/phonebook.xml`)).status, 403);
  // token hoort niet bij de geconfigureerde client_uuid -> nooit andermans contacten leveren
  assert.equal((await get(`/yealink/${KEY_WRONG}/phonebook.xml`)).status, 503);
});

test('bij een storing levert de server de laatste goede versie', async () => {
  let r = await get(`/yealink/${KEY_STALE}/phonebook.xml`);
  assert.equal(r.status, 200);
  const first = await r.text();
  mock.revoke('tok-kim');
  r = await get(`/yealink/${KEY_STALE}/phonebook.xml`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), first);
});

test('configuratie wordt zonder herstart opnieuw geladen', async () => {
  const NEW = 'f'.repeat(40);
  assert.equal((await get(`/yealink/${NEW}/phonebook.xml`)).status, 404);
  await new Promise((r) => setTimeout(r, 20)); // ander mtime
  writeConfig([...baseBooks(), { name: 'Nieuw', key: NEW, apiToken: 'tok-jan', clientUuid: CLIENT_UUID }]);
  assert.equal((await get(`/yealink/${NEW}/phonebook.xml`)).status, 200);
  // een kapot bestand houdt de vorige configuratie actief
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(file, '{ kapot');
  assert.equal((await get(`/yealink/${NEW}/phonebook.xml`)).status, 200);
});
