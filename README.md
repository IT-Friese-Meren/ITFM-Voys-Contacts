# Contacten & Bellen (klik-en-bel voor bureautoestellen)

Een webapp waarin een gebruiker inlogt met zijn **eigen Voys/VoIPGRID-account**, de **gedeelde contacten** ziet die ook in Vialer, de Voys-app en de Webphone staan, en met een klik **zijn eigen toestel laat overgaan**. Dat kan ook een vast bureautoestel zijn (Yealink e.d.). Neemt de gebruiker op, dan belt het platform het contact en verbindt het gesprek.

## Hoe het werkt

```
Browser --(sessiecookie)--> deze app (Node) --(API-token van de gebruiker)--> Voys-platform
                                       |
                                       +-- POST api.voys.nl/api/permission/apitoken/          inloggen (+2FA), zelfde flow als Vialer
                                       +-- GET  api.voys.nl/api/v2/users/auth-context          client_uuid / user_uuid
                                       +-- GET  api.voys.nl/api/v2/user/{uuid}/details         toestellen van de gebruiker
                                       +-- GET  holodeck.../contactbook/clients/{uuid}/contacts gedeelde contacten (Contactbook)
                                       +-- GET  api.voys.nl/api/v2/clients/{id}/users          collega's (als de gebruiker dit mag zien)
                                       +-- POST api.voys.nl/api/clicktodial/ (+ GET/DELETE)    gesprek opzetten, status volgen, ophangen

Toestel (Yealink) --(sleutel)--> deze app --(API-token servicegebruiker)--> Contactbook + collega's --> XML-telefoonboek
```

Alles gebeurt met de rechten van de ingelogde gebruiker zelf. Er is geen beheerders- of partnertoken nodig. Wat iemand in Freedom niet mag, mag hij hier ook niet.

Waarom een backend? `api.voys.nl` staat geen directe aanroepen vanuit de browser toe (geen CORS). Daarnaast blijft het API-token zo **op de server**: de browser krijgt alleen een willekeurige sessie-ID in een `HttpOnly`/`SameSite=Strict`-cookie.

