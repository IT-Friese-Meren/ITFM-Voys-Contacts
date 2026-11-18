import { loadConfig } from './config.js';
import { createApp } from './server.js';

const config = loadConfig();
const server = createApp(config);

server.listen(config.port, config.host, () => {
  console.log(`${config.appName} draait op http://${config.host}:${config.port}`);
  console.log(`Voys API: ${config.voysApi} | Holodeck API: ${config.holodeckApi}`);
  const books = server.phonebooks?.entries() ?? [];
  console.log(books.length
    ? `Yealink-telefoonboek: ${books.length} klant(en) geconfigureerd (${config.phonebooksFile})`
    : `Yealink-telefoonboek: uit (geen klanten in ${config.phonebooksFile})`);
  if (!config.cookieSecure) {
    console.warn('Let op: COOKIE_SECURE staat uit. Gebruik dit alleen lokaal; zet het in productie aan (achter HTTPS).');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
