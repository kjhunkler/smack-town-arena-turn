// Hat Studio: a pixel-perfect hat editor drawn over a zoomed-in view of the
// player's own fighter. The fighter idles under the drawing box — blinking
// and glancing around — so hats are painted exactly where they'll sit in a
// fight. The grid maps 1:1 onto the in-game hat box (see profile.js).

import { HAT_W, HAT_H, HAT_PX, HAT_FACE_ROWS, HAT_CHARS, HAT_PALETTE, sanitizeHat } from './profile.js';

const $ = s => document.querySelector(s);

const F_W = 46, F_H = 64;                 // fighter body (matches render.js)
const BOX_X = -(HAT_W * HAT_PX) / 2;      // hat box in fighter-local units
// Anchored at the brim (y = -16, brim overlaps the forehead): crown rows
// stack above it, HAT_FACE_ROWS rows hang below it over the face.
const BOX_Y = -F_H / 2 + 16 - (HAT_H - HAT_FACE_ROWS) * HAT_PX;
const BOX_W = HAT_W * HAT_PX;
const BOX_H = HAT_H * HAT_PX;

// world-units window the studio camera frames (head + hat + shoulders)
const VIEW_W = 110, VIEW_H = 120, VIEW_CY = -12;

export { BOX_X, BOX_Y, BOX_W, BOX_H };

export class HatStudio {
  constructor() {
    this.canvas = $('#hat-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.cells = new Array(HAT_W * HAT_H).fill('.');
    this.color = 5;                  // selected palette index
    this.erasing = false;
    this.fighterColor = '#ff5470';
    this.cbs = {};
    this.opened = false;
    this.raf = 0;
    this.lastT = 0;

    // idle face state: periodic blinks, occasional glances
    this.blink = 0;                  // >0 while eyes are shut
    this.nextBlink = 2;
    this.pupil = { x: 0, y: 0 };
    this.pupilTgt = { x: 0, y: 0 };
    this.nextGlance = 1.5;

    // palette swatches (built once)
    const pal = $('#hat-palette');
    HAT_PALETTE.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'hat-swatch';
      b.style.background = c;
      b.addEventListener('click', () => {
        this.color = i;
        this.erasing = false;
        this._syncTools();
      });
      pal.appendChild(b);
    });

    $('#hat-eraser').addEventListener('click', () => {
      this.erasing = !this.erasing;
      this._syncTools();
    });
    $('#hat-clear').addEventListener('click', () => this.cells.fill('.'));
    // Closing is the caller's call — saving into the hat library can fail
    // (library full), in which case the studio stays open.
    $('#hat-save').addEventListener('click', () =>
      this.cbs.onSave?.(sanitizeHat(this.cells.join(''))));   // all-transparent -> null
    $('#hat-dup').addEventListener('click', () =>
      this.cbs.onDuplicate?.(sanitizeHat(this.cells.join(''))));
    $('#hat-cancel').addEventListener('click', () => this.cbs.onCancel?.());