Bronnen: [Voys OpenAPI-portaal](https://openapi.eu-production.holodeck.voys.nl/), [help.voys.nl/onze-apis](https://help.voys.nl/onze-apis), en de VoIPGRID-repo's [chrome-extension](https://github.com/VoIPGRID/chrome-extension), [vialer-ios](https://github.com/VoIPGRID/vialer-ios) en [vialer-android](https://github.com/VoIPGRID/vialer-android) (login- en 2FA-flow).

## Functies

- Inloggen met e-mail en wachtwoord, inclusief tweestapsverificatie (2FA)
- Gedeelde contacten uit het Contactbook, doorzoekbaar op naam, bedrijf en nummer (`06...`, `+316...` en `00316...` vinden allemaal hetzelfde)
- Kaartweergave: afhankelijk van de schermbreedte staan er meerdere contacten naast elkaar
- **Contacten beheren**: toevoegen, bewerken en verwijderen in het gedeelde Contactbook. Nationale nummers (`06...`, `020...`) worden automatisch omgezet naar internationaal formaat op basis van het land van de klant. Verwijderen vraagt **twee keer** om bevestiging ("Verwijderen?" -> "Weet je het zeker?"); de server weigert een verwijderverzoek ook zonder expliciete bevestiging. Wijzigingen zijn direct zichtbaar in Vialer, de Webphone en op de toestellen. Of iemand mag beheren, bepalen de rechten van zijn Voys-account
- Tabblad **Collega's**. Het toestelnummer komt van de gebruiker zelf of van het VoIP-account van de gekozen bestemming; collega's zonder nummer worden wel getoond, maar zijn niet te bellen. Het tabblad verschijnt alleen als de gebruiker de gebruikerslijst mag zien
- **Bel via**: kies het toestel dat moet overgaan (bureautoestel, vast nummer, webphone of app). De keuze wordt per browser onthouden; standaard is dat het eerste bureautoestel. *Standaard (klik-en-bel-instelling)* gebruikt wat in Freedom is ingesteld
- Live gespreksstatus (toestel gaat over -> contact wordt gebeld -> verbonden) met een knop **Ophangen**
- Vrij nummer intypen en bellen
- Licht en donker thema, werkt ook op mobiel

## Lokaal draaien

Je hebt Node.js 20 of hoger nodig. Er zijn geen npm-dependencies.

```bash
# Tegen het echte Voys-platform:
COOKIE_SECURE=false npm start
# -> http://localhost:3000

# Of met de nagebootste API (zonder echte account):
npm run mock                     # terminal 1, poort 4010
COOKIE_SECURE=false VOYS_API_BASE=http://localhost:4010 HOLODECK_API_BASE=http://localhost:4010 npm start   # terminal 2
# Testaccounts: jan@example.com / geheim   en   piet@example.com / geheim (2FA-code 123456)
```

Tests (backend met nagebootste Voys-API):

```bash
npm test
```

## Productie

```bash
docker build -t contacten-bellen .
docker run -d -p 3000:3000 -e TRUST_PROXY=true --name contacten-bellen contacten-bellen
```

Zet er een reverse proxy met HTTPS voor (Caddy, nginx, Traefik). `COOKIE_SECURE=true` is in de image al de standaard. Alle instellingen staan in [`.env.example`](.env.example).

**Let op:** sessies worden in het geheugen bewaard. Na een herstart moeten gebruikers opnieuw inloggen. Draai een instantie, of vervang `SessionStore` in `src/sessions.js` door Redis als je wilt opschalen.

## Installeren als app (PWA)

De app is een Progressive Web App: hij heeft een manifest, een service worker en app-iconen. Via **HTTPS** (of op `localhost`) kun je hem installeren:

- **Windows/macOS (Chrome, Edge):** het installatie-icoon in de adresbalk, of menu -> *App installeren*. De app opent daarna in een eigen venster, zonder browserbalk.
- **Android (Chrome):** menu -> *Toevoegen aan startscherm* / *App installeren*.
- **iPhone/iPad (Safari):** deelknop -> *Zet op beginscherm*.

Op een gewoon `http://`-adres (bijv. `http://192.168.x.x:3000`) werkt installeren **niet**, omdat browsers dan geen service worker toestaan. Dat is een beveiligingsregel van de browser.

Offline laadt de app-schil gewoon, met de melding dat je verbinding nodig hebt. Contacten en sessiegegevens worden bewust **niet** in de browser gecachet; bellen vraagt sowieso verbinding met het platform. De naam van de geinstalleerde app volgt `APP_NAME`.

Na een update ziet de geinstalleerde app de nieuwe versie bij de eerstvolgende start (network-first).

## Yealink-telefoonboek (Remote Phone Book)

Per klant levert de app een XML-telefoonboek in Yealink-formaat. Het bevat de gedeelde contacten uit het Contactbook (groep **Contacten**) en de interne nummers van collega's (groep **Collega's**). Het toestel haalt het periodiek op en toont het onder *Directory*. Met *lookup* aan toont het toestel bij binnenkomende gesprekken ook de naam.

### Per klant instellen

1. **Servicegebruiker:** maak in het VoIP-platform een gebruiker aan, bijvoorbeeld "Telefoonboek", en vraag zijn **API-token** en **client_uuid** op. Kan deze gebruiker de gebruikerslijst zien, dan komen er ook collega's in het telefoonboek.
2. **Sleutel maken:**
   ```bash
   npm run phonebook:key
   ```
