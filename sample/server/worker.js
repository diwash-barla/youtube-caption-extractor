import { Container, getContainer } from '@cloudflare/containers';
import { env as workerEnv } from 'cloudflare:workers';
import { Hono } from 'hono';

const app = new Hono();

export class CaptionApiContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '30m';
  enableInternet = true;
  envVars = {
    NODE_ENV: 'production',
    OUTBOUND_PROXY_URL: workerEnv.OUTBOUND_PROXY_URL || '',
    CACHE_TTL_SECONDS: workerEnv.CACHE_TTL_SECONDS || '21600',
    ALLOWED_ORIGINS: workerEnv.ALLOWED_ORIGINS || '*',
  };
}

async function getCaptionApiContainer(c) {
  const instanceCount = Number.parseInt(c.env.API_INSTANCE_COUNT || '2', 10);
  const containerVersion = c.env.CONTAINER_VERSION || 'default';
  const instanceSlot = Math.floor(Math.random() * instanceCount);
  return getContainer(
    c.env.CAPTION_API,
    `${containerVersion}-${instanceSlot}`
  );
}

async function proxyToContainer(c) {
  const container = await getCaptionApiContainer(c);
  return container.fetch(c.req.raw);
}

async function requireApiToken(c, next) {
  const expectedToken = c.env.CAPTION_API_TOKEN;

  if (!expectedToken) {
    return c.json(
      {
        code: 'auth_misconfigured',
        message: 'CAPTION_API_TOKEN is not configured',
      },
      500
    );
  }

  const authorization = c.req.header('authorization') || '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';

  if (token !== expectedToken) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ code: 'unauthorized', message: 'Unauthorized' }, 401);
  }

  await next();
}

function methodNotAllowed(c) {
  return c.json({ code: 'method_not_allowed', message: 'Use GET' }, 405);
}

app.get('/', (c) =>
  c.json({
    service: 'youtube-caption-extractor-api',
    runtime: 'cloudflare-worker+hono',
    backend: 'cloudflare-container+hono',
    endpoints: ['/health', '/api/subtitles', '/api/videoDetails'],
  })
);

app.use('/health', requireApiToken);
app.use('/api/*', requireApiToken);

app.get('/health', proxyToContainer);
app.get('/api/*', proxyToContainer);
app.all('/health', methodNotAllowed);
app.all('/api/*', methodNotAllowed);

app.notFound((c) => c.json({ code: 'not_found', message: 'Not found' }, 404));

export default app;
