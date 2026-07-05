// Fight simulation. Host-authoritative: the host steps this at 60 Hz using
// everyone's latest inputs and broadcasts snapshots; clients interpolate.
// All tuning constants live here so host handoff resumes identical rules.

import { derivedStats } from './profile.js';

export const TICK = 1 / 60;
export const SNAP_RATE = 3;          // broadcast every 3rd tick (20 Hz)

// Maps in world units (1u ≈ 1px at zoom 1). Every map is one solid main
// floor plus optional drop-through platforms, so all mechanics (ledges,
// drop-through, blast KOs) work everywhere. Visual themes live in render.js.
export const MAPS = {
  battlefield: {
    name: 'Battlefield',
    main: { x: -340, y: 0, w: 680, h: 46 },              // solid ground (top at y=0)
    plats: [                                             // drop-through platforms
      { x: -230, y: -130, w: 170 },
      { x: 60,   y: -130, w: 170 },
      { x: -85,  y: -250, w: 170 },
    ],
    blast: { l: -1150, r: 1150, t: -950, b: 500 },
    spawns: [ -240, 240, -80, 80 ],
    respawnY: -320,
  },
  flatlands: {
    name: 'Flatlands',
    main: { x: -520, y: 0, w: 1040, h: 46 },             // wide open ground, no plats
    plats: [],
    blast: { l: -1300, r: 1300, t: -950, b: 500 },
    spawns: [ -380, 380, -130, 130 ],
    respawnY: -320,
  },
  skyline: {
    name: 'Skyline',
    main: { x: -250, y: 0, w: 500, h: 46 },              // tight ground, aerial towers
    plats: [
      { x: -350, y: -160, w: 150 },
      { x: 200,  y: -160, w: 150 },
      { x: -80,  y: -300, w: 160 },
      { x: -80,  y: -440, w: 160 },
    ],
    blast: { l: -1100, r: 1100, t: -1050, b: 500 },
    spawns: [ -180, 180, -60, 60 ],
    respawnY: -380,
  },
};
export const DEFAULT_MAP = 'battlefield';
export const MAP_IDS = Object.keys(MAPS);

const GRAV = 2600, MAX_FALL = 1150, FASTFALL = 1750;
const RUN = 380, AIR_ACCEL = 1450, GROUND_ACCEL = 3400, FRICTION = 2400;
const JUMP_V = 860, JUMP2_V = 780;
const LEDGE_JUMP_V = 1120;           // ledge super jump — spends no air jump
const LEDGE_INVULN = 0.6, LEDGE_MAX_HANG = 4.0, REGRAB_CD = 0.45;
const LEDGE_HANG_Y = 22;             // fighter center hangs this far below the lip
const ROLL_TIME = 0.38, ROLL_DIST = 150; // ledge getup roll onto the stage
const F_W = 46, F_H = 64;            // fighter hurtbox
const STOCKS = 3;
const RESPAWN_INVULN = 2.0;
const HIT_PAUSE = 0.045;
const BUFFER = 0.15;                 // edge-input buffer window (s)

// Ducking: hold down while grounded to squat behind a guard. Straight
// projectiles sail clean over a ducked head; melee that connects deals
// chip damage and a shove instead of a launch, but the guard meter
// drains while held and eats the full raw damage of every blocked hit.
// At zero the guard crushes: a crumple stun that takes bonus knockback.
// Down-aimed attacks (dair/dsmash/spikes/aimed-down) pierce the duck.
const DUCK_H = 24;                   // ducked hurtbox height (stands 64)
const DUCK_DMG_TAKEN = 0.5;          // chip damage multiplier while ducking
const DUCK_KB_TAKEN = 0.3;           // knockback multiplier while ducking
const DUCK_STANDUP = 0.07;           // delay before attacking after release
const GUARD_MAX = 100;
const GUARD_DRAIN = 12;              // per second while holding duck
const GUARD_REGEN = 20;              // per second while not ducking
const GUARD_REDUCK = 25;             // min guard needed to start a duck
const CRUSH_STUN = 1.0;              // crumple duration at guard zero
const CRUSH_KB_TAKEN = 1.3;         // knockback penalty while crushed

// attack archetypes: [damage, baseKb, kbScale, startup, active, recover, reach, angle]
const ATTACKS = {
  jab:    { dmg: 4,  kb: 130, ks: 9,  startup: .05, active: .09, rec: .12, rx: 52, ry: 26, ang: -10 },
  fsmash: { dmg: 13, kb: 240, ks: 22, startup: .16, active: .10, rec: .26, rx: 68, ry: 34, ang: -35 },
  usmash: { dmg: 11, kb: 230, ks: 21, startup: .14, active: .11, rec: .24, rx: 46, ry: 60, ang: -85, up: true },
  dsmash: { dmg: 10, kb: 210, ks: 19, startup: .13, active: .10, rec: .24, rx: 76, ry: 26, ang: -160, both: true },
  dair:   { dmg: 11, kb: 220, ks: 20, startup: .13, active: .12, rec: .22, rx: 40, ry: 56, ang: 80, down: true, spike: true },
};

const ABILITY_DEFS = {
  fireball:  { cd: 3.0 },
  dashstrike:{ cd: 4.0 },
  shockwave: { cd: 6.0 },
  uppercut:  { cd: 5.0 },
  counter:   { cd: 5.0 },
  blink:     { cd: 4.0 },
  boomerang: { cd: 4.0 },
  volley:    { cd: 5.0 },
  gale:      { cd: 5.0 },
  bubble:    { cd: 7.0 },
  mend:      { cd: 8.0 },
};

let nextEid = 1;