3. **Configuratie:** voeg de klant toe aan `config/phonebooks.json`. Kopieer daarvoor `config/phonebooks.example.json` en beveilig het bestand met `chmod 600 config/phonebooks.json`:
   ```json
   {
     "phonebooks": [
       {
         "name": "Voorbeeld BV",
         "title": "Voorbeeld BV",
         "key": "<uitvoer van phonebook:key>",
         "apiToken": "<API-token van de servicegebruiker>",
         "clientUuid": "<client_uuid van de klant>",
         "colleagues": true,
         "showCompany": true,
         "numberFormat": "e164",
         "allowedIps": ["203.0.113.10"]
       }
     ]
   }
   ```
   | Veld | Betekenis |
   |---|---|
   | `name` | Interne naam, voor de logs en `phonebook:check` |
   | `title` | Titel op het toestel (standaard gelijk aan `name`) |
   | `key` | Geheime sleutel die het toestel meestuurt (32-128 tekens) |
   | `apiToken` / `apiTokenEnv` | Het token zelf, of de naam van een omgevingsvariabele waarin het staat |
   | `clientUuid` | De klant. De server controleert dat het token bij deze klant hoort en levert anders niets |
   | `colleagues` | Groep "Collega's" met interne nummers tonen (standaard `true`) |
   | `showCompany` | "Naam - Bedrijf" als weergavenaam (standaard `true`) |
   | `numberFormat` | `e164` (`+31201234567`, standaard) of `national` (`0201234567`, buitenland als `0032...`) |
   | `allowedIps` | Optioneel: alleen deze IP-adressen of IPv4-bereiken (CIDR) mogen het ophalen, bijv. het publieke IP van het kantoor |
   | `contactsGroup` / `colleaguesGroup` | Andere namen voor de groepen (standaard "Contacten" / "Collega's") |

   Het bestand wordt **zonder herstart** opnieuw ingelezen zodra het wijzigt. Bevat het een fout, dan blijft de vorige geldige versie actief en verschijnt de fout in de log.
4. **Controleren:**
   ```bash
   npm run phonebook:check              # alle klanten
   npm run phonebook:check "Voorbeeld BV"
   # OK Voorbeeld BV: 147 contacten, 10 collega's (...)
   ```

### Yealink provisionen

Er zijn twee manieren om de sleutel mee te sturen.

**A. Sleutel in de URL:** werkt op elke firmware.
```ini
remote_phonebook.data.1.url = https://bellen.itfm.nl/yealink/<sleutel>/phonebook.xml
remote_phonebook.data.1.name = Contacten
features.remote_phonebook.enable = 1
features.remote_phonebook.flash_time = 3600
```

**B. Sleutel als wachtwoord (HTTP Basic):** dan staat de sleutel niet in de access-logs van de proxy. Dit vereist firmware die gebruikersnaam en wachtwoord voor het remote phonebook ondersteunt.
```ini
remote_phonebook.data.1.url = https://bellen.itfm.nl/yealink/phonebook.xml
remote_phonebook.data.1.username = toestel
remote_phonebook.data.1.password = <sleutel>
remote_phonebook.data.1.name = Contacten
features.remote_phonebook.enable = 1
features.remote_phonebook.flash_time = 3600
```

- `features.remote_phonebook.enable = 1` zet het opzoeken van namen bij in- en uitgaande gesprekken aan.
- `flash_time` is het verversinterval in seconden. Op veel modellen is het minimum 3600.
- **Controleer de parameternamen en toegestane waarden in de Yealink Admin Guide van jullie modellen en firmware**, want die verschillen per serie.
- Handmatig instellen kan ook in de webinterface van het toestel, onder *Directory -> Remote Phone Book*.

Naamherkenning bij binnenkomende gesprekken werkt alleen als het nummer precies overeenkomt met wat het platform als beller-ID meestuurt. Komt er bijvoorbeeld `0612345678` binnen terwijl het telefoonboek `+31612345678` bevat, kies dan `"numberFormat": "national"`.

### Beveiliging en gedrag

- **Token blijft op de server:** het API-token gaat nooit naar het toestel. Het toestel kent alleen de sleutel. Een gelekte sleutel trek je in door een nieuwe te maken; het Voys-token blijft dan geldig.
- **Geen informatie lekken:** een onbekende sleutel geeft een `404`, zonder te verraden of de functie aan staat.
- **Beperkingen:** het IP-filter is per klant instelbaar, en er geldt een limiet van 120 verzoeken per minuut per klant.
- **Cache en storingen:** telefoonboeken worden `PHONEBOOK_CACHE_SECONDS` lang gecachet (standaard 300), zodat veel toestellen tegelijk Voys niet belasten. Mislukt het verversen, dan levert de server de laatste goede versie, zodat toestellen geen leeg telefoonboek krijgen.
- **Weglaten:** contacten zonder telefoonnummer en collega's zonder toestelnummer staan er niet in. Een contact met meer dan 3 nummers krijgt extra regels ("Naam (2)").
- **Docker:** mount het bestand, bijvoorbeeld `-v /pad/phonebooks.json:/app/config/phonebooks.json:ro`. De container draait als gebruiker `node` (uid 1000), dus die moet het bestand kunnen lezen. Het bestand staat in `.gitignore` en `.dockerignore`.

