import { NextResponse } from 'next/server';

/**
 * Maps library errors to HTTP responses. YouTube blocks datacenter IPs
 * (Vercel, AWS Lambda, Cloudflare Workers) with a bot challenge — the
 * library will throw a descriptive "Video not playable on any client"
 * error in that case. We surface that as a 503 with a friendly explanation
 * instead of a generic 500.
 */
export function handleApiError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);

  const looksLikeBotChallenge =
    message.includes('LOGIN_REQUIRED') ||
    message.includes('not a bot') ||
    message.includes('no longer supported') ||
    message.includes('Video not playable on any client');

  if (looksLikeBotChallenge) {
    return NextResponse.json(
      {
        code: 'youtube_blocked_datacenter_ip',
        message:
          'YouTube is blocking this server. Most cloud hosts (Vercel, AWS Lambda, Cloudflare Workers) share IP ranges that YouTube gates with a bot challenge — no client-side fix can bypass it. The library works on residential IPs: run the demo locally to see it in action, or wire up a residential proxy via the `fetch` option.',
        debug: message,
      },
      { status: 503 }
    );
  }

  return NextResponse.json(
    { code: 'unknown_error', message },
    { status: 500 }
  );
}