export class Game {
  // players: [{id, name, color, build, isBot}]
  constructor(players, seed = 1, mapId = DEFAULT_MAP) {
    this.map = MAPS[mapId] ? mapId : DEFAULT_MAP;
    this.stage = MAPS[this.map];
    this.tick = 0;
    this.over = false;
    this.winner = null;
    this.events = [];               // transient: hits/kos/sfx for renderer
    this.projectiles = [];
    this.hitPause = 0;
    this.rng = mulberry32(seed);
    this.fighters = players.map((p, i) => this._spawnFighter(p, i));
    this.inputs = new Map();        // id -> latest input
    for (const f of this.fighters) this.inputs.set(f.id, blankInput());
    this.hist = [];                 // recent positions per tick (lag compensation)
    this.lagComp = new Map();       // attacker id -> ticks to rewind their victims
  }

  _spawnFighter(p, i) {
    const st = derivedStats(p.build);
    return {
      id: p.id, name: p.name, color: p.color, isBot: !!p.isBot, st,
      x: this.stage.spawns[i % this.stage.spawns.length], y: -F_H / 2,
      vx: 0, vy: 0, facing: i % 2 === 0 ? 1 : -1,
      grounded: true, jumps: st.maxJumps, fastfall: false,
      pct: 0, stocks: STOCKS,
      state: 'idle',                // idle|run|air|attack|hitstun|ledge|roll|dead|respawn
      stateT: 0,
      atk: null,                    // active attack name
      atkDir: null,                 // 8-way aim at attack start {x,y} or null
      atkHit: new Set(),
      invuln: 0, counterT: 0, dashT: 0,
      guard: GUARD_MAX, standT: 0,  // duck guard meter & stand-up delay
      cds: [0, 0],                  // ability cooldowns (seconds remaining)
      usedSecondWind: false,
      dropT: 0,                     // drop-through timer
      ledge: 0,                     // hanging: -1 left lip, 1 right lip, 0 none
      regrabT: 0,                   // cooldown before the ledge can be regrabbed
      rollDir: 0,
      dead: false,
      lastDir: { x: 1, y: 0 },
    };
  }

  // Drop a late joiner into a running fight. They enter like a respawn —
  // descending from above with spawn invulnerability — so they can't be
  // camped the instant they appear.
  addFighter(p) {
    if (this.fighters.some(f => f.id === p.id)) return null;
    const f = this._spawnFighter(p, this.fighters.length);
    f.y = this.stage.respawnY;
    f.grounded = false;
    f.state = 'respawn';
    f.stateT = 0;
    f.invuln = RESPAWN_INVULN;
    this.fighters.push(f);
    this.inputs.set(f.id, blankInput());
    return f;
  }

  setInput(id, inp) {
    const cur = this.inputs.get(id);
    if (!cur) return;
    // Movement is level-triggered; actions are edge-triggered and buffered
    // for a short window (like classic fighting games) so a press during
    // hitstun or an attack still comes out the moment the fighter can act.
    cur.mx = clamp(inp.mx, -1, 1);
    cur.my = clamp(inp.my, -1, 1);
    if (inp.jump) { cur.jump = true; cur.bufJ = BUFFER; }
    cur.ff ||= !!inp.ff;
    cur.drop ||= !!inp.drop;
    if (inp.atk) { cur.atk = inp.atk; cur.bufA = BUFFER; } // {kind:'tap'|'up'|'down'|'side', dir}
    if (inp.ab0) { cur.ab0 = true; cur.buf0 = BUFFER; }
    if (inp.ab1) { cur.ab1 = true; cur.buf1 = BUFFER; }
  }

  // How far back (in ticks) this peer's victims are rewound when their
  // attacks resolve. Host sets it from measured RTT; capped at 400 ms.
  setLag(id, ticks) {
    this.lagComp.set(id, clamp(ticks | 0, 0, 24));
  }

  step() {
    if (this.over) return;
    this.tick++;
    this.events.length = 0;
    if (this.hitPause > 0) { this.hitPause -= TICK; return; }

    for (const f of this.fighters) {
      if (f.dead) continue;
      if (f.isBot) this._botThink(f);
      this._stepFighter(f, this.inputs.get(f.id));
    }
    this._stepProjectiles();
    this._recordHistory();
    this._resolveAttacks();
    this._checkBlast();

    const alive = this.fighters.filter(f => !f.dead);
    if (alive.length <= (this.fighters.length > 1 ? 1 : 0)) {
      this.over = true;
      this.winner = alive[0] || null;
      this.events.push({ e: 'gameover' });
    }
  }

  // ---------- fighter physics & actions ----------

