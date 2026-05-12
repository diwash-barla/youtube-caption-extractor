import he from 'he';
import striptags from 'striptags';

// Universal logger that works in all environments (Node.js, Cloudflare Workers, etc.)
const createLogger = (namespace: string) => {
  const isDebugEnabled = () => {
    try {
      const env =
        typeof process !== 'undefined' && process.env ? process.env : {};
      const debugEnv = env.DEBUG || '';
      return debugEnv === '*' || debugEnv.includes(namespace);
    } catch {
      return false;
    }
  };

  return (message: string, ...args: any[]) => {
    if (isDebugEnabled()) {
      const timestamp = new Date().toISOString();
      const logMessage = `${timestamp} ${namespace} ${message}`;
      if (args.length > 0) {
        console.log(logMessage, ...args);
      } else {
        console.log(logMessage);
      }
    }
  };
};

const debug = createLogger('youtube-caption-extractor');

export interface Subtitle {
  start: string;
  dur: string;
  text: string;
}

export interface Options {
  videoID: string;
  lang?: string;
}

export interface VideoDetails {
  title: string;
  description: string;
  subtitles: Subtitle[];
}

interface CaptionTrack {
  baseUrl: string;
  vssId?: string;
  languageCode?: string;
  kind?: string;
}

interface PlayerResponse {
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
  videoDetails?: {
    title?: string;
    shortDescription?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
}

// InnerTube client profiles. Listed in fallback order — IOS first because
// Apple app review constraints prevent YouTube from requiring PO tokens or
// browser attestation on mobile native clients, making it the most reliable
// path for caption extraction (this is also what yt-dlp prefers).
//
// When YouTube tightens enforcement and one of these starts returning empty
// captions or `UNPLAYABLE`, bump its clientVersion to a current value and
// keep going. Track yt-dlp's `youtube.py` for known-good versions.
interface ClientProfile {
  name: string;
  clientName: string;
  clientVersion: string;
  clientNameHeader: string;
  userAgent: string;
  context: Record<string, unknown>;
}

const CLIENT_PROFILES: ClientProfile[] = [
  {
    name: 'ios',
    clientName: 'IOS',
    clientVersion: '20.10.4',
    clientNameHeader: '5',
    userAgent:
      'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    context: {
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      platform: 'MOBILE',
      osName: 'iOS',
      osVersion: '18.3.2.22D82',
    },
  },
  {
    name: 'mweb',
    clientName: 'MWEB',
    clientVersion: '2.20251209.01.00',
    clientNameHeader: '2',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    context: {
      platform: 'MOBILE',
      osName: 'iOS',
      osVersion: '17.5.1',
    },
  },
  {
    name: 'tv',
    clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    clientVersion: '2.0',
    clientNameHeader: '85',
    userAgent:
      'Mozilla/5.0 (PlayStation 4 5.55) AppleWebKit/601.2 (KHTML, like Gecko)',
    context: {
      platform: 'TV',
    },
  },
];

const INNERTUBE_ENDPOINT =
  'https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false';

