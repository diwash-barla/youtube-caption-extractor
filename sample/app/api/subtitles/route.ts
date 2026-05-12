import { getSubtitles } from 'youtube-caption-extractor';
import { NextResponse, type NextRequest } from 'next/server';
import { handleApiError } from '../_lib/handleError';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const videoID = searchParams.get('videoID');
  const lang = searchParams.get('lang') || 'en';

  if (!videoID) {
    return NextResponse.json(
      { code: 'missing_video_id', message: 'Missing videoID' },
      { status: 400 }
    );
  }

  try {
    const subtitles = await getSubtitles({ videoID, lang });
    return NextResponse.json({ subtitles }, { status: 200 });
  } catch (error) {
    return handleApiError(error);
  }
}
