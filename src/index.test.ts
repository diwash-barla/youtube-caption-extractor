import {
  getSubtitles,
  getVideoDetails,
  Options,
  Subtitle,
  VideoDetails,
} from './index';

// Surface-level sanity tests — always run, no network.
describe('public API surface', () => {
  test('exports the documented functions and types', () => {
    expect(typeof getSubtitles).toBe('function');
    expect(typeof getVideoDetails).toBe('function');
  });
});

// Live-network integration tests. YouTube blocks most datacenter IP ranges
// (including GitHub Actions, AWS, etc.) with a "Sign in to confirm you're
// not a bot" challenge that no client version bypasses. So these tests are
// gated behind YOUTUBE_LIVE=1 and only run by default in local development
// (where the requester IP is residential).
const liveTestsEnabled =
  !process.env.CI || process.env.YOUTUBE_LIVE === '1';
const describeLive = liveTestsEnabled ? describe : describe.skip;

const TEST_VIDEOS = {
  // "I Stopped Building MCP Servers. Here's Why." — ASR English only
  asr: 'Q0RFb53ExfY',
  // Manual English captions
  manual: 'fKxLbERmB4U',
};

const NETWORK_TIMEOUT = 20_000;

describeLive('getSubtitles (live)', () => {
  test(
    'extracts auto-generated English captions',
    async () => {
      const subtitles = await getSubtitles({
        videoID: TEST_VIDEOS.asr,
        lang: 'en',
      });
      expect(Array.isArray(subtitles)).toBe(true);
      expect(subtitles.length).toBeGreaterThan(0);

      const first = subtitles[0];
      expect(first).toHaveProperty('start');
      expect(first).toHaveProperty('dur');
      expect(first).toHaveProperty('text');
      expect(typeof first.text).toBe('string');
      expect(first.text.length).toBeGreaterThan(0);
      expect(Number(first.start)).not.toBeNaN();
      expect(Number(first.dur)).not.toBeNaN();
    },
    NETWORK_TIMEOUT
  );

  test(
    'extracts manual English captions',
    async () => {
      const subtitles = await getSubtitles({
        videoID: TEST_VIDEOS.manual,
        lang: 'en',
      });
      expect(subtitles.length).toBeGreaterThan(0);
    },
    NETWORK_TIMEOUT
  );
});

describeLive('getVideoDetails (live)', () => {
  let videoDetails: VideoDetails;

  beforeAll(async () => {
    const options: Options = { videoID: TEST_VIDEOS.asr, lang: 'en' };
    videoDetails = await getVideoDetails(options);
  }, NETWORK_TIMEOUT);

  test('returns title, description, and subtitles', () => {
    expect(videoDetails).toHaveProperty('title');
    expect(videoDetails).toHaveProperty('description');
    expect(videoDetails).toHaveProperty('subtitles');
  });

  test('title and description are non-empty strings', () => {
    expect(typeof videoDetails.title).toBe('string');
    expect(videoDetails.title.length).toBeGreaterThan(0);
    expect(videoDetails.title).not.toBe('No title found');
    expect(typeof videoDetails.description).toBe('string');
    expect(videoDetails.description.length).toBeGreaterThan(0);
  });

  test('subtitles is a non-empty array of Subtitle objects', () => {
    expect(Array.isArray(videoDetails.subtitles)).toBe(true);
    expect(videoDetails.subtitles.length).toBeGreaterThan(0);
    const s: Subtitle = videoDetails.subtitles[0];
    expect(s.text.length).toBeGreaterThan(0);
  });
});
