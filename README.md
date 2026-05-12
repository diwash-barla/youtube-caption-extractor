# youtube-caption-extractor

A small, dependency-light library that extracts the transcript (and basic
metadata) from any public YouTube video. Works with both manual captions and
YouTube's auto-generated subtitles, in any language the video has tracks for.

```ts
import { getSubtitles } from 'youtube-caption-extractor';

const subtitles = await getSubtitles({ videoID: 'dQw4w9WgXcQ', lang: 'en' });
// → [
//     { start: '3.84', dur: '4.16', text: 'We're no strangers to love' },
//     { start: '8.00', dur: '5.84', text: 'You know the rules, and so do I' },
//     ...
//   ]
```

## Installation

```sh
npm install youtube-caption-extractor
```

Requires **Node.js ≥ 18** (uses the global `fetch` API). Works in Node.js,
Bun, Deno, Cloudflare Workers, and any other modern JavaScript runtime that
provides `fetch` — see [Deployment environments](#deployment-environments)
for important notes about which runtimes YouTube will actually allow.

## API

The library exports two functions and three types.

### `getSubtitles({ videoID, lang?, fetch? })`

Returns the caption track as an array of timed segments.

| Param | Type | Default | Notes |
|---|---|---|---|
| `videoID` | `string` | (required) | The 11-character YouTube video ID, e.g. `dQw4w9WgXcQ`. Not the full URL. |
| `lang` | `string` | `'en'` | ISO language code (`'en'`, `'es'`, `'fr'`, `'ja'`, …). Manual captions are preferred over auto-generated, and an exact match is preferred over a partial match. |
| `fetch` | `typeof fetch` | global `fetch` | Custom fetch implementation. Use this to route through a residential proxy on Vercel / AWS Lambda / Workers. See [Making it work in production](#making-it-work-in-production). |

Resolves to `Subtitle[]`. Returns an empty array if the video plays but has no caption track in the requested language. **Throws** if the video is unavailable on any extraction path (see [Error handling](#error-handling)).

### `getVideoDetails({ videoID, lang?, fetch? })`

Same arguments as `getSubtitles`. Returns title, description, and the same subtitle array:

```ts
const details = await getVideoDetails({ videoID, lang: 'en' });
// → {
//     title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
//     description: 'The official video for "Never Gonna Give You Up"…',
//     subtitles: [{ start: '3.84', dur: '4.16', text: '...' }, …],
//   }
```

If subtitles fail to extract but the video metadata is available, `subtitles` will be an empty array and the call still resolves (rather than throwing). This way you can always show title/description even when captions aren't available.

### Types

```ts
interface Subtitle {
  start: string;        // Segment start time, seconds
  dur: string;          // Segment duration, seconds
  text: string;         // Decoded text content
}

interface VideoDetails {
  title: string;
  description: string;
  subtitles: Subtitle[];
}

interface Options {
  videoID: string;
  lang?: string;
  fetch?: typeof fetch;
}
```

All three are exported by name and can be imported directly:

```ts
import type { Subtitle, VideoDetails, Options } from 'youtube-caption-extractor';
```

## Languages

The `lang` argument is a hint, not a strict filter. Track selection precedence:

1. **Manual captions in the requested language** (`vssId === '.<lang>'`)
2. **Auto-generated captions in the requested language** (`vssId === 'a.<lang>'`)
3. **Any track whose `languageCode` matches** the requested code
4. **Any track whose `vssId` contains the requested code** (partial match)
5. **The first available track** as a final fallback

If you pass `lang: 'en'` and the video only has Spanish manual captions, you'll get those — the library prefers *some* output over none. If you pass a code that doesn't exist on the video, you'll typically get the video's primary language track. To check whether you got what you asked for, inspect the first segment's text or compare against `VideoDetails.title` / `description`.

## Error handling

The library throws an `Error` (a regular `Error`, not a custom class) when no extraction path succeeds — typically a private video, a deleted video, or a server-side block (see [Deployment environments](#deployment-environments)).

The error message has a stable, parseable structure:

```
Video not playable on any client. Attempts:
tv: ERROR - <reason from YouTube>
android_vr: LOGIN_REQUIRED - Sign in to confirm you're not a bot
ios: LOGIN_REQUIRED - Sign in to confirm you're not a bot
mweb: LOGIN_REQUIRED - Sign in to confirm you're not a bot
```

If `LOGIN_REQUIRED` or `not a bot` appears in the message, the client failed YouTube's bot challenge — almost always means you're hitting it from a datacenter IP and need a proxy. If the error names a specific YouTube status like `ERROR - Video unavailable`, the video itself is the problem.

A common pattern for surfacing this gracefully:

```ts
try {
  const subtitles = await getSubtitles({ videoID, lang });
  return subtitles;
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('LOGIN_REQUIRED') || msg.includes('not a bot')) {
    throw new Error('youtube_blocked_by_bot_challenge');
  }
  if (msg.includes('Video unavailable') || msg.includes('private')) {
    throw new Error('video_not_accessible');
  }
  throw err;
}
```

## Deployment environments

This package calls YouTube's internal player API. **YouTube filters requests by source IP** and gates many cloud/datacenter ranges with a bot challenge. Compatibility depends entirely on where your code egresses from.

Compatibility, based on real measurements from deployed test endpoints (May 2026 — 20 sequential requests per platform):

| Environment | Source IP | Behavior |
|---|---|---|
| Local development | Residential | ✅ Reliable (close to 100%) |
| Self-hosted Node server on a residential connection | Residential | ✅ Reliable |
| Traditional VPS / dedicated server | Datacenter | ⚠️ Depends on host IP reputation |
| **Cloudflare Workers** | Cloudflare edge (mixed) | ⚠️ **~70% per request** (14/20 in our test), see [retry pattern](#cloudflare-workers-pattern-retry-on-bot-challenge) below — usable in production with retries |
| Vercel Functions / Vercel Edge | AWS / edge datacenter | ❌ **0% in our test** (0/20), needs residential proxy |
| AWS Lambda / Netlify Functions | AWS datacenter | ❌ Almost always blocked, needs proxy |
| Browser (client-side `fetch`) | Residential, but… | ❌ CORS blocks the InnerTube call — proxy through your own server |

This isn't a library-level issue — `yt-dlp` and other extractors hit the same wall. There's no client-version trick or header combination that gets past it; YouTube filters by source IP at the network layer.

### Cloudflare Workers pattern (retry on bot challenge)

Cloudflare Workers succeed roughly 70% of the time per request because outbound traffic egresses from many PoPs with varying IP reputations. A simple retry-on-block wrapper pushes the effective success rate to ~91% with one retry and ~97% with two:

```ts
import { getSubtitles, type Subtitle } from 'youtube-caption-extractor';

async function getSubtitlesWithRetry(
  videoID: string,
  lang = 'en',
  maxAttempts = 3
): Promise<Subtitle[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await getSubtitles({ videoID, lang });
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isBotChallenge =
        msg.includes('LOGIN_REQUIRED') || msg.includes('not a bot');
      if (!isBotChallenge) throw err; // real error, don't retry
      // Small backoff so retries land on different PoP states
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  throw lastError;
}
```

For higher availability (>99%) on Workers, combine the retry pattern with a residential-proxy fallback on final failure.

### Vercel / AWS / browser pattern (residential proxy)

For deployments where YouTube blocks essentially 100% of requests, route through a **residential proxy** via the `fetch` option:

```ts
import { getSubtitles } from 'youtube-caption-extractor';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const dispatcher = new ProxyAgent(process.env.RESIDENTIAL_PROXY_URL!);

const proxied: typeof fetch = (input, init) =>
  undiciFetch(input, { ...init, dispatcher }) as unknown as Promise<Response>;

const subtitles = await getSubtitles({
  videoID: 'dQw4w9WgXcQ',
  lang: 'en',
  fetch: proxied,
});
```

Common residential-proxy providers: **Bright Data**, **IPRoyal**, **Decodo**, **Oxylabs**. Most start around $5–15/mo for modest traffic and offer a free trial.

The `fetch` option can also be used for:

- **Caching layers** — wrap the global fetch with your own LRU/in-memory cache
- **Authenticated proxies** — pass `Authorization` headers via a wrapper
- **Region-specific egress** — route through a specific country's residential IPs

## Usage examples

### Next.js (App Router)

```ts
// app/api/captions/route.ts
import { NextResponse, type NextRequest } from 'next/server';
import { getVideoDetails } from 'youtube-caption-extractor';

export async function GET(request: NextRequest) {
  const videoID = request.nextUrl.searchParams.get('videoID');
  const lang = request.nextUrl.searchParams.get('lang') ?? 'en';

  if (!videoID) {
    return NextResponse.json({ error: 'Missing videoID' }, { status: 400 });
  }

  try {
    const details = await getVideoDetails({ videoID, lang });
    return NextResponse.json(details);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
```

Call from a client component with `fetch('/api/captions?videoID=...')`. This avoids the browser CORS issue and keeps the YouTube call server-side.

### Express

```ts
import express from 'express';
import { getSubtitles } from 'youtube-caption-extractor';

const app = express();

app.get('/captions/:videoID', async (req, res) => {
  try {
    const subtitles = await getSubtitles({
      videoID: req.params.videoID,
      lang: (req.query.lang as string) ?? 'en',
    });
    res.json({ subtitles });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
```

### Cloudflare Workers (retry-on-block)

Cloudflare Workers reach YouTube about 70% of the time per request — failures are stochastic (different egress PoPs have different IP reputations). A small retry loop on bot-challenge errors brings the effective success rate up to 91% (1 retry) or 97% (2 retries):

```ts
import { getSubtitles, type Subtitle } from 'youtube-caption-extractor';

async function getSubtitlesWithRetry(
  videoID: string,
  lang: string,
  maxAttempts = 3,
): Promise<Subtitle[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await getSubtitles({ videoID, lang });
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Only retry the bot-challenge case; real errors fail fast.
      if (!msg.includes('LOGIN_REQUIRED') && !msg.includes('not a bot')) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  throw lastError;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const videoID = url.searchParams.get('videoID');
    if (!videoID) return new Response('Missing videoID', { status: 400 });

    try {
      const subtitles = await getSubtitlesWithRetry(videoID, 'en', 3);
      return Response.json({ subtitles });
    } catch (err) {
      return Response.json(
        { error: (err as Error).message },
        { status: 500 },
      );
    }
  },
};
```

Add `compatibility_flags: ["nodejs_compat"]` in your `wrangler.jsonc` so the library's `he` and `striptags` dependencies resolve.

For ≥99% reliability, combine the retry pattern with a residential-proxy fallback on final failure — see [Vercel / AWS / browser pattern](#vercel--aws--browser-pattern-residential-proxy).

## Debug logging

The library is silent by default. To see what's happening internally — which client returned what, where it fell back, what URL was hit — set the `DEBUG` env var:

```sh
DEBUG=youtube-caption-extractor node your-script.js

# Cloudflare Workers
DEBUG=youtube-caption-extractor wrangler dev

# Or DEBUG=* for everything
```

The logger uses only `console.log` and `process.env` (read defensively), so it works in any runtime that provides those — no `debug` package dependency.

## TypeScript

The package ships type definitions; no `@types/*` install needed. All three types (`Subtitle`, `VideoDetails`, `Options`) are exported:

```ts
import {
  getSubtitles,
  getVideoDetails,
  type Subtitle,
  type VideoDetails,
  type Options,
} from 'youtube-caption-extractor';

async function transcript(opts: Options): Promise<Subtitle[]> {
  return await getSubtitles(opts);
}
```

## Changelog

### v1.10.0

- Caption extraction is reliable again — fixes a regression where `getSubtitles` would silently return `[]` for many videos.
- Multi-path extraction with automatic fallback across clients; gracefully degrades when one path is unavailable.
- json3-based subtitle parser replaces the legacy XML regex, fixing multi-line and special-character edge cases.
- New optional `fetch` option for routing through a residential proxy.
- `Options` interface now exported.
- `engines.node` bumped to `>=18.0.0`.
- Slimmer install — published tarball is ~85% smaller.

### v1.9.0

- `Subtitle` interface exported.
- Universal debug logger that works in Node.js, Cloudflare Workers, and edge runtimes.
- Library is silent by default in production.

### v1.4.2

- TypeScript definitions shipped with the package.
- Node.js and edge runtime support.
- New `getVideoDetails` API for title + description + subtitles in one call.

## License

[MIT](./LICENSE)
