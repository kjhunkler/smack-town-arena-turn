// Screen management + all menu/builder/lobby DOM. Game HUD lives here too.

import {
  COLORS, TOTAL_CREDITS, STATS, ABILITIES, AUGMENTS,
  MAX_ABILITIES, MAX_AUGMENTS, buildCost, buildSummary,
  loadLoadouts, deleteLoadout, hatArt, loadHats, selectedLoadout, selectLoadout,
  HAT_W, HAT_H, HAT_PX, HAT_FACE_ROWS, HAT_CHARS, HAT_PALETTE, sanitizeHat,
} from './profile.js';
import { MAPS } from './game.js';

// ---------- pixel hats ----------
// Rasterize a hat string once to a tiny offscreen canvas; scaled draws stay
// pixel-crisp with imageSmoothing off. Shared by the renderer and previews.
const hatCache = new Map();
export function hatImage(hat) {
  const s = sanitizeHat(hat);
  if (!s) return null;
  let img = hatCache.get(s);
  if (img) return img;
  img = document.createElement('canvas');
  img.width = HAT_W;
  img.height = HAT_H;
  const x = img.getContext('2d');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '.') continue;
    x.fillStyle = HAT_PALETTE[HAT_CHARS.indexOf(s[i])] || '#fff';
    x.fillRect(i % HAT_W, (i / HAT_W) | 0, 1, 1);
  }
  if (hatCache.size > 64) hatCache.clear();   // hats are tiny; cap anyway
  hatCache.set(s, img);
  return img;
}

const $ = s => document.querySelector(s);

export function showScreen(name) {
  for (const el of document.querySelectorAll('.screen')) el.classList.add('hidden');
  $('#screen-' + name).classList.remove('hidden');
}

export function banner(text, kind = 'warn', ms = 3000, onClick = null) {
  const el = $('#net-banner');
  el.textContent = text;
  el.className = kind + (onClick ? ' tappable' : '');   // warn (default style) | bad | good
  el.classList.remove('hidden');
  if (el._click) el.removeEventListener('click', el._click);
  el._click = onClick ? () => { el.classList.add('hidden'); onClick(); } : null;
  if (el._click) el.addEventListener('click', el._click, { once: true });
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

export function toast(text, ms = 1300) {
  const el = $('#game-toast');
  el.textContent = text;
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

// ---------- color picker ----------

export function renderColorGrid(container, selected, onPick) {
  container.innerHTML = '';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'color-swatch' + (c === selected ? ' sel' : '');
    b.style.background = c;
    b.addEventListener('click', () => onPick(c));
    container.appendChild(b);
  }
}

// ---------- fighter preview (menu card) ----------

export function drawPreview(canvas, color, hat = null) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2 + 8);
  ctx.fillStyle = color;
  rr(ctx, -26, -34, 52, 68, 15); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.14)';
  rr(ctx, -21, -29, 42, 34, 10); ctx.fill();
  ctx.fillStyle = '#10122a';
  ctx.beginPath(); ctx.arc(2, -12, 3.6, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(15, -12, 3.6, 0, 7); ctx.fill();
  const img = hatImage(hat);
  if (img) {
    // preview body is 52x68 vs the in-game 46x64 — scale the hat to match.
    // Same brim-anchored box as hat.js: crown rows above y=-16, face rows below.
    const s = 68 / 64;
    const bw = HAT_W * HAT_PX, bh = HAT_H * HAT_PX;
    const by = -32 + 16 - (HAT_H - HAT_FACE_ROWS) * HAT_PX;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, (-bw / 2) * s, by * s, bw * s, bh * s);
  }
  ctx.restore();
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

// ---------- fighter builder ----------

