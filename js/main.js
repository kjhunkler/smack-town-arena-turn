// App orchestration: boot, screens, room flow, and the game session driver.

import {
  loadProfile, saveProfile, validName, COLORS, emptyBuild, sanitizeBuild, saveLoadout, sanitizeHat,
  loadHats, hatArt, saveHat, deleteHat, loadLoadouts, selectedLoadout, selectLoadout,
} from './profile.js';
import { Net } from './net.js';
import { Presence } from './presence.js';
import { Game, gameFromSnapshot, restoreFighter, blankInput, TICK, SNAP_RATE, MAP_IDS, DEFAULT_MAP } from './game.js';
import { TouchInput } from './input.js';
import { HatStudio } from './hat.js';
import { Renderer } from './render.js';
import * as UI from './ui.js';

const $ = s => document.querySelector(s);

// ---------------- global state ----------------
let profile = null;
let net = null;             // Net instance while in a room
let session = null;         // active game session
let presence = null;        // town-square presence (menu roster + invites)
let pendingInvite = null;   // {id, name} to ping once our fresh room opens
const touch = new TouchInput(document);
touch.onPad = on => UI.banner(
  on ? '🎮 Controller connected — stick moves · A jumps · X quick · B/Y smash · bumpers = abilities'
     : '🎮 Controller disconnected',
  on ? 'good' : 'warn', on ? 4500 : 2500);
const renderer = new Renderer($('#game-canvas'));

// ---------------- boot ----------------
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------------- PWA install ----------------
// Chrome & friends: surface an in-app Install button when the browser says
// the app qualifies. iOS has no prompt API, so show Add-to-Home-Screen steps.
let installPrompt = null;
const isStandalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches
  || navigator.standalone === true;

addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('#menu-install').classList.remove('hidden');
  $('#install-hint').classList.add('hidden');
});

$('#menu-install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $('#menu-install').classList.add('hidden');
});

addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#menu-install').classList.add('hidden');
  $('#install-hint').classList.add('hidden');
  UI.banner('SmackTown installed! 🥊', 'good');
});

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS && !isStandalone) $('#install-hint').classList.remove('hidden');

// ---------------- gesture guards ----------------
// Mobile browsers zoom on pinch and double-tap even with user-scalable=no
// (iOS ignores it); frantic button mashing triggers both and leaves the page
// zoomed + overflowing. Kill those gestures app-wide; inputs still work.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, e => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', e => {
  if (e.touches.length > 1 || e.scale && e.scale !== 1) e.preventDefault();
}, { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', e => {
  // Double-tap zoom guard for the game screen only (rapid tap-attacks!).
  // Menus rely on touch-action: manipulation instead, so their taps keep
  // producing synthetic clicks.
  if ($('#screen-game').classList.contains('hidden')) return;
  const now = Date.now();
  if (now - lastTouchEnd < 350) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });
document.addEventListener('contextmenu', e => {
  if (!$('#screen-game').classList.contains('hidden')) e.preventDefault();
});

// invite deep link: opening ?join=CODE drops you into that room directly
const urlJoin = new URLSearchParams(location.search).get('join');
let pendingJoinCode = urlJoin && /^[A-Za-z]{4}$/.test(urlJoin) ? urlJoin.toUpperCase() : null;
if (urlJoin) history.replaceState(null, '', location.pathname); // don't re-join on refresh

profile = loadProfile();
if (profile) {
  UI.renderMenuCard(profile);
  UI.showScreen('menu');
  startPresence();
  if (pendingJoinCode) { enterRoom(pendingJoinCode); pendingJoinCode = null; }
} else {
  initLogin();
  UI.showScreen('login');
}

// ---------------- town-square presence ----------------
function presenceState() {
  // The room stays open even mid-fight — late joiners drop straight in.
  if (session) return { status: 'fighting', code: net?.roomCode || null, open: !!net?.roomCode };
  if (net?.roomCode) return { status: 'lobby', code: net.roomCode, open: true };
  return { status: 'menu', code: null, open: false };
}

function startPresence() {
  if (presence || !profile) return;
  presence = new Presence(profile, presenceState);
  presence.on('roster', refreshOnline);
  presence.on('hats', list => {
    // Only paint if the Town Hats tab is actually on screen.
    if (!$('#hat-library').classList.contains('hidden')
      && !$('#hatlib-town').classList.contains('hidden')) renderTownHats(list);
  });
  presence.on('invite', inv => {
    if (!inv.code) return;
    if (session) { UI.banner(`${inv.from.name} invited you — room ${inv.code}`, 'warn', 6000); return; }
    if (net?.roomCode) {
      // Already in a different lobby: ask, don't yank.
      if (net.roomCode === inv.code) return;
      UI.banner(`⚔️ ${inv.from.name} challenged you! Tap to switch to room ${inv.code}`, 'good', 12000,
        () => enterRoom(inv.code));
      return;
    }
    // Not in a lobby: the invite pulls you straight in.
    UI.banner(`⚔️ ${inv.from.name} pulled you into room ${inv.code}!`, 'good', 5000);
    enterRoom(inv.code);
  });
  presence.start();
  publishHats();                  // share my hat collection with the town
  refreshOnline();
}

