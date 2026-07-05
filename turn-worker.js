const ALLOWED_ORIGIN = 'https://smacktownarena.com';
const TURN_TTL_SECONDS = 86400;

function corsHeaders(origin) {
  return origin === ALLOWED_ORIGIN ? {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  } : { 'Vary': 'Origin' };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      if (origin !== ALLOWED_ORIGIN) return new Response(null, { status: 403, headers: corsHeaders(origin) });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405, origin);
    }

    if (!env.TURN_API_TOKEN || !env.TURN_TOKEN_ID) {
      return json({ error: 'TURN Worker secrets are not configured' }, 500, origin);
    }

    const cf = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_TOKEN_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
      });

    let body;
    try { body = await cf.json(); }
    catch (_) { body = { error: 'invalid Cloudflare response' }; }

    if (!cf.ok) {
      return json({ error: 'turn credential generation failed', details: body }, cf.status, origin);
    }

    const iceServers = Array.isArray(body.iceServers) ? body.iceServers : [];
    return json({ iceServers }, 200, origin);
  },
};