export function renderBuilder(work) {
  // work: {color, build} — mutated in place as the user shops
  const spent = buildCost(work.build);
  const left = TOTAL_CREDITS - spent;
  $('#builder-credits').textContent = left;

  renderBuilderPreview(work);
  renderEditingBadge();
  renderLoadouts(work);

  renderColorGrid($('#builder-colors'), work.color, c => {
    work.color = c;
    renderBuilder(work);
  });

  // stat upgrade rows
  const statsBox = $('#builder-stats');
  statsBox.innerHTML = '';
  for (const s of STATS) {
    const lvl = work.build.stats[s.id];
    const row = document.createElement('div');
    row.className = 'stat-row';
    row.innerHTML = `
      <div class="stat-info">
        <div class="stat-name">${s.name}</div>
        <div class="stat-desc">${s.desc}</div>
        <div class="stat-pips">${Array.from({ length: s.max }, (_, i) =>
          `<span class="pip${i < lvl ? ' on' : ''}"></span>`).join('')}</div>
      </div>
      <div>
        <div class="stat-btns">
          <button data-d="-1" ${lvl <= 0 ? 'disabled' : ''}>−</button>
          <button data-d="1" ${lvl >= s.max || left < s.cost ? 'disabled' : ''}>+</button>
        </div>
        <div class="stat-cost">${s.cost} cr / lvl</div>
      </div>`;
    row.querySelectorAll('button').forEach(b =>
      b.addEventListener('click', () => {
        work.build.stats[s.id] = lvl + Number(b.dataset.d);
        renderBuilder(work);
      }));
    statsBox.appendChild(row);
  }

  renderShop($('#builder-abilities'), ABILITIES, work.build.abilities, MAX_ABILITIES, left, work);
  renderShop($('#builder-augments'), AUGMENTS, work.build.augments, MAX_AUGMENTS, left, work);
}

// Live fighter preview in the workshop: the fighter wearing work.hatId,
// with a label placing that hat in the library cycle (arrows flip through).
export function renderBuilderPreview(work) {
  drawPreview($('#builder-preview-canvas'), work.color, hatArt(work.hatId));
  const label = $('#builder-hat-label');
  const hats = loadHats();
  const i = work.hatId ? hats.findIndex(h => h.id === work.hatId) : -1;
  label.textContent = i >= 0 ? `Hat ${i + 1} of ${hats.length}`
    : hats.length ? 'No hat' : 'No hat — draw one in the library!';
}

// Which character the workshop is editing, mirrored in the header badge.
function renderEditingBadge() {
  const sel = selectedLoadout();
  $('#builder-editing').textContent = sel ? `editing \u201c${sel}\u201d` : 'unsaved fighter';
}

// Saved builds: tap a chip to load it into the workshop, ✕ to forget it.
function renderLoadouts(work) {
  const box = $('#builder-loadouts');
  const list = loadLoadouts();
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="loadout-empty">No saved builds yet — tune a build below and stash it with a nickname.</p>';
    return;
  }
  const sel = selectedLoadout();
  for (const lo of list) {
    const row = document.createElement('div');
    row.className = 'loadout-chip' + (lo.name === sel ? ' selected' : '');
    row.innerHTML = `
      <button class="lo-main">
        <span class="lo-fig">
          <span class="r-swatch" style="background:${esc(lo.color)}"></span>
        </span>
        <span class="lo-text">
          <span class="lo-name">${esc(lo.name)}</span>
          <span class="lo-sum">${esc(buildSummary(lo.build).replace(/\n/g, ' · '))}</span>
        </span>
      </button>
      <button class="lo-del" aria-label="Delete ${esc(lo.name)}">✕</button>`;
    const img = hatImage(hatArt(lo.hatId));
    if (img) {
      const c = document.createElement('canvas');
      c.width = HAT_W;
      c.height = HAT_H;
      c.className = 'lo-hat';
      c.getContext('2d').drawImage(img, 0, 0);
      row.querySelector('.lo-fig').appendChild(c);
    }
    row.querySelector('.lo-main').addEventListener('click', () => {
      work.color = lo.color;
      work.build = JSON.parse(JSON.stringify(lo.build));
      work.hatId = lo.hatId;
      selectLoadout(lo.name);
      $('#loadout-name').value = lo.name;
      renderBuilder(work);
    });
    row.querySelector('.lo-del').addEventListener('click', () => {
      deleteLoadout(lo.name);
      renderBuilder(work);
    });
    box.appendChild(row);
  }
}

function renderShop(box, defs, owned, maxOwned, left, work) {
  box.innerHTML = '';
  for (const item of defs) {
    const has = owned.includes(item.id);
    const affordable = has || (left >= item.cost && owned.length < maxOwned);
    const el = document.createElement('div');
    el.className = 'shop-item' + (has ? ' owned' : affordable ? '' : ' locked');
    el.innerHTML = `
      <div class="si-icon">${item.icon}</div>
      <div class="si-cost">${has ? '✓ owned' : item.cost + ' cr'}</div>
      <div class="si-name">${item.name}</div>
      <div class="si-desc">${item.desc}</div>`;
    el.addEventListener('click', () => {
      if (has) owned.splice(owned.indexOf(item.id), 1);
      else if (affordable) owned.push(item.id);
      else return;
      renderBuilder(work);
    });
    box.appendChild(el);
  }
}