  _stepFighter(f, inp) {
    f.stateT += TICK;
    f.invuln = Math.max(0, f.invuln - TICK);
    f.counterT = Math.max(0, f.counterT - TICK);
    f.dashT = Math.max(0, f.dashT - TICK);
    f.dropT = Math.max(0, f.dropT - TICK);
    f.regrabT = Math.max(0, f.regrabT - TICK);
    f.standT = Math.max(0, f.standT - TICK);
    f.cds[0] = Math.max(0, f.cds[0] - TICK);
    f.cds[1] = Math.max(0, f.cds[1] - TICK);

    if (f.state === 'respawn') {
      if (f.stateT > 0.8) { f.state = 'air'; }
      else { f.y = this.stage.respawnY; f.vx = 0; f.vy = 0; this._decayInput(inp); return; }
    }
    if (f.state === 'ledge') { this._stepLedge(f, inp); return; }
    if (f.state === 'roll') { this._stepRoll(f, inp); return; }

    const inHitstun = f.state === 'hitstun';
    const inAttack = f.state === 'attack';
    const inDuck = f.state === 'duck';
    const inCrush = f.state === 'crush';
    const canAct = !inHitstun && !inAttack && !inCrush;

    if (Math.abs(inp.mx) > 0.15) f.lastDir = { x: Math.sign(inp.mx), y: inp.my };

    // --- ducking (hold the stick mostly-down while grounded) ---
    const wantDuck = f.grounded && inp.my > 0.6 && inp.my >= Math.abs(inp.mx);
    if (inDuck) {
      f.guard = Math.max(0, f.guard - GUARD_DRAIN * TICK);
      if (f.guard <= 0) this._crushGuard(f);
      else if (!wantDuck) {
        f.state = f.grounded ? 'idle' : 'air';
        f.stateT = 0;
        f.standT = DUCK_STANDUP;   // brief stand-up before attacks come out
      }
    } else {
      f.guard = Math.min(GUARD_MAX, f.guard + GUARD_REGEN * TICK);
      if (wantDuck && canAct && f.guard >= GUARD_REDUCK) {
        f.state = 'duck';
        f.stateT = 0;
        this.events.push({ e: 'duck', id: f.id, x: f.x, y: f.y + F_H / 2 });
      }
    }
    const ducking = f.state === 'duck';

    // --- horizontal movement ---
    if (!inHitstun && !inCrush && f.dashT <= 0) {
      const want = inp.mx * RUN * f.st.speedMult;
      if (f.grounded) {
        if (Math.abs(inp.mx) > 0.15 && canAct && !ducking) {
          f.vx = approach(f.vx, want, GROUND_ACCEL * TICK);
          f.facing = Math.sign(inp.mx) || f.facing;
          f.state = 'run';
        } else {
          f.vx = approach(f.vx, 0, FRICTION * TICK);
          if (canAct && !ducking) f.state = 'idle';
        }
      } else {
        if (Math.abs(inp.mx) > 0.15) {
          f.vx = approach(f.vx, want, AIR_ACCEL * f.st.airMult * TICK);
          if (canAct) f.facing = Math.sign(inp.mx) || f.facing;
        }
      }
    }

    // --- jumping / fast fall / drop-through ---
    if (canAct && inp.jump && f.jumps > 0) {
      f.vy = -(f.grounded || f.jumps === f.st.maxJumps ? JUMP_V : JUMP2_V) * f.st.jumpMult;
      f.jumps--;
      f.grounded = false;
      f.fastfall = false;
      f.state = 'air';
      f.standT = 0;
      inp.jump = false;
      this.events.push({ e: 'jump', id: f.id, x: f.x, y: f.y + F_H / 2 });
    }
    if (inp.ff && !f.grounded && f.vy > -200) f.fastfall = true;
    if (inp.drop && f.grounded) f.dropT = 0.25;    // fall through platforms
    inp.ff = inp.drop = false;

    // --- attacks & abilities (locked while ducking / standing up / crushed) ---
    const mayAct = canAct && f.state !== 'duck' && f.standT <= 0;
    if (mayAct && inp.atk) { this._startAttack(f, inp.atk); inp.atk = null; }
    if (mayAct && inp.ab0) { this._useAbility(f, 0); inp.ab0 = false; }
    if (mayAct && inp.ab1) { this._useAbility(f, 1); inp.ab1 = false; }

    // attack state machine
    if (inAttack) {
      const a = ATTACKS[f.atk];
      const total = a.startup + a.active + a.rec;
      if (f.stateT >= total) { f.state = f.grounded ? 'idle' : 'air'; f.atk = null; f.atkDir = null; f.atkHit.clear(); }
    }
    if (inHitstun && f.stateT >= f.hitstunFor) { f.state = 'air'; }
    if (inCrush && f.stateT >= CRUSH_STUN) { f.state = f.grounded ? 'idle' : 'air'; }

    // --- gravity & integration ---
    if (!f.grounded) {
      const cap = f.fastfall ? FASTFALL : MAX_FALL;
      f.vy = Math.min(cap, f.vy + GRAV * TICK);
    }
    f.x += f.vx * TICK;
    f.y += f.vy * TICK;

    this._collide(f);
    this._tryLedgeGrab(f);
    this._decayInput(inp);
  }

  _decayInput(inp) {
    inp.ff = inp.drop = false;
    if ((inp.bufJ -= TICK) <= 0) inp.jump = false;
    if ((inp.bufA -= TICK) <= 0) inp.atk = null;
    if ((inp.buf0 -= TICK) <= 0) inp.ab0 = false;
    if ((inp.buf1 -= TICK) <= 0) inp.ab1 = false;
  }

  _collide(f) {
    const wasGrounded = f.grounded;
    f.grounded = false;
    const feet = f.y + F_H / 2;

    // solid main stage: land on top, push out of sides
    const m = this.stage.main;
    if (f.vy >= 0 && feet >= m.y && feet <= m.y + 42 && f.x > m.x - F_W / 2 && f.x < m.x + m.w + F_W / 2) {
      f.y = m.y - F_H / 2; f.vy = 0; f.grounded = true;
    } else if (f.y + F_H / 2 > m.y + 6 && f.y - F_H / 2 < m.y + m.h) {
      if (f.x > m.x - F_W / 2 && f.x < m.x + F_W / 4) { f.x = m.x - F_W / 2; if (f.vx > 0) f.vx = 0; }
      else if (f.x < m.x + m.w + F_W / 2 && f.x > m.x + m.w - F_W / 4) { f.x = m.x + m.w + F_W / 2; if (f.vx < 0) f.vx = 0; }
    }

    // drop-through platforms (only when falling, not dropping through)
    if (f.dropT <= 0 && f.vy >= 0) {
      for (const p of this.stage.plats) {
        if (feet >= p.y && feet <= p.y + 22 && f.x > p.x && f.x < p.x + p.w) {
          f.y = p.y - F_H / 2; f.vy = 0; f.grounded = true;
          break;
        }
      }
    }

    if (f.grounded && !wasGrounded) {
      f.jumps = f.st.maxJumps;
      f.fastfall = false;
      if (f.state === 'air' || f.state === 'hitstun') f.state = 'idle';
      this.events.push({ e: 'land', id: f.id, x: f.x, y: f.y + F_H / 2 });
    }
  }