function refreshOnline() {
  if (!presence) return;
  UI.renderOnline(presence.list(), presence.ready, {
    onJoin: e => enterRoom(e.code),
    onInvite: e => {
      if (net?.roomCode) {
        presence.invite(e.id, net.roomCode);
        UI.banner(`Challenge sent to ${e.name}!`, 'good');
      } else {
        // No room yet: open one, then ping them once the code exists.
        pendingInvite = { id: e.id, name: e.name };
        enterRoom(null);
      }
    },
  });
}

// ---------------- login (first run) ----------------
function initLogin() {
  let color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const paint = () =>
    UI.renderColorGrid($('#login-colors'), color, c => { color = c; paint(); });
  paint();

  $('#login-go').addEventListener('click', () => {
    const name = $('#login-name').value;
    if (!validName(name)) {
      const err = $('#login-error');
      err.textContent = '2–14 letters, numbers or basic punctuation, please!';
      err.classList.remove('hidden');
      return;
    }
    profile = saveProfile({ name, color, build: emptyBuild() });
    // First run: straight into the workshop to spend starting credits.
    openBuilder(true);
  });
}

// ---------------- builder ----------------
let builderWork = null;
let builderFirstRun = false;
let builderReturn = 'menu';        // 'menu' | 'lobby' — where Save goes back to

function openBuilder(firstRun = false, returnTo = 'menu') {
  builderFirstRun = firstRun;
  builderReturn = returnTo;
  builderWork = {
    color: profile.color,
    build: JSON.parse(JSON.stringify(profile.build)),
    hatId: profile.hatId,
  };
  $('#builder-name').value = profile.name;
  $('#builder-name-error').classList.add('hidden');
  $('#loadout-name').value = selectedLoadout() || '';
  UI.renderBuilder(builderWork);
  UI.showScreen('builder');
}

$('#builder-reset').addEventListener('click', () => {
  builderWork.build = emptyBuild();
  UI.renderBuilder(builderWork);
});

$('#loadout-save').addEventListener('click', () => {
  const nameEl = $('#loadout-name');
  const err = $('#loadout-error');
  const res = saveLoadout(nameEl.value, builderWork.color, builderWork.build, builderWork.hatId);
  if (res.ok) {
    selectLoadout(nameEl.value);           // the freshly saved build is now "me"
    nameEl.value = selectedLoadout() || '';
    err.classList.add('hidden');
    UI.renderBuilder(builderWork);
  } else {
    err.textContent = res.error;
    err.classList.remove('hidden');
  }
});

$('#builder-save').addEventListener('click', () => {
  const nameEl = $('#builder-name');
  const nameErr = $('#builder-name-error');
  if (!validName(nameEl.value)) {
    nameErr.textContent = '2–14 letters, numbers or basic punctuation, please!';
    nameErr.classList.remove('hidden');
    nameEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  nameErr.classList.add('hidden');
  profile = saveProfile({ name: nameEl.value, color: builderWork.color, build: builderWork.build, hatId: builderWork.hatId });
  const sel = selectedLoadout();
  if (sel) saveLoadout(sel, builderWork.color, builderWork.build, builderWork.hatId);   // edits stick to the character
  UI.renderMenuCard(profile);
  if (builderReturn === 'lobby' && net?.roomCode) {
    net.updateProfile(profile);      // let the room see the new colors/build
    renderLobby();
    UI.showScreen('lobby');
  } else {
    UI.showScreen('menu');
    startPresence();
  }
  presence?.setProfile(profile);
  if (builderFirstRun) UI.banner(`Welcome to SmackTown, ${profile.name}!`, 'good');
  if (builderFirstRun && pendingJoinCode) { enterRoom(pendingJoinCode); pendingJoinCode = null; }
});

$('#menu-builder').addEventListener('click', () => openBuilder());

// ----- menu character switching -----
// The fighter card is the "edit me" button; the arrows swap which saved
// build (character) is active — applied to the profile on the spot.
$('#menu-card').addEventListener('click', () => openBuilder());
$('#menu-card').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBuilder(); }
});

function cycleCharacter(dir) {
  const list = loadLoadouts();
  if (!list.length) return;
  const sel = selectedLoadout();
  const i = sel ? list.findIndex(l => l.name === sel) : -1;
  const next = list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length];
  selectLoadout(next.name);
  profile = saveProfile({ name: profile.name, color: next.color, build: next.build, hatId: next.hatId });
  UI.renderMenuCard(profile);
  presence?.setProfile(profile);            // town roster shows the new colors
}
$('#menu-char-prev').addEventListener('click', () => cycleCharacter(-1));
$('#menu-char-next').addEventListener('click', () => cycleCharacter(1));

// ---------------- hats: builder arrows, library modal, studio ----------------
const hatStudio = new HatStudio();
let editingHatId = null;           // library entry the studio canvas holds

