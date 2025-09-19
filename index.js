// index.js (ESM)
import 'dotenv/config';
import sdk from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP } = sdk;

const TMDB_KEY = process.env.TMDB_API_KEY;
if (!TMDB_KEY) {
  console.error('Missing TMDB_API_KEY in environment');
  process.exit(1);
}

const TMDB_IMG_W500 = 'https://image.tmdb.org/t/p/w500';
const TMDB_IMG_BG   = 'https://image.tmdb.org/t/p/w1280';

// ---------- utils ----------
async function tmdb(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set('api_key', TMDB_KEY);
  url.searchParams.set('language', 'en-GB');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}
const img = (p) => (p ? `${TMDB_IMG_W500}${p}` : undefined);

// Web-friendly links for Streams
const webSearch = (q) => `https://web.stremio.com/#/search?search=${encodeURIComponent(q)}`;
const webDetail = (kind, id) => `https://web.stremio.com/#/detail/${kind}/${encodeURIComponent(id)}`;

// IDs
async function imdbForTv(tmdbId)    { try { return (await tmdb(`/tv/${tmdbId}/external_ids`)).imdb_id || null; } catch { return null; } }
async function imdbForMovie(tmdbId) { try { return (await tmdb(`/movie/${tmdbId}/external_ids`)).imdb_id || null; } catch { return null; } }
async function tmdbFromImdb(imdb)   {
  try {
    const r = await tmdb(`/find/${imdb}`, { external_source: 'imdb_id' });
    if (r.movie_results?.[0]) return { tmdbType: 'movie', tmdbId: r.movie_results[0].id };
    if (r.tv_results?.[0])    return { tmdbType: 'tv',    tmdbId: r.tv_results[0].id };
  } catch {}
  return null;
}

// TMDB lists
const getOnAir   = (page) => tmdb('/tv/on_the_air', { page: String(page) });
const getPopTv   = (page) => tmdb('/tv/popular',    { page: String(page) });
const getPopMov  = (page) => tmdb('/movie/popular', { page: String(page) });

// Search / recs
async function resolveQueryToTmdb(q) {
  const query = (q || '').trim();
  if (!query) return null;
  if (/^tt\d+$/i.test(query)) {
    const r = await tmdb(`/find/${query}`, { external_source: 'imdb_id' });
    if (r.movie_results?.[0]) return { tmdbType: 'movie', tmdbId: r.movie_results[0].id };
    if (r.tv_results?.[0])    return { tmdbType: 'tv',    tmdbId: r.tv_results[0].id };
    return null;
  }
  const m = await tmdb('/search/movie', { query });
  const t = await tmdb('/search/tv',    { query });
  const mTop = m.results?.[0], tTop = t.results?.[0];
  if (mTop && tTop) return (Number(mTop.popularity||0) >= Number(tTop.popularity||0)) ? { tmdbType:'movie', tmdbId:mTop.id } : { tmdbType:'tv', tmdbId:tTop.id };
  if (mTop) return { tmdbType:'movie', tmdbId:mTop.id };
  if (tTop) return { tmdbType:'tv',    tmdbId:tTop.id };
  return null;
}
async function getRecs({ tmdbType, tmdbId, page = 1 }) {
  const path = tmdbType === 'movie' ? `/movie/${tmdbId}/recommendations` : `/tv/${tmdbId}/recommendations`;
  return tmdb(path, { page: String(page) });
}

