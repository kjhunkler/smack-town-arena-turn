// Player profile: username, color, and fighter build. Persisted in localStorage.

export const COLORS = [
  '#ff5470', '#ffb02e', '#3ddc84', '#38b6ff',
  '#b388ff', '#ff8a5c', '#f5f5f5', '#00e5c3',
];

export const TOTAL_CREDITS = 1000;

export const STATS = [
  { id: 'power',   name: 'Power',   desc: '+7% damage & knockback per level',      cost: 80, max: 5 },
  { id: 'speed',   name: 'Speed',   desc: '+6% run speed per level',               cost: 80, max: 5 },
  { id: 'defense', name: 'Defense', desc: '-5% knockback taken per level',         cost: 80, max: 5 },
  { id: 'agility', name: 'Agility', desc: '+jump height & air control per level',  cost: 80, max: 5 },
];

export const ABILITIES = [
  { id: 'fireball',  icon: '🔥', name: 'Fireball',    cost: 220, cd: 3.0,
    desc: 'Hurl a projectile that burns for 6%' },
  { id: 'dashstrike',icon: '⚡', name: 'Dash Strike', cost: 200, cd: 4.0,
    desc: 'Lunge forward with a rushing blow' },
  { id: 'shockwave', icon: '💥', name: 'Shockwave',   cost: 250, cd: 6.0,
    desc: 'Slam the ground, blasting everyone nearby' },
  { id: 'uppercut',  icon: '🥊', name: 'Uppercut',    cost: 200, cd: 5.0,
    desc: 'Rising punch that launches enemies skyward' },
  { id: 'counter',   icon: '🛡️', name: 'Counter',     cost: 240, cd: 5.0,
    desc: 'Brief parry — negate a hit and strike back' },
  { id: 'blink',     icon: '✨', name: 'Blink',       cost: 260, cd: 4.0,
    desc: 'Teleport a short distance in any direction' },
  { id: 'boomerang', icon: '🪃', name: 'Boomerang',   cost: 230, cd: 4.0,
    desc: 'Bladed rang that flies out, then whips back' },
  { id: 'volley',    icon: '🎇', name: 'Fire Volley', cost: 250, cd: 5.0,
    desc: 'Loose a fan of three fire bolts' },
  { id: 'gale',      icon: '💨', name: 'Gale Burst',  cost: 220, cd: 5.0,
    desc: 'Blast of wind that flings everyone near you' },
  { id: 'bubble',    icon: '🫧', name: 'Bubble Shield', cost: 240, cd: 7.0,
    desc: 'Pop a shield — 1s of invulnerability' },
  { id: 'mend',      icon: '💚', name: 'Mend',        cost: 260, cd: 8.0,
    desc: 'Patch yourself up — instantly heal 15%' },
];

export const AUGMENTS = [
  { id: 'vampiric',    icon: '🩸', name: 'Vampiric',     cost: 180,
    desc: 'Heal 15% of the damage you deal' },
  { id: 'thorns',      icon: '🌵', name: 'Thorns',       cost: 150,
    desc: 'Melee attackers take 3% recoil damage' },
  { id: 'feather',     icon: '🪶', name: 'Featherweight',cost: 120,
    desc: '+1 midair jump, but you fly 8% further when hit' },
  { id: 'heavy',       icon: '🗿', name: 'Heavyweight',  cost: 160,
    desc: '-12% knockback taken, but -8% run speed' },
  { id: 'berserker',   icon: '😤', name: 'Berserker',    cost: 170,
    desc: '+25% damage while your own percent is 80+' },
  { id: 'secondwind',  icon: '💫', name: 'Second Wind',  cost: 200,
    desc: 'Once per stock: heal 30% when you pass 100%' },
  { id: 'glasscannon', icon: '💎', name: 'Glass Cannon', cost: 170,
    desc: '+20% damage & knockback dealt, +15% knockback taken' },
  { id: 'quickhands',  icon: '⏱️', name: 'Quick Hands',  cost: 180,
    desc: 'Ability cooldowns recover 25% faster' },
  { id: 'acrobat',     icon: '🤸', name: 'Acrobat',      cost: 150,
    desc: 'Landing a hit refreshes your air jumps' },
  { id: 'sniper',      icon: '🎯', name: 'Sniper',       cost: 160,
    desc: 'Your projectiles deal +30% damage' },
];

