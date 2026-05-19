import { NextResponse } from 'next/server';

const PROXY_HEADERS = ['content-type', 'cache-control', 'x-cache'];
const RETRYABLE_PROXY_STATUSES = new Set([502, 503, 504]);

function proxyAttempts(): number {
  const configured = Number(process.env.CAPTION_API_PROXY_ATTEMPTS || 3);
  if (!Number.isFinite(configured)) return 3;
  return Math.max(1, Math.min(5, Math.floor(configured)));
}

function captionApiBaseUrl(): string {
  return (process.env.CAPTION_API_BASE_URL || '').replace(/\/+$/, '');
}

function captionApiToken(): string {
  return process.env.CAPTION_API_TOKEN || '';
}

export async function proxyCaptionApi(
  path: string,
  searchParams: URLSearchParams
): Promise<NextResponse | null> {
  const baseUrl = captionApiBaseUrl();
  if (!baseUrl) return null;

  const upstreamUrl = `${baseUrl}${path}?${searchParams.toString()}`;
  const token = captionApiToken();
  const headers = new Headers();

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const attempts = proxyAttempts();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const upstream = await fetch(upstreamUrl, {
        cache: 'no-store',
        headers,
      });
      const body = await upstream.text();
      const responseHeaders = new Headers();

      for (const header of PROXY_HEADERS) {
        const value = upstream.headers.get(header);
        if (value) responseHeaders.set(header, value);
      }

      if (
        attempt < attempts &&
        RETRYABLE_PROXY_STATUSES.has(upstream.status)
      ) {
        continue;
      }

      return new NextResponse(body, {
        headers: responseHeaders,
        status: upstream.status,
      });
    } catch (error) {
      if (attempt < attempts) continue;
      return NextResponse.json(
        {
          code: 'caption_api_unreachable',
          message:
            error instanceof Error ? error.message : 'Caption API unreachable',
        },
        { status: 502 }
      );
    }
  }

  return NextResponse.json(
    { code: 'caption_api_unreachable', message: 'Caption API unreachable' },
    { status: 502 }
  );
}
