// Touch controls tuned for one-thumb-per-side play:
//   left zone  — drag = virtual stick · flick up = jump · flick down = fast-fall/drop
//   right zone — tap = quick attack aimed by the movement stick (8-way)
//                swipe = smash attack in the swipe direction (8-way)
//   two floating buttons — equipped abilities
// Keyboard fallback (desktop testing): arrows/WASD move, space jump,
// J = tap attack, K = swipe attack (both aimed by held direction, 8-way),
// L and ; = abilities. Z/X/C/V mirror J/K/L/; for left-hand play.
// Gamepad (standard layout, polled each frame alongside touch/keys):
// left stick / dpad move — hold down to duck, flick up = jump, flick
// down = fast-fall/drop · A = jump · X = quick attack · B/Y = smash
// (aimed by the stick, 8-way) · LB/LT = ability 0 · RB/RT = ability 1.

const FLICK_SPEED = 0.55;    // px/ms — how fast a move must be to be a flick
const SWIPE_MIN = 24;        // px before a right-zone gesture becomes a swipe
const TAP_MAX_MS = 220;
const STICK_RADIUS = 52;
const PAD_DEAD = 0.25;       // gamepad stick deadzone
const PAD_AIM_DEAD = 0.35;   // stick tilt before an attack aims off-neutral
const PAD_FLICK = 0.6;       // stick tilt that counts as a vertical flick

// standard-mapping button index -> action
const PAD_BTN = {
  0: 'jump',                 // A
  1: 'swipe', 3: 'swipe',    // B / Y — smash attack
  2: 'tap',                  // X — quick attack
  4: 'ab0', 6: 'ab0',        // LB / LT
  5: 'ab1', 7: 'ab1',        // RB / RT
  12: 'jump',                // dpad up
};

export class TouchInput {
  constructor(root) {
    this.state = { mx: 0, my: 0 };   // continuous stick
    this.queue = [];                 // edge-triggered actions
    this.enabled = false;

    this.stickZone = root.querySelector('#stick-zone');
    this.actionZone = root.querySelector('#action-zone');
    this.stickBase = root.querySelector('#stick-base');
    this.stickKnob = root.querySelector('#stick-knob');
    this.abBtns = [root.querySelector('#ability-btn-0'), root.querySelector('#ability-btn-1')];

    this.stick = null;   // active left touch {id, ox, oy, lastX, lastY, lastT, flicked}
    this.swipe = null;   // active right touch

    this._bindZone(this.stickZone, 'stick');
    this._bindZone(this.actionZone, 'swipe');
    this.abBtns.forEach((btn, i) => {
      btn.addEventListener('pointerdown', e => {
        e.preventDefault(); e.stopPropagation();
        if (this.enabled) this.queue.push({ ['ab' + i]: true });
      });
    });

    this.keys = new Set();
    addEventListener('keydown', e => this._key(e, true));
    addEventListener('keyup', e => this._key(e, false));

    // gamepads are polled (in poll()), only connection changes are events
    this.onPad = null;               // optional (connected, id) callback
    this.padPrev = [];               // last-frame button states (edge detect)
    this.padFlicked = false;         // vertical stick flick armed/fired
    addEventListener('gamepadconnected', e => this.onPad?.(true, e.gamepad.id));
    addEventListener('gamepaddisconnected', e => this.onPad?.(false, e.gamepad.id));
  }