  // ---------- ledge grabs (main floor lips only, never platforms) ----------

  _tryLedgeGrab(f) {
    // 'air' and 'run' are both free-fall here: walking off an edge keeps the
    // run state while airborne. Anything else (attack/hitstun/...) can't grab.
    if (f.grounded || (f.state !== 'air' && f.state !== 'run')) return;
    if (f.vy <= 0 || f.fastfall || f.regrabT > 0) return;
    const m = this.stage.main;
    for (const side of [-1, 1]) {
      const lipX = side < 0 ? m.x : m.x + m.w;
      const dx = (f.x - lipX) * side;        // >0 = outside the stage
      const dy = f.y - m.y;                  // fighter center below the lip
      if (f.vx * side > 40) continue;        // moving away from the stage: no snag
      if (dx > -8 && dx < 42 && dy > -26 && dy < 64) {
        f.state = 'ledge';
        f.stateT = 0;
        f.ledge = side;
        f.vx = 0; f.vy = 0;
        f.jumps = f.st.maxJumps;             // hanging refreshes air jumps, like landing
        f.fastfall = false;
        f.atk = null; f.melee = null;
        f.invuln = Math.max(f.invuln, LEDGE_INVULN);
        this.events.push({ e: 'ledge', id: f.id, x: lipX, y: m.y });
        return;
      }
    }
  }

  _stepLedge(f, inp) {
    const m = this.stage.main;
    const lipX = f.ledge < 0 ? m.x : m.x + m.w;
    f.x = lipX + f.ledge * (F_W / 2 - 6);    // hands over the lip, body outside
    f.y = m.y + LEDGE_HANG_Y;
    f.vx = 0; f.vy = 0;
    f.facing = -f.ledge;                     // face the stage
    f.grounded = false;

    if (inp.jump) {
      // super jump — stronger than a ground jump and spends no air jump
      f.state = 'air'; f.stateT = 0;
      f.vy = -LEDGE_JUMP_V * f.st.jumpMult;
      f.vx = -f.ledge * 60;
      f.regrabT = REGRAB_CD;
      inp.jump = false; inp.bufJ = 0;
      this.events.push({ e: 'jump', id: f.id, x: f.x, y: f.y + F_H / 2 });
    } else if (inp.atk) {
      // getup roll: pop onto the stage and tumble inward, briefly invulnerable
      f.state = 'roll'; f.stateT = 0;
      f.rollDir = -f.ledge;
      f.y = m.y - F_H / 2;
      f.grounded = true;
      f.invuln = Math.max(f.invuln, ROLL_TIME + 0.1);
      f.regrabT = REGRAB_CD;
      inp.atk = null; inp.bufA = 0;
      this.events.push({ e: 'roll', id: f.id, x: f.x, y: f.y });
    } else if (inp.ff || inp.drop || inp.my > 0.6 || f.ledge * inp.mx > 0.7
        || f.stateT > LEDGE_MAX_HANG) {
      // let go: down input, push away from the stage, or hang timeout
      f.state = 'air'; f.stateT = 0;
      f.regrabT = REGRAB_CD;
      f.fastfall = false;
    }
    this._decayInput(inp);
  }

  _stepRoll(f, inp) {
    const m = this.stage.main;
    f.x = clamp(f.x + f.rollDir * (ROLL_DIST / ROLL_TIME) * TICK,
      m.x + F_W / 2, m.x + m.w - F_W / 2);
    f.y = m.y - F_H / 2;
    f.vx = 0; f.vy = 0;
    f.grounded = true;
    if (f.stateT >= ROLL_TIME) { f.state = 'idle'; f.facing = f.rollDir; }
    this._decayInput(inp);
  }

  // Guard meter hit zero: crumple stun. Pops the fighter up a touch and
  // leaves them taking bonus knockback until the stun runs out.
  _crushGuard(f) {
    f.guard = 0;
    f.state = 'crush';
    f.stateT = 0;
    f.standT = 0;
    f.vy = Math.min(f.vy, -300);
    f.grounded = false;
    f.atk = null; f.atkDir = null; f.melee = null;
    this.events.push({ e: 'crush', id: f.id, x: f.x, y: f.y });
  }

  _startAttack(f, atk) {
    // Aimed commands: {kind:'tap'|'swipe', dx, dy} with dx/dy in {-1,0,1}
    // (8-way). Legacy shapes {kind:'up'|'down'|'side'} from older peers
    // still convert. Taps are quick jabs aimed by movement; swipes are
    // smashes aimed by the swipe itself.
    let dx = atk.dx | 0, dy = atk.dy | 0;
    if (atk.kind === 'up') { dx = 0; dy = -1; }
    else if (atk.kind === 'down') { dx = 0; dy = 1; }
    else if (atk.kind === 'side') { dx = atk.dir || 1; dy = 0; }
    const swipe = atk.kind !== 'tap';

    let name;
    if (!swipe) {
      name = 'jab';
      // grounded straight-down tap: angle it forward so it isn't in the floor
      if (dy > 0 && !dx && f.grounded) dx = f.facing;
    } else if (dy < 0 && !dx) name = 'usmash';
    else if (dy > 0 && !dx) name = f.grounded ? 'dsmash' : 'dair';
    else name = 'fsmash';

    if (dx) f.facing = dx;
    f.state = 'attack';
    f.stateT = 0;
    f.atk = name;
    f.atkDir = (dx || dy) ? { x: dx, y: dy } : null;
    f.atkHit.clear();
    if (f.grounded) f.vx *= 0.35;
    // upward swipe in the air boosts you like an air jump — and costs none
    if (swipe && dy < 0 && !f.grounded) {
      f.vy = Math.min(f.vy, -JUMP2_V * f.st.jumpMult * (dx ? 0.75 : 1));
      f.fastfall = false;
    }
    this.events.push({ e: 'swing', id: f.id, atk: name, x: f.x, y: f.y, dx, dy });
  }

