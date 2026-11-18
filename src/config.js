// Alle configuratie komt uit omgevingsvariabelen, met de productie-URL's van Voys als standaard.
// Bronnen: https://help.voys.nl/onze-apis en https://openapi.eu-production.holodeck.voys.nl/

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function stripSlash(url) {
  return String(url).replace(/\/+$/, '');
}

// Alleen http(s)-links toestaan, zodat een verkeerde instelling geen javascript:-link kan opleveren.
function safeUrl(value, fallback) {
  if (!value) return fallback;
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) ? u.href.replace(/\/$/, '') : fallback;
  } catch {
    return fallback;
  }
}

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',

    // Klassieke VoIPGRID-API (login, click-to-dial) en API v2 (users) draaien op hetzelfde domein.
    voysApi: stripSlash(env.VOYS_API_BASE || 'https://api.voys.nl'),
    // Nieuwere API's (Contactbook, User status).
    holodeckApi: stripSlash(env.HOLODECK_API_BASE || 'https://api.eu-production.holodeck.voys.nl'),

    // Zet op false als je lokaal zonder HTTPS test. In productie altijd true (achter een TLS-proxy).
    cookieSecure: bool(env.COOKIE_SECURE, env.NODE_ENV === 'production'),
    // Zet op true als de app achter een reverse proxy draait (voor X-Forwarded-For bij rate limiting).
    trustProxy: bool(env.TRUST_PROXY, false),

    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES || 480),
    contactsCacheSeconds: Number(env.CONTACTS_CACHE_SECONDS || 60),
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS || 10000),

    // Max. inlogpogingen per e-mailadres en per IP-adres binnen het venster.
    loginMaxAttempts: Number(env.LOGIN_MAX_ATTEMPTS || 10),
    loginMaxAttemptsPerIp: Number(env.LOGIN_MAX_ATTEMPTS_PER_IP || 50),
    loginWindowMinutes: Number(env.LOGIN_WINDOW_MINUTES || 15),

    appName: env.APP_NAME || 'Contacten & Bellen',

    // Links en naam in de footer.
    portalUrl: safeUrl(env.PORTAL_URL, 'https://mijnvoip.itfm.nl'),
    webphoneUrl: safeUrl(env.WEBPHONE_URL, 'https://webphone.vialer.nl'),
    websiteUrl: safeUrl(env.WEBSITE_URL, 'https://www.itfm.nl'),
    companyName: env.COMPANY_NAME || 'IT Friese Meren B.V.',

    // Yealink-telefoonboeken: configuratiebestand en hoe lang een telefoonboek gecachet wordt.
    phonebooksFile: env.PHONEBOOKS_FILE || 'config/phonebooks.json',
    phonebookCacheSeconds: Number(env.PHONEBOOK_CACHE_SECONDS || 300),

    // Logt per API-aanroep naar Voys de status en de vórm van het antwoord (geen waarden).
    debugUpstream: bool(env.DEBUG_UPSTREAM, false),
  };
}