// ---------- manifest ----------
const manifest = {
  id: 'org.example.tmdb.onair',
  version: '2.3.3',
  name: 'TMDB Recommendations & Popular',
  description:
    'Discovery-focused add-on for Stremio. Optional rails: “On the air” (TV) and “Recommendations” (TV/Movies). ' +
    'Open titles from this add-on to see a Recommendations list for quick discovery. ' +
    'Use the Popular rails to browse trending titles and jump between related ones.',

  behaviorHints: { configurable: true, configurationRequired: false },
  config: [
    { key: 'enableOnAir',         type: 'boolean', default: 'checked', title: 'Enable “On the air” rail (TV)' },
    { key: 'enableRecsTv',        type: 'boolean', default: 'checked', title: 'Enable “Recommendations” rail (TV)' },
    { key: 'enableRecsMovie',     type: 'boolean', default: 'checked', title: 'Enable “Recommendations” rail (Movies)' },
    { key: 'enableStreamsRecs',   type: 'boolean', default: 'checked', title: 'Enable “Recommendations” button in Streams' },
    { key: 'compatPopularImdb',   type: 'boolean', default: '',        title: 'Compatibility mode for Popular rails (use IMDb IDs)' }
  ],

  resources: [
    'catalog',
    { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tmdb:tv', 'tmdb:movie', 'recs'] },
    'stream'
  ],
  types: ['series', 'movie'],
  idPrefixes: ['tt', 'tmdb:tv', 'tmdb:movie', 'recs'],

  catalogs: [
    { type: 'series', id: 'tmdb-on-air',         name: 'On The Air (TMDB)',               extra: [{ name: 'skip', isRequired: false }] },
    { type: 'series', id: 'tmdb-popular-series', name: 'Popular series recommendations',   extra: [{ name: 'skip', isRequired: false }] },
    { type: 'movie',  id: 'tmdb-popular-movies', name: 'Popular movies recommendations',   extra: [{ name: 'skip', isRequired: false }] },
    { type: 'movie',  id: 'tmdb-recs-movie',     name: 'TMDB Recommendations',             extra: [{ name: 'search', isRequired: true }, { name: 'skip', isRequired: false }] },
    { type: 'series', id: 'tmdb-recs-series',    name: 'TMDB Recommendations',             extra: [{ name: 'search', isRequired: true }, { name: 'skip', isRequired: false }] }
  ]
};

const builder = new addonBuilder(manifest);

// ---------- CATALOG ----------
builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
  const cfg = config || {};
  const tmdbPerPage = 20;
  const maxReturn = 100;
  const skip = Number(extra?.skip || 0);
  const startPage = Math.floor(skip / tmdbPerPage) + 1;
  const endIndexExclusive = skip + maxReturn;
  const endPage = Math.ceil(endIndexExclusive / tmdbPerPage);

  if (id === 'tmdb-on-air'      && cfg.enableOnAir       === false) return { metas: [] };
  if (id === 'tmdb-recs-series' && cfg.enableRecsTv      === false) return { metas: [] };
  if (id === 'tmdb-recs-movie'  && cfg.enableRecsMovie   === false) return { metas: [] };

  // On The Air (TV)
  if (type === 'series' && id === 'tmdb-on-air') {
    const pages = [];
    for (let p = startPage; p <= endPage; p++) {
      const data = await getOnAir(p);
      pages.push(data);
      if (p >= (data.total_pages || p)) break;
    }
    const all = pages.flatMap(pg => pg.results || []);
    const startOffset = skip % tmdbPerPage;
    const window = all.slice(startOffset, startOffset + maxReturn);
    const imdbIds = await Promise.all(window.map(tv => imdbForTv(tv.id)));
    return {
      metas: window.map((tv, i) => ({
        id: imdbIds[i] || `tmdb:tv:${tv.id}`,
        type: 'series',
        name: tv.name || tv.original_name,
        poster: img(tv.poster_path),
        posterShape: 'poster',
        description: tv.overview || '',
        releaseInfo: (tv.first_air_date || '').slice(0, 4)
      }))
    };
  }

  // Popular series
  if (type === 'series' && id === 'tmdb-popular-series') {
    const pages = [];
    for (let p = startPage; p <= endPage; p++) {
      const data = await getPopTv(p);
      pages.push(data);
      if (p >= (data.total_pages || p)) break;
    }
    const all = pages.flatMap(pg => pg.results || []);
    const startOffset = skip % tmdbPerPage;
    const window = all.slice(startOffset, startOffset + maxReturn);

    if (cfg.compatPopularImdb) {
      const imdbIds = await Promise.all(window.map(tv => imdbForTv(tv.id)));
      return { metas: window.map((tv, i) => ({
        id: imdbIds[i] || `tmdb:tv:${tv.id}`,
        type: 'series',
        name: tv.name || tv.original_name,
        poster: img(tv.poster_path),
        posterShape: 'poster',
        description: tv.overview || '',
        releaseInfo: (tv.first_air_date || '').slice(0, 4)
      })) };
    }
    return { metas: window.map(tv => ({
      id: `tmdb:tv:${tv.id}`,
      type: 'series',
      name: tv.name || tv.original_name,
      poster: img(tv.poster_path),
      posterShape: 'poster',
      description: tv.overview || '',
      releaseInfo: (tv.first_air_date || '').slice(0, 4)
    })) };
  }

  // Popular movies
  if (type === 'movie' && id === 'tmdb-popular-movies') {
    const pages = [];
    for (let p = startPage; p <= endPage; p++) {
      const data = await getPopMov(p);
      pages.push(data);
      if (p >= (data.total_pages || p)) break;
    }
    const all = pages.flatMap(pg => pg.results || []);
    const startOffset = skip % tmdbPerPage;
    const window = all.slice(startOffset, startOffset + maxReturn);

    if (cfg.compatPopularImdb) {
      const imdbIds = await Promise.all(window.map(m => imdbForMovie(m.id)));
      return { metas: window.map((m, i) => ({
        id: imdbIds[i] || `tmdb:movie:${m.id}`,
        type: 'movie',
        name: m.title || m.original_title,
        poster: img(m.poster_path),
        posterShape: 'poster',
        description: m.overview || '',
        releaseInfo: (m.release_date || '').slice(0, 4)
      })) };
    }
    return { metas: window.map(m => ({
      id: `tmdb:movie:${m.id}`,
      type: 'movie',
      name: m.title || m.original_title,
      poster: img(m.poster_path),
      posterShape: 'poster',
      description: m.overview || '',
      releaseInfo: (m.release_date || '').slice(0, 4)
    })) };
  }

  // Search-triggered recs rails
  if (id === 'tmdb-recs-movie' || id === 'tmdb-recs-series') {
    const q = (extra?.search || '').trim();
    const PAGE_SIZE = 50;
    const resolved = await resolveQueryToTmdb(q);
    if (!resolved) return { metas: [] };
    const wantType = (id === 'tmdb-recs-movie') ? 'movie' : 'tv';
    if (resolved.tmdbType !== wantType) return { metas: [] };

    let collected = [];
    for (let page = 1; collected.length < skip + PAGE_SIZE && page <= 10; page++) {
      const recs = await getRecs({ tmdbType: resolved.tmdbType, tmdbId: resolved.tmdbId, page });
      collected = collected.concat(recs.results || []);
      if (page >= (recs.total_pages || page)) break;
    }
    const slice = collected.slice(skip, skip + PAGE_SIZE);

    if (resolved.tmdbType === 'tv') {
      const ids = await Promise.all(slice.map(it => imdbForTv(it.id)));
      return { metas: slice.map((it, i) => ({
        id: ids[i] || `tmdb:tv:${it.id}`,
        type: 'series',
        name: it.name,
        poster: img(it.poster_path),
        posterShape: 'poster',
        description: it.overview || '',
        releaseInfo: (it.first_air_date || '').slice(0, 4)
      })) };
    } else {
      const ids = await Promise.all(slice.map(it => imdbForMovie(it.id)));
      return { metas: slice.map((it, i) => ({
        id: ids[i] || `tmdb:movie:${it.id}`,
        type: 'movie',
        name: it.title,
        poster: img(it.poster_path),
        posterShape: 'poster',
        description: it.overview || '',
        releaseInfo: (it.release_date || '').slice(0, 4)
      })) };
    }
  }

  return { metas: [] };
});

