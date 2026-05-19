'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type Subtitle = { start: string; dur: string; text: string };
type VideoDetails = { title?: string; description?: string };
type VideoDetailsPayload = VideoDetails & { subtitles?: Subtitle[] };
type ErrorState = { message: string; code?: string };

async function readApiError(res: Response): Promise<ErrorState> {
  try {
    const body = await res.json();
    return {
      message: body.message ?? body.error ?? `HTTP ${res.status}`,
      code: body.code,
    };
  } catch {
    return { message: `HTTP ${res.status}` };
  }
}

const YOUTUBE_ID_REGEX =
  /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/;

function extractVideoId(input: string): string {
  const t = input.trim();
  if (!t) return '';
  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return t;
  const m = t.match(YOUTUBE_ID_REGEX);
  return m ? m[1] : t;
}

function formatTime(seconds: number | string): string {
  const total = Math.floor(Number(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSrtTime(sec: number): string {
  const total = Math.floor(sec);
  const ms = Math.round((sec - total) * 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(
    s,
  ).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function buildSRT(subs: Subtitle[]): string {
  return subs
    .map((sub, i) => {
      const start = Number(sub.start);
      const end = start + Number(sub.dur);
      return `${i + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${
        sub.text
      }\n`;
    })
    .join('\n');
}

function download(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const LANGUAGES = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['pt', 'Portuguese'],
  ['hi', 'Hindi'],
  ['zh', 'Chinese'],
] as const;

const SAMPLE_IDS = [
  '0Gb1z-2SjHY',
  'D37Ijn2o5U0',
  'g9JIUM0MHgQ',
  '6BB6exR8Zd8',
  '55pTFVoclvE',
];
function apiUrl(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return `${path}${query ? `?${query}` : ''}`;
}

export default function HomePage() {
  const [input, setInput] = useState('');
  const [lang, setLang] = useState('en');
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [videoDetails, setVideoDetails] = useState<VideoDetails>({});
  const [videoId, setVideoId] = useState('');
  const [error, setError] = useState<ErrorState | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const filteredSubs = useMemo(() => {
    if (!query.trim()) return subtitles;
    const q = query.toLowerCase();
    return subtitles.filter((s) => s.text.toLowerCase().includes(q));
  }, [subtitles, query]);

  const totalDuration = useMemo(() => {
    if (!subtitles.length) return 0;
    const last = subtitles[subtitles.length - 1];
    return Number(last.start) + Number(last.dur);
  }, [subtitles]);

  const wordCount = useMemo(
    () =>
      subtitles.reduce(
        (acc, s) => acc + s.text.trim().split(/\s+/).filter(Boolean).length,
        0,
      ),
    [subtitles],
  );

  const hasResults = subtitles.length > 0;

  // Cmd/Ctrl+K to focus search when results are visible
  useEffect(() => {
    if (!hasResults) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasResults]);

  const fetchData = async (overrideInput?: string) => {
    const raw = overrideInput ?? input;
    const id = extractVideoId(raw);
    if (!id || id.length !== 11) {
      setError({
        message: 'That doesn’t look like a YouTube URL or video ID.',
      });
      return;
    }
    if (overrideInput) setInput(overrideInput);
    setIsFetching(true);
    setError(null);
    setQuery('');
    try {
      const params = new URLSearchParams({ videoID: id, lang });
      const detailsRes = await fetch(apiUrl('/api/videoDetails', params));

      if (!detailsRes.ok) {
        setError(await readApiError(detailsRes));
        setSubtitles([]);
        setVideoDetails({});
        return;
      }

      const detailsData = await detailsRes.json();
      const details: VideoDetailsPayload = detailsData.videoDetails ?? {};
      const { subtitles: subs = [], ...metadata } = details;

      setSubtitles(subs);
      setVideoDetails(metadata);
      setVideoId(id);
      if (subs.length === 0) {
        setError({
          message: `No captions for ${LANGUAGES.find((l) => l[0] === lang)?.[1] ?? lang}. This video might not be subtitled in that language.`,
        });
      }
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Unknown error',
      });
      setSubtitles([]);
      setVideoDetails({});
    } finally {
      setIsFetching(false);
    }
  };

  const copyTranscript = async () => {
    const text = subtitles.map((s) => s.text).join('\n');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <main className='min-h-screen flex flex-col'>
      <div className='mx-auto w-full max-w-2xl px-6 sm:px-8 pt-16 sm:pt-24 pb-16 flex-1'>
        {/* Eyebrow */}
        <div className='font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500'>
          youtube-caption-extractor
        </div>

        {/* Headline */}
        <h1 className='mt-3 font-serif text-[44px] sm:text-[56px] leading-[1.15] tracking-[-0.02em] text-stone-900'>
          <span className='highlight'>Get clean transcript</span>
          <br />
          <span className='highlight italic font-light'>
            for any{' '}
            <span className='not-italic font-normal tracking-[-0.01em]'>
              YouTube
            </span>{' '}
            video
          </span>
        </h1>

        <p className='mt-6 max-w-md text-stone-600 leading-relaxed'>
          Paste the video link and read it like an article: searchable,
          timestamped, exportable.
        </p>

        {/* Input — single underlined field, language as inline metadata below */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!isFetching) fetchData();
          }}
          className='mt-12'
        >
          <div className='relative'>
            <input
              type='text'
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder='paste a youtube link'
              spellCheck={false}
              autoFocus
              disabled={isFetching}
              className='w-full bg-transparent border-b border-stone-300 pb-3 pr-10 text-lg text-stone-900 placeholder:text-stone-400 focus:outline-none focus:border-stone-900 transition-colors disabled:opacity-50'
            />
            <button
              type='submit'
              disabled={isFetching || !input.trim()}
              aria-label='Extract transcript'
              className='absolute right-0 bottom-3 text-stone-400 hover:text-stone-900 disabled:opacity-30 disabled:cursor-not-allowed transition-colors'
            >
              {isFetching ? (
                <Spinner />
              ) : (
                <svg
                  viewBox='0 0 24 24'
                  className='size-5'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='1.75'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  aria-hidden='true'
                >
                  <path d='M5 12h14M13 5l7 7-7 7' />
                </svg>
              )}
            </button>
          </div>

          <div className='mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3 text-xs text-stone-500'>
            <label className='inline-flex items-baseline gap-2'>
              <span>in</span>
              <span className='relative'>
                <select
                  value={lang}
                  onChange={(e) => setLang(e.target.value)}
                  className='appearance-none bg-transparent pr-4 text-stone-900 border-b border-dotted border-stone-400 hover:border-stone-900 focus:outline-none focus:border-stone-900 transition-colors cursor-pointer'
                  aria-label='Language'
                >
                  {LANGUAGES.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
                <span
                  className='absolute right-0 top-1/2 -translate-y-1/2 text-stone-400 pointer-events-none text-[10px]'
                  aria-hidden='true'
                >
                  ▾
                </span>
              </span>
            </label>

            {!hasResults && !isFetching && (
              <div className='inline-flex items-baseline gap-3'>
                <span>or try</span>
                {SAMPLE_IDS.map((id, idx) => (
                  <span key={id} className='inline-flex items-baseline gap-3'>
                    <button
                      type='button'
                      onClick={() => fetchData(id)}
                      className='font-mono text-stone-700 hover:text-stone-900 underline decoration-stone-300 hover:decoration-stone-900 decoration-1 underline-offset-[3px] transition-colors'
                    >
                      {id}
                    </button>
                    {idx < SAMPLE_IDS.length - 1 && (
                      <span className='text-stone-300'>·</span>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>
        </form>

        {/* Error / notice */}
        {error &&
          (error.code === 'youtube_blocked_datacenter_ip' ? (
            <aside className='mt-8 rounded-md border border-amber-200 bg-amber-50/60 px-5 py-4'>
              <div className='font-mono text-[10px] uppercase tracking-[0.22em] text-amber-700 mb-2'>
                Live demo limitation
              </div>
              <p className='text-sm text-stone-700 leading-relaxed'>
                {error.message}
              </p>
              <div className='mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs'>
                <a
                  href='https://github.com/devhims/youtube-caption-extractor#deployment-environments'
                  target='_blank'
                  rel='noopener noreferrer'
                  className='text-amber-800 hover:text-amber-900 underline decoration-amber-300 hover:decoration-amber-700 decoration-1 underline-offset-[3px] transition-colors'
                >
                  why this happens
                </a>
                <a
                  href='https://github.com/devhims/youtube-caption-extractor'
                  target='_blank'
                  rel='noopener noreferrer'
                  className='text-amber-800 hover:text-amber-900 underline decoration-amber-300 hover:decoration-amber-700 decoration-1 underline-offset-[3px] transition-colors'
                >
                  run locally
                </a>
              </div>
            </aside>
          ) : (
            <p className='mt-6 text-sm text-stone-600 border-l-2 border-stone-300 pl-3'>
              {error.message}
            </p>
          ))}

        {/* Loading */}
        {isFetching && !hasResults && (
          <div className='mt-16 space-y-6'>
            <div className='flex gap-5'>
              <div className='shrink-0 w-32 aspect-video bg-stone-100 rounded animate-pulse' />
              <div className='flex-1 space-y-2 pt-1'>
                <div className='h-5 bg-stone-100 rounded animate-pulse w-3/4' />
                <div className='h-3 bg-stone-100 rounded animate-pulse w-1/3' />
              </div>
            </div>
            <hr className='border-stone-200' />
            <div className='space-y-3'>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className='flex gap-4'>
                  <div className='w-10 h-3 bg-stone-100 rounded animate-pulse mt-1.5' />
                  <div
                    className='flex-1 h-3 bg-stone-100 rounded animate-pulse'
                    style={{ width: `${60 + ((i * 7) % 40)}%` }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Results */}
        {hasResults && (
          <article className='mt-16'>
            {/* Video header */}
            <header className='flex gap-5 mb-10'>
              <a
                href={`https://youtu.be/${videoId}`}
                target='_blank'
                rel='noopener noreferrer'
                className='shrink-0 group block w-32 aspect-video rounded overflow-hidden bg-stone-100 border border-stone-200'
              >
                <img
                  src={`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`}
                  alt={videoDetails.title ?? 'Video thumbnail'}
                  className='w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500'
                />
              </a>
              <div className='flex-1 min-w-0'>
                <h2 className='font-serif text-2xl leading-[1.15] tracking-[-0.01em] text-stone-900 text-balance'>
                  {videoDetails.title || `youtu.be/${videoId}`}
                </h2>
                <a
                  href={`https://youtu.be/${videoId}`}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='mt-2 inline-flex items-center gap-1 text-xs font-mono text-stone-500 hover:text-stone-900 transition-colors'
                >
                  <span>youtu.be/{videoId}</span>
                  <span aria-hidden='true'>↗</span>
                </a>
              </div>
            </header>

            <hr className='border-stone-200' />

            {/* Stats */}
            <dl className='mt-6 flex items-baseline gap-8 text-sm'>
              <Stat label='segments' value={subtitles.length.toString()} />
              <Stat label='length' value={formatTime(totalDuration)} />
              <Stat label='words' value={wordCount.toLocaleString()} />
              <Stat label='language' value={lang} />
            </dl>

            {/* Description */}
            {videoDetails.description && (
              <details className='mt-6 group'>
                <summary className='cursor-pointer text-xs uppercase tracking-[0.18em] text-stone-500 hover:text-stone-900 transition-colors inline-flex items-center gap-1.5'>
                  <span>description</span>
                  <span className='group-open:rotate-90 transition-transform inline-block'>
                    →
                  </span>
                </summary>
                <p className='mt-3 text-sm text-stone-600 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto scrollbar-paper pr-2'>
                  {videoDetails.description}
                </p>
              </details>
            )}

            {/* Transcript section */}
            <section className='mt-14'>
              <div className='flex items-baseline justify-between gap-4 mb-5'>
                <h3 className='font-serif text-2xl tracking-[-0.01em] text-stone-900'>
                  Transcript
                </h3>
                <div className='flex items-center gap-4 text-xs'>
                  <button
                    onClick={copyTranscript}
                    className='text-stone-500 hover:text-stone-900 transition-colors'
                  >
                    {copied ? 'copied' : 'copy'}
                  </button>
                  <button
                    onClick={() =>
                      download(
                        subtitles.map((s) => s.text).join('\n'),
                        `${videoId}.txt`,
                        'text/plain',
                      )
                    }
                    className='text-stone-500 hover:text-stone-900 transition-colors'
                  >
                    .txt
                  </button>
                  <button
                    onClick={() =>
                      download(
                        buildSRT(subtitles),
                        `${videoId}.srt`,
                        'application/x-subrip',
                      )
                    }
                    className='text-stone-500 hover:text-stone-900 transition-colors'
                  >
                    .srt
                  </button>
                </div>
              </div>

              {/* Search */}
              <div className='relative mb-6'>
                <input
                  ref={searchRef}
                  type='search'
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder='Search transcript'
                  className='w-full bg-transparent border-b border-stone-200 py-2 pr-16 text-sm placeholder:text-stone-400 focus:outline-none focus:border-stone-900 transition-colors'
                />
                <kbd className='absolute right-0 top-1/2 -translate-y-1/2 text-[10px] font-mono text-stone-400 border border-stone-200 rounded px-1.5 py-0.5'>
                  ⌘K
                </kbd>
                {query.trim() && (
                  <div className='mt-2 text-xs text-stone-500'>
                    {filteredSubs.length === 0
                      ? `no matches`
                      : `${filteredSubs.length} of ${subtitles.length}`}
                  </div>
                )}
              </div>

              {/* Segments */}
              <ol className='space-y-2'>
                {filteredSubs.map((sub, i) => (
                  <li key={`${sub.start}-${i}`} className='flex gap-5 group'>
                    <a
                      href={`https://youtu.be/${videoId}?t=${Math.floor(
                        Number(sub.start),
                      )}s`}
                      target='_blank'
                      rel='noopener noreferrer'
                      className='shrink-0 w-12 pt-[3px] font-mono text-[11px] tabular-nums text-stone-400 hover:text-stone-900 transition-colors text-right'
                      title='Open at this moment'
                    >
                      {formatTime(sub.start)}
                    </a>
                    <p className='flex-1 text-[15px] leading-[1.7] text-stone-800'>
                      {query.trim() ? highlight(sub.text, query) : sub.text}
                    </p>
                  </li>
                ))}
              </ol>
            </section>
          </article>
        )}
      </div>

      {/* Footer pinned to the bottom of the viewport on short content, naturally follows on long content */}
      <footer className='border-t border-stone-200'>
        <div className='mx-auto w-full max-w-2xl px-6 sm:px-8 py-6 text-xs text-stone-500 flex flex-wrap items-baseline gap-x-6 gap-y-2'>
          <a
            href='https://www.npmjs.com/package/youtube-caption-extractor'
            target='_blank'
            rel='noopener noreferrer'
            className='hover:text-stone-900 transition-colors'
          >
            npm
          </a>
          <a
            href='https://github.com/devhims/youtube-caption-extractor'
            target='_blank'
            rel='noopener noreferrer'
            className='hover:text-stone-900 transition-colors'
          >
            github
          </a>
          <span className='ml-auto font-mono text-stone-400'>v1.10.2</span>
        </div>
      </footer>
    </main>
  );
}

function Spinner() {
  return (
    <svg
      className='size-3.5 animate-spin'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.5'
      strokeLinecap='round'
    >
      <path d='M12 3a9 9 0 1 0 9 9' className='opacity-90' />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex flex-col'>
      <dt className='text-[10px] uppercase tracking-[0.18em] text-stone-500 mb-1'>
        {label}
      </dt>
      <dd className='font-serif text-xl tabular-nums text-stone-900'>
        {value}
      </dd>
    </div>
  );
}

function highlight(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const parts = text.split(new RegExp(`(${escapeRegex(q)})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase() ? (
      <mark key={i} className='bg-yellow-100 text-stone-900 rounded px-0.5'>
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
