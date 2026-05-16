import { NextResponse } from 'next/server';

const PROXY_HEADERS = ['content-type', 'cache-control', 'x-cache'];

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

  try {
    const upstream = await fetch(upstreamUrl, {
      cache: 'no-store',
      headers,
    });
    const responseHeaders = new Headers();

    for (const header of PROXY_HEADERS) {
      const value = upstream.headers.get(header);
      if (value) responseHeaders.set(header, value);
    }

    return new NextResponse(await upstream.text(), {
      headers: responseHeaders,
      status: upstream.status,
    });
  } catch (error) {
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