async function fetchPlayerWithClient(
  videoID: string,
  client: ClientProfile
): Promise<PlayerResponse> {
  const body = {
    context: {
      client: {
        clientName: client.clientName,
        clientVersion: client.clientVersion,
        hl: 'en',
        gl: 'US',
        ...client.context,
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
    videoId: videoID,
    contentCheckOk: true,
    racyCheckOk: true,
  };

  debug(`Calling InnerTube /player with ${client.name} client`);

  const response = await fetch(INNERTUBE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'User-Agent': client.userAgent,
      'X-YouTube-Client-Name': client.clientNameHeader,
      'X-YouTube-Client-Version': client.clientVersion,
      Origin: 'https://www.youtube.com',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `InnerTube /player failed (${client.name}): ${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as PlayerResponse;
}

// Try clients in order until one returns a playable response with captions.
// Returns the first response that has captionTracks; otherwise the last
// playable response (so the caller can still get title/description).
async function fetchPlayer(videoID: string): Promise<PlayerResponse> {
  let lastPlayable: PlayerResponse | null = null;
  let lastError: Error | null = null;

  for (const client of CLIENT_PROFILES) {
    try {
      const data = await fetchPlayerWithClient(videoID, client);
      const status = data.playabilityStatus?.status;
      debug(`${client.name} client returned playabilityStatus=${status}`);

      if (status && status !== 'OK') {
        // Surface real errors (LOGIN_REQUIRED, AGE_VERIFICATION_REQUIRED,
        // ERROR for private/deleted videos). Don't keep retrying for these.
        if (
          status === 'LOGIN_REQUIRED' ||
          status === 'ERROR' ||
          status === 'AGE_VERIFICATION_REQUIRED'
        ) {
          throw new Error(
            `Video not playable: ${status}${
              data.playabilityStatus?.reason
                ? ` - ${data.playabilityStatus.reason}`
                : ''
            }`
          );
        }
        // UNPLAYABLE / soft errors → try the next client
        continue;
      }

      lastPlayable = data;
      const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length > 0) {
        return data;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      debug(`${client.name} client error: ${lastError.message}`);
    }
  }

  if (lastPlayable) return lastPlayable;
  throw lastError ?? new Error('All InnerTube clients failed');
}

function pickCaptionTrack(
  tracks: CaptionTrack[],
  lang: string
): CaptionTrack | null {
  if (!tracks.length) return null;
  return (
    tracks.find((t) => t.vssId === `.${lang}`) || // manual captions in requested lang
    tracks.find((t) => t.vssId === `a.${lang}`) || // auto-generated in requested lang
    tracks.find((t) => t.languageCode === lang) ||
    tracks.find((t) => t.vssId?.includes(`.${lang}`)) ||
    tracks[0]
  );
}

interface Json3Segment {
  utf8?: string;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Segment[];
  aAppend?: number;
}

interface Json3Transcript {
  events?: Json3Event[];
}

async function fetchCaptionTrack(track: CaptionTrack): Promise<Subtitle[]> {
  // Force json3 — structured, stable across edge cases, no regex parsing needed
  let url = track.baseUrl.replace(/&fmt=[^&]+/, '');
  url += '&fmt=json3';

  debug(`Fetching caption track from ${url.split('?')[0]}?…`);

  const response = await fetch(url, {
    headers: {
      'User-Agent': CLIENT_PROFILES[0].userAgent,
    },
  });

  if (!response.ok) {
    throw new Error(`Caption fetch failed: ${response.status}`);
  }

  const text = await response.text();
  if (!text.trim()) {
    return [];
  }

  let data: Json3Transcript;
  try {
    data = JSON.parse(text) as Json3Transcript;
  } catch {
    throw new Error('Caption response was not valid JSON');
  }

  const events = data.events ?? [];
  const subtitles: Subtitle[] = [];

  for (const event of events) {
    if (!event.segs || event.aAppend === 1) continue;
    const raw = event.segs.map((s) => s.utf8 ?? '').join('');
    const text = he.decode(striptags(raw)).trim();
    if (!text) continue;
    const startMs = event.tStartMs ?? 0;
    const durMs = event.dDurationMs ?? 0;
    subtitles.push({
      start: (startMs / 1000).toString(),
      dur: (durMs / 1000).toString(),
      text,
    });
  }

  debug(`Parsed ${subtitles.length} caption events from json3`);
  return subtitles;
}

async function extractSubtitles(
  playerData: PlayerResponse,
  lang: string
): Promise<Subtitle[]> {
  const tracks =
    playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) {
    debug('No caption tracks available on this video');
    return [];
  }

  const track = pickCaptionTrack(tracks, lang);
  if (!track?.baseUrl) {
    debug(`No matching caption track for lang=${lang}`);
    return [];
  }

  debug(`Selected caption track: ${track.vssId ?? track.languageCode}`);
  return fetchCaptionTrack(track);
}

export const getSubtitles = async ({
  videoID,
  lang = 'en',
}: Options): Promise<Subtitle[]> => {
  debug(`getSubtitles videoID=${videoID} lang=${lang}`);
  const playerData = await fetchPlayer(videoID);
  return extractSubtitles(playerData, lang);
};

export const getVideoDetails = async ({
  videoID,
  lang = 'en',
}: Options): Promise<VideoDetails> => {
  debug(`getVideoDetails videoID=${videoID} lang=${lang}`);
  const playerData = await fetchPlayer(videoID);

  const title = playerData.videoDetails?.title ?? 'No title found';
  const description =
    playerData.videoDetails?.shortDescription ?? 'No description found';

  let subtitles: Subtitle[] = [];
  try {
    subtitles = await extractSubtitles(playerData, lang);
  } catch (err) {
    debug(
      `Subtitle extraction failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return { title, description, subtitles };
};