// Publish my hat collection to the town lobby (low-priority presence freight).
function publishHats() {
  presence?.setHats(loadHats().map(h => h.art));
}

// tiny canvas copy of a hat, for cards and chips
function hatThumb(art) {
  const img = UI.hatImage(art);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

// ----- builder preview arrows: cycle [bare-headed, ...library] -----
function cycleHat(dir) {
  const ids = [null, ...loadHats().map(h => h.id)];
  const i = Math.max(0, ids.indexOf(builderWork.hatId));   // stale id -> start at "no hat"
  builderWork.hatId = ids[(i + dir + ids.length) % ids.length];
  UI.renderBuilder(builderWork);
}
$('#builder-hat-prev').addEventListener('click', () => cycleHat(-1));
$('#builder-hat-next').addEventListener('click', () => cycleHat(1));

// ----- hat library modal -----
function openHatLibrary() {
  $('#hat-library').classList.remove('hidden');
  showHatLibTab('mine');
}

function closeHatLibrary() {
  $('#hat-library').classList.add('hidden');
}

function showHatLibTab(which) {
  $('#hatlib-tab-mine').classList.toggle('on', which === 'mine');
  $('#hatlib-tab-town').classList.toggle('on', which === 'town');
  $('#hatlib-mine').classList.toggle('hidden', which !== 'mine');
  $('#hatlib-town').classList.toggle('hidden', which !== 'town');
  if (which === 'mine') {
    renderHatLibrary();
  } else {
    renderTownHats(null);           // "looking…" until the hub answers
    presence?.requestHats();
  }
}

$('#builder-hat-library').addEventListener('click', openHatLibrary);
$('#hatlib-close').addEventListener('click', closeHatLibrary);
$('#hat-library').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeHatLibrary();    // tap the backdrop to close
});
$('#hatlib-tab-mine').addEventListener('click', () => showHatLibTab('mine'));
$('#hatlib-tab-town').addEventListener('click', () => showHatLibTab('town'));
$('#hatlib-new').addEventListener('click', () => openHatStudio(null));

// My hats: tap the art to wear it (tap again to take it off), ✏️ edit, ✕ delete.
function renderHatLibrary() {
  const box = $('#hatlib-grid');
  box.innerHTML = '';
  const hats = loadHats();
  if (!hats.length) {
    box.innerHTML = '<p class="hatlib-empty">No hats yet — draw your first one below!</p>';
    return;
  }
  for (const h of hats) {
    const worn = h.id === builderWork.hatId;
    const card = document.createElement('div');
    card.className = 'hatlib-card' + (worn ? ' worn' : '');
    const wear = document.createElement('button');
    wear.className = 'hatlib-art';
    wear.title = worn ? 'Take this hat off' : 'Wear this hat';
    wear.appendChild(hatThumb(h.art));
    if (worn) {
      const badge = document.createElement('span');
      badge.className = 'hatlib-worn';
      badge.textContent = 'WORN';
      wear.appendChild(badge);
    }
    wear.addEventListener('click', () => {
      builderWork.hatId = worn ? null : h.id;
      UI.renderBuilder(builderWork);
      renderHatLibrary();
    });
    const actions = document.createElement('div');
    actions.className = 'hatlib-actions';
    const edit = document.createElement('button');
    edit.className = 'hatlib-btn';
    edit.setAttribute('aria-label', 'Edit hat');
    edit.textContent = '✏️';
    edit.addEventListener('click', () => openHatStudio(h.id));
    const del = document.createElement('button');
    del.className = 'hatlib-btn';
    del.setAttribute('aria-label', 'Delete hat');
    del.textContent = '✕';
    del.addEventListener('click', () => {
      deleteHat(h.id);
      if (builderWork.hatId === h.id) builderWork.hatId = null;
      publishHats();
      UI.renderBuilder(builderWork);
      renderHatLibrary();
    });
    actions.append(edit, del);
    card.append(wear, actions);
    box.appendChild(card);
  }
}

