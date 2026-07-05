# SmackTown 🥊

A pocket-sized, Smash-style 2D platform fighter that runs as an installable
PWA and connects phones **directly to each other** over WebRTC — no game
server. One player hosts a room, everyone else joins with a 4-letter code,
and if the host bails mid-fight the game hands off to the next player
without dropping the match.

## Play it

Serve the repo root over HTTPS (any static host works — GitHub Pages,
Netlify, `npx serve`…) and open it on your phone:

```sh
npx serve .          # or: python3 -m http.server 8000
```

> WebRTC + PWA features need a **secure context**: `https://` or `http://localhost`.

Add it to your home screen when the browser offers — it installs as a
fullscreen landscape app and keeps working offline (practice mode; multiplayer
naturally needs a connection).

## How it works

| Piece | Where | What it does |
|---|---|---|
| Profile & credits | `js/profile.js` | First-run username + color pick; every player gets **1000 credits** to spend on stat upgrades, up to 2 active abilities and 2 passive augments. Builds are validated on the host too, so nobody can join over budget. |
| Fighter workshop | `js/ui.js` | The shop UI — stats (Power/Speed/Defense/Agility), abilities (Fireball, Dash Strike, Shockwave, Uppercut, Counter, Blink) and augments (Vampiric, Thorns, Featherweight, Heavyweight, Berserker, Second Wind). |
| P2P + presence + handoff | `js/net.js` | PeerJS full-mesh rooms. Presence heartbeats every 2s drive the lobby's online/away/gone dots and ping readouts. The host is just the *authority role*: if it disconnects, the remaining player with the lowest join order claims hosthood (term-numbered claims resolve races), resumes the sim from the last snapshot, and re-registers the room code so new players can still join. |
| Simulation | `js/game.js` | 60 Hz host-authoritative sim. Percent-based damage → growing knockback, 3 stocks, blast zones, drop-through platforms, hitpause, respawn invulnerability, and a practice bot. |
| Touch controls | `js/input.js` | Left thumb: drag to move, flick up to jump, flick down to fast-fall/drop. Right thumb: tap = jab, swipe = smash attack in that direction. Two ability buttons with cooldown rings. Keyboard fallback for desktop (arrows/WASD + J/K/L). |
| Netcode | `js/main.js` | Clients send inputs (~30 Hz), host broadcasts snapshots (20 Hz), clients render 130 ms behind with interpolation. |
| Rendering | `js/render.js` | Canvas renderer with a Smash-style auto-framing camera, squash & stretch, particles and screen shake. |
| PWA | `sw.js`, `manifest.webmanifest` | Full precache, cache-first with background refresh, installable fullscreen landscape app. |

## Signaling

Room discovery uses the free PeerJS cloud broker for the initial WebRTC
handshake only — all gameplay traffic is peer-to-peer data channels. To use
your own broker, run [peerjs-server](https://github.com/peers/peerjs-server)
and pass its host/port where `new Peer(...)` is created in `js/net.js`.