  _useAbility(f, slot) {
    const id = f.st.abilities[slot];
    if (!id || f.cds[slot] > 0) return;
    const def = ABILITY_DEFS[id];
    f.cds[slot] = def.cd * (f.st.cdMult || 1);
    const dir = f.lastDir;
    switch (id) {
      case 'fireball':
        this.projectiles.push({
          eid: nextEid++, kind: 'fireball', owner: f.id,
          x: f.x + f.facing * 40, y: f.y - 8,
          vx: f.facing * 620, vy: 0, ttl: 1.4,
          dmg: 6, kb: 170, ks: 13, r: 14,
        });
        break;
      case 'dashstrike':
        f.dashT = 0.22;
        f.vx = f.facing * 950;
        f.vy = 0;
        f.melee = { name: 'dash', dmg: 8, kb: 200, ks: 16, rx: 50, ry: 30, ang: -20, until: this.tick + 14, hit: new Set() };
        break;
      case 'shockwave':
        if (!f.grounded) { f.vy = FASTFALL; f.fastfall = true; f.pendingShock = true; }
        else this._shockwave(f);
        break;
      case 'uppercut':
        f.vy = -900;
        f.grounded = false;
        f.melee = { name: 'upper', dmg: 9, kb: 260, ks: 20, rx: 44, ry: 60, ang: -88, until: this.tick + 16, hit: new Set() };
        break;
      case 'counter':
        f.counterT = 0.45;
        break;
      case 'blink': {
        const len = Math.hypot(dir.x, dir.y) > 0.3 ? 1 : 0;
        const dx = len ? dir.x : f.facing, dy = len ? dir.y : 0;
        const n = Math.hypot(dx, dy) || 1;
        f.x += (dx / n) * 150;
        f.y += (dy / n) * 150;
        f.y = Math.min(f.y, this.stage.main.y - F_H / 2); // never blink into the floor
        f.invuln = Math.max(f.invuln, 0.35);
        f.vy = Math.min(f.vy, 0);
        break;
      }
      case 'boomerang':
        this.projectiles.push({
          eid: nextEid++, kind: 'boomerang', owner: f.id,
          x: f.x + f.facing * 40, y: f.y - 8,
          vx: f.facing * 560, vy: 0, ttl: 1.5,
          ret: -f.facing * 1400,   // constant pull back toward the throw point
          dmg: 5, kb: 150, ks: 11, r: 15,
        });
        break;
      case 'volley':
        for (const vy of [-150, 0, 150]) {
          this.projectiles.push({
            eid: nextEid++, kind: 'bolt', owner: f.id,
            x: f.x + f.facing * 40, y: f.y - 8,
            vx: f.facing * 580, vy, ttl: 1.1,
            dmg: 4, kb: 140, ks: 10, r: 11,
          });
        }
        break;
      case 'gale':
        // radial windbox: little damage, lots of shove; works midair
        this.events.push({ e: 'gale', id: f.id, x: f.x, y: f.y });
        for (const o of this.fighters) {
          if (o.id === f.id || o.dead || o.invuln > 0) continue;
          const pos = this._rewound(o, f.id);
          const d = Math.hypot(pos.x - f.x, pos.y - f.y);
          if (d < 200) {
            this._applyHit(f, o, { dmg: 3, kb: 420, ks: 6 },
              Math.atan2(pos.y - f.y, pos.x - f.x) * 0.25 - Math.PI / 6, Math.sign(pos.x - f.x) || 1);
          }
        }
        break;
      case 'bubble':
        f.invuln = Math.max(f.invuln, 1.0);
        break;
      case 'mend':
        f.pct = Math.max(0, f.pct - 15);
        this.events.push({ e: 'mend', id: f.id, x: f.x, y: f.y });
        break;
    }
    this.events.push({ e: 'ability', id: f.id, ability: id, x: f.x, y: f.y });
  }

  _shockwave(f) {
    f.pendingShock = false;
    this.events.push({ e: 'shockwave', id: f.id, x: f.x, y: f.y + F_H / 2 });
    for (const o of this.fighters) {
      if (o.id === f.id || o.dead || o.invuln > 0) continue;
      const pos = this._rewound(o, f.id);
      const d = Math.hypot(pos.x - f.x, pos.y - f.y);
      if (d < 190) {
        this._applyHit(f, o, { dmg: 10, kb: 280, ks: 18 },
          Math.atan2(pos.y - f.y, pos.x - f.x) * 0.3 - Math.PI / 2.4, Math.sign(pos.x - f.x) || 1);
      }
    }
  }

  // ---------- combat resolution ----------

  // Lag compensation: the host remembers where everyone stood for the last
  // ~30 ticks. When an attack resolves, victims are tested at the position
  // the *attacker* saw (one-way latency + interpolation delay ago), so what
  // you see on your screen is what you hit.
  _recordHistory() {
    const p = new Map();
    for (const f of this.fighters) p.set(f.id, [f.x, f.y]);
    this.hist.push({ tk: this.tick, p });
    if (this.hist.length > 30) this.hist.shift();
  }

  _rewound(victim, attackerId) {
    const rw = this.lagComp.get(attackerId) | 0;
    if (rw <= 0) return victim;
    const want = this.tick - rw;
    for (let i = this.hist.length - 1; i >= 0; i--) {
      if (this.hist[i].tk <= want) {
        const p = this.hist[i].p.get(victim.id);
        return p ? { x: p[0], y: p[1] } : victim;
      }
    }
    return victim;
  }