export const MAX_ABILITIES = 2;
export const MAX_AUGMENTS = 2;

// ---------- pixel hats ----------
// A hat is a HAT_W x HAT_H pixel grid drawn in the Hat Studio, worn above
// the fighter's head. Encoded as one string, row-major: '.' = transparent,
// '0'-'f' = an index into HAT_PALETTE. HAT_PX is world units per hat pixel;
// the box is centered on the head (x: ±36) with its brim at y = -16. The
// bottom HAT_FACE_ROWS rows hang below the brim, over the face — room for
// glasses, sideburns, masks. Hats saved before the face rows existed are
// zero-padded at the bottom by sanitizeHat, so old art keeps its position.
export const HAT_W = 24;
export const HAT_H = 23;
export const HAT_FACE_ROWS = 7;   // rows of the grid below the brim line
export const HAT_PX = 3;
export const HAT_CHARS = '0123456789abcdef';
export const HAT_PALETTE = [
  '#10122a', '#ffffff', '#9aa3c7', '#4a2c14',
  '#8a5a2b', '#ff5470', '#ffb02e', '#f5d76e',
  '#3ddc84', '#1e7a4a', '#38b6ff', '#2a5fd0',
  '#b388ff', '#ff8a5c', '#00e5c3', '#ff2e63',
];

// Valid hat string or null (malformed, wrong size, or fully transparent).
// Legacy hats from before the face rows are padded up to the new height.
export function sanitizeHat(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length === HAT_W * (HAT_H - HAT_FACE_ROWS)) {
    raw += '.'.repeat(HAT_W * HAT_FACE_ROWS);
  }
  if (raw.length !== HAT_W * HAT_H) return null;
  if (!/^[.0-9a-f]+$/.test(raw) || !/[0-9a-f]/.test(raw)) return null;
  return raw;
}

// ---------- hat library ----------
// Hats live in their own store, each under a unique id. The profile and any
// saved build reference their 'selected hat' by id instead of owning the art.

const HATS_KEY = 'smacktown.hats.v1';
export const MAX_HATS = 40;

export function loadHats() {
  try {
    const raw = JSON.parse(localStorage.getItem(HATS_KEY));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(h => h && typeof h.id === 'string' && sanitizeHat(h.art))
      .slice(0, MAX_HATS)
      .map(h => ({ id: h.id, art: sanitizeHat(h.art) }));
  } catch (_) { return []; }
}

// Resolve a hat id to its pixel art (null if unset or since deleted).
export function hatArt(id) {
  if (typeof id !== 'string') return null;
  return loadHats().find(h => h.id === id)?.art ?? null;
}

// Update an existing hat (matched by id) or mint a new one (id = null).
// Returns {ok, id} or {ok:false, error} with a message fit to show the player.
export function saveHat(art, id = null) {
  const a = sanitizeHat(art);
  if (!a) return { ok: false, error: 'Paint at least one pixel first!' };
  const list = loadHats();
  const i = id ? list.findIndex(h => h.id === id) : -1;
  if (i >= 0) {
    list[i] = { id, art: a };
  } else {
    if (list.length >= MAX_HATS) {
      return { ok: false, error: `You can keep up to ${MAX_HATS} hats — delete one first.` };
    }
    id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    list.push({ id, art: a });
  }
  localStorage.setItem(HATS_KEY, JSON.stringify(list));
  return { ok: true, id };
}

export function deleteHat(id) {
  localStorage.setItem(HATS_KEY, JSON.stringify(loadHats().filter(h => h.id !== id)));
}

export function emptyBuild() {
  return {
    stats: { power: 0, speed: 0, defense: 0, agility: 0 },
    abilities: [],
    augments: [],
  };
}

