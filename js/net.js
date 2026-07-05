// P2P layer: PeerJS full-mesh rooms with a presence system and host handoff.
//
// Topology: every player holds a DataConnection to every other player (full
// mesh). One player is the *host* — the game-state authority and roster
// keeper. Because the mesh already connects everyone, host handoff is just a
// re-election: no new connections are needed mid-game. The elected host also
// re-registers the room's public peer ID so new players can keep joining.
//
// Election rule (deterministic, no votes): alive member with the lowest
// joinOrder wins. Claims carry a monotonically increasing `term`; a stale
// host that reappears sees a higher term and demotes itself.

import { peerOptions } from './ice.js';

const ID_PREFIX = 'smacktown-v1-';
const HB_INTERVAL = 2000;   // presence heartbeat period (ms)
const HB_AWAY_MS = 6000;    // no heartbeat for this long -> presence 'gone'
const HB_DROP_MS = 14000;   // host prunes members silent this long
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O (look like 1/0)

const hostPeerId = code => ID_PREFIX + code.toLowerCase() + '-h';

export function randomCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return c;
}

export class Net {
  constructor(profile) {
    this.profile = profile;         // {name, color, build}
    this.roomCode = null;
    this.peer = null;               // my main Peer
    this.hostListener = null;       // extra Peer bound to the room's host ID after handoff
    this.conns = new Map();         // peerId -> open DataConnection
    this.members = new Map();       // peerId -> member record
    this.myId = null;
    this.hostId = null;             // peerId of current authority
    this.term = 0;
    this.joinOrder = -1;
    this.nextJoinOrder = 1;         // host-only counter
    this.status = 'online';
    this.handlers = {};
    this.hbTimer = null;
    this.closed = false;
    this._visHandler = () => {
      this.status = document.visibilityState === 'hidden' ? 'away' : 'online';
      this._broadcastHeartbeat();
    };
  }

  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }

  get isHost() { return this.myId !== null && this.myId === this.hostId; }

  rosterList() {
    return [...this.members.values()].sort((a, b) => a.joinOrder - b.joinOrder);
  }

  _me(joinOrder) {
    return {
      peerId: this.myId,
      name: this.profile.name,
      color: this.profile.color,
      build: this.profile.build,
      hat: this.profile.hat || null,
      joinOrder,
      ready: false,
      vote: null,
      status: 'online',
      ping: 0,
      lastSeen: Date.now(),
    };
  }

  // ---------- room lifecycle ----------

  host() {
    this.roomCode = randomCode();
    this._openPeer(hostPeerId(this.roomCode), () => {
      this.myId = this.peer.id;
      this.hostId = this.myId;
      this.joinOrder = 0;
      this.term = 1;
      this.members.set(this.myId, this._me(0));
      this._startHeartbeat();
      this.emit('room', this.roomCode);
      this.emit('roster');
    });
  }

  join(code) {
    this.roomCode = code.toUpperCase();
    this._openPeer(null, () => {
      this.myId = this.peer.id;
      this.pendingHost = hostPeerId(this.roomCode);
      this.joined = false;
      setTimeout(() => {
        if (!this.joined && !this.closed) this.emit('error', 'Could not reach that room. Check the code?');
      }, 9000);
      this._dialHost(this.pendingHost);
    });
  }

  _dialHost(pid) {
    const conn = this.peer.connect(pid, { reliable: true });
    conn.on('open', () => {
      this._adoptConn(conn);
      conn.send({ t: 'hello', profile: this.profile });
    });
  }

  leave() {
    this.closed = true;
    clearInterval(this.hbTimer);
    document.removeEventListener('visibilitychange', this._visHandler);
    try { this.broadcast({ t: 'bye' }); } catch (_) {}
    for (const c of this.conns.values()) { try { c.close(); } catch (_) {} }
    try { this.peer?.destroy(); } catch (_) {}
    try { this.hostListener?.destroy(); } catch (_) {}
    this.conns.clear();
    this.members.clear();
  }

  async _openPeer(id, onOpen) {
    // Default PeerJS cloud for signaling; media never touches it (WebRTC is P2P).
    const opts = await peerOptions();
    if (this.closed) return;
    const p = id ? new Peer(id, opts) : new Peer(opts);
    this.peer = p;
    p.on('open', onOpen);
    p.on('connection', conn => this._acceptConn(conn));
    p.on('error', err => {
      if (p !== this.peer) return;
      if (err.type === 'unavailable-id') {
        // Room code collision (or stale registration) — reroll and retry.
        if (this.joinOrder <= 0 && !this.members.size) {
          this.roomCode = randomCode();
          this._openPeer(hostPeerId(this.roomCode), onOpen);
        }
      } else if (err.type === 'peer-unavailable') {
        this.emit('error', 'Room not found — is the host online?');
      } else if (err.type === 'network' || err.type === 'disconnected') {
        this.emit('banner', 'Reconnecting to matchmaking…', 'warn');
        if (!this.closed) setTimeout(() => { try { this.peer.reconnect(); } catch (_) {} }, 1500);
      } else {
        this.emit('error', 'Network error: ' + err.type);
      }
    });
    p.on('disconnected', () => {
      if (!this.closed && p === this.peer) { try { p.reconnect(); } catch (_) {} }
    });
  }

  _acceptConn(conn) {
    conn.on('open', () => this._adoptConn(conn));
  }

  _adoptConn(conn) {
    const pid = conn.peer;
    const old = this.conns.get(pid);
    if (old && old !== conn) { try { old.close(); } catch (_) {} }
    this.conns.set(pid, conn);
    conn.on('data', msg => this._onMessage(pid, msg));
    const drop = () => this._onConnLost(pid, conn);
    conn.on('close', drop);
    conn.on('error', drop);
  }

  _onConnLost(pid, conn) {
    if (this.closed || this.conns.get(pid) !== conn) return;
    this.conns.delete(pid);
    if (this.joinOrder < 0 && pid === this.pendingHost) {
      // lost the host link before we were admitted — tell the user now
      // instead of leaving them staring at a silent join/hold screen
      this.emit('error', 'Lost connection to the room before joining.');
      return;
    }
    const m = this.members.get(pid);
    if (m) { m.status = 'gone'; this.emit('roster'); }
    if (pid === this.hostId) this._election();
    else if (this.isHost) this._pruneSoon(pid);
  }

  // ---------- messaging ----------

  send(pid, msg) {
    const c = this.conns.get(pid);
    if (c && c.open) { try { c.send(msg); } catch (_) {} }
  }

  broadcast(msg) {
    for (const c of this.conns.values()) {
      if (c.open) { try { c.send(msg); } catch (_) {} }
    }
  }

  sendToHost(msg) {
    if (this.isHost) this._onMessage(this.myId, msg);
    else this.send(this.hostId, msg);
  }

  _onMessage(pid, msg) {
    if (!msg || typeof msg !== 'object') return;
    const m = this.members.get(pid);
    if (m) { m.lastSeen = Date.now(); if (m.status === 'gone') { m.status = 'online'; this.emit('roster'); } }

    switch (msg.t) {
      case 'hello': {
        // New player at the door. Doors are open: the host admits them on
        // the spot — no knock, no approval step.
        if (!this.isHost) return;
        const existing = this.members.get(pid);
        const rec = existing || {
          peerId: pid,
          joinOrder: this.nextJoinOrder++,
          ready: false, status: 'online', ping: 0, lastSeen: Date.now(),
        };
        rec.name = String(msg.profile?.name || 'Fighter').slice(0, 14);
        rec.color = msg.profile?.color || '#f5f5f5';
        rec.build = msg.profile?.build || null;
        rec.hat = msg.profile?.hat || null;
        this.members.set(pid, rec);
        this.send(pid, {
          t: 'welcome',
          code: this.roomCode,
          term: this.term,
          joinOrder: rec.joinOrder,
          roster: this._rosterWire(),
        });
        this._broadcastRoster();
        this.emit('roster');
        if (!existing) this.emit('peer-joined', rec);
        break;
      }

      case 'redirect': {
        // The room's public ID is now just a door held by a handed-off host:
        // it points us at the real host's main peer ID.
        if (pid !== this.pendingHost || this.joined) return;
        this.pendingHost = msg.to;
        this.conns.get(pid)?.close();
        this.conns.delete(pid);
        this._dialHost(msg.to);
        break;
      }

      case 'welcome': {
        if (pid !== this.pendingHost && pid !== this.hostId) return;
        this.joined = true;
        this.hostId = pid;
        this.term = msg.term;
        this.joinOrder = msg.joinOrder;
        this._applyRosterWire(msg.roster);
        this.members.set(this.myId, this._me(this.joinOrder));
        // Complete the mesh: dial everyone we don't have a link to yet.
        for (const rec of this.members.values()) {
          if (rec.peerId !== this.myId && !this.conns.has(rec.peerId)) {
            const c = this.peer.connect(rec.peerId, { reliable: true });
            c.on('open', () => {
              this._adoptConn(c);
              c.send({ t: 'mesh-hi', joinOrder: this.joinOrder, profile: this.profile });
            });
          }
        }
        this._startHeartbeat();
        this.emit('room', this.roomCode);
        this.emit('roster');
        break;
      }

      case 'mesh-hi': {
        // Direct link from a fellow member (roster arrives via host).
        if (!this.members.has(pid)) {
          this.members.set(pid, {
            peerId: pid,
            name: String(msg.profile?.name || 'Fighter').slice(0, 14),
            color: msg.profile?.color || '#f5f5f5',
            build: msg.profile?.build || null,
            hat: msg.profile?.hat || null,
            joinOrder: msg.joinOrder ?? 999,
            ready: false, vote: null, status: 'online', ping: 0, lastSeen: Date.now(),
          });
          this.emit('roster');
        }
        break;
      }

      case 'roster': {
        if (pid !== this.hostId) return;
        this._applyRosterWire(msg.roster);
        this.emit('roster');
        break;
      }

      case 'hb': {
        if (m) { m.status = msg.status || 'online'; }
        this.send(pid, { t: 'hb-ack', ts: msg.ts });
        this.emit('roster');
        break;
      }

      case 'hb-ack': {
        if (m) m.ping = Math.max(1, Date.now() - msg.ts);
        break;
      }

      case 'ready': {
        if (m) { m.ready = !!msg.ready; this.emit('roster'); }
        if (this.isHost) this._broadcastRoster();
        break;
      }

      case 'vote': {
        // Map vote for the next fight (null clears it).
        if (m) { m.vote = msg.map || null; this.emit('roster'); }
        if (this.isHost) this._broadcastRoster();
        break;
      }

      case 'profile': {
        // A member re-tuned their fighter (lobby workshop edit).
        if (m) {
          m.name = String(msg.profile?.name || m.name || 'Fighter').slice(0, 14);
          m.color = msg.profile?.color || m.color;
          m.build = msg.profile?.build || m.build;
          m.hat = msg.profile?.hat ?? m.hat ?? null;
          this.emit('roster');
          if (this.isHost) this._broadcastRoster();
        }
        break;
      }

      case 'bye': {
        this.conns.get(pid)?.close();
        this.conns.delete(pid);
        this.members.delete(pid);
        this.emit('roster');
        if (pid === this.hostId) this._election();
        else if (this.isHost) this._broadcastRoster();
        break;
      }

      case 'claim': {
        // Someone claims hosthood. Accept if their (term, joinOrder) beats the
        // current authority's — this resolves simultaneous claims after a
        // host loss and rejects stale claims from a returning old host.
        const curJo = this.isHost
          ? this.joinOrder
          : (this.members.get(this.hostId)?.joinOrder ?? Infinity);
        const better = msg.term > this.term
          || (msg.term === this.term && msg.joinOrder < curJo);
        if (better) {
          const wasHost = this.isHost;
          this.hostId = pid;
          this.term = msg.term;
          if (wasHost) this.emit('banner', 'Host role transferred', 'warn');
          this.emit('host-changed', pid);
          this.emit('roster');
        }
        break;
      }

      // Game traffic is passed straight through to the game layer.
      case 'start': case 'input': case 'snap': case 'end': case 'rematch':
        this.emit('game:' + msg.t, msg, pid);
        break;
    }
  }

  // ---------- profile updates ----------

  updateProfile(profile) {
    this.profile = profile;
    const me = this.members.get(this.myId);
    if (me) {
      me.name = profile.name;
      me.color = profile.color;
      me.build = profile.build;
      me.hat = profile.hat || null;
    }
    this.broadcast({ t: 'profile', profile: { name: profile.name, color: profile.color, build: profile.build, hat: profile.hat || null } });
    if (this.isHost) this._broadcastRoster();
    this.emit('roster');
  }

  // ---------- roster sync ----------

  _rosterWire() {
    return this.rosterList().map(r => ({
      peerId: r.peerId, name: r.name, color: r.color,
      build: r.build, hat: r.hat || null, joinOrder: r.joinOrder, ready: r.ready,
      vote: r.vote || null, status: r.status,
    }));
  }

  _applyRosterWire(list) {
    if (!Array.isArray(list)) return;
    const seen = new Set();
    for (const w of list) {
      seen.add(w.peerId);
      const cur = this.members.get(w.peerId);
      if (cur) {
        Object.assign(cur, { name: w.name, color: w.color, build: w.build, hat: w.hat || null, joinOrder: w.joinOrder, ready: w.ready, vote: w.vote || null });
      } else {
        this.members.set(w.peerId, { ...w, ping: 0, lastSeen: Date.now(), status: w.status || 'online' });
      }
    }
    for (const pid of [...this.members.keys()]) {
      if (!seen.has(pid) && pid !== this.myId) this.members.delete(pid);
    }
  }

  _broadcastRoster() {
    if (this.isHost) this.broadcast({ t: 'roster', roster: this._rosterWire() });
  }

  setReady(ready) {
    const me = this.members.get(this.myId);
    if (me) me.ready = ready;
    this.broadcast({ t: 'ready', ready });
    if (this.isHost) this._broadcastRoster();
    this.emit('roster');
  }

  setVote(map) {
    const me = this.members.get(this.myId);
    if (me) me.vote = map || null;
    this.broadcast({ t: 'vote', map: map || null });
    if (this.isHost) this._broadcastRoster();
    this.emit('roster');
  }

  // ---------- presence ----------

  _startHeartbeat() {
    document.addEventListener('visibilitychange', this._visHandler);
    clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => this._tickPresence(), HB_INTERVAL);
    this._tickPresence();
  }

  _broadcastHeartbeat() {
    this.broadcast({ t: 'hb', ts: Date.now(), status: this.status });
  }

  _tickPresence() {
    this._broadcastHeartbeat();
    const now = Date.now();
    let changed = false;
    for (const m of this.members.values()) {
      if (m.peerId === this.myId) continue;
      const silent = now - m.lastSeen;
      const s = silent > HB_AWAY_MS ? 'gone' : m.status === 'away' ? 'away' : 'online';
      if (s !== m.status && !(s === 'online' && m.status === 'away')) { m.status = s; changed = true; }
      if (this.isHost && silent > HB_DROP_MS && m.peerId !== this.myId) {
        this.members.delete(m.peerId);
        this.conns.get(m.peerId)?.close();
        this.conns.delete(m.peerId);
        this._broadcastRoster();
        changed = true;
      }
      if (m.status === 'gone' && m.peerId === this.hostId && silent > HB_AWAY_MS + 2000) {
        this._election();
      }
    }
    if (changed) this.emit('roster');
  }

  _pruneSoon() { /* handled by _tickPresence via HB_DROP_MS */ }

  // ---------- host handoff ----------

  _election() {
    if (this.closed) return;
    const oldHost = this.hostId;
    const alive = this.rosterList().filter(r =>
      r.peerId === this.myId || (this.conns.get(r.peerId)?.open && r.status !== 'gone'));
    const candidates = alive.filter(r => r.peerId !== oldHost);
    if (!candidates.length) return;
    const winner = candidates[0]; // lowest joinOrder
    if (winner.peerId !== this.myId) {
      // Not me — just note the expected winner; their claim will confirm.
      this.hostId = winner.peerId;
      this.emit('roster');
      return;
    }
    // I win: take over authority.
    this.members.delete(oldHost);
    this.term += 1;
    this.hostId = this.myId;
    this.broadcast({ t: 'claim', term: this.term, joinOrder: this.joinOrder });
    this._broadcastRoster();
    this.emit('banner', 'Host left — you are the new host', 'good');
    this.emit('host-changed', this.myId);
    this.emit('roster');
    this._claimHostSlot(1);
  }

  // Re-register the room's public peer ID so newcomers can still join.
  async _claimHostSlot(attempt) {
    if (this.closed || !this.isHost || this.hostListener) return;
    if (attempt > 6) return; // room stays open for current members only
    const hid = hostPeerId(this.roomCode);
    const listener = new Peer(hid, await peerOptions());
    if (this.closed || !this.isHost || this.hostListener) { try { listener.destroy(); } catch (_) {} return; }
    listener.on('open', () => {
      this.hostListener = listener;
      listener.on('connection', conn => {
        // Door only: point the newcomer at our real peer ID so every mesh
        // link stays keyed by main IDs, then hang up.
        conn.on('open', () => {
          try { conn.send({ t: 'redirect', to: this.myId }); } catch (_) {}
          setTimeout(() => { try { conn.close(); } catch (_) {} }, 1500);
        });
      });
    });
    listener.on('error', err => {
      if (err.type === 'unavailable-id') {
        // Old host's registration hasn't expired yet — retry with backoff.
        try { listener.destroy(); } catch (_) {}
        setTimeout(() => this._claimHostSlot(attempt + 1), attempt * 3000);
      }
    });
  }
}
