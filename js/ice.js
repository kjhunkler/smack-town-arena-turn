// WebRTC ICE server config for PeerJS. TURN credentials come from our
// Cloudflare Worker so API tokens never ship to the browser.

export const TURN_ENDPOINT = '/api/turn-credentials';

const ICE_CACHE_MS = 20 * 60 * 60 * 1000;  // generated TURN credentials last 24h
const RETRY_AFTER_MS = 60 * 1000;
const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

let cachedIceServers = null;
let cachedAt = 0;
let retryAfter = 0;
let inflight = null;

function usable(list) {
  return Array.isArray(list) && list.length && list.every(s => s && (typeof s.urls === 'string' || Array.isArray(s.urls)));
}

export async function peerOptions() {
  const now = Date.now();
  if (usable(cachedIceServers) && now - cachedAt < ICE_CACHE_MS) {
    return { debug: 0, config: { iceServers: cachedIceServers } };
  }

  if (now < retryAfter) {
    return { debug: 0, config: { iceServers: FALLBACK_ICE_SERVERS } };
  }

  inflight ||= fetch(TURN_ENDPOINT, { cache: 'no-store' })
    .then(async r => {
      if (!r.ok) throw new Error(`TURN endpoint ${r.status}`);
      const data = await r.json();
      if (!usable(data.iceServers)) throw new Error('TURN endpoint returned no iceServers');
      cachedIceServers = data.iceServers;
      cachedAt = Date.now();
      retryAfter = 0;
      return cachedIceServers;
    })
    .catch(() => {
      retryAfter = Date.now() + RETRY_AFTER_MS;
      return FALLBACK_ICE_SERVERS;
    })
    .finally(() => { inflight = null; });

  const iceServers = await inflight;
  return { debug: 0, config: { iceServers } };
}