// ---------- menu card ----------

export function renderMenuCard(profile) {
  $('#menu-name').textContent = profile.name;
  $('#menu-build').textContent = buildSummary(profile.build);
  drawPreview($('#menu-preview'), profile.color, profile.hat);
  // Selected character label + arrow availability. The arrows cycle saved
  // builds; from an unsaved fighter the first tap lands on a saved one.
  const list = loadLoadouts();
  const sel = selectedLoadout();
  const i = sel ? list.findIndex(l => l.name === sel) : -1;
  $('#menu-loadout').textContent = i >= 0 ? `${sel} · ${i + 1} of ${list.length}`
    : list.length ? 'unsaved fighter' : '';
  const lock = !list.length || (list.length === 1 && i >= 0);
  $('#menu-char-prev').disabled = lock;
  $('#menu-char-next').disabled = lock;
}

// ---------- main-menu presence ----------

export function renderOnline(entries, ready, { onJoin, onInvite } = {}) {
  const list = $('#menu-online-list');
  const empty = $('#menu-online-empty');
  $('#menu-online-count').textContent = entries.length ? `${entries.length} in town` : '';
  empty.classList.toggle('hidden', entries.length > 0);
  empty.textContent = ready
    ? 'No one else is in town — send someone an invite link!'
    : 'Looking for fighters…';
  list.innerHTML = '';
  for (const e of entries) {
    const li = document.createElement('li');
    const where = e.status === 'fighting' ? 'in a fight'
      : e.status === 'lobby' ? 'in room ' + esc(e.code || '????')
      : 'in the menu';
    li.innerHTML = `
      <span class="presence-dot online"></span>
      <span class="r-swatch" style="background:${esc(e.color || '#f5f5f5')}"></span>
      <span class="r-name">${esc(e.name)}<span class="r-where">${where}</span></span>`;
    if ((e.status === 'lobby' || e.status === 'fighting') && e.open && e.code) {
      const b = document.createElement('button');
      b.className = 'btn tiny';
      b.textContent = 'Join';
      b.addEventListener('click', () => onJoin?.(e));
      li.appendChild(b);
    } else if (e.status === 'menu') {
      const b = document.createElement('button');
      b.className = 'btn tiny ghost';
      b.textContent = 'Invite';
      b.addEventListener('click', () => onInvite?.(e));
      li.appendChild(b);
    }
    list.appendChild(li);
  }
}

// ---------- lobby ----------

export function renderLobby(net, onVote = null) {
  $('#lobby-code').textContent = net.roomCode || '····';
  const list = $('#lobby-roster');
  list.innerHTML = '';
  const roster = net.rosterList();
  for (const m of roster) {
    const li = document.createElement('li');
    const isHost = m.peerId === net.hostId;
    const isMe = m.peerId === net.myId;
    li.innerHTML = `
      <span class="presence-dot ${m.status === 'gone' ? 'gone' : m.status === 'away' ? 'away' : 'online'}"></span>
      <span class="r-swatch" style="background:${m.color}"></span>
      <span class="r-name">${esc(m.name)}${isMe ? ' (you)' : ''}${isHost ? '<span class="r-host">HOST</span>' : ''}</span>
      <span class="r-meta">${m.ready ? '<div class="r-ready">READY</div>' : ''}${!isMe && m.ping ? m.ping + 'ms' : ''}</span>`;
    list.appendChild(li);
  }

  // map vote grid: tap to vote, tap again to clear
  const grid = $('#lobby-maps');
  grid.innerHTML = '';
  const active = roster.filter(m => m.status !== 'gone');
  const myVote = net.members.get(net.myId)?.vote || null;
  for (const [id, map] of Object.entries(MAPS)) {
    const votes = active.filter(m => m.vote === id).length;
    const card = document.createElement('button');
    card.className = 'map-card' + (myVote === id ? ' voted' : '');
    card.innerHTML = `
      <span class="map-thumb map-thumb-${id}"></span>
      <span class="map-name">${esc(map.name)}</span>
      <span class="map-votes${votes ? '' : ' none'}">${votes ? '🗳️ ' + votes : '—'}</span>`;
    card.addEventListener('click', () => onVote?.(id));
    grid.appendChild(card);
  }

  const me = net.members.get(net.myId);
  const readyBtn = $('#lobby-ready');
  readyBtn.textContent = me?.ready ? 'Ready ✓' : "I'm Ready";
  readyBtn.classList.toggle('ready-on', !!me?.ready);

  const everyoneReady = active.length >= 1 && active.every(m => m.ready);
  const allReady = active.length >= 2 && everyoneReady;
  const soloReady = active.length === 1 && everyoneReady;   // host alone: practice mode
  const startBtn = $('#lobby-start');
  startBtn.classList.toggle('hidden', !net.isHost);
  startBtn.disabled = !(allReady || (soloReady && net.isHost));
  $('#lobby-status').textContent =
    soloReady ? 'Solo practice ready — hit Start Fight! Friends can join mid-fight.'
      : active.length < 2 ? 'Waiting for challengers — or ready up to practice solo…'
      : allReady ? 'All ready — starting…'
      : 'Waiting for everyone to ready up…';
}

