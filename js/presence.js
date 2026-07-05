// Town-square presence: who's got SmackTown open right now, app-wide.
//
// Serverless, same trick as net.js rooms: the first player to arrive claims a
// well-known PeerJS ID and becomes the *hub*; everyone else connects to it as
// a guest. The hub keeps the roster, rebroadcasts it every beat, and relays
// invites between players. If the hub vanishes, guests race (with jittered
// backoff) to claim the ID — losers get 'unavailable-id' and simply reconnect
// as guests. A relay hub is needed because the public PeerJS cloud disables
// peer discovery (listAllPeers), so peers can't find each other by scanning.

import { peerOptions } from './ice.js';
import { sanitizeHat } from './profile.js';

const HUB_ID = 'smacktown-v1-town-hub';
const HB_MS = 2500;        // heartbeat / roster broadcast period
const SILENT_MS = 8000;    // silent this long -> dropped from the roster
const DIAL_MS = 8000;      // guest dial to hub considered failed after this
const RETRY_MAX_MS = 8000; // cap for reconnect backoff
const MAX_SHARED_HATS = 12; // hats each player publishes to the town lobby

// A hat list off the wire: valid art strings only, capped.
function sanitizeHatList(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map(a => sanitizeHat(a))
    .filter(Boolean)
    .slice(0, MAX_SHARED_HATS);
}