## Huisstijl en footer

Kleuren, lettertypen (Poppins en Play) en logo's komen van [itfm.nl](https://www.itfm.nl). Lettertypen en logo's staan in `public/fonts` en `public/brand` en worden door de app zelf geserveerd. Er worden dus geen externe bronnen geladen. De footer toont links naar het VoIP-platform, de Webphone en de website, plus "Deze app is een extra dienst van IT Friese Meren B.V. - <jaartal>". Het jaartal wordt automatisch bepaald. Aanpassen kan via `PORTAL_URL`, `WEBPHONE_URL`, `WEBSITE_URL` en `COMPANY_NAME`.

## Debuggen

Start met `DEBUG_UPSTREAM=1` om per aanroep naar Voys de status en de **vorm** van het antwoord te loggen: veldnamen, types en aantallen, nooit de waarden. UUID's en ID's in paden worden gemaskeerd. Voorbeeld:

```
[upstream] GET api.voys.nl/api/v2/clients/<id>/users -> 200 { data: array(0), meta: {  } }
[collega's] bron gebruikers: 0 ontvangen, 0 met toestelnummer
[collega's] bron voip-accounts: 12 ontvangen, 12 met toestelnummer
```

Collega's komen uit de eerste bron die iets oplevert: gebruikers (v2) -> VoIP-accounts (v2) -> de klassieke phoneaccount-lijst (die ook de Klik-en-bel-extensie gebruikt). Welke bron werkt, hangt af van de rechten van het account.

## Vereisten aan de Voys-kant

- De gebruiker is een **klantgebruiker**. Partneraccounts mogen geen click-to-dial gebruiken, en de app geeft dan een duidelijke melding.
- Het gekozen toestel is een VoIP-account dat aan de gebruiker gekoppeld is (in Freedom: gebruiker -> bestemmingen). Bureautoestellen die daar staan, verschijnen automatisch onder **Bel via**.
- Voor bureautoestellen met *auto answer*: dat bepaalt de klik-en-bel-instelling van de gebruiker in Freedom.

## Beveiliging

- Het API-token verlaat de server nooit en wordt niet gelogd.
- Sessiecookie `HttpOnly`, `SameSite=Strict` en `Secure` (in productie). Sessies verlopen na inactiviteit.
- CSRF: naast SameSite moeten alle muterende verzoeken een `X-Requested-With`-header hebben.
- Rate limiting op inlogpogingen, per e-mailadres en per IP.
- Strikte Content-Security-Policy (geen inline scripts, geen externe bronnen), `X-Frame-Options: DENY`.
- Gebruikers kunnen alleen de status van hun eigen gesprekken opvragen en ophangen.
- Als Voys het token weigert (bijvoorbeeld na een wachtwoordwijziging), wordt de sessie direct beeindigd.

## Projectstructuur

```
src/index.js       opstarten
src/config.js      configuratie via omgevingsvariabelen
src/server.js      HTTP-server, routes, sessies, beveiliging
src/voys.js        client voor de Voys/VoIPGRID-API's
src/sessions.js    sessie-opslag en rate limiter
public/            frontend (HTML/CSS/JS, zonder build-stap)
test/              tests + nagebootste Voys-API (test/mock-voys.js)
```

## Mogelijke uitbreidingen

- Beschikbaarheid van collega's tonen via de *User status* API (`holodeck.../user-status`)
- Contacten toevoegen of bewerken (het Contactbook ondersteunt POST, PUT en DELETE)
- Gespreksgeschiedenis via `GET /api/v2/call/personalized/`
- Gespreksnotificaties (webhook) in plaats van polling voor de status
