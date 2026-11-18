import { randomBytes } from 'node:crypto';

// In-memory sessies. Het Voys API-token blijft altijd op de server; de browser krijgt alleen
// een willekeurige sessie-ID in een HttpOnly-cookie. Bij een herstart moeten gebruikers opnieuw
// inloggen; draai je meerdere instanties, vervang dit dan door bijvoorbeeld Redis.
export class SessionStore {
  constructor({ idleMinutes = 480 } = {}) {
    this.idleMs = idleMinutes * 60_000;
    this.sessions = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  create(data) {
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { ...data, lastSeen: Date.now() });
    return id;
  }

  get(id) {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (Date.now() - s.lastSeen > this.idleMs) {
      this.sessions.delete(id);
      return null;
    }
    s.lastSeen = Date.now();
    return s;
  }

  destroy(id) {
    this.sessions.delete(id);
  }

  sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > this.idleMs) this.sessions.delete(id);
    }
  }

  close() {
    clearInterval(this.timer);
  }
}

// Eenvoudige rate limiter op basis van een vast tijdvenster, per sleutel (IP of e-mail).
export class RateLimiter {
  constructor({ max, windowMinutes }) {
    this.max = max;
    this.windowMs = windowMinutes * 60_000;
    this.hits = new Map();
  }

  // Geeft true terug als de sleutel nog een poging mag doen.
  allow(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.start > this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  reset(key) {
    this.hits.delete(key);
  }
}