  _bindZone(zone, which) {
    zone.addEventListener('pointerdown', e => {
      if (!this.enabled) return;
      zone.setPointerCapture(e.pointerId);
      const rec = { id: e.pointerId, ox: e.clientX, oy: e.clientY, lastX: e.clientX, lastY: e.clientY, lastT: e.timeStamp, t0: e.timeStamp, flicked: false, moved: 0 };
      if (which === 'stick') {
        this.stick = rec;
        this.stickBase.classList.remove('hidden');
        this.stickBase.style.left = e.clientX + 'px';
        this.stickBase.style.top = e.clientY + 'px';
      } else {
        this.swipe = rec;
      }
    });
    zone.addEventListener('pointermove', e => {
      const rec = which === 'stick' ? this.stick : this.swipe;
      if (!rec || rec.id !== e.pointerId) return;
      const dt = Math.max(1, e.timeStamp - rec.lastT);
      const vy = (e.clientY - rec.lastY) / dt;
      rec.moved = Math.max(rec.moved, Math.hypot(e.clientX - rec.ox, e.clientY - rec.oy));
      rec.lastX = e.clientX; rec.lastY = e.clientY; rec.lastT = e.timeStamp;

      if (which === 'stick') {
        let dx = e.clientX - rec.ox, dy = e.clientY - rec.oy;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) {
          // walk the stick origin so direction changes stay responsive
          rec.ox += dx * (1 - STICK_RADIUS / len);
          rec.oy += dy * (1 - STICK_RADIUS / len);
          dx = e.clientX - rec.ox; dy = e.clientY - rec.oy;
          this.stickBase.style.left = rec.ox + 'px';
          this.stickBase.style.top = rec.oy + 'px';
        }
        this.state.mx = dx / STICK_RADIUS;
        this.state.my = dy / STICK_RADIUS;
        this.stickKnob.style.transform =
          `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        // vertical flicks on the movement thumb = jump / fast-fall+drop
        if (!rec.flicked && vy < -FLICK_SPEED) { rec.flicked = true; this.queue.push({ jump: true }); }
        else if (!rec.flicked && vy > FLICK_SPEED) { rec.flicked = true; this.queue.push({ ff: true, drop: true }); }
        else if (rec.flicked && Math.abs(vy) < 0.12) rec.flicked = false; // re-arm
      }
    });
    const end = e => {
      const rec = which === 'stick' ? this.stick : this.swipe;
      if (!rec || rec.id !== e.pointerId) return;
      if (which === 'stick') {
        this.stick = null;
        this.state.mx = 0; this.state.my = 0;
        this.stickBase.classList.add('hidden');
        this.stickKnob.style.transform = 'translate(-50%,-50%)';
      } else {
        this.swipe = null;
        const dx = e.clientX - rec.ox, dy = e.clientY - rec.oy;
        const dist = Math.hypot(dx, dy);
        const dur = e.timeStamp - rec.t0;
        if (dist < SWIPE_MIN && dur < TAP_MAX_MS) {
          // tap: quick attack aimed by the movement stick (neutral = facing)
          this.queue.push({ atk: { kind: 'tap', ...octant(this.state.mx, this.state.my, 0.35) } });
        } else if (dist >= SWIPE_MIN) {
          // swipe: smash attack in the swipe direction
          this.queue.push({ atk: { kind: 'swipe', ...octant(dx, dy) } });
        }
      }
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }

  _key(e, down) {
    if (!this.enabled || e.repeat) return;
    const k = e.key.toLowerCase();
    if (down) this.keys.add(k); else this.keys.delete(k);
    const dir = this.keys.has('arrowleft') || this.keys.has('a') ? -1
      : this.keys.has('arrowright') || this.keys.has('d') ? 1 : 0;
    const up = this.keys.has('arrowup') || this.keys.has('w');
    const dn = this.keys.has('arrowdown') || this.keys.has('s');
    this.state.mx = dir;
    this.state.my = dn ? 1 : up ? -1 : 0;
    if (!down) return;
    if (k === ' ' || k === 'arrowup' || k === 'w') this.queue.push({ jump: true });
    if (k === 'arrowdown' || k === 's') this.queue.push({ ff: true, drop: true });
    const aim = { dx: dir, dy: dn ? 1 : up ? -1 : 0 };
    if (k === 'j' || k === 'z') this.queue.push({ atk: { kind: 'tap', ...aim } });
    if (k === 'k' || k === 'x') this.queue.push({ atk: { kind: 'swipe', ...aim } });
    if (k === 'l' || k === 'c') this.queue.push({ ab0: true });
    if (k === ';' || k === 'v') this.queue.push({ ab1: true });
  }

  // Read the first connected gamepad: level movement merges with the touch/
  // keyboard stick (dominant axis wins), buttons and stick flicks queue the
  // same edge actions the other sources produce.
  _pollGamepad() {
    const pad = [...(navigator.getGamepads?.() || [])].find(p => p && p.connected);
    if (!pad) { this.padPrev = []; this.padFlicked = false; return null; }

    let mx = pad.axes[0] || 0, my = pad.axes[1] || 0;
    if (Math.hypot(mx, my) < PAD_DEAD) { mx = 0; my = 0; }
    if (pad.buttons[14]?.pressed) mx = -1;      // dpad overrides the stick
    if (pad.buttons[15]?.pressed) mx = 1;
    if (pad.buttons[12]?.pressed) my = -1;
    if (pad.buttons[13]?.pressed) my = 1;

    if (this.enabled) {
      // vertical flicks mirror the touch stick: jump up, fast-fall/drop down
      if (!this.padFlicked && my < -PAD_FLICK) { this.padFlicked = true; this.queue.push({ jump: true }); }
      else if (!this.padFlicked && my > PAD_FLICK) { this.padFlicked = true; this.queue.push({ ff: true, drop: true }); }
      else if (this.padFlicked && Math.abs(my) < PAD_AIM_DEAD) this.padFlicked = false;

      for (const [i, act] of Object.entries(PAD_BTN)) {
        const down = !!pad.buttons[i]?.pressed;
        if (down && !this.padPrev[i]) {
          if (act === 'jump') this.queue.push({ jump: true });
          else if (act === 'tap') this.queue.push({ atk: { kind: 'tap', ...octant(mx, my, PAD_AIM_DEAD) } });
          else if (act === 'swipe') this.queue.push({ atk: { kind: 'swipe', ...octant(mx, my, PAD_AIM_DEAD) } });
          else if (act === 'ab0') this.queue.push({ ab0: true });
          else if (act === 'ab1') this.queue.push({ ab1: true });
        }
        this.padPrev[i] = down;
      }
    } else {
      for (const i of Object.keys(PAD_BTN)) this.padPrev[i] = !!pad.buttons[i]?.pressed;
      this.padFlicked = Math.abs(my) > PAD_FLICK;
    }
    return { mx, my };
  }

  // Drain into a single input frame for the sim/network.
  poll() {
    const g = this._pollGamepad();
    const out = { mx: this.state.mx, my: this.state.my };
    if (g) {
      if (Math.abs(g.mx) > Math.abs(out.mx)) out.mx = g.mx;
      if (Math.abs(g.my) > Math.abs(out.my)) out.my = g.my;
    }
    for (const q of this.queue) Object.assign(out, q);
    this.queue.length = 0;
    return out;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.queue.length = 0;
      this.state.mx = 0; this.state.my = 0;
      this.stick = this.swipe = null;
      this.stickBase.classList.add('hidden');
    }
  }
}

// Snap a vector to one of 8 directions — {dx, dy} each in {-1, 0, 1} —
// or neutral {0, 0} inside the deadzone.
function octant(x, y, dead = 0) {
  if (Math.hypot(x, y) <= dead) return { dx: 0, dy: 0 };
  const s = Math.round(Math.atan2(y, x) / (Math.PI / 4)) * (Math.PI / 4);
  return { dx: Math.round(Math.cos(s)), dy: Math.round(Math.sin(s)) };
}