// ---------- META ----------
builder.defineMetaHandler(async ({ type, id }) => {
  // tmdb pages -> our enhanced detail with Season 0 recs (20)
  const m = id.match(/^tmdb:(movie|tv):(\d+)$/i);
  if (m) {
    const tmdbType = m[1] === 'movie' ? 'movie' : 'tv';
    const tmdbId = m[2];

    const details = await tmdb(`/${tmdbType}/${tmdbId}`);
    const title = (details.title || details.name || '').trim();
    const poster = img(details.poster_path) || img(details.backdrop_path) || undefined;

    const meta = {
      id,
      type, // ensure it matches the request ('series' or 'movie')
      name: title || id,
      description: details.overview || '',
      poster,
      background: details.backdrop_path ? `${TMDB_IMG_BG}${details.backdrop_path}` : undefined,
      releaseInfo: (details.release_date || details.first_air_date || '').slice(0, 4),
      seasons: [{ season: 0, name: 'Recommendations' }]
    };

    const recs = await getRecs({ tmdbType, tmdbId, page: 1 });
    const first20 = (recs.results || []).slice(0, 20);

    meta.videos = await Promise.all(first20.map(async (item, i) => {
      let imdb = null;
      try { imdb = tmdbType === 'movie' ? await imdbForMovie(item.id) : await imdbForTv(item.id); } catch {}
      const displayTitle = (item.title || item.name || '').trim() || `Recommendation ${i+1}`;
      const year = (item.release_date || item.first_air_date || '').slice(0, 4);
      const target = imdb ? `tt:${imdb}` : `tmdb-${item.id}`;
      const kind   = tmdbType === 'movie' ? 'movie' : 'series';
      return {
        season: 0,
        episode: i + 1,
        id: `recs:${kind}:${target}`,
        title: year ? `${displayTitle} (${year})` : displayTitle,
        overview: item.overview || '',
        thumbnail: img(item.poster_path)
      };
    }));

    return { meta };
  }

  // Synthetic "more recommendations" page (kept for backwards compatibility)
  const r = id.match(/^recs:(movie|series):(tt:tt\d+|tmdb-\d+)$/i);
  if (r) {
    // We still return something valid, but your Streams button now targets tmdb:* detail instead.
    const isMovie = r[1] === 'movie';
    return { meta: {
      id,
      type: isMovie ? 'movie' : 'series',
      name: 'More recommendations',
      description: `Additional related ${isMovie ? 'movies' : 'shows'} based on TMDB.`,
      seasons: [{ season: 0, name: 'Recommendations' }],
      videos: []
    }};
  }

  return { meta: {} };
});