// ---------- game HUD ----------

export function buildHud(players) {
  const hud = $('#game-hud');
  hud.innerHTML = '';
  for (const p of players) {
    const tile = document.createElement('div');
    tile.className = 'hud-tile';
    tile.id = 'hud-' + cssId(p.id);
    tile.style.borderTopColor = p.color;
    tile.innerHTML = `
      <div class="h-name">${esc(p.name)}</div>
      <div class="h-pct" style="color:${p.color}">0%</div>
      <div class="h-stocks">●●●</div>`;
    hud.appendChild(tile);
  }
}

export function updateHud(fighters) {
  for (const f of fighters) {
    const tile = document.getElementById('hud-' + cssId(f.id));
    if (!tile) continue;
    const pctEl = tile.querySelector('.h-pct');
    const cur = Math.round(f.pct);
    if (cur > (+tile.dataset.pct || 0)) {   // took damage: punch the number
      pctEl.classList.remove('h-pct-hit');
      void pctEl.offsetWidth;               // restart the animation
      pctEl.classList.add('h-pct-hit');
    }
    tile.dataset.pct = cur;
    pctEl.textContent = cur + '%';
    tile.querySelector('.h-stocks').textContent = '●'.repeat(Math.max(0, f.stocks)) || '—';
    tile.classList.toggle('dead', !!f.dead);
    const heat = Math.min(1, f.pct / 150);
    pctEl.style.color =
      f.pct > 0 ? `rgb(255, ${Math.round(220 - 150 * heat)}, ${Math.round(160 - 130 * heat)})` : '';
  }
}

export function setupAbilityButtons(abilityIds) {
  const btns = [$('#ability-btn-0'), $('#ability-btn-1')];
  btns.forEach((btn, i) => {
    const id = abilityIds[i];
    btn.classList.toggle('hidden', !id);
    if (id) {
      const def = ABILITIES.find(a => a.id === id);
      btn.querySelector('.ab-icon').textContent = def?.icon || '?';
      btn.dataset.cd = def?.cd || 3;
    }
  });
}

export function updateAbilityButtons(cds) {
  [$('#ability-btn-0'), $('#ability-btn-1')].forEach((btn, i) => {
    if (btn.classList.contains('hidden')) return;
    const total = Number(btn.dataset.cd) || 3;
    const left = cds?.[i] || 0;
    const frac = Math.max(0, Math.min(1, left / total));
    btn.querySelector('.cd-ring').style.strokeDashoffset = String(113 * frac);
    btn.classList.toggle('cooling', left > 0.05);
  });
}

// ---------- results ----------

export function renderResults(players, winnerId, finalFighters) {
  $('#results-title').textContent = winnerId
    ? `${esc(players.find(p => p.id === winnerId)?.name || '???')} wins!`
    : players.length === 1 ? 'Practice complete!'
    : 'Draw!';
  const list = $('#results-list');
  list.innerHTML = '';
  const rows = [...players].sort((a, b) => {
    const fa = finalFighters.find(f => f.id === a.id) || { stocks: 0, pct: 999 };
    const fb = finalFighters.find(f => f.id === b.id) || { stocks: 0, pct: 999 };
    return (fb.stocks - fa.stocks) || (fa.pct - fb.pct);
  });
  rows.forEach((p, i) => {
    const f = finalFighters.find(x => x.id === p.id);
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="r-score">${p.id === winnerId ? '🏆' : '#' + (i + 1)}</span>
      <span class="r-swatch" style="background:${p.color}"></span>
      <span class="r-name">${esc(p.name)}</span>
      <span class="r-meta">${f ? (f.stocks > 0 ? f.stocks + ' stocks left' : 'KO’d') : ''}</span>`;
    list.appendChild(li);
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cssId(s) { return String(s).replace(/[^\w-]/g, '_'); }