  // Current melee hitbox for a fighter (offsets relative to its center), or
  // null when nothing threatens. active=false marks the windup telegraph
  // before the hit can actually connect. The renderer draws exactly this.
  hitboxFor(f) {
    if (f.dead) return null;
    if (f.state === 'attack' && f.atk) {
      const a = ATTACKS[f.atk];
      if (f.stateT <= a.startup + a.active) {
        return { ...meleeHitbox(f, a, f.atkDir), active: f.stateT >= a.startup };
      }
    }
    if (f.melee && this.tick <= f.melee.until) {
      return { ...meleeHitbox(f, f.melee), active: true };
    }
    return null;
  }

  _resolveAttacks() {
    for (const f of this.fighters) {
      if (f.dead) continue;

      // landed shockwave slam
      if (f.pendingShock && f.grounded) this._shockwave(f);

      // normal attacks during active window
      if (f.state === 'attack' && f.atk) {
        const a = ATTACKS[f.atk];
        if (f.stateT >= a.startup && f.stateT <= a.startup + a.active) {
          this._meleeHit(f, a, f.atkHit, a.ang, f.atkDir);
        }
      }

      // ability melee windows (dash strike / uppercut)
      if (f.melee) {
        if (this.tick > f.melee.until) f.melee = null;
        else this._meleeHit(f, f.melee, f.melee.hit, f.melee.ang);
      }
    }

    // projectiles vs fighters
    for (const pr of this.projectiles) {
      for (const o of this.fighters) {
        if (o.dead || o.id === pr.owner || o.invuln > 0) continue;
        const pos = this._rewound(o, pr.owner);
        const ob = hurtBox(o);
        if (Math.abs(pos.x - pr.x) < F_W / 2 + pr.r && Math.abs(pos.y + ob.dy - pr.y) < ob.hh + pr.r) {
          const att = this.fighters.find(x => x.id === pr.owner);
          if (o.counterT > 0) { pr.vx *= -1; pr.owner = o.id; this.events.push({ e: 'counter', x: o.x, y: o.y }); continue; }
          if (att) this._applyHit(att, o, pr, deg(-40), Math.sign(pr.vx) || 1);
          pr.ttl = 0;
        }
      }
    }
  }

  _meleeHit(f, spec, hitSet, angDeg, aim = null) {
    const hb = meleeHitbox(f, spec, aim);
    const cx = f.x + hb.dx, cy = f.y + hb.dy;
    const a = aim && (aim.x || aim.y) ? aim : null;
    for (const o of this.fighters) {
      if (o.id === f.id || o.dead || o.invuln > 0 || hitSet.has(o.id)) continue;
      const pos = this._rewound(o, f.id);
      const ob = hurtBox(o);
      if (Math.abs(pos.x - cx) < hb.hw + F_W / 2 && Math.abs(pos.y + ob.dy - cy) < hb.hh + ob.hh) {
        hitSet.add(o.id);
        if (o.counterT > 0) {
          // countered: attacker eats a reversal hit
          this.events.push({ e: 'counter', x: o.x, y: o.y });
          this._applyHit(o, f, { dmg: spec.dmg * 1.2, kb: 240, ks: 16 }, deg(-45), Math.sign(f.x - o.x) || 1);
          continue;
        }
        // launch direction follows the aim (8-way); neutral keeps archetype
        let ang = deg(angDeg), spike = !!spec.spike;
        let dirX = spec.both ? (Math.sign(o.x - f.x) || 1) : f.facing;
        if (a) {
          dirX = a.x || Math.sign(o.x - f.x) || f.facing;
          if (a.y > 0 && !f.grounded) spike = true;          // airborne down attacks spike
          else if (a.y > 0 && a.x) ang = deg(-18);           // grounded down-diag: semi-spike
          else if (a.y < 0 && a.x) ang = deg(-45);           // up-diag: diagonal launch
        }
        // low hits pierce a duck: spikes, dair/dsmash, anything aimed down
        const pierce = spike || !!spec.down || !!spec.both || !!(a && a.y > 0);
        this._applyHit(f, o, spec, ang, dirX, spike, pierce);
      }
    }
  }