// Town hats: everyone's shared hats, grouped by owner. list = null while loading.
function renderTownHats(list) {
  const box = $('#hatlib-town-list');
  const empty = $('#hatlib-town-empty');
  box.innerHTML = '';
  if (!list) {
    empty.textContent = presence ? 'Looking for town hats…' : 'Town hats need a connection.';
    empty.classList.remove('hidden');
    return;
  }
  const others = list.filter(e => e.id !== presence?.myId && e.hats.length);
  if (!others.length) {
    empty.textContent = 'No town hats right now — your hats are shared automatically, so check back soon!';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  for (const e of others) {
    const row = document.createElement('div');
    row.className = 'town-row';
    const owner = document.createElement('div');
    owner.className = 'town-owner';
    const sw = document.createElement('span');
    sw.className = 'r-swatch';
    sw.style.background = e.color;
    const nm = document.createElement('span');
    nm.className = 'town-name';
    nm.textContent = e.name;
    owner.append(sw, nm);
    const hatsBox = document.createElement('div');
    hatsBox.className = 'town-hats';
    for (const art of e.hats) {
      const chip = document.createElement('div');
      chip.className = 'town-hat';
      chip.appendChild(hatThumb(art));
      const copy = document.createElement('button');
      copy.className = 'town-copy';
      copy.title = 'Copy to my hats';
      copy.textContent = '📋';
      copy.addEventListener('click', () => {
        const res = saveHat(art);           // mints a fresh local copy
        if (!res.ok) { UI.banner(res.error, 'bad'); return; }
        publishHats();
        UI.renderBuilder(builderWork);      // hat count in the cycle label changed
        UI.banner(`Copied ${e.name}'s hat to your library! 🎩`, 'good');
      });
      chip.appendChild(copy);
      hatsBox.appendChild(chip);
    }
    row.append(owner, hatsBox);
    box.appendChild(row);
  }
}

// ----- hat studio (drawing screen) -----
// Reached only through the library modal: New Hat or ✏️ on a card. Saving
// and cancelling both land back in the library.
function openHatStudio(hatId) {
  editingHatId = hatId;
  closeHatLibrary();
  UI.showScreen('hat');                 // show first so the canvas has a size
  hatStudio.open(builderWork.color, hatArt(editingHatId), {
    onSave: art => {
      const res = saveHat(art, editingHatId);   // empty canvas -> friendly error
      if (!res.ok) { UI.banner(res.error, 'bad'); return; }
      builderWork.hatId = res.id;
      publishHats();
      closeHatStudio();
      UI.banner('Hat saved! 🎩', 'good');
    },
    onDuplicate: art => {
      const res = saveHat(art, null);   // always mints a new hat
      if (!res.ok) { UI.banner(res.error, 'bad'); return; }
      builderWork.hatId = res.id;
      publishHats();
      closeHatStudio();
      UI.banner('Saved as a new hat! 🎩', 'good');
    },
    onCancel: () => closeHatStudio(),
  });
}

function closeHatStudio() {
  hatStudio.close();
  UI.showScreen('builder');
  UI.renderBuilder(builderWork);
  openHatLibrary();                     // back to managing the library
}

// ---------------- menu actions ----------------
$('#menu-solo').addEventListener('click', () => {
  startSession({
    mode: 'solo',
    myId: 'me',
    map: MAP_IDS[(Math.random() * MAP_IDS.length) | 0],
    players: [
      { id: 'me', name: profile.name, color: profile.color, build: profile.build, hat: profile.hat },
      {
        id: 'bot', name: 'Trainer Bot', isBot: true,
        color: COLORS.find(c => c !== profile.color) || '#38b6ff',
        build: { stats: { power: 2, speed: 2, defense: 1, agility: 1 }, abilities: ['fireball'], augments: [] },
      },
    ],
  });
});

$('#menu-join').addEventListener('click', () => {
  const code = $('#menu-code').value.trim().toUpperCase();
  if (!code) return enterRoom(null);          // no code — host a fresh room
  if (code.length !== 4) return menuError('Room codes are 4 letters.');
  enterRoom(code);
});

function menuError(text) {
  const el = $('#menu-error');
  el.textContent = text;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ---------------- room / lobby ----------------
function enterRoom(joinCode) {
  if (net) { net.leave(); net = null; }
  net = new Net(profile);

  net.on('room', () => {
    renderLobby();
    UI.showScreen('lobby');
    presence?.update();               // advertise the joinable room
    if (pendingInvite && net.isHost) {
      presence?.invite(pendingInvite.id, net.roomCode);
      UI.banner(`Challenge sent to ${pendingInvite.name}!`, 'good');
      pendingInvite = null;
    }
  });
  net.on('roster', () => {
    if (!$('#screen-lobby').classList.contains('hidden')) renderLobby();
    session?.onRoster();
    maybeAutoStart();
  });
  net.on('error', text => {
    if (session) return;
    UI.showScreen('menu');
    menuError(text);
    net?.leave(); net = null;
    pendingInvite = null;
    presence?.update();
  });
  net.on('banner', (text, kind) => UI.banner(text, kind));
  net.on('peer-joined', rec => {
    // A player walked in while a fight is running: as host, drop them into
    // the live game and re-broadcast the player list so everyone syncs up.
    if (!session || session.ended || !net.isHost || session.mode === 'solo') return;
    session.addPlayer({ id: rec.peerId, name: rec.name, color: rec.color, build: sanitizeBuild(rec.build), hat: sanitizeHat(rec.hat) });
    net.broadcast({ t: 'start', players: session.players, seed: session.seed, map: session.map });
    UI.banner(`${rec.name} joined the fight!`, 'good');
  });
  net.on('host-changed', () => {
    if (!$('#screen-lobby').classList.contains('hidden')) renderLobby();
    session?.onHostChanged();
    maybeAutoStart();
  });
  net.on('game:start', (msg, pid) => {
    if (pid !== net.hostId) return;
    const players = msg.players.map(p => ({ ...p, build: sanitizeBuild(p.build), hat: sanitizeHat(p.hat) }));
    if (session) { session.syncPlayers(players); return; }  // mid-game roster update
    startSession({ mode: 'client', myId: net.myId, players, seed: msg.seed, map: msg.map });
  });
  net.on('game:input', (msg, pid) => session?.onRemoteInput(pid, msg.inp, msg.seq));
  net.on('game:snap', (msg, pid) => session?.onSnapshot(msg.s, pid));

  if (joinCode) net.join(joinCode); else net.host();
  UI.banner(joinCode ? 'Joining room…' : 'Opening room…', 'warn', 8000);
}

$('#lobby-ready').addEventListener('click', () => {
  const me = net?.members.get(net.myId);
  if (me) net.setReady(!me.ready);
  renderLobby();
});

// Map voting: tap a card to vote, tap it again to clear your vote.
function voteMap(id) {
  if (!net) return;
  const me = net.members.get(net.myId);
  net.setVote(me?.vote === id ? null : id);
  renderLobby();
}

function renderLobby() {
  if (net) UI.renderLobby(net, voteMap);
}

// Everyone ready -> the host counts down and starts the fight automatically.
let autoStartTimer = null;
let autoStartAt = 0;

function cancelAutoStart() {
  clearInterval(autoStartTimer);
  autoStartTimer = null;
}

function lobbyAllReady() {
  const active = net.rosterList().filter(m => m.status !== 'gone');
  return active.length >= 2 && active.every(m => m.ready);
}

function maybeAutoStart() {
  const armed = net?.isHost && !session
    && !$('#screen-lobby').classList.contains('hidden') && lobbyAllReady();
  if (!armed) {
    if (autoStartTimer) {
      cancelAutoStart();
      if (net && !$('#screen-lobby').classList.contains('hidden')) renderLobby();
    }
    return;
  }
  if (!autoStartTimer) {
    autoStartAt = Date.now() + 3000;
    autoStartTimer = setInterval(maybeAutoStart, 250);
  }
  const left = Math.ceil((autoStartAt - Date.now()) / 1000);
  if (left <= 0) { startFight(); return; }
  $('#lobby-status').textContent = `All ready — starting in ${left}…`;
}

// Tally the lobby's map votes: most votes wins, ties break randomly among
// the leaders, and nobody voting means a random map for everyone.
function tallyMapVotes(active) {
  const counts = new Map();
  for (const m of active) {
    if (m.vote && MAP_IDS.includes(m.vote)) counts.set(m.vote, (counts.get(m.vote) || 0) + 1);
  }
  if (!counts.size) return MAP_IDS[(Math.random() * MAP_IDS.length) | 0];
  const top = Math.max(...counts.values());
  const leaders = [...counts.entries()].filter(([, n]) => n === top).map(([id]) => id);
  return leaders[(Math.random() * leaders.length) | 0];
}

function startFight() {
  cancelAutoStart();
  if (!net?.isHost || session) return;
  const active = net.rosterList().filter(m => m.status !== 'gone');
  // One active player = solo practice: the host still runs a normal
  // authoritative session so friends can drop in mid-fight.
  if (!active.length || !active.every(m => m.ready)) return;
  const players = active.map(m => ({
    id: m.peerId, name: m.name, color: m.color, build: sanitizeBuild(m.build), hat: sanitizeHat(m.hat),
  }));
  const seed = (Math.random() * 1e9) | 0;
  const map = tallyMapVotes(active);
  net.broadcast({ t: 'start', players, seed, map });
  startSession({ mode: 'host', myId: net.myId, players, seed, map });
}

$('#lobby-start').addEventListener('click', startFight);

$('#lobby-edit').addEventListener('click', () => {
  // Editing un-readies you so the fight can't auto-start while you shop.
  net?.setReady(false);
  openBuilder(false, 'lobby');
});

$('#lobby-leave').addEventListener('click', () => {
  cancelAutoStart();
  net?.leave(); net = null;
  pendingInvite = null;
  UI.showScreen('menu');
  presence?.update();
});

$('#lobby-invite').addEventListener('click', async () => {
  if (!net?.roomCode) return;
  const url = `${location.origin}${location.pathname}?join=${net.roomCode}`;
  const text = `Fight me in SmackTown! Room ${net.roomCode}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'SmackTown', text, url }); } catch (_) {} // cancel = fine
  } else {
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      UI.banner('Invite link copied!', 'good');
    } catch (_) {
      UI.banner(`Share this code: ${net.roomCode}`, 'warn');
    }
  }
});

// ---------------- game session ----------------
function startSession(cfg) {
  session?.stop();
  session = new Session(cfg);
  session.start();
  presence?.update();
}

// Cosmetic events the client already plays locally via prediction; the
// host's copies are dropped for our own fighter to avoid double effects.
const PREDICTED_EV = new Set(['jump', 'land', 'ledge', 'roll', 'swing', 'ability', 'shockwave', 'gale', 'mend', 'duck']);

class Session {
  constructor({ mode, myId, players, seed = 1, map = DEFAULT_MAP }) {
    this.mode = mode;               // 'solo' | 'host' | 'client'
    this.myId = myId;
    this.players = players;
    this.meta = new Map(players.map(p => [p.id, p]));
    this.seed = seed;
    this.map = map;
    this.game = null;               // authoritative sim (solo/host)
    this.snaps = [];                // client: interpolation buffer
    this.lastSnap = null;
    this.pendingEv = [];
    this.acc = 0;
    this.lastT = 0;
    this.lastInputSend = 0;
    this.pred = null;               // client: local mirror sim (prediction)
    this.inputSeq = 0;              // client: monotonically increasing per tick
    this.tickLog = [];              // client: per-tick inputs awaiting host ack
    this.corr = { x: 0, y: 0 };     // client: reconciliation smoothing offset
    this.pendActs = {};             // client: actions waiting for a sim tick
    this.acks = new Map();          // host: last input seq processed per client
    this.running = false;
    this.ended = false;
    this.raf = 0;
  }

  start() {
    if (this.mode !== 'client') this.game = new Game(this.players, this.seed, this.map);
    else this.pred = new Game(this.players, this.seed, this.map);
    renderer.setMap(this.map);
    const me = this.meta.get(this.myId);
    UI.showScreen('game');
    UI.buildHud(this.players);
    UI.setupAbilityButtons(sanitizeBuild(me.build).abilities);
    touch.setEnabled(true);
    this.running = true;
    this.lastT = performance.now();

    // one-time controls explainer
    if (!localStorage.getItem('smacktown.helped')) {
      $('#game-help').classList.remove('hidden');
      localStorage.setItem('smacktown.helped', '1');
    }
    try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch (_) {}

    this.raf = requestAnimationFrame(t => this.frame(t));
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    touch.setEnabled(false);
  }

  frame(t) {
    if (!this.running) return;
    const dt = Math.min(0.1, (t - this.lastT) / 1000);
    this.lastT = t;

    if (this.mode === 'client') this.clientFrame(t, dt);
    else this.hostFrame(t, dt);

    this.raf = requestAnimationFrame(tt => this.frame(tt));
  }

  // ----- authoritative loop (solo & host) -----
  hostFrame(t, dt) {
    this.game.setInput(this.myId, touch.poll());
    this.acc += dt;
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.game.step();
      if (this.game.events.length) {
        renderer.onEvents(this.game.events);
        this.gameEvents(this.game.events);
        this.pendingEv.push(...this.game.events);
      }
      if (this.mode === 'host' && net &&
          (this.game.tick % SNAP_RATE === 0 || this.game.over)) {
        const s = this.game.snapshot();
        s.ev = this.pendingEv.splice(0);
        s.ack = Object.fromEntries(this.acks);
        net.broadcast({ t: 'snap', s });
      }
      // Refresh lag compensation ~1/s from measured pings: victims are
      // rewound by each attacker's one-way latency + interp delay.
      if (this.mode === 'host' && net && this.game.tick % 60 === 0) {
        for (const [pid, m] of net.members) {
          if (pid === this.myId || !this.meta.has(pid)) continue;
          this.game.setLag(pid, Math.round((m.ping / 2 + 130) / 1000 / TICK));
        }
      }
      if (this.game.over) break;
    }
    const view = {
      fighters: this.game.fighters.map(f => ({
        id: f.id, x: f.x, y: f.y, vx: f.vx, vy: f.vy, facing: f.facing,
        pct: f.pct, stocks: f.stocks, state: f.state, dead: f.dead,
        invuln: f.invuln > 0, atk: f.atk, hb: this.game.hitboxFor(f), guard: f.guard,
        color: this.meta.get(f.id)?.color, hat: this.meta.get(f.id)?.hat, cds: f.cds,
      })),
      projectiles: this.game.projectiles,
    };
    this.renderView(view, dt);
    if (this.game.over && !this.ended) this.finish(this.game.winner?.id ?? null, view.fighters);
  }

  // ----- predicted loop (client) -----
  clientFrame(t, dt) {
    const inp = touch.poll();

    // Predict our own fighter locally at the sim rate so controls feel
    // instant; the host remains authoritative and corrects us via snapshots.
    // Edge actions are carried until a tick consumes them — render frames
    // can outpace sim ticks.
    for (const k of ['jump', 'ff', 'drop', 'ab0', 'ab1']) if (inp[k]) this.pendActs[k] = true;
    if (inp.atk) this.pendActs.atk = inp.atk;
    this.acc += dt;
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.inputSeq++;
      const tin = { mx: inp.mx, my: inp.my, ...this.pendActs };
      this.pendActs = {};
      this.pred.setInput(this.myId, tin);
      this.tickLog.push({ seq: this.inputSeq, inp: tin });
      if (this.tickLog.length > 180) this.tickLog.shift();
      const ev = this.pred.predictStep(this.myId);
      if (ev.length) renderer.onEvents(ev.filter(e => e.id === this.myId));
    }

    // ship inputs to the host (fresh actions immediately, stick at ~30 Hz)
    const hasAction = inp.jump || inp.ff || inp.atk || inp.ab0 || inp.ab1 || inp.drop;
    if (hasAction || t - this.lastInputSend > 33) {
      this.lastInputSend = t;
      net?.sendToHost({ t: 'input', inp, seq: this.inputSeq });
    }

    // bleed off any reconciliation correction so fixes never pop
    const decay = Math.pow(0.002, dt);
    this.corr.x *= decay; this.corr.y *= decay;

    const view = this.interpolate(performance.now() - 130);
    if (view) this.renderView(view, dt);

    const s = this.lastSnap;
    if (s && s.over && !this.ended) {
      this.finish(s.win, this.rowsToFighters(s.f));
    }
  }

  renderView(view, dt) {
    renderer.draw(view, dt, this.myId);
    UI.updateHud(view.fighters);
    const mine = view.fighters.find(f => f.id === this.myId);
    UI.updateAbilityButtons(mine?.cds);
  }

  // ----- network callbacks -----
  onRemoteInput(pid, inp, seq) {
    if (this.game && this.meta.has(pid)) {
      this.game.setInput(pid, inp || blankInput());
      if (seq) this.acks.set(pid, seq);
    }
  }

  onSnapshot(s, pid) {
    if (this.mode !== 'client' || pid !== net?.hostId) return;
    this.lastSnap = s;
    this.snaps.push({ rt: performance.now(), s });
    if (this.snaps.length > 40) this.snaps.shift();
    if (s.ev?.length) {
      // our own movement cosmetics already fired locally via prediction
      const evs = s.ev.filter(e => !(e.id === this.myId && PREDICTED_EV.has(e.e)));
      if (evs.length) renderer.onEvents(evs);
      this.gameEvents(s.ev);
    }
    this.reconcile(s);
  }

  // Reconciliation: overwrite our predicted fighter with the authoritative
  // row, replay inputs the host hasn't processed yet, then fold whatever
  // error remains into a decaying render offset so corrections are seamless.
  reconcile(s) {
    if (!this.pred) return;
    this.pred.projectiles.length = 0; // authoritative ones come via snapshots
    const row = (s.f || []).find(r => r[0] === this.myId);
    const mine = this.pred.fighters.find(f => f.id === this.myId);
    if (!row || !mine) return;
    const px = mine.x, py = mine.y;
    restoreFighter(mine, row);
    const ack = (s.ack && s.ack[this.myId]) || 0;
    if (this.tickLog.length && ack) {
      this.tickLog = this.tickLog.filter(e => e.seq > ack);
    }
    for (const e of this.tickLog) {
      this.pred.setInput(this.myId, e.inp);
      this.pred.predictStep(this.myId); // replay: events discarded
    }
    const ex = px - mine.x + this.corr.x, ey = py - mine.y + this.corr.y;
    // small error: smooth it; big error (KO, teleport): snap
    const big = Math.hypot(ex, ey) > 150;
    this.corr.x = big ? 0 : ex;
    this.corr.y = big ? 0 : ey;
  }

  onHostChanged() {
    if (!net || this.ended) return;
    if (this.mode === 'client' && net.isHost) {
      // Host dropped mid-fight and we won the election: resurrect the sim
      // from the freshest snapshot and carry on as the authority.
      this.mode = 'host';
      this.game = gameFromSnapshot(this.players, this.lastSnap, this.seed + 1);
      this.map = this.game.map;
      this.pred = null;
      this.tickLog = [];
      this.acc = 0;
      this.pendingEv = [];
      // Drop the departed host's fighter if they're no longer around.
      this.onRoster();
      UI.toast('You are now the host!');
    }
  }

  // Host: admit a late joiner into the running fight.
  addPlayer(p) {
    if (this.meta.has(p.id) || this.ended) return;
    this.players.push(p);
    this.meta.set(p.id, p);
    this.game?.addFighter(p);
    UI.buildHud(this.players);
  }

  // Client: the host re-broadcast the player list (someone joined mid-game).
  // Fold in anyone new; authoritative state arrives via snapshots.
  syncPlayers(players) {
    let changed = false;
    for (const p of players) {
      if (this.meta.has(p.id)) continue;
      this.players.push(p);
      this.meta.set(p.id, p);
      this.pred?.addFighter(p);
      this.game?.addFighter(p);
      changed = true;
    }
    if (changed) UI.buildHud(this.players);
  }

  onRoster() {
    // Authoritative side: fighters whose player vanished forfeit their stocks.
    if (!net || !this.game || this.mode === 'solo' || this.ended) return;
    for (const f of this.game.fighters) {
      if (f.dead || f.isBot || f.id === this.myId) continue;
      const m = net.members.get(f.id);
      const connLost = !m || (m.status === 'gone' && !net.conns.get(f.id)?.open);
      if (connLost) {
        f.dead = true;
        f.stocks = 0;
        this.game.events.push({ e: 'ko', x: f.x, y: f.y, id: f.id, stocks: 0 });
        UI.banner(`${this.meta.get(f.id)?.name || 'A fighter'} disconnected`, 'warn');
      }
    }
  }

  // ----- interpolation (client) -----
  rowsToFighters(rows) {
    return (rows || []).map(r => ({
      id: r[0], x: r[1], y: r[2], vx: r[3], vy: r[4], facing: r[5],
      pct: r[6], stocks: r[7], state: r[8], dead: !!r[9],
      invuln: !!r[10], atk: r[11] || null, cds: [r[12], r[13]],
      hb: r[14] ? { dx: r[14][0], dy: r[14][1], hw: r[14][2], hh: r[14][3], active: !!r[14][4] } : null,
      guard: r[28],
      color: this.meta.get(r[0])?.color, hat: this.meta.get(r[0])?.hat,
    }));
  }

  interpolate(renderTime) {
    const buf = this.snaps;
    if (!buf.length) return null;
    let a = buf[0], b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].rt <= renderTime && buf[i + 1].rt >= renderTime) {
        a = buf[i]; b = buf[i + 1];
        break;
      }
    }
    const span = Math.max(1, b.rt - a.rt);
    const k = Math.max(0, Math.min(1, (renderTime - a.rt) / span));
    const fa = this.rowsToFighters(a.s.f);
    const fb = this.rowsToFighters(b.s.f);
    const fighters = fb.map(f2 => {
      const f1 = fa.find(x => x.id === f2.id) || f2;
      return { ...f2, x: f1.x + (f2.x - f1.x) * k, y: f1.y + (f2.y - f1.y) * k };
    });
    // our own fighter comes from the predicted sim, not the (delayed) buffer
    const mine = this.pred?.fighters.find(f => f.id === this.myId);
    if (mine) {
      const pv = {
        id: mine.id, x: mine.x + this.corr.x, y: mine.y + this.corr.y,
        vx: mine.vx, vy: mine.vy, facing: mine.facing,
        pct: mine.pct, stocks: mine.stocks, state: mine.state, dead: mine.dead,
        invuln: mine.invuln > 0, atk: mine.atk, hb: this.pred.hitboxFor(mine),
        guard: mine.guard,
        cds: mine.cds, color: this.meta.get(mine.id)?.color, hat: this.meta.get(mine.id)?.hat,
      };
      const i = fighters.findIndex(f => f.id === this.myId);
      if (i >= 0) fighters[i] = pv; else fighters.push(pv);
    }
    const projectiles = (b.s.p || []).map(p => ({ eid: p[0], kind: p[1], x: p[2], y: p[3] }));
    return { fighters, projectiles };
  }

  // ----- events & endgame -----
  gameEvents(events) {
    for (const ev of events) {
      if (ev.e === 'hit' && ev.vic === this.myId && navigator.vibrate) {
        navigator.vibrate(ev.heavy ? 40 : 15);
      }
      if (ev.e === 'ko') {
        const name = this.meta.get(ev.id)?.name || '???';
        UI.toast(ev.id === this.myId ? 'You got smacked!' : `${name} KO’d!`);
        if (navigator.vibrate && ev.id === this.myId) navigator.vibrate(80);
      }
      if (ev.e === 'gameover') UI.toast('GAME!', 2000);
    }
  }

  finish(winnerId, finalFighters) {
    this.ended = true;
    setTimeout(() => {
      this.stop();
      UI.renderResults(this.players, winnerId, finalFighters);
      $('#results-again').textContent = this.mode === 'solo' ? 'Rematch' : 'Back to Lobby';
      UI.showScreen('results');
      session = null;
      presence?.update();
      if (net) {
        // reset ready states for the next round
        net.setReady(false);
        if (net.isHost) {
          for (const m of net.members.values()) m.ready = false;
          net._broadcastRoster();
        }
      }
    }, 1600);
  }
}

// ---------------- game screen buttons ----------------
$('#help-close').addEventListener('click', () => $('#game-help').classList.add('hidden'));

$('#game-quit').addEventListener('click', () => {
  session?.stop();
  session = null;
  if (net) {
    renderLobby();
    UI.showScreen('lobby');
    net.setReady(false);
  } else {
    UI.showScreen('menu');
  }
  presence?.update();
});

$('#results-again').addEventListener('click', () => {
  if (net) {
    renderLobby();
    UI.showScreen('lobby');
  } else {
    $('#menu-solo').click();
  }
});

$('#results-menu').addEventListener('click', () => {
  net?.leave(); net = null;
  UI.showScreen('menu');
  presence?.update();
});

// Leaving the page: tell peers instead of ghosting them.
addEventListener('pagehide', () => { net?.leave(); presence?.stop(); });
addEventListener('pageshow', e => { if (e.persisted) presence?.start(); });

// Debug/testing handle (read-only peek at live state).
window.__smack = () => ({ session, net, profile, presence });