    // paint with any pointer; drag to keep painting
    let painting = false;
    this.canvas.addEventListener('pointerdown', e => {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      painting = true;
      this._paintAt(e);
    });
    this.canvas.addEventListener('pointermove', e => { if (painting) this._paintAt(e); });
    const up = () => { painting = false; };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
  }

  // Call with the hat screen already visible so the canvas has a size.
  open(fighterColor, hat, cbs) {
    this.fighterColor = fighterColor;
    this.cbs = cbs || {};
    const s = sanitizeHat(hat);
    this.cells = s ? s.split('') : new Array(HAT_W * HAT_H).fill('.');
    this.erasing = false;
    this._syncTools();
    this.opened = true;
    this.lastT = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(t => this._frame(t));
  }

  close() {
    this.opened = false;
    cancelAnimationFrame(this.raf);
  }

  _syncTools() {
    $('#hat-eraser').classList.toggle('tool-on', this.erasing);
    document.querySelectorAll('.hat-swatch').forEach((el, i) =>
      el.classList.toggle('sel', !this.erasing && i === this.color));
  }

  // camera for the current canvas size: world units -> device px
  _cam() {
    const { canvas } = this;
    const S = Math.min(canvas.width / VIEW_W, canvas.height / VIEW_H);
    return { S, cx: canvas.width / 2, cy: canvas.height / 2 - VIEW_CY * S };
  }

  _paintAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return;
    const px = (e.clientX - rect.left) * (this.canvas.width / rect.width);
    const py = (e.clientY - rect.top) * (this.canvas.height / rect.height);
    const { S, cx, cy } = this._cam();
    const col = Math.floor(((px - cx) / S - BOX_X) / HAT_PX);
    const row = Math.floor(((py - cy) / S - BOX_Y) / HAT_PX);
    if (col < 0 || col >= HAT_W || row < 0 || row >= HAT_H) return;
    this.cells[row * HAT_W + col] = this.erasing ? '.' : HAT_CHARS[this.color];
  }

  _frame(t) {
    if (!this.opened) return;
    const dt = Math.min(0.05, (t - this.lastT) / 1000);
    this.lastT = t;

    // keep the backing store matched to the on-screen size
    const dpr = Math.min(2, devicePixelRatio || 1);
    const cw = Math.round(this.canvas.clientWidth * dpr);
    const ch = Math.round(this.canvas.clientHeight * dpr);
    if (cw && (this.canvas.width !== cw || this.canvas.height !== ch)) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }

    // idle life: blink every few seconds, glance somewhere now and then
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) { this.blink = 0.13; this.nextBlink = 2 + Math.random() * 2.5; }
    this.blink = Math.max(0, this.blink - dt);
    this.nextGlance -= dt;
    if (this.nextGlance <= 0) {
      this.pupilTgt = Math.random() < 0.3
        ? { x: 0, y: 0 }                                        // back to center
        : { x: (Math.random() * 6 - 3) | 0, y: (Math.random() * 3 - 1.5) | 0 };
      this.nextGlance = 1.2 + Math.random() * 2.4;
    }
    const k = 1 - Math.pow(0.0005, dt);
    this.pupil.x += (this.pupilTgt.x - this.pupil.x) * k;
    this.pupil.y += (this.pupilTgt.y - this.pupil.y) * k;

    this._draw();
    this.raf = requestAnimationFrame(tt => this._frame(tt));
  }

  _draw() {
    const { ctx, canvas } = this;
    const { S, cx, cy } = this._cam();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(S, S);

    // soft spotlight behind the fighter
    const glow = ctx.createRadialGradient(0, -20, 10, 0, -20, 90);
    glow.addColorStop(0, 'rgba(80, 95, 170, .35)');
    glow.addColorStop(1, 'rgba(80, 95, 170, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(-VIEW_W / 2, -VIEW_H, VIEW_W, VIEW_H * 2);

    // body (same proportions as the in-game fighter, facing right)
    ctx.fillStyle = this.fighterColor;
    rr(ctx, -F_W / 2, -F_H / 2, F_W, F_H, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    rr(ctx, -F_W / 2 + 5, -F_H / 2 + 5, F_W - 10, F_H / 2, 10);
    ctx.fill();

    // eyes: dark dots that glance around and blink shut
    const ex = 8, ey = -F_H / 6;
    ctx.fillStyle = '#10122a';
    for (const off of [-6, 6]) {
      if (this.blink > 0) {
        ctx.fillRect(ex + off - 3.6, ey - 1, 7.2, 2.2);
      } else {
        ctx.beginPath();
        ctx.arc(ex + off + this.pupil.x, ey + this.pupil.y, 3.4, 0, 7);
        ctx.fill();
      }
    }

    // the hat itself, exactly as the game will draw it
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      if (c === '.') continue;
      ctx.fillStyle = HAT_PALETTE[HAT_CHARS.indexOf(c)];
      ctx.fillRect(BOX_X + (i % HAT_W) * HAT_PX, BOX_Y + ((i / HAT_W) | 0) * HAT_PX, HAT_PX, HAT_PX);
    }

    // drawing box + pixel grid on top
    ctx.strokeStyle = 'rgba(255, 176, 46, .06)';
    ctx.lineWidth = 0.5;
    for (let c = 1; c < HAT_W; c++) {
      ctx.beginPath();
      ctx.moveTo(BOX_X + c * HAT_PX, BOX_Y); ctx.lineTo(BOX_X + c * HAT_PX, BOX_Y + BOX_H);
      ctx.stroke();
    }
    for (let r = 1; r < HAT_H; r++) {
      ctx.beginPath();
      ctx.moveTo(BOX_X, BOX_Y + r * HAT_PX); ctx.lineTo(BOX_X + BOX_W, BOX_Y + r * HAT_PX);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255, 176, 46, .8)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(BOX_X, BOX_Y, BOX_W, BOX_H);
    ctx.setLineDash([]);

    ctx.restore();
  }
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