export function buildCost(build) {
  let total = 0;
  for (const s of STATS) total += (build.stats[s.id] || 0) * s.cost;
  for (const id of build.abilities) {
    const a = ABILITIES.find(x => x.id === id);
    if (a) total += a.cost;
  }
  for (const id of build.augments) {
    const a = AUGMENTS.find(x => x.id === id);
    if (a) total += a.cost;
  }
  return total;
}

// Clamp/repair an incoming build (also used by the host to validate remote
// players so nobody joins with an over-budget build).
export function sanitizeBuild(raw) {
  const b = emptyBuild();
  if (raw && typeof raw === 'object') {
    for (const s of STATS) {
      const v = raw.stats && raw.stats[s.id];
      b.stats[s.id] = Math.min(s.max, Math.max(0, Math.floor(Number(v) || 0)));
    }
    if (Array.isArray(raw.abilities)) {
      b.abilities = raw.abilities
        .filter(id => ABILITIES.some(a => a.id === id))
        .slice(0, MAX_ABILITIES);
    }
    if (Array.isArray(raw.augments)) {
      b.augments = raw.augments
        .filter(id => AUGMENTS.some(a => a.id === id))
        .slice(0, MAX_AUGMENTS);
    }
  }
  if (buildCost(b) > TOTAL_CREDITS) return emptyBuild();
  return b;
}

const KEY = 'smacktown.profile.v1';
let profile = null;

export function loadProfile() {
  if (profile) return profile;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw.name === 'string' && raw.name.trim()) {
      let hatId = typeof raw.hatId === 'string' ? raw.hatId : null;
      if (!hatId && sanitizeHat(raw.hat)) {
        const res = saveHat(raw.hat);        // migrate pre-library inline art
        if (res.ok) hatId = res.id;
      }
      profile = {
        name: String(raw.name).slice(0, 14),
        color: COLORS.includes(raw.color) ? raw.color : COLORS[0],
        build: sanitizeBuild(raw.build),
        hatId,
        hat: hatArt(hatId),                  // resolved art — what the room sees
      };
      localStorage.setItem(KEY, JSON.stringify(profile));
      return profile;
    }
  } catch (_) { /* corrupted storage — treat as first run */ }
  return null;
}

export function saveProfile(p) {
  const hatId = hatArt(p.hatId) ? p.hatId : null;
  profile = {
    name: String(p.name).trim().slice(0, 14),
    color: COLORS.includes(p.color) ? p.color : COLORS[0],
    build: sanitizeBuild(p.build),
    hatId,
    hat: hatArt(hatId),
  };
  localStorage.setItem(KEY, JSON.stringify(profile));
  return profile;
}

export function validName(name) {
  const n = String(name || '').trim();
  return n.length >= 2 && n.length <= 14 && /^[\w \-'!.]+$/.test(n);
}

// Derived combat stats used by the sim (must match on host & clients).
export function derivedStats(build) {
  const b = sanitizeBuild(build);
  const has = id => b.augments.includes(id);
  const glass = has('glasscannon');
  return {
    dmgMult:   (1 + 0.07 * b.stats.power) * (glass ? 1.2 : 1),
    kbMult:    (1 + 0.07 * b.stats.power) * (glass ? 1.2 : 1),
    speedMult: (1 + 0.06 * b.stats.speed) * (has('heavy') ? 0.92 : 1),
    kbTaken:   (1 - 0.05 * b.stats.defense) * (has('heavy') ? 0.88 : 1)
      * (has('feather') ? 1.08 : 1) * (glass ? 1.15 : 1),
    jumpMult:  1 + 0.05 * b.stats.agility,
    airMult:   1 + 0.08 * b.stats.agility,
    maxJumps:  2 + (has('feather') ? 1 : 0),
    cdMult:    has('quickhands') ? 0.75 : 1,
    abilities: b.abilities,
    augments:  b.augments,
  };
}

// ---------- saved builds (loadouts) ----------
// Nicknamed presets the player can stash and swap between in the workshop.

const LOADOUT_KEY = 'smacktown.loadouts.v1';
export const MAX_LOADOUTS = 8;

export function validLoadoutName(name) {
  const n = String(name || '').trim();
  return n.length >= 1 && n.length <= 16 && /^[\w \-'!.]+$/.test(n);
}

export function loadLoadouts() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOADOUT_KEY));
    if (!Array.isArray(raw)) return [];
    let migrated = false;
    const list = raw
      .filter(l => l && validLoadoutName(l.name))
      .slice(0, MAX_LOADOUTS)
      .map(l => {
        let hatId = typeof l.hatId === 'string' ? l.hatId : null;
        if (!hatId && sanitizeHat(l.hat)) {
          const res = saveHat(l.hat);        // migrate pre-library inline art
          if (res.ok) { hatId = res.id; migrated = true; }
        }
        return {
          name: String(l.name).trim().slice(0, 16),
          color: COLORS.includes(l.color) ? l.color : COLORS[0],
          build: sanitizeBuild(l.build),
          hatId,
        };
      });
    if (migrated) localStorage.setItem(LOADOUT_KEY, JSON.stringify(list));
    return list;
  } catch (_) { return []; }
}

