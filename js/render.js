// Canvas renderer: draws the stage, fighters, projectiles and juice
// (particles, screen shake, KO bursts) from interpolated view state.

import { MAPS, DEFAULT_MAP } from './game.js';
import { hatImage } from './ui.js';
import { BOX_X as HAT_X, BOX_Y as HAT_Y, BOX_W as HAT_BW, BOX_H as HAT_BH } from './hat.js';

const F_W = 46, F_H = 64;

// Per-map look: background gradient, celestial motif, star behavior, and
// stage palette. Geometry comes from MAPS in game.js; looks live here.
const THEMES = {
  battlefield: {
    sky: ['#141a38', '#1c1430', '#090a14'],
    motif: 'moon',
    stars: 1,
    deck: '#2a3154', lip: '#3b4573', trim: '#ffb02e',
    plat: '#3b4573', platTop: '#556099',
  },
  flatlands: {
    sky: ['#2c1a3e', '#83303c', '#e8703a'],
    motif: 'sun',
    stars: 0.25,
    deck: '#4a2b33', lip: '#6b3a40', trim: '#ffd23e',
    plat: '#6b3a40', platTop: '#8a4f52',
  },
  skyline: {
    sky: ['#04141c', '#0a2a30', '#071018'],
    motif: 'aurora',
    stars: 1,
    deck: '#173a42', lip: '#20545c', trim: '#3ddca4',
    plat: '#20545c', platTop: '#2e7880',
  },
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 0, y: -120, zoom: 0.8 };
    this.shake = 0;
    this.particles = [];
    this.dmgPops = [];               // floating damage numbers
    this.flash = new Map();          // fighter id -> hit-flash time left
    this.setMap(DEFAULT_MAP);
    this.stars = Array.from({ length: 90 }, () => ({
      x: Math.random() * 2900 - 1450,
      y: Math.random() * 1300 - 1050,
      s: Math.random() * 1.6 + 0.4,
      tw: Math.random() * Math.PI * 2,
    }));
    this._resize();
    addEventListener('resize', () => this._resize());
  }

  setMap(id) {
    this.mapId = MAPS[id] ? id : DEFAULT_MAP;
    this.stage = MAPS[this.mapId];
    this.theme = THEMES[this.mapId] || THEMES[DEFAULT_MAP];
  }

  _resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = innerWidth * dpr;
    this.canvas.height = innerHeight * dpr;
    this.dpr = dpr;
  }

  onEvents(events) {
    for (const ev of events || []) {
      switch (ev.e) {
        case 'hit':
          this.burst(ev.x, ev.y, ev.heavy ? 18 : 8, ev.heavy ? '#ffdd55' : '#ffffff', ev.heavy ? 420 : 220);
          this.shake = Math.max(this.shake, ev.heavy ? 14 : 5);
          this.flash.set(ev.vic, 0.16);
          this.dmgPops.push({
            x: ev.x + (Math.random() - 0.5) * 16, y: ev.y - F_H / 2 - 10,
            txt: String(ev.dmg), t: 0, life: ev.heavy ? 0.85 : 0.65,
            heavy: !!ev.heavy,
          });
          break;
        case 'ko':
          this.burst(ev.x, ev.y, 40, '#ff5470', 700);
          this.burst(ev.x, ev.y, 20, '#ffffff', 500);
          this.shake = 22;
          break;
        case 'shockwave':
          this.burst(ev.x, ev.y, 26, '#ffb02e', 520);
          this.shake = Math.max(this.shake, 10);
          break;
        case 'counter':
          this.burst(ev.x, ev.y, 14, '#38b6ff', 300);
          break;
        case 'secondwind':
          this.burst(ev.x, ev.y, 16, '#3ddc84', 260);
          break;
        case 'gale':
          this.burst(ev.x, ev.y, 24, '#bfe3ff', 560);
          this.shake = Math.max(this.shake, 7);
          break;
        case 'mend':
          this.burst(ev.x, ev.y, 14, '#3ddc84', 220);
          break;
        case 'land':
          this.burst(ev.x, ev.y, 4, '#8899cc', 90);
          break;
        case 'jump':
          this.burst(ev.x, ev.y, 5, '#aabbee', 120);
          break;
        case 'ledge':
          this.burst(ev.x, ev.y, 6, '#8fd3ff', 150);
          break;
        case 'roll':
          this.burst(ev.x, ev.y, 5, '#aabbee', 110);
          break;
        case 'duck':
          this.burst(ev.x, ev.y, 4, '#8899cc', 90);
          break;
        case 'block':
          this.burst(ev.x, ev.y, 10, '#8fd3ff', 260);
          this.shake = Math.max(this.shake, 3);
          break;
        case 'crush':
          this.burst(ev.x, ev.y, 26, '#ffd23e', 480);
          this.burst(ev.x, ev.y, 12, '#ffffff', 320);
          this.shake = Math.max(this.shake, 12);
          break;
      }
    }
  }

  burst(x, y, n, color, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      this.particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.2,
        life: 0.35 + Math.random() * 0.4, t: 0, color,
        r: 2 + Math.random() * 3.5,
      });
    }
  }

  draw(view, dt, myId) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;

    // --- camera: frame all live fighters ---
    const live = view.fighters.filter(f => !f.dead);
    if (live.length) {
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (const f of live) {
        minX = Math.min(minX, f.x); maxX = Math.max(maxX, f.x);
        minY = Math.min(minY, f.y); maxY = Math.max(maxY, f.y);
      }
      const pad = 260;
      const tx = (minX + maxX) / 2;
      const ty = (minY + maxY) / 2 - 40;
      const zx = W / (maxX - minX + pad * 2);
      const zy = H / (maxY - minY + pad * 2);
      const tz = Math.max(0.30 * this.dpr, Math.min(1.05 * this.dpr, Math.min(zx, zy)));
      const k = 1 - Math.pow(0.001, dt);
      this.cam.x += (tx - this.cam.x) * k;
      this.cam.y += (ty - this.cam.y) * k;
      this.cam.zoom += (tz - this.cam.zoom) * k;
    }
    this.shake = Math.max(0, this.shake - dt * 60);
    const shx = (Math.random() - 0.5) * this.shake * this.dpr;
    const shy = (Math.random() - 0.5) * this.shake * this.dpr;

    // --- background (themed per map) ---
    const th = this.theme;
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, th.sky[0]);
    grd.addColorStop(0.6, th.sky[1]);
    grd.addColorStop(1, th.sky[2]);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);

    const t = performance.now() / 1000;
    this._motif(ctx, W, H, t);

    ctx.fillStyle = '#ffffff';
    for (const s of this.stars) {
      const px = W / 2 + (s.x - this.cam.x * 0.15) * this.dpr * 0.5;
      const py = H / 2 + (s.y - this.cam.y * 0.15) * this.dpr * 0.5;
      if (px < 0 || px > W || py < 0 || py > H) continue;
      ctx.globalAlpha = (0.3 + 0.3 * Math.sin(t * 2 + s.tw)) * th.stars;
      ctx.fillRect(px, py, s.s * this.dpr, s.s * this.dpr);
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(W / 2 + shx, H / 2 + shy);
    ctx.scale(this.cam.zoom, this.cam.zoom);
    ctx.translate(-this.cam.x, -this.cam.y);

    this._stage(ctx);

    // tick down hit flashes
    for (const [id, v] of this.flash) {
      if (v - dt <= 0) this.flash.delete(id);
      else this.flash.set(id, v - dt);
    }

    // projectiles
    for (const p of view.projectiles || []) {
      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.kind === 'boomerang') {
        ctx.rotate(t * 18 + p.eid);
        ctx.fillStyle = '#8fd3ff';
        roundRect(ctx, -17, -5, 34, 10, 5); ctx.fill();
        roundRect(ctx, -5, -17, 10, 34, 5); ctx.fill();
        ctx.fillStyle = '#eaf7ff';
        ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, 7); ctx.fill();
      } else {
        const bolt = p.kind === 'bolt';
        const flick = 1 + Math.sin(t * 30 + p.eid) * 0.2;
        ctx.fillStyle = '#ff8a2e';
        ctx.beginPath(); ctx.arc(0, 0, (bolt ? 9 : 13) * flick, 0, 7); ctx.fill();
        ctx.fillStyle = '#ffd23e';
        ctx.beginPath(); ctx.arc(0, 0, (bolt ? 4.5 : 7) * flick, 0, 7); ctx.fill();
      }
      ctx.restore();
    }

    for (const f of view.fighters) if (!f.dead) this._fighter(ctx, f, f.id === myId, t);

    // attack hitboxes — the exact rects the sim tests, drawn in world space
    // so squash & stretch never distorts them
    for (const f of view.fighters) if (!f.dead && f.hb) this._hitbox(ctx, f, t);

    // particles
    for (const p of this.particles) {
      p.t += dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vy += 900 * dt;
      const a = 1 - p.t / p.life;
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * a + 0.5, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.particles = this.particles.filter(p => p.t < p.life);

    // floating damage numbers
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const d of this.dmgPops) {
      d.t += dt;
      const k = d.t / d.life;
      if (k >= 1) continue;
      const pop = Math.min(1, d.t * 9);          // quick scale-in punch
      const size = (d.heavy ? 32 : 22) * (0.5 + 0.5 * pop);
      ctx.globalAlpha = 1 - k * k;
      ctx.font = `italic 900 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(10, 12, 25, .75)';
      ctx.fillStyle = d.heavy ? '#ffdd55' : '#ffffff';
      const y = d.y - 46 * k;
      ctx.strokeText(d.txt, d.x, y);
      ctx.fillText(d.txt, d.x, y);
    }
    ctx.globalAlpha = 1;
    this.dmgPops = this.dmgPops.filter(d => d.t < d.life);

    ctx.restore();
  }

  // Sky centerpiece per theme: parallaxes gently with the camera.
  _motif(ctx, W, H, t) {
    const px = W * 0.72 - this.cam.x * 0.05 * this.dpr;
    const py = H * 0.26 - this.cam.y * 0.05 * this.dpr;
    const r = Math.min(W, H) * 0.09;
    if (this.theme.motif === 'moon') {
      ctx.fillStyle = '#e8ecff';
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fill();
      ctx.fillStyle = this.theme.sky[0];               // bite = crescent
      ctx.beginPath(); ctx.arc(px + r * 0.45, py - r * 0.18, r * 0.85, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
    } else if (this.theme.motif === 'sun') {
      const sy = H * 0.52 - this.cam.y * 0.05 * this.dpr;
      const g = ctx.createRadialGradient(px, sy, 0, px, sy, r * 3);
      g.addColorStop(0, 'rgba(255, 210, 62, .95)');
      g.addColorStop(0.35, 'rgba(255, 138, 46, .55)');
      g.addColorStop(1, 'rgba(255, 138, 46, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(px - r * 3, sy - r * 3, r * 6, r * 6);
      ctx.fillStyle = '#ffd23e';
      ctx.beginPath(); ctx.arc(px, sy, r * 1.15, 0, 7); ctx.fill();
    } else if (this.theme.motif === 'aurora') {
      ctx.lineWidth = Math.max(8, H * 0.045);
      ctx.lineCap = 'round';
      for (let b = 0; b < 3; b++) {
        ctx.strokeStyle = b === 1 ? 'rgba(61, 220, 164, .16)' : 'rgba(56, 182, 255, .12)';
        ctx.beginPath();
        for (let i = 0; i <= 8; i++) {
          const x = (W / 8) * i;
          const y = H * (0.16 + b * 0.07)
            + Math.sin(t * 0.35 + i * 0.9 + b * 2.1) * H * 0.05
            - this.cam.y * 0.04 * this.dpr;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
    }
  }

  _stage(ctx) {
    const th = this.theme;
    const m = this.stage.main;
    // main platform with themed deck & lip
    ctx.fillStyle = th.deck;
    roundRect(ctx, m.x, m.y, m.w, m.h + 30, 12); ctx.fill();
    ctx.fillStyle = th.lip;
    roundRect(ctx, m.x, m.y, m.w, 12, 6); ctx.fill();
    ctx.fillStyle = th.trim;
    ctx.fillRect(m.x + 8, m.y + 1, m.w - 16, 3);

    for (const p of this.stage.plats) {
      ctx.fillStyle = th.plat;
      roundRect(ctx, p.x, p.y, p.w, 12, 6); ctx.fill();
      ctx.fillStyle = th.platTop;
      ctx.fillRect(p.x + 6, p.y + 1, p.w - 12, 3);
    }
  }

  _fighter(ctx, f, isMe, t) {
    ctx.save();
    ctx.translate(f.x, f.y);

    if (f.invuln && Math.sin(t * 30) > 0) ctx.globalAlpha = 0.45;

    // "you" marker
    if (isMe) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(0, -F_H / 2 - 26);
      ctx.lineTo(-7, -F_H / 2 - 38);
      ctx.lineTo(7, -F_H / 2 - 38);
      ctx.closePath(); ctx.fill();
    }

    // getup roll: tumble the whole body inward
    if (f.state === 'roll') ctx.rotate(t * 16 * f.facing);
    // guard crush: dazed wobble until the stun wears off
    if (f.state === 'crush') ctx.rotate(Math.sin(t * 22) * 0.12);

    // squash & stretch by vertical speed
    const stretch = clamp(1 + Math.abs(f.vy) / 3500, 1, 1.25);
    ctx.scale(1 / Math.sqrt(stretch), stretch);

    const hurt = f.state === 'hitstun' || f.state === 'crush';
    const attacking = f.state === 'attack' || f.atk;

    // ducking: tuck into a short, wide squat planted on the same ground
    // line (mirrors the DUCK_H hurtbox in game.js — what you see is what
    // can be hit)
    const duck = f.state === 'duck';
    const bw = duck ? F_W + 10 : F_W, bh = duck ? 24 : F_H;
    const bTop = F_H / 2 - bh;

    // body
    ctx.fillStyle = f.color;
    roundRect(ctx, -bw / 2, bTop, bw, bh, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // hit flash: body whites out for a blink when damage lands
    const flash = this.flash.get(f.id) || 0;
    if (flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${Math.min(1, flash / 0.16) * 0.85})`;
      roundRect(ctx, -bw / 2, bTop, bw, bh, 14);
      ctx.fill();
    }

    // belly shade
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    roundRect(ctx, -bw / 2 + 5, bTop + 5, bw - 10, bh / 2, 10);
    ctx.fill();

    // face
    const ex = f.facing * 8;
    const ey = duck ? bTop + 11 : -F_H / 6;
    ctx.fillStyle = '#10122a';
    if (hurt) {
      ctx.lineWidth = 3; ctx.strokeStyle = '#10122a';
      cross(ctx, ex - 6, ey, 4); cross(ctx, ex + 6, ey, 4);
    } else {
      ctx.beginPath(); ctx.arc(ex - 6, ey, 3.4, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(ex + 6, ey, 3.4, 0, 7); ctx.fill();
      if (attacking) { // gritted mouth
        ctx.fillRect(ex - 6, ey + 10, 12, 3);
      }
    }

    // pixel hat: rides the head through squash/stretch and rolls, and
    // mirrors with the fighter's facing so it always points the right way
    if (f.hat) {
      const hat = hatImage(f.hat);
      if (hat) {
        ctx.save();
        ctx.scale(f.facing || 1, 1);
        if (duck) {
          ctx.translate(0, F_H - bh);  // hat rides the lowered head
          // smush: squash the hat vertically (anchored at its top) so the
          // face rows stop at the ground line instead of sinking into it
          const squish = (bh - F_H / 2 - HAT_Y) / HAT_BH;
          ctx.translate(0, HAT_Y);
          ctx.scale(1, squish);
          ctx.translate(0, -HAT_Y);
        }
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(hat, HAT_X, HAT_Y, HAT_BW, HAT_BH);
        ctx.restore();
      }
    }

    // hanging: fists gripping the lip (hang offset mirrors game.js LEDGE_HANG_Y)
    if (f.state === 'ledge') {
      ctx.fillStyle = f.color;
      ctx.strokeStyle = 'rgba(0,0,0,.35)';
      ctx.lineWidth = 2.5;
      for (const off of [-6, 6]) {
        ctx.beginPath();
        ctx.arc(f.facing * (F_W / 2 - 6) + off, -22, 5.5, 0, 7);
        ctx.fill(); ctx.stroke();
      }
    }

    ctx.restore();

    // guard meter: floats overhead while ducking, crushed, or refilling
    if (f.guard != null && (duck || f.state === 'crush' || f.guard < 99.5)) {
      const w = 44, h = 5;
      const k = clamp(f.guard / 100, 0, 1);
      const x = f.x - w / 2, y = f.y - F_H / 2 - 14;
      ctx.fillStyle = 'rgba(10,12,30,.6)';
      roundRect(ctx, x, y, w, h, 3); ctx.fill();
      if (k > 0) {
        ctx.fillStyle = k > 0.5 ? '#3ddc84' : k > 0.25 ? '#ffb02e' : '#ff5470';
        roundRect(ctx, x, y, Math.max(4, w * k), h, 3); ctx.fill();
      }
    }
  }

  // Attack hitbox: dashed outline while winding up (telegraph), then a hot
  // translucent fill during active frames. Mirrors game.js meleeHitbox.
  _hitbox(ctx, f, t) {
    const { dx, dy, hw, hh, active } = f.hb;
    const x = f.x + dx - hw, y = f.y + dy - hh;
    ctx.save();
    if (active) {
      ctx.fillStyle = 'rgba(255, 82, 82, .30)';
      ctx.strokeStyle = 'rgba(255, 150, 130, .95)';
      ctx.lineWidth = 3;
      roundRect(ctx, x, y, hw * 2, hh * 2, 9);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255, 214, 102, .55)';
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 6]);
      ctx.lineDashOffset = -t * 60;
      roundRect(ctx, x, y, hw * 2, hh * 2, 9);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function cross(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
  ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
  ctx.stroke();
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