// ---------- STREAMS ----------
builder.defineStreamHandler(async ({ id, config }) => {
  const cfg = config || {};
  const makeRecRow = (label, searchQuery, ytId) => ({
    ...(ytId ? { ytId } : {}),
    name: label,
    description: 'Open Stremio Search to view related titles.',
    externalUrl: `stremio://search?search=${encodeURIComponent(searchQuery)}`
  });

  // Synthetic rec "episodes" (series)
  const rs = id.match(/^recs:series:(tt:tt\d+|tmdb-\d+)$/i);
  if (rs) {
    let imdb = rs[1].startsWith('tt:') ? rs[1].slice(3) : null;
    let tmdbId = rs[1].startsWith('tmdb-') ? rs[1].slice(5) : null;

    // Ensure we know the TMDB id to jump to the *real* detail page
    if (!tmdbId && imdb) {
      const found = await tmdbFromImdb(imdb);
      if (found?.tmdbType === 'tv') tmdbId = String(found.tmdbId);
    }
    if (!imdb && tmdbId) imdb = await imdbForTv(tmdbId);

    const streams = [];
    // (1) Open normal details (Cinemeta or search) – keep both
    if (imdb) {
      streams.push({ name: 'Open series details', description: 'Go to the series page', externalUrl: `stremio://detail/series/${imdb}` });
      streams.push({ name: 'Open series details (browser)', description: 'Open in Stremio Web', externalUrl: webDetail('series', imdb) });
    } else {
      let title = '';
      try { title = (await tmdb(`/tv/${tmdbId}`)).name || ''; } catch {}
      const q = title || 'recommendations';
      streams.push({ name: 'Open series details', description: 'Go to the series page (via search)', externalUrl: `stremio://search?search=${encodeURIComponent(q)}` });
      streams.push({ name: 'Open series details (browser)', description: 'Open in Stremio Web', externalUrl: webSearch(q) });
    }

    // (2) NEW: Jump directly to the proper TMDB detail page for this title (with Season-0 recs)
    if (tmdbId) {
      const tmdbSeriesId = `tmdb:tv:${tmdbId}`;
      streams.push({ name: 'See more recommendations for this', description: 'Open recommendations page for this series', externalUrl: `stremio://detail/series/${encodeURIComponent(tmdbSeriesId)}` });
      streams.push({ name: 'See more recommendations (browser)', description: 'Open in Stremio Web', externalUrl: webDetail('series', tmdbSeriesId) });
    }

    return { streams };
  }

  // Synthetic rec "episodes" (movies)
  const rm = id.match(/^recs:movie:(tt:tt\d+|tmdb-\d+)$/i);
  if (rm) {
    let imdb = rm[1].startsWith('tt:') ? rm[1].slice(3) : null;
    let tmdbId = rm[1].startsWith('tmdb-') ? rm[1].slice(5) : null;

    if (!tmdbId && imdb) {
      const found = await tmdbFromImdb(imdb);
      if (found?.tmdbType === 'movie') tmdbId = String(found.tmdbId);
    }
    if (!imdb && tmdbId) imdb = await imdbForMovie(tmdbId);

    const streams = [];
    if (imdb) {
      streams.push({ name: 'Open movie details', description: 'Go to the movie page', externalUrl: `stremio://detail/movie/${imdb}` });
      streams.push({ name: 'Open movie details (browser)', description: 'Open in Stremio Web', externalUrl: webDetail('movie', imdb) });
    } else {
      let title = '';
      try { title = (await tmdb(`/movie/${tmdbId}`)).title || ''; } catch {}
      const q = title || 'recommendations';
      streams.push({ name: 'Open movie details', description: 'Go to the movie page (via search)', externalUrl: `stremio://search?search=${encodeURIComponent(q)}` });
      streams.push({ name: 'Open movie details (browser)', description: 'Open in Stremio Web', externalUrl: webSearch(q) });
    }

    // NEW: Jump directly to the proper TMDB detail page for this movie (with Season-0 recs)
    if (tmdbId) {
      const tmdbMovieId = `tmdb:movie:${tmdbId}`;
      streams.push({ name: 'See more recommendations for this', description: 'Open recommendations page for this movie', externalUrl: `stremio://detail/movie/${encodeURIComponent(tmdbMovieId)}` });
      streams.push({ name: 'See more recommendations (browser)', description: 'Open in Stremio Web', externalUrl: webDetail('movie', tmdbMovieId) });
    }

    return { streams };
  }

  // IMDb items (normal pages) — add Recommendations rows (in-app + browser)
  const imdbMatch = id.match(/^(tt\d+)(?::\d+:\d+)?$/i);
  if (imdbMatch) {
    if (cfg.enableStreamsRecs === false) return { streams: [] };
    const imdb = imdbMatch[1];
    return {
      streams: [
        makeRecRow('TMDB Recommendations (in app)', imdb),
        { name: 'TMDB Recommendations (in browser)', description: 'Open Stremio Web search with recommendations.', externalUrl: webSearch(imdb) }
      ]
    };
  }

  // tmdb fallback ids — also give both rows
  const tmdbMatch = id.match(/^tmdb:(movie|tv):(\d+)(?::\d+:\d+)?$/i);
  if (tmdbMatch) {
    if (cfg.enableStreamsRecs === false) return { streams: [] };
    const tmdbType = tmdbMatch[1] === 'movie' ? 'movie' : 'tv';
    const tmdbId   = tmdbMatch[2];
    let imdb = null, title = '';
    try { imdb = tmdbType === 'movie' ? await imdbForMovie(tmdbId) : await imdbForTv(tmdbId); } catch {}
    try { const d = await tmdb(`/${tmdbType}/${tmdbId}`); title = (d.title || d.name || '').trim(); } catch {}
    const query = imdb || title || 'recommendations';
    return {
      streams: [
        makeRecRow('TMDB Recommendations (in app)', query),
        { name: 'TMDB Recommendations (in browser)', description: 'Open Stremio Web search with recommendations.', externalUrl: webSearch(query) }
      ]
    };
  }

  return { streams: [] };
});

// ---------- serve ----------
serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
console.log(`Add-on running at http://localhost:${process.env.PORT || 7000}/manifest.json`);