export class Presence {
  constructor(profile, getState) {
    this.profile = { name: profile.name, color: profile.color };
    this.getState = getState;   // () => {status:'menu'|'lobby'|'fighting', code, open}
    this.peer = null;
    this.isHub = false;
    this.myId = null;
    this.hubConn = null;        // guest: my link to the hub
    this.guests = new Map();    // hub: peerId -> {conn, rec, lastSeen, hats}
    this.roster = [];           // latest full roster (includes me)
    this.myHats = [];           // hat art I'm sharing with the town
    this.ready = false;         // true once we're the hub or got a roster
    this.handlers = {};
    this.hbTimer = null;
    this.retryTimer = null;
    this.dialTimer = null;
    this.attempt = 0;
    this.lastFromHub = 0;
    this.closed = true;
    this._visHandler = () => {
      if (document.visibilityState === 'visible') this.update();
    };
  }

  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }

  // Everyone in town except me, alphabetical.
  list() {
    return this.roster
      .filter(r => r.id && r.id !== this.myId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  start() {
    if (!this.closed) return;
    this.closed = false;
    document.addEventListener('visibilitychange', this._visHandler);
    this._tryHub();
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    document.removeEventListener('visibilitychange', this._visHandler);
    clearInterval(this.hbTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.dialTimer);
    try { if (this.hubConn?.open) this.hubConn.send({ t: 'bye' }); } catch (_) {}
    this._teardownPeer();
    this.guests.clear();
    this.roster = [];
    this.ready = false;
  }

  setProfile(profile) {
    this.profile = { name: profile.name, color: profile.color };
    this.update();
  }

  // Push my current state out right now (heartbeats also do this on a timer).
  update() {
    if (this.closed) return;
    if (this.isHub) this._hubBeat();
    else if (this.hubConn?.open) this._sendState('hb');
  }

  invite(toId, code) {
    const msg = { t: 'invite', to: toId, code, from: { ...this.profile } };
    if (this.isHub) this._relayInvite(msg);
    else if (this.hubConn?.open) { try { this.hubConn.send(msg); } catch (_) {} }
  }

  // ---------- global hat lobby ----------
  // Hats ride the presence channel as low-priority freight: pushed only on
  // connect and when the local library changes, aggregated by the hub, and
  // fetched on demand when someone opens the Town Hats tab. They never touch
  // the roster heartbeats.

  setHats(arts) {
    this.myHats = sanitizeHatList(arts);
    if (this.closed || this.isHub) return;
    this._sendHats();
  }

  // Ask for the aggregate town hat list; answers via the 'hats' event.
  requestHats() {
    if (this.closed) return;
    if (this.isHub) this.emit('hats', this._hatLobby());
    else if (this.hubConn?.open) { try { this.hubConn.send({ t: 'hats:req' }); } catch (_) {} }
    else this.emit('hats', []);
  }

  _sendHats() {
    if (!this.hubConn?.open) return;
    try { this.hubConn.send({ t: 'hats', hats: this.myHats }); } catch (_) {}
  }

  // Hub: everyone's shared hats (mine + every guest's), attributed by roster.
  _hatLobby() {
    const list = [];
    if (this.myHats.length) {
      list.push({ id: this.myId, name: this.profile.name, color: this.profile.color, hats: [...this.myHats] });
    }
    for (const g of this.guests.values()) {
      if (g.hats?.length) list.push({ id: g.rec.id, name: g.rec.name, color: g.rec.color, hats: g.hats });
    }
    return list;
  }

  // ---------- connection state machine ----------

  _teardownPeer() {
    const p = this.peer;
    this.peer = null;
    this.hubConn = null;
    this.isHub = false;
    clearTimeout(this.dialTimer);
    try { p?.destroy(); } catch (_) {}
  }

  _retry(ms) {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.attempt = Math.min(this.attempt + 1, 16);
    const wait = ms ?? Math.min(RETRY_MAX_MS, 400 * this.attempt) + Math.random() * 1200;
    this.retryTimer = setTimeout(() => this._tryHub(), wait);
  }

  async _tryHub() {
    if (this.closed) return;
    this._teardownPeer();
    const p = new Peer(HUB_ID, await peerOptions());
    if (this.closed) { try { p.destroy(); } catch (_) {} return; }
    this.peer = p;
    p.on('open', () => {
      if (p !== this.peer || this.closed) return;
      this.isHub = true;
      this.myId = p.id;
      this.attempt = 0;
      this.ready = true;
      this.guests.clear();
      clearInterval(this.hbTimer);
      this.hbTimer = setInterval(() => this._hubBeat(), HB_MS);
      this._hubBeat();
    });
    p.on('connection', conn => this._hubAccept(conn));
    p.on('error', err => {
      if (p !== this.peer || this.closed) return;
      if (err.type === 'unavailable-id') this._tryGuest(); // a hub already exists
      else this._retry();
    });
    p.on('disconnected', () => {
      if (p !== this.peer || this.closed) return;
      try { p.reconnect(); } catch (_) { this._retry(); }
    });
  }

  async _tryGuest() {
    if (this.closed) return;
    this._teardownPeer();
    const p = new Peer(await peerOptions());
    if (this.closed) { try { p.destroy(); } catch (_) {} return; }
    this.peer = p;
    p.on('open', () => {
      if (p !== this.peer || this.closed) return;
      this.myId = p.id;
      const conn = p.connect(HUB_ID, { reliable: true });
      // The hub's ID can linger on the signaling server right after it dies:
      // the dial then never opens and never errors. Time it out ourselves.
      clearTimeout(this.dialTimer);
      this.dialTimer = setTimeout(() => {
        if (p === this.peer && !this.closed && !conn.open) this._retry();
      }, DIAL_MS);
      conn.on('open', () => {
        if (p !== this.peer || this.closed) return;
        clearTimeout(this.dialTimer);
        this.hubConn = conn;
        this.attempt = 0;
        this.lastFromHub = Date.now();
        this._sendState('hi');
        if (this.myHats.length) this._sendHats();   // (re)introduce my hats to the hub
        clearInterval(this.hbTimer);
        this.hbTimer = setInterval(() => this._guestBeat(), HB_MS);
      });
      conn.on('data', msg => this._guestMessage(msg));
      const lost = () => {
        if (p !== this.peer || this.closed) return;
        this._retry(); // hub gone — race to claim its slot
      };
      conn.on('close', lost);
      conn.on('error', lost);
    });
    p.on('error', err => {
      if (p !== this.peer || this.closed) return;
      if (err.type === 'peer-unavailable') this._retry(300 + Math.random() * 900); // no hub: claim it
      else this._retry();
    });
    p.on('disconnected', () => {
      if (p !== this.peer || this.closed) return;
      try { p.reconnect(); } catch (_) { this._retry(); }
    });
  }

  _me() {
    const s = this.getState();
    return {
      id: this.myId,
      name: this.profile.name,
      color: this.profile.color,
      status: s.status,
      code: s.code || null,
      open: !!s.open,
    };
  }

  _sendState(t) {
    try {
      this.hubConn.send({ t, profile: { ...this.profile }, state: this.getState() });
    } catch (_) {}
  }

  // ---------- guest duties ----------

  _guestBeat() {
    if (this.closed || !this.hubConn?.open) return;
    this._sendState('hb');
    if (Date.now() - this.lastFromHub > SILENT_MS) {
      const conn = this.hubConn;
      this.hubConn = null;
      try { conn.close(); } catch (_) {}
      this._retry();
    }
  }

  _guestMessage(msg) {
    if (!msg || typeof msg !== 'object' || this.closed) return;
    this.lastFromHub = Date.now();
    if (msg.t === 'roster' && Array.isArray(msg.list)) {
      this.roster = msg.list;
      this.ready = true;
      this.emit('roster');
    } else if (msg.t === 'invite' && msg.from) {
      this.emit('invite', {
        from: { name: String(msg.from.name || 'Fighter').slice(0, 14), color: msg.from.color },
        code: typeof msg.code === 'string' ? msg.code.slice(0, 4).toUpperCase() : null,
      });
    } else if (msg.t === 'hats:all' && Array.isArray(msg.list)) {
      this.emit('hats', msg.list.map(e => ({
        id: String(e?.id || ''),
        name: String(e?.name || 'Fighter').slice(0, 14),
        color: e?.color || '#f5f5f5',
        hats: sanitizeHatList(e?.hats),
      })).filter(e => e.hats.length));
    }
  }

  // ---------- hub duties ----------

  _hubAccept(conn) {
    conn.on('data', msg => this._hubMessage(conn, msg));
    const drop = () => {
      if (this.closed || !this.isHub) return;
      const g = this.guests.get(conn.peer);
      if (g && g.conn === conn) { this.guests.delete(conn.peer); this._hubBeat(); }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  _hubMessage(conn, msg) {
    if (!msg || typeof msg !== 'object' || this.closed || !this.isHub) return;
    switch (msg.t) {
      case 'hi': case 'hb': {
        const st = msg.state || {};
        const rec = {
          id: conn.peer,
          name: String(msg.profile?.name || 'Fighter').slice(0, 14),
          color: msg.profile?.color || '#f5f5f5',
          status: st.status === 'lobby' || st.status === 'fighting' ? st.status : 'menu',
          code: typeof st.code === 'string' ? st.code.slice(0, 4).toUpperCase() : null,
          open: !!st.open,
        };
        const had = this.guests.get(conn.peer);
        this.guests.set(conn.peer, { conn, rec, lastSeen: Date.now(), hats: had?.hats || [] });
        // Rebroadcast right away for arrivals and visible changes.
        if (!had || JSON.stringify(had.rec) !== JSON.stringify(rec)) this._hubBeat();
        break;
      }
      case 'invite':
        this._relayInvite(msg);
        break;
      case 'hats': {
        const g = this.guests.get(conn.peer);
        if (g) g.hats = sanitizeHatList(msg.hats);
        break;
      }
      case 'hats:req':
        try { conn.send({ t: 'hats:all', list: this._hatLobby() }); } catch (_) {}
        break;
      case 'bye':
        this.guests.delete(conn.peer);
        this._hubBeat();
        break;
    }
  }

  _relayInvite(msg) {
    const out = {
      t: 'invite',
      code: typeof msg.code === 'string' ? msg.code.slice(0, 4).toUpperCase() : null,
      from: {
        name: String(msg.from?.name || 'Fighter').slice(0, 14),
        color: msg.from?.color || '#f5f5f5',
      },
    };
    if (!out.code) return;
    if (msg.to === this.myId) { // hub player is the invitee
      this.emit('invite', { from: out.from, code: out.code });
      return;
    }
    const g = this.guests.get(msg.to);
    if (g?.conn?.open) { try { g.conn.send(out); } catch (_) {} }
  }

  _hubBeat() {
    if (this.closed || !this.isHub) return;
    const now = Date.now();
    for (const [pid, g] of this.guests) {
      // Drop the silent (backgrounded tabs etc.); their next hb re-adds them.
      if (now - g.lastSeen > SILENT_MS) this.guests.delete(pid);
    }
    this.roster = [this._me(), ...[...this.guests.values()].map(g => g.rec)];
    const wire = { t: 'roster', list: this.roster };
    for (const g of this.guests.values()) {
      if (g.conn.open) { try { g.conn.send(wire); } catch (_) {} }
    }
    this.emit('roster');
  }
}