// Saves (or overwrites, matched by name) a loadout. Returns {ok} or
// {ok:false, error} with a message fit to show the player.
export function saveLoadout(name, color, build, hatId = null) {
  if (!validLoadoutName(name)) {
    return { ok: false, error: 'Nicknames are 1–16 letters, numbers or basic punctuation.' };
  }
  const n = String(name).trim().slice(0, 16);
  const list = loadLoadouts();
  const entry = {
    name: n,
    color: COLORS.includes(color) ? color : COLORS[0],
    build: sanitizeBuild(build),
    hatId: hatArt(hatId) ? hatId : null,
  };
  const i = list.findIndex(l => l.name.toLowerCase() === n.toLowerCase());
  if (i >= 0) list[i] = entry;
  else if (list.length >= MAX_LOADOUTS) {
    return { ok: false, error: `You can keep up to ${MAX_LOADOUTS} builds — delete one first.` };
  } else list.push(entry);
  localStorage.setItem(LOADOUT_KEY, JSON.stringify(list));
  return { ok: true };
}

export function deleteLoadout(name) {
  const n = String(name || '').trim().toLowerCase();
  const list = loadLoadouts().filter(l => l.name.toLowerCase() !== n);
  localStorage.setItem(LOADOUT_KEY, JSON.stringify(list));
  const sel = selectedLoadout();
  if (sel && sel.toLowerCase() === n) selectLoadout(null);
}

// ---------- selected character ----------
// Which saved build the player is currently "being". Tracked by nickname;
// the menu arrows cycle it and the workshop saves back into it.

const SEL_KEY = 'smacktown.loadout.sel.v1';

// Canonical name of the selected loadout, or null if none / since deleted.
export function selectedLoadout() {
  const raw = localStorage.getItem(SEL_KEY);
  if (!raw) return null;
  const hit = loadLoadouts().find(l => l.name.toLowerCase() === raw.toLowerCase());
  return hit ? hit.name : null;
}

export function selectLoadout(name) {
  if (name) localStorage.setItem(SEL_KEY, String(name).trim().slice(0, 16));
  else localStorage.removeItem(SEL_KEY);
}

export function buildSummary(build) {
  const b = sanitizeBuild(build);
  const parts = [];
  const statBits = STATS.filter(s => b.stats[s.id] > 0)
    .map(s => `${s.name} ${b.stats[s.id]}`);
  if (statBits.length) parts.push(statBits.join(' · '));
  const abil = b.abilities.map(id => ABILITIES.find(a => a.id === id)?.name).filter(Boolean);
  if (abil.length) parts.push(abil.join(' + '));
  const augs = b.augments.map(id => AUGMENTS.find(a => a.id === id)?.name).filter(Boolean);
  if (augs.length) parts.push(augs.join(' + '));
  return parts.length ? parts.join('\n') : 'Stock fighter — visit the workshop!';
}
