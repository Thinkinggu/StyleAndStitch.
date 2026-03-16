const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ALLOWED_TRANSLATIONS = new Set(['kjv', 'web']);

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

async function handlePassageRequest(request) {
  const { searchParams } = new URL(request.url);
  const reference = (searchParams.get('reference') || '').trim();
  const translation = (searchParams.get('translation') || 'kjv').trim().toLowerCase();

  if (!reference) {
    return jsonResponse({ error: 'Missing reference query parameter.' }, 400);
  }

  if (!ALLOWED_TRANSLATIONS.has(translation)) {
    return jsonResponse({ error: 'Unsupported translation. Use kjv or web.' }, 400);
  }

  const apiUrl = `https://bible-api.com/${encodeURIComponent(reference)}?translation=${translation}`;
  const cache = caches.default;
  const cacheKey = new Request(apiUrl, { method: 'GET' });

  const cached = await cache.match(cacheKey);
  if (cached) {
    return new Response(cached.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        ...CORS_HEADERS,
      },
    });
  }

  const upstream = await fetch(apiUrl, {
    headers: { 'User-Agent': 'RadiantWordPro/1.0 (+Cloudflare Pages Worker)' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });

  if (!upstream.ok) {
    return jsonResponse({ error: 'Unable to load passage from upstream Bible API.' }, 502);
  }

  const payload = await upstream.text();
  const response = new Response(payload, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      ...CORS_HEADERS,
    },
  });

  response.headers.set('X-Radiant-Word-Pro', 'passage-api');
  await cache.put(cacheKey, response.clone());
  return response;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'ok', service: 'Radiant Word Pro API', now: new Date().toISOString() });
    }

    if (url.pathname === '/api/passage') {
      return handlePassageRequest(request);
    }

    return env.ASSETS.fetch(request);
  },
};
