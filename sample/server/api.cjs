const { serve } = require('@hono/node-server');
const { Hono } = require('hono');
const { getSubtitles, getVideoDetails } = require('youtube-caption-extractor');

const PORT = Number(process.env.PORT || 8080);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 21600) * 1000;
const SUCCESS_CACHE_CONTROL =
  process.env.SUCCESS_CACHE_CONTROL ||
  'public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400';
const OUTBOUND_PROXY_URL = process.env.OUTBOUND_PROXY_URL;

const app = new Hono();
const cache = new Map();
let extractorFetchPromise;

function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '*';
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const allowedOrigins = parseAllowedOrigins();

function allowOriginFor(c) {
  const origin = c.req.header('origin');
  if (allowedOrigins.includes('*') || !origin) return '*';
  return allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
}

function normalizeApiError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const looksLikeBotChallenge =
    message.includes('LOGIN_REQUIRED') ||
    message.includes('not a bot') ||
    message.includes('no longer supported') ||
    message.includes('Video not playable on any client');

  if (looksLikeBotChallenge) {
    return {
      status: 503,
      body: {
        code: 'youtube_blocked_datacenter_ip',
        message:
          'YouTube is blocking this server egress. Cloud/container hosts often use shared datacenter IP ranges that YouTube gates with a bot challenge. If this persists on Cloudflare Containers, route outbound YouTube requests through the library `fetch` option using a trusted proxy.',
        debug: message,
      },
    };
  }

  return {
    status: 500,
    body: { code: 'unknown_error', message },
  };
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  if (CACHE_TTL_MS <= 0) return;
  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

async function getExtractorFetch() {
  if (!OUTBOUND_PROXY_URL) return undefined;
  if (!extractorFetchPromise) {
    extractorFetchPromise = import('undici').then(({ ProxyAgent, fetch }) => {
      const dispatcher = new ProxyAgent(OUTBOUND_PROXY_URL);
      return (input, init) => fetch(input, { ...init, dispatcher });
    });
  }
  return extractorFetchPromise;
}

function cacheHeaders(cacheState) {
  return {
    'Cache-Control': SUCCESS_CACHE_CONTROL,
    'X-Cache': cacheState,
  };
}

function missingVideoId(c) {
  return c.json(
    { code: 'missing_video_id', message: 'Missing videoID' },
    400
  );
}

function methodNotAllowed(c) {
  return c.json({ code: 'method_not_allowed', message: 'Use GET' }, 405);
}

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', allowOriginFor(c));
  c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Vary', 'Origin');

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
});

app.get('/health', (c) =>
  c.json({ status: 'ok', runtime: 'hono-node-container' })
);
app.all('/health', methodNotAllowed);

app.get('/api/subtitles', async (c) => {
  const videoID = c.req.query('videoID');
  const lang = c.req.query('lang') || 'en';

  if (!videoID) return missingVideoId(c);

  try {
    const cacheKey = `subtitles:${videoID}:${lang}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return c.json(cached, 200, cacheHeaders('HIT'));
    }

    const fetchImpl = await getExtractorFetch();
    const body = {
      subtitles: await getSubtitles({ videoID, lang, fetch: fetchImpl }),
    };
    setCached(cacheKey, body);
    return c.json(body, 200, cacheHeaders('MISS'));
  } catch (error) {
    const normalized = normalizeApiError(error);
    return c.json(normalized.body, normalized.status);
  }
});
app.all('/api/subtitles', methodNotAllowed);

app.get('/api/videoDetails', async (c) => {
  const videoID = c.req.query('videoID');
  const lang = c.req.query('lang') || 'en';

  if (!videoID) return missingVideoId(c);

  try {
    const cacheKey = `videoDetails:${videoID}:${lang}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return c.json(cached, 200, cacheHeaders('HIT'));
    }

    const fetchImpl = await getExtractorFetch();
    const body = {
      videoDetails: await getVideoDetails({ videoID, lang, fetch: fetchImpl }),
    };
    setCached(cacheKey, body);
    return c.json(body, 200, cacheHeaders('MISS'));
  } catch (error) {
    const normalized = normalizeApiError(error);
    return c.json(normalized.body, normalized.status);
  }
});
app.all('/api/videoDetails', methodNotAllowed);

app.notFound((c) => c.json({ code: 'not_found', message: 'Not found' }, 404));

app.onError((error, c) => {
  const normalized = normalizeApiError(error);
  return c.json(normalized.body, normalized.status);
});

serve(
  {
    fetch: app.fetch,
    hostname: '0.0.0.0',
    port: PORT,
  },
  () => {
    console.log(`Caption API listening on :${PORT}`);
  }
);
