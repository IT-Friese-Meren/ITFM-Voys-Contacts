#!/usr/bin/env node
// Beheer van de Yealink-telefoonboeken.
//   npm run phonebook:key            -> nieuwe willekeurige sleutel voor een klant
//   npm run phonebook:check [naam]   -> controleert de configuratie en haalt elk telefoonboek één keer op
import { loadConfig } from './config.js';
import { createVoysClient } from './voys.js';
import { createPhonebookService, generateKey } from './phonebook.js';

const [cmd, filter] = process.argv.slice(2);
const config = loadConfig();

if (cmd === 'key') {
  console.log(generateKey());
  process.exit(0);
}

if (cmd === 'check') {
  const quiet = { info: () => {}, warn: (m) => console.warn(m), error: (m) => console.error(m) };
  const voys = createVoysClient({ voysApi: config.voysApi, holodeckApi: config.holodeckApi, timeoutMs: config.upstreamTimeoutMs });
  const service = createPhonebookService({ voys, file: config.phonebooksFile, cacheSeconds: 0, log: quiet });
  const entries = service.entries().filter((e) => !filter || e.name === filter);
  if (!entries.length) {
    console.error(`Geen telefoonboeken gevonden in ${config.phonebooksFile}${filter ? ` met naam "${filter}"` : ''}.`);
    process.exit(1);
  }
  let failed = 0;
  for (const entry of entries) {
    try {
      const { counts, xml } = await service.getPhonebook(entry);
      console.log(`✔ ${entry.name}: ${counts.contacts} contacten, ${counts.colleagues} collega's (${Buffer.byteLength(xml)} bytes, nummers: ${entry.numberFormat}${entry.allowedIps.length ? `, IP-filter: ${entry.allowedIps.join(' ')}` : ''})`);
    } catch (err) {
      failed++;
      console.error(`✖ ${entry.name}: ${err.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

console.log(`Gebruik:
  npm run phonebook:key            Maak een nieuwe sleutel voor een klant
  npm run phonebook:check [naam]   Controleer de configuratie (${config.phonebooksFile})`);
process.exit(cmd ? 1 : 0);
