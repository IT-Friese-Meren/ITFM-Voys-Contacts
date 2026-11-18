'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const DEVICE_KEY = 'vcd.device';
  const MAX_RENDER = 300;
  const POLL_MS = 1500;
  const POLL_MAX_MS = 3 * 60_000;

  const DEVICE_KIND = {
    phone: 'Toestel',
    app: 'App',
    webphone: 'Webphone',
    fixed: 'Vast nummer',
  };

  const STATUS = {
    null: ['Gesprek wordt opgezet…', 'busy'],
    dialing_a: ['Je toestel gaat over', 'busy', 'Neem op om {name} te bellen.'],
    confirm: ['Bevestig op je toestel', 'busy', 'Druk op de toets die je hoort om {name} te bellen.'],
    dialing_b: ['{name} wordt gebeld…', 'busy'],
    connected: ['Verbonden met {name}', 'ok'],
    disconnected: ['Gesprek beëindigd', 'done'],
    failed_a: ['Je toestel werd niet bereikt', 'fail', 'Bezet, niet opgenomen of niet beschikbaar.'],
    failed_b: ['{name} werd niet bereikt', 'fail', 'Bezet, niet opgenomen of niet beschikbaar.'],
    blacklisted: ['Gesprek geblokkeerd', 'fail', 'Je toestel heeft deze oproep geweigerd.'],
  };
  const FINAL = new Set(['disconnected', 'failed_a', 'failed_b', 'blacklisted']);

  const state = {
    me: null,
    tab: 'contacts',
    data: { contacts: [], colleagues: [] },
    loaded: { contacts: false, colleagues: false },
    colleaguesAvailable: false,
    call: null,
  };

  // ---------- API ----------

  async function api(path, { method = 'GET', body, headers: extra = {} } = {}) {
    const headers = { Accept: 'application/json', ...extra };
    if (method !== 'GET') headers['X-Requested-With'] = 'fetch';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
    } catch {
      throw Object.assign(new Error('Geen verbinding met de server.'), { code: 'network' });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || `Fout (HTTP ${res.status})`);
      err.code = data.error;
      err.status = res.status;
      if (res.status === 401 && data.error === 'not_logged_in' && state.me) showLogin('Je sessie is verlopen. Log opnieuw in.');
      throw err;
    }
    return data;
  }

  // ---------- helpers ----------

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c) node.append(c);
    return node;
  }

  function initials(name) {
    const parts = name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  const digits = (s) => String(s).replace(/\D/g, '');

  function fold(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  // Zoeken op naam/bedrijf, maar ook op nummer in elk formaat (06…, +316…, 0031…).
  function matches(item, q) {
    if (!q) return true;
    const text = fold([item.name, item.company, item.email, item.internalNumber].filter(Boolean).join(' '));
    const words = fold(q).split(/\s+/).filter(Boolean);
    if (words.every((w) => text.includes(w))) return true;
    const qd = digits(q);
    if (qd.length < 2) return false;
    const variants = new Set([qd, qd.replace(/^00/, ''), qd.replace(/^0(?!0)/, '31')]);
    const nums = (item.numbers || []).map((n) => digits(n.flat)).concat(item.internalNumber ? [item.internalNumber] : []);
    return nums.some((n) => [...variants].some((v) => n.includes(v)));
  }

  // ---------- views ----------

  function showLogin(message) {
    state.me = null;
    stopPolling();
    $('app-view').hidden = true;
    $('call-panel').hidden = true;
    $('login-view').hidden = false;
    setOtpStep(false);
    $('password').value = '';
    setLoginError(message);
    $('email').focus();
  }

  function setLoginError(message) {
    $('login-error').textContent = message || '';
    $('login-error').hidden = !message;
  }

  function setOtpStep(on) {
    $('otp-step').hidden = !on;
    $('credentials-step').hidden = on;
    $('login-submit').textContent = on ? 'Bevestigen' : 'Inloggen';
    if (on) { $('otp').value = ''; $('otp').focus(); }
  }

  function showApp(me) {
    state.me = me;
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    $('user-name').textContent = me.name;
    $('user-meta').textContent = [me.internalNumber && `toestel ${me.internalNumber}`, me.clientName].filter(Boolean).join(' · ');
    renderDevices(me.devices);
    loadTab('contacts');
    loadColleaguesTab();
  }

  function renderDevices(devices) {
    const select = $('device-select');
    select.replaceChildren(el('option', { value: '', text: 'Standaard (klik-en-bel-instelling)' }));
    const groups = {};
    for (const d of devices) (groups[d.kind] ||= []).push(d);
    for (const kind of ['phone', 'fixed', 'webphone', 'app']) {
      if (!groups[kind]) continue;
      const og = el('optgroup', { label: DEVICE_KIND[kind] });
      for (const d of groups[kind]) {
        og.append(el('option', {
          value: d.id,
          text: `${d.label} (${d.number})${d.active ? '' : ' – inactief'}`,
        }));
      }
      select.append(og);
    }
    // Voorkeur: eerder gekozen toestel, anders het eerste actieve bureautoestel.
    let saved = '';
    try { saved = localStorage.getItem(DEVICE_KEY) || ''; } catch { /* geen opslag */ }
    const firstDesk = devices.find((d) => d.kind === 'phone' && d.active);
    const pick = devices.some((d) => d.id === saved) ? saved : (firstDesk?.id || '');
    select.value = pick;
  }

  function setTab(tab) {
    state.tab = tab;
    for (const btn of document.querySelectorAll('.tab')) {
      btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
    }
    $('new-contact').hidden = tab !== 'contacts';
    renderList();
  }

  function updateCounts() {
    $('count-contacts').textContent = state.loaded.contacts ? String(state.data.contacts.length) : '';
    $('count-colleagues').textContent = state.loaded.colleagues ? String(state.data.colleagues.length) : '';
  }

  async function loadTab(tab, refresh = false) {
    const path = tab === 'contacts' ? '/api/contacts' : '/api/colleagues';
    if (!state.loaded[tab] || refresh) {
      if (state.tab === tab) showListMessage('Laden…');
      try {
        const data = await api(path + (refresh ? '?refresh=1' : ''));
        state.data[tab] = data.items || [];
        state.loaded[tab] = true;
      } catch (err) {
        if (state.tab === tab) showListMessage(err.message);
        return;
      }
    }
    updateCounts();
    if (state.tab === tab) renderList();
  }

  async function loadColleaguesTab() {
    try {
      const data = await api('/api/colleagues');
      state.colleaguesAvailable = data.available;
      state.data.colleagues = data.items || [];
      state.loaded.colleagues = true;
      $('tab-colleagues').hidden = !data.available;
      updateCounts();
      if (state.tab === 'colleagues') renderList();
    } catch {
      $('tab-colleagues').hidden = true;
    }
  }

  function showListMessage(text) {
    $('list').replaceChildren();
    $('list-message').textContent = text;
    $('list-message').hidden = !text;
  }

  function renderList() {
    const q = $('search').value.trim();
    const all = state.data[state.tab];
    const items = all.filter((i) => matches(i, q));

    if (!state.loaded[state.tab]) return showListMessage('Laden…');
    if (!all.length) {
      return showListMessage(state.tab === 'contacts'
        ? 'Er staan nog geen gedeelde contacten in het adresboek van je organisatie.'
        : "Geen collega's gevonden.");
    }
    if (!items.length) return showListMessage(`Niets gevonden voor “${q}”.`);

    const frag = document.createDocumentFragment();
    for (const item of items.slice(0, MAX_RENDER)) frag.append(state.tab === 'contacts' ? contactCard(item) : colleagueCard(item));
    $('list').replaceChildren(frag);
    $('list-message').hidden = items.length <= MAX_RENDER;
    $('list-message').textContent = `Eerste ${MAX_RENDER} van ${items.length} resultaten — verfijn je zoekopdracht.`;
  }

  function callButton(number, label, name) {
    return el('button', {
      type: 'button',
      class: 'num',
      title: `Bel ${name} op ${label}`,
      onclick: () => startCall(number, name, label),
    }, el('span', { class: 'phone-ico', 'aria-hidden': 'true', text: '☎' }), el('span', { text: label }));
  }

  function cardHead(avatarClass, name, sub, action) {
    return el('div', { class: 'card-head' },
      el('span', { class: `avatar ${avatarClass}`, 'aria-hidden': 'true', text: initials(name) }),
      el('div', { class: 'meta' },
        el('div', { class: 'name', text: name, title: name }),
        sub ? el('div', { class: 'muted small sub', text: sub, title: sub }) : null),
      action);
  }

  function contactCard(c) {
    const edit = el('button', {
      type: 'button', class: 'ghost icon edit', title: `${c.name} bewerken`, 'aria-label': `${c.name} bewerken`,
      onclick: () => openEditor(c),
    }, el('span', { 'aria-hidden': 'true', text: '✎' }));
    return el('li', { class: 'contact-card' },
      cardHead('', c.name, c.company, edit),
      c.note ? el('p', { class: 'note small muted', text: c.note }) : null,
      c.numbers.length
        ? el('div', { class: 'nums' }, ...c.numbers.map((n) => callButton(n.flat, n.pretty, c.name)))
        : el('p', { class: 'muted small empty', text: 'Geen telefoonnummer' }));
  }

  function colleagueCard(u) {
    let numbers;
    if (u.self) numbers = el('p', { class: 'muted small empty', text: u.internalNumber ? `Jouw toestel ${u.internalNumber}` : 'Dit ben jij' });
    else if (u.internalNumber) numbers = el('div', { class: 'nums' }, callButton(u.internalNumber, `Toestel ${u.internalNumber}`, u.name));
    else numbers = el('p', { class: 'muted small empty', text: 'Geen toestelnummer' });
    const presence = u.registered === undefined ? null
      : el('span', { class: `presence ${u.registered ? 'on' : 'off'}`, title: u.registered ? 'Toestel is aangemeld' : 'Toestel is niet aangemeld',
        text: u.registered ? 'Aangemeld' : 'Niet aangemeld' });
    return el('li', { class: 'contact-card' },
      cardHead('alt', u.self ? `${u.name} (jij)` : u.name, u.email || (u.internalNumber ? `Toestel ${u.internalNumber}` : ''), presence),
      numbers);
  }

  // ---------- contact toevoegen / bewerken / verwijderen ----------

  let editing = null; // het contact dat bewerkt wordt, of null bij een nieuw contact

  function numberField(value = '') {
    const input = el('input', { type: 'tel', value, placeholder: 'bijv. 0201234567 of +31201234567', 'aria-label': 'Telefoonnummer', autocomplete: 'off' });
    const row = el('div', { class: 'phone-row' }, input,
      el('button', {
        type: 'button', class: 'ghost icon', title: 'Nummer verwijderen', 'aria-label': 'Nummer verwijderen',
        onclick: () => { row.remove(); if (!$('cf-numbers').children.length) $('cf-numbers').append(numberField()); },
      }, el('span', { 'aria-hidden': 'true', text: '✕' })));
    return row;
  }

  function setFormError(msg) {
    $('cf-error').textContent = msg || '';
    $('cf-error').hidden = !msg;
  }

  function openEditor(contact = null) {
    editing = contact;
    $('contact-dialog-title').textContent = contact ? 'Contact bewerken' : 'Nieuw contact';
    $('cf-given').value = contact?.givenName || '';
    $('cf-family').value = contact?.familyName || '';
    $('cf-company').value = contact?.companyName || '';
    $('cf-note').value = contact?.note || '';
    const nums = contact?.numbers?.length ? contact.numbers.map((n) => n.flat) : [''];
    $('cf-numbers').replaceChildren(...nums.map((n) => numberField(n)));
    $('cf-delete').hidden = !contact;
    setFormError('');
    $('contact-dialog').showModal();
    $('cf-given').focus();
  }

  function closeEditor() {
    $('contact-dialog').close();
    editing = null;
  }

  function replaceContact(updated, removedId) {
    let list = state.data.contacts.filter((c) => c.id !== (removedId || updated?.id));
    if (updated) list.push(updated);
    list.sort((a, b) => a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' }));
    state.data.contacts = list;
    updateCounts();
    renderList();
  }

  $('contact-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError('');
    const body = {
      givenName: $('cf-given').value,
      familyName: $('cf-family').value,
      companyName: $('cf-company').value,
      note: $('cf-note').value,
      phoneNumbers: [...$('cf-numbers').querySelectorAll('input')].map((i) => i.value).filter((v) => v.trim()),
    };
    if (!body.givenName.trim() && !body.familyName.trim() && !body.companyName.trim()) {
      return setFormError('Vul minimaal een voornaam, achternaam of bedrijfsnaam in.');
    }
    const btn = $('cf-save');
    btn.disabled = true;
    try {
      const saved = editing
        ? await api(`/api/contacts/${encodeURIComponent(editing.id)}`, { method: 'PUT', body })
        : await api('/api/contacts', { method: 'POST', body });
      replaceContact(saved);
      closeEditor();
    } catch (err) {
      setFormError(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  for (const b of document.querySelectorAll('#contact-dialog [data-close]')) b.addEventListener('click', closeEditor);
  $('cf-add-number').addEventListener('click', () => {
    const row = numberField();
    $('cf-numbers').append(row);
    row.querySelector('input').focus();
  });
  $('new-contact').addEventListener('click', () => openEditor(null));
  $('contact-dialog').addEventListener('close', () => { editing = null; });

  // Verwijderen in twee stappen: eerst "Verwijderen?", daarna "Weet je het zeker?".
  let deleteStep = 0;
  let deleteTarget = null;

  function renderDeleteStep() {
    const name = deleteTarget.name;
    $('delete-error').hidden = true;
    if (deleteStep === 1) {
      $('delete-title').textContent = `${name} verwijderen?`;
      $('delete-text').textContent = 'Het contact wordt uit het gedeelde adresboek van je organisatie gehaald.';
      $('delete-confirm').textContent = 'Verwijderen';
    } else {
      $('delete-title').textContent = 'Weet je het zeker?';
      $('delete-text').textContent = `${name} verdwijnt voor iedereen in je organisatie, ook in de app, de Webphone en op de toestellen. Dit kan niet ongedaan worden gemaakt.`;
      $('delete-confirm').textContent = 'Ja, definitief verwijderen';
    }
  }

  $('cf-delete').addEventListener('click', () => {
    if (!editing) return;
    deleteTarget = editing;
    deleteStep = 1;
    renderDeleteStep();
    $('delete-dialog').showModal();
    $('delete-cancel').focus();
  });

  $('delete-cancel').addEventListener('click', () => $('delete-dialog').close());

  $('delete-confirm').addEventListener('click', async () => {
    if (deleteStep === 1) {
      deleteStep = 2;
      renderDeleteStep();
      $('delete-cancel').focus(); // veilige standaard: Enter annuleert
      return;
    }
    const btn = $('delete-confirm');
    btn.disabled = true;
    try {
      await api(`/api/contacts/${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE', headers: { 'X-Confirm-Delete': 'yes' } });
      replaceContact(null, deleteTarget.id);
      $('delete-dialog').close();
      closeEditor();
    } catch (err) {
      $('delete-error').textContent = err.message;
      $('delete-error').hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  $('delete-dialog').addEventListener('close', () => { deleteStep = 0; deleteTarget = null; });

  // ---------- bellen ----------

  async function startCall(number, name, label) {
    if (state.call && !state.call.final) {
      if (!confirm('Er loopt al een gesprek. Toch een nieuw gesprek starten?')) return;
      stopPolling();
    }
    const device = $('device-select').value;
    const displayName = name || label || number;
    state.call = { id: null, name: displayName, final: false, started: Date.now() };
    renderCall(null, `Je toestel wordt gebeld…`);

    try {
      const res = await api('/api/calls', { method: 'POST', body: { number, device: device || undefined } });
      state.call.id = res.callId;
      renderCall(res.status);
      poll();
    } catch (err) {
      state.call.final = true;
      renderCall('failed', err.message);
    }
  }

  function renderCall(status, override) {
    const call = state.call;
    const [title, tone, sub] = status === 'failed'
      ? ['Bellen mislukt', 'fail', '']
      : (STATUS[status] || STATUS.null);
    const fill = (s) => (s || '').replaceAll('{name}', call.name);
    $('call-title').textContent = fill(title);
    $('call-sub').textContent = override || fill(sub) || (call.name !== fill(title) ? call.name : '');
    $('call-dot').className = `dot ${tone}`;
    $('call-hangup').hidden = call.final;
    $('call-close').hidden = !call.final;
    $('call-panel').hidden = false;
  }

  let pollTimer = null;
  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      const call = state.call;
      if (!call?.id || call.final) return;
      try {
        const res = await api(`/api/calls/${encodeURIComponent(call.id)}`);
        if (state.call !== call) return;
        if (FINAL.has(res.status)) call.final = true;
        renderCall(res.status);
        if (call.final) return setTimeout(() => { if (state.call === call) $('call-panel').hidden = true; }, 8000);
      } catch (err) {
        if (err.status === 401) return;
      }
      if (Date.now() - call.started < POLL_MAX_MS) poll();
      else { call.final = true; renderCall(null, 'Status onbekend; controleer je toestel.'); }
    }, POLL_MS);
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    if (state.call) state.call.final = true;
  }

  async function hangup() {
    const call = state.call;
    if (!call) return;
    $('call-hangup').disabled = true;
    try {
      if (call.id) await api(`/api/calls/${encodeURIComponent(call.id)}`, { method: 'DELETE' });
      call.final = true;
      renderCall('disconnected');
    } catch (err) {
      $('call-sub').textContent = err.message;
    } finally {
      $('call-hangup').disabled = false;
    }
  }

  // ---------- events ----------

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setLoginError('');
    const otpMode = !$('otp-step').hidden;
    const email = $('email').value.trim();
    const password = $('password').value;
    if (!email || !password) return setLoginError('Vul je e-mailadres en wachtwoord in.');
    const btn = $('login-submit');
    btn.disabled = true;
    try {
      const me = await api('/api/login', {
        method: 'POST',
        body: { email, password, otp: otpMode ? $('otp').value.trim() : undefined },
      });
      $('password').value = '';
      setOtpStep(false);
      showApp(me);
    } catch (err) {
      if (err.code === 'otp_required') {
        setOtpStep(true);
      } else if (err.code === 'otp_invalid') {
        setLoginError(err.message);
        $('otp').select();
      } else {
        setLoginError(err.message);
      }
    } finally {
      btn.disabled = false;
    }
  });

  $('otp-back').addEventListener('click', () => { setOtpStep(false); setLoginError(''); $('password').focus(); });

  $('logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* negeren */ }
    state.data = { contacts: [], colleagues: [] };
    state.loaded = { contacts: false, colleagues: false };
    showLogin();
  });

  $('device-select').addEventListener('change', (e) => {
    try { localStorage.setItem(DEVICE_KEY, e.target.value); } catch { /* geen opslag */ }
  });

  for (const btn of document.querySelectorAll('.tab')) {
    btn.addEventListener('click', () => { setTab(btn.dataset.tab); loadTab(btn.dataset.tab); });
  }

  let searchTimer;
  $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 80); });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; renderList(); }
  });
  $('refresh').addEventListener('click', () => loadTab(state.tab, true));

  $('dial-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = $('dial-number').value.trim();
    if (!n) return;
    startCall(n, n, n);
  });

  $('call-hangup').addEventListener('click', hangup);
  $('call-close').addEventListener('click', () => { $('call-panel').hidden = true; });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) && state.me) {
      e.preventDefault();
      $('search').focus();
    }
  });

  // ---------- start ----------

  // Jaartal in de footer actueel houden, ook als de pagina uit de cache van de PWA komt.
  $('footer-year').textContent = String(new Date().getFullYear());

  api('/api/me').then(showApp).catch((err) => {
    if (err.code === 'network') showLogin('Je bent offline. Maak verbinding met internet om in te loggen en te bellen.');
    else showLogin();
  });

  // PWA: service worker registreren (werkt alleen via HTTPS of op localhost).
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* niet kritisch */ });
    });
  }

  window.addEventListener('offline', () => {
    if (state.me) showListMessage('Je bent offline. Bellen kan pas weer als je verbinding hebt.');
  });
  window.addEventListener('online', () => {
    if (state.me) loadTab(state.tab, true);
  });
})();