  _applyHit(att, vic, spec, angRad, dirX, spike = false, pierce = false) {
    let dmg = spec.dmg * att.st.dmgMult;
    if (att.st.augments.includes('berserker') && att.pct >= 80) dmg *= 1.25;
    if (att.st.augments.includes('sniper') && spec.r) dmg *= 1.3; // projectile hit

    // ducked block: chip damage and a horizontal shove instead of a launch.
    // The guard eats the hit's full raw damage and crushes at zero.
    if (vic.state === 'duck' && !pierce) {
      const raw = dmg;
      dmg *= DUCK_DMG_TAKEN;
      vic.pct = Math.min(999, vic.pct + dmg);
      const kb = (spec.kb + spec.ks * dmg * (1 + vic.pct / 90))
        * att.st.kbMult * vic.st.kbTaken * DUCK_KB_TAKEN;
      vic.vx = Math.cos(angRad) * kb * dirX;
      vic.guard -= raw;
      if (vic.guard <= 0) this._crushGuard(vic);
      this.hitPause = Math.min(0.12, HIT_PAUSE + dmg * 0.004);
      this.events.push({ e: 'block', x: vic.x, y: vic.y - F_H / 2 + DUCK_H / 2, vic: vic.id });
      this.events.push({
        e: 'hit', x: vic.x, y: vic.y, dmg: Math.round(dmg),
        heavy: false, vic: vic.id, att: att.id,
      });
      return;
    }

    vic.pct = Math.min(999, vic.pct + dmg);

    // acrobat: connecting resets your air jumps, enabling aerial chases
    if (att.st.augments.includes('acrobat')) att.jumps = att.st.maxJumps;

    // vampiric heal & second wind
    if (att.st.augments.includes('vampiric')) att.pct = Math.max(0, att.pct - dmg * 0.15);
    if (vic.st.augments.includes('secondwind') && !vic.usedSecondWind && vic.pct >= 100) {
      vic.usedSecondWind = true;
      vic.pct = Math.max(0, vic.pct - 30);
      this.events.push({ e: 'secondwind', x: vic.x, y: vic.y });
    }
    // thorns recoil (melee only — projectiles have no body contact)
    if (vic.st.augments.includes('thorns') && !spec.r) {
      att.pct = Math.min(999, att.pct + 3);
    }

    // smash-style knockback: grows with victim percent
    const kb = (spec.kb + spec.ks * dmg * (1 + vic.pct / 90))
      * att.st.kbMult * vic.st.kbTaken
      * (vic.state === 'crush' ? CRUSH_KB_TAKEN : 1);
    const ang = spike ? Math.PI / 2 : angRad;   // spikes send straight down
    vic.vx = Math.cos(ang) * kb * dirX * (spike ? 0.15 : 1);
    vic.vy = Math.sin(ang) * kb;
    vic.grounded = false;
    vic.fastfall = false;
    vic.state = 'hitstun';
    vic.stateT = 0;
    vic.hitstunFor = Math.min(1.1, 0.08 + kb / 2600);
    vic.atk = null;
    vic.atkDir = null;
    vic.melee = null;

    this.hitPause = Math.min(0.12, HIT_PAUSE + dmg * 0.004);
    this.events.push({
      e: 'hit', x: vic.x, y: vic.y, dmg: Math.round(dmg),
      heavy: kb > 700, vic: vic.id, att: att.id,
    });
  }

  _stepProjectiles() {
    for (const pr of this.projectiles) {
      if (pr.ret) pr.vx += pr.ret * TICK;    // boomerang: decelerate, then return
      pr.x += pr.vx * TICK;
      pr.y += pr.vy * TICK;
      pr.ttl -= TICK;
      const m = this.stage.main;
      if (pr.y > m.y && pr.x > m.x && pr.x < m.x + m.w) pr.ttl = 0;
    }
    this.projectiles = this.projectiles.filter(p => p.ttl > 0);
  }

  _checkBlast() {
    const b = this.stage.blast;
    for (const f of this.fighters) {
      if (f.dead || f.state === 'respawn') continue;
      if (f.x < b.l || f.x > b.r || f.y < b.t || f.y > b.b) {
        f.stocks--;
        this.events.push({ e: 'ko', x: clamp(f.x, b.l, b.r), y: clamp(f.y, b.t, b.b), id: f.id, stocks: f.stocks });
        if (f.stocks <= 0) {
          f.dead = true;
          f.state = 'dead';
        } else {
          f.x = this.stage.spawns[this.fighters.indexOf(f) % this.stage.spawns.length];
          f.y = this.stage.respawnY;
          f.vx = 0; f.vy = 0;
          f.pct = 0;
          f.guard = GUARD_MAX; f.standT = 0;
          f.usedSecondWind = false;
          f.state = 'respawn';
          f.stateT = 0;
          f.invuln = RESPAWN_INVULN;
          f.jumps = f.st.maxJumps;
          f.melee = null;
        }
      }
    }
  }

  // ---------- practice bot ----------

  _botThink(f) {
    const inp = this.inputs.get(f.id);
    const target = this.fighters.find(o => o.id !== f.id && !o.dead);
    if (!target) return;
    if (f.state === 'ledge') {
      // hang a beat, then climb: usually the super jump, sometimes the roll
      if (f.stateT > 0.5) {
        if (this.rng() < 0.10) inp.jump = true;
        else if (this.rng() < 0.06) inp.atk = { kind: 'tap' };
      }
      return;
    }
    const dx = target.x - f.x, dy = target.y - f.y;
    const offstage = f.x < this.stage.main.x || f.x > this.stage.main.x + this.stage.main.w;

    inp.mx = 0; inp.my = 0;
    if (offstage) {
      // recover toward stage center
      inp.mx = f.x < 0 ? 1 : -1;
      if (f.vy > 100 && f.jumps > 0 && this.rng() < 0.25) inp.jump = true;
    } else {
      if (Math.abs(dx) > 60) inp.mx = Math.sign(dx) * (0.6 + 0.4 * this.rng());
      if (dy < -90 && f.grounded && this.rng() < 0.06) inp.jump = true;
      if (Math.abs(dx) < 85 && Math.abs(dy) < 70 && this.rng() < 0.10) {
        inp.atk = this.rng() < 0.55 ? { kind: 'tap', dx: 0, dy: 0 }
          : this.rng() < 0.5 ? { kind: 'swipe', dx: Math.sign(dx) || 1, dy: 0 }
          : { kind: 'swipe', dx: 0, dy: dy < -30 ? -1 : 1 };
      }
      if (f.pct > 70 && this.rng() < 0.02) inp.ab0 = true;
      // duck under a nearby swing; keep holding until the threat passes
      const threat = target.state === 'attack' && Math.abs(dx) < 140 && Math.abs(dy) < 60;
      if (f.grounded && threat
          && (f.state === 'duck' || (f.guard > 40 && this.rng() < 0.25))) {
        inp.mx = 0; inp.my = 1;
        inp.atk = null; inp.jump = false;
      }
    }
  }

  // ---------- client-side prediction ----------

  // Step ONLY the given fighter — movement, ledges, attack states — with no
  // combat resolution, projectiles, or KOs. Clients run this on a local
  // mirror sim so their own fighter responds instantly; the host stays
  // authoritative and corrections arrive via snapshots + reconciliation.
  predictStep(id) {
    this.events.length = 0;
    if (this.over) return this.events;
    this.tick++;
    const f = this.fighters.find(x => x.id === id);
    if (f && !f.dead) this._stepFighter(f, this.inputs.get(id));
    return this.events;
  }

  // ---------- snapshots (host <-> clients) ----------

  snapshot() {
    return {
      tk: this.tick,
      over: this.over,
      win: this.winner ? this.winner.id : null,
      map: this.map,
      f: this.fighters.map(f => {
        const hb = this.hitboxFor(f);
        return [
          f.id, r1(f.x), r1(f.y), r1(f.vx), r1(f.vy), f.facing,
          r1(f.pct), f.stocks, f.state, f.dead ? 1 : 0,
          f.invuln > 0 ? 1 : 0, f.atk || '', r1(f.cds[0]), r1(f.cds[1]),
          hb ? [r1(hb.dx), r1(hb.dy), hb.hw, hb.hh, hb.active ? 1 : 0] : 0,
          // Appended for client prediction/reconciliation + host handoff:
          f.grounded ? 1 : 0, f.jumps, r2(f.stateT), f.ledge,
          r2(f.regrabT), f.rollDir, r2(f.invuln), r2(f.dropT),
          f.fastfall ? 1 : 0, r2(f.dashT), r2(f.counterT),
          f.atkDir ? f.atkDir.x : 0, f.atkDir ? f.atkDir.y : 0,
          r1(f.guard), r2(f.standT),
        ];
      }),
      p: this.projectiles.map(p => [p.eid, p.kind, r1(p.x), r1(p.y), r1(p.vx)]),
      ev: this.events.slice(),
    };
  }
}

// Rebuild a live sim from the last snapshot a peer saw — used when the host
// drops mid-fight and the elected successor takes over the simulation.
export function gameFromSnapshot(players, snap, seed = 2) {
  const g = new Game(players, seed, snap?.map || DEFAULT_MAP);
  if (!snap) return g;
  g.tick = snap.tk || 0;
  for (const row of snap.f || []) {
    const f = g.fighters.find(x => x.id === row[0]);
    if (!f) continue;
    restoreFighter(f, row);
  }
  return g;
}

// Overwrite a fighter with an authoritative snapshot row. Used by clients
// before replaying unacked inputs (reconciliation) and by host handoff.
export function restoreFighter(f, row) {
  [, f.x, f.y, f.vx, f.vy, f.facing] = row;
  f.pct = row[6]; f.stocks = row[7];
  f.dead = !!row[9];
  f.atk = row[11] || null;
  f.cds = [row[12] || 0, row[13] || 0];
  if (row.length > 15) {
    f.state = row[8];
    f.grounded = !!row[15]; f.jumps = row[16] | 0;
    f.stateT = row[17] || 0; f.ledge = row[18] || 0;
    f.regrabT = row[19] || 0; f.rollDir = row[20] || 0;
    f.invuln = row[21] || 0; f.dropT = row[22] || 0;
    f.fastfall = !!row[23]; f.dashT = row[24] || 0; f.counterT = row[25] || 0;
    f.atkDir = (row[26] || row[27]) ? { x: row[26] | 0, y: row[27] | 0 } : null;
    if (row.length > 28) { f.guard = row[28]; f.standT = row[29] || 0; }
  } else {
    // Old-format row: mid-swing/hitstun details aren't included; resuming
    // in a neutral state costs at most a dropped attack frame.
    f.state = f.dead ? 'dead' : 'air';
    f.grounded = false;
  }
  if (f.atk && f.state !== 'attack') f.atk = null;
  if (!f.atk) f.atkDir = null;
}

export function blankInput() {
  return {
    mx: 0, my: 0, jump: false, ff: false, drop: false, atk: null,
    ab0: false, ab1: false, bufJ: 0, bufA: 0, buf0: 0, buf1: 0,
  };
}

// ---------- helpers ----------

// Axis-aligned melee hitbox for a spec, as offsets from the fighter's center
// plus half-extents. Shared by combat resolution and the renderer so the
// hitbox players see is exactly the one the sim tests. An 8-way aim places
// the box along that direction; 'both' boxes stay centered on the fighter.
export function meleeHitbox(f, spec, aim = null) {
  const a = !spec.both && aim && (aim.x || aim.y) ? aim : null;
  if (a) {
    const n = Math.hypot(a.x, a.y);
    return {
      dx: (a.x / n) * (F_W / 2 + spec.rx / 2),
      dy: (a.y / n) * (F_H / 2 + spec.ry / 2),
      hw: spec.rx / 2 + 14,
      hh: spec.ry,
    };
  }
  return {
    dx: spec.both || spec.up || spec.down ? 0 : f.facing * (F_W / 2 + spec.rx / 2),
    dy: spec.up ? -F_H / 2 - spec.ry / 2 : spec.down ? F_H / 2 + spec.ry / 2 : 0,
    hw: spec.both ? spec.rx : spec.rx / 2 + 14,
    hh: spec.ry,
  };
}

// Ducking tucks the fighter into a shorter box that stays planted on the
// ground: half-height shrinks and the center shifts down so jabs and
// forward smashes whiff over a ducked head. Standing boxes are unchanged.
function hurtBox(f) {
  if (f.state === 'duck') return { dy: (F_H - DUCK_H) / 2, hh: DUCK_H / 2 };
  return { dy: 0, hh: F_H / 2 };
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function approach(v, target, amt) {
  return v < target ? Math.min(target, v + amt) : Math.max(target, v - amt);
}
function deg(d) { return d * Math.PI / 180; }
function r1(v) { return Math.round(v * 10) / 10; }
function r2(v) { return Math.round(v * 100) / 100; }
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
