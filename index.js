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

// ---------- helpers ----------
async function tmdb(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set('api_key', TMDB_KEY);
  url.searchParams.set('language', 'en-GB');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}
const tmdbImage = (p) => (p ? `${TMDB_IMG_W500}${p}` : undefined);

// --- TMDB lists ---
async function fetchOnTheAirPage(page) {
  return tmdb('/tv/on_the_air', { page: String(page) });
}
async function fetchPopularTvPage(page) {
  return tmdb('/tv/popular', { page: String(page) });
}
async function fetchPopularMoviePage(page) {
  return tmdb('/movie/popular', { page: String(page) });
}

// --- IDs / mappings ---
async function fetchImdbIdForSeries(tmdbTvId) {
  const ext = await tmdb(`/tv/${tmdbTvId}/external_ids`);
  return ext.imdb_id || null;
}
function metaFromOnAir(tv, imdbId) {
  const id = imdbId || `tmdb:tv:${tv.id}`;
  return {
    id, type: 'series',
    name: tv.name || tv.original_name,
    poster: tmdbImage(tv.poster_path),
    posterShape: 'poster',
    description: tv.overview || '',
    releaseInfo: (tv.first_air_date || '').slice(0, 4),
    year: tv.first_air_date ? Number(tv.first_air_date.slice(0, 4)) : undefined,
  };
}
function metaFromOnAirTmdbOnly(tv) {
  return {
    id: `tmdb:tv:${tv.id}`,
    type: 'series',
    name: tv.name || tv.original_name,
    poster: tmdbImage(tv.poster_path),
    posterShape: 'poster',
    description: tv.overview || '',
    releaseInfo: (tv.first_air_date || '').slice(0, 4),
    year: tv.first_air_date ? Number(tv.first_air_date.slice(0, 4)) : undefined,
  };
}
function metaFromPopularMovie(movie) {
  return {
    id: `tmdb:movie:${movie.id}`,
    type: 'movie',
    name: movie.title || movie.original_title,
    poster: tmdbImage(movie.poster_path),
    posterShape: 'poster',
    description: movie.overview || '',
    releaseInfo: (movie.release_date || '').slice(0, 4),
    year: movie.release_date ? Number(movie.release_date.slice(0, 4)) : undefined,
  };
}

// --- Recommendations utils (rails/search + season 0) ---
async function resolveQueryToTmdb(q) {
  const query = (q || '').trim();
  if (!query) return null;
  if (/^tt\d+$/i.test(query)) {
    const data = await tmdb(`/find/${query}`, { external_source: 'imdb_id' });
    if (data.movie_results?.[0]) return { tmdbType: 'movie', tmdbId: data.movie_results[0].id };
    if (data.tv_results?.[0])    return { tmdbType: 'tv',    tmdbId: data.tv_results[0].id };
    return null;
  }
  const m = await tmdb('/search/movie', { query });
  const t = await tmdb('/search/tv',    { query });
  const mTop = m.results?.[0];
  const tTop = t.results?.[0];
  if (mTop && tTop) {
    return (Number(mTop.popularity || 0) >= Number(tTop.popularity || 0))
      ? { tmdbType: 'movie', tmdbId: mTop.id }
      : { tmdbType: 'tv',    tmdbId: tTop.id };
  }
  if (mTop) return { tmdbType: 'movie', tmdbId: mTop.id };
  if (tTop) return { tmdbType: 'tv',    tmdbId: tTop.id };
  return null;
}
async function getRecs({ tmdbType, tmdbId, page = 1 }) {
  const path = tmdbType === 'movie'
    ? `/movie/${tmdbId}/recommendations`
    : `/tv/${tmdbId}/recommendations`;
  return tmdb(path, { page: String(page) });
}
async function findTmdbFromImdb(imdb) {
  const data = await tmdb(`/find/${imdb}`, { external_source: 'imdb_id' });
  if (data.movie_results?.[0]) return { tmdbType: 'movie', tmdbId: data.movie_results[0].id };
  if (data.tv_results?.[0])    return { tmdbType: 'tv',    tmdbId: data.tv_results[0].id };
  return null;
}

// ---------- manifest ----------
const manifest = {
  id: 'org.example.tmdb.onair',
  version: '1.9.0',
  name: 'On The Air + TMDB Recs',
  description: 'On-the-air TV + TMDB recommendations. Includes Popular series & Popular movies rails. Movies now have Season 0 too.',
  resources: [
    'catalog',
    { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tmdb'] }, // we own meta for tmdb:* only
    'stream'
  ],
  types: ['series', 'movie'],
  // streams: handle IMDb+tmdb (and synthetic recs ids)
  idPrefixes: ['tt', 'tmdb', 'recs'],
  catalogs: [
    // Keep normal On The Air rail
    {
      type: 'series',
      id: 'tmdb-on-air',
      name: 'On The Air (TMDB)',
      extra: [{ name: 'skip', isRequired: false }],
    },
    // Popular series → open tmdb:tv:* so our meta shows Season 0
    {
      type: 'series',
      id: 'tmdb-popular-series-s0',
      name: 'Popular series recommendations',
      extra: [{ name: 'skip', isRequired: false }],
    },
    // Popular movies → open tmdb:movie:* so our meta shows Season 0 (NEW)
    {
      type: 'movie',
      id: 'tmdb-popular-movies',
      name: 'Popular movies recommendations',
      extra: [{ name: 'skip', isRequired: false }],
    },
    // Search-triggered recs rails (unchanged)
    {
      type: 'movie',
      id: 'tmdb-recs-movie',
      name: 'TMDB Recommendations',
      extra: [{ name: 'search', isRequired: true }, { name: 'skip', isRequired: false }],
    },
    {
      type: 'series',
      id: 'tmdb-recs-series',
      name: 'TMDB Recommendations',
      extra: [{ name: 'search', isRequired: true }, { name: 'skip', isRequired: false }],
    },
  ],
};

const builder = new addonBuilder(manifest);

// ---------- CATALOG handler ----------
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const tmdbPerPage = 20;
  const maxReturn = 100;
  const skip = Number(extra?.skip || 0);
  const startPage = Math.floor(skip / tmdbPerPage) + 1;
  const endIndexExclusive = skip + maxReturn;
  const endPage = Math.ceil(endIndexExclusive / tmdbPerPage);

  // On The Air (original rail)
  if (type === 'series' && id === 'tmdb-on-air') {
    const pages = [];
    for (let p = startPage; p <= endPage; p++) {
      const data = await fetchOnTheAirPage(p);
      pages.push(data);
      if (p >= (data.total_pages || p)) break;
    }
    const all = pages.flatMap(pg => pg.results || []);
    const startOffset = skip % tmdbPerPage;
    const window = all.slice(startOffset, startOffset + maxReturn);
    const imdbIds = await Promise.all(window.map(tv => fetchImdbIdForSeries(tv.id).catch(() => null)));
    return { metas: window.map((tv, i) => metaFromOnAir(tv, imdbIds[i])) };
  }

  // Popular series → open tmdb pages so Season 0 shows
  if (type === 'series' && id === 'tmdb-popular-series-s0') {
    const pages = [];
    for (let p = startPage; p <= endPage; p++) {
      const data = await fetchPopularTvPage(p);
      pages.push(data);
      if (p >= (data.total_pages || p)) break;
    }
    const all = pages.flatMap(pg => pg.results || []);
    const startOffset = skip % tmdbPerPage;
    const window = all.slice(startOffset, startOffset + maxReturn);
    return { metas: window.map(metaFromOnAirTmdbOnly) };
  }

  // Popular movies → open tmdb pages so Season 0 shows (NEW)
  if (type === 'movie' && id === 'tmdb-popular-movies') {
    const pages = [];
    for (let p = startPage; p <= endPage; p++) {
      const data = await fetchPopularMoviePage(p);
      pages.push(data);
      if (p >= (data.total_pages || p)) break;
    }
    const all = pages.flatMap(pg => pg.results || []);
    const startOffset = skip % tmdbPerPage;
    const window = all.slice(startOffset, startOffset + maxReturn);
    return { metas: window.map(metaFromPopularMovie) };
  }

  // Search-triggered recs rails (unchanged)
  if (id === 'tmdb-recs-movie' || id === 'tmdb-recs-series') {
    const q = (extra?.search || '').trim();
    const PAGE_SIZE = 50;

    const resolved = await resolveQueryToTmdb(q);
    if (!resolved) return { metas: [] };

    const wantType = (id === 'tmdb-recs-movie') ? 'movie' : 'tv';
    if (resolved.tmdbType !== wantType) return { metas: [] };

    // fetch enough pages to cover skip+PAGE_SIZE
    let collected = [];
    let page = 1;
    while (collected.length < skip + PAGE_SIZE && page <= 10) {
      const recs = await getRecs({ tmdbType: resolved.tmdbType, tmdbId: resolved.tmdbId, page });
      collected = collected.concat(recs.results || []);
      if (page >= (recs.total_pages || page)) break;
      page++;
    }

    const slice = collected.slice(skip, skip + PAGE_SIZE);
    const metas = await Promise.all(slice.map(async it => {
      if (resolved.tmdbType === 'tv') {
        // series recs → open our tmdb page to show Season 0
        return {
          id: `tmdb:tv:${it.id}`,
          type: 'series',
          name: it.name,
          poster: tmdbImage(it.poster_path),
          posterShape: 'poster',
          releaseInfo: (it.first_air_date || '').slice(0, 4),
          description: it.overview || ''
        };
      } else {
        // movie recs → we can still try IMDb (but tmdb is fine since we now show Season 0)
        let imdbId = null;
        try { imdbId = (await tmdb(`/movie/${it.id}/external_ids`)).imdb_id || null; } catch {}
        return {
          id: imdbId || `tmdb:movie:${it.id}`,
          type: 'movie',
          name: it.title,
          poster: tmdbImage(it.poster_path),
          posterShape: 'poster',
          releaseInfo: (it.release_date || '').slice(0, 4),
          description: it.overview || ''
        };
      }
    }));
    return { metas: metas.filter(Boolean) };
  }

  return { metas: [] };
});

// ---------- META handler (Season 0 for SERIES **and MOVIES**) ----------
builder.defineMetaHandler(async ({ type, id }) => {
  const m = id.match(/^tmdb:(movie|tv):(\d+)$/i);
  if (!m) return { meta: {} };

  const tmdbType = m[1] === 'movie' ? 'movie' : 'tv';
  const tmdbId = m[2];

  const [details, ext] = await Promise.all([
    tmdb(`/${tmdbType}/${tmdbId}`),
    tmdb(`/${tmdbType}/${tmdbId}/external_ids`).catch(() => ({}))
  ]);

  const title = (details.title || details.name || '').trim();
  const imdb = ext?.imdb_id || null;

  const meta = {
    id,
    type: tmdbType === 'movie' ? 'movie' : 'series',
    name: title || id,
    description: details.overview || '',
    poster: tmdbImage(details.poster_path),
    background: details.backdrop_path ? `${TMDB_IMG_BG}${details.backdrop_path}` : undefined,
    releaseInfo: (details.release_date || details.first_air_date || '').slice(0, 4),
    // Helpful chip to jump to Cinemeta if desired
    links: imdb
      ? [{
          name: tmdbType === 'movie' ? 'Open normal page (IMDb)' : 'Open normal page (IMDb)',
          url: tmdbType === 'movie'
            ? `stremio://detail/movie/${imdb}`
            : `stremio://detail/series/${imdb}`
        }]
      : []
  };

  // Season 0 for BOTH tv and movie
  const recs = await getRecs({ tmdbType, tmdbId, page: 1 });
  const first10 = (recs.results || []).slice(0, 10);

  // Label the season as "Recommendations"
  meta.seasons = [{ season: 0, name: 'Recommendations' }];

  meta.videos = await Promise.all(first10.map(async (item, i) => {
    // For target id and labels we depend on current meta type
    const recType = tmdbType; // recommendations are same type as current page
    let imdbId = null;
    try { imdbId = (await tmdb(`/${recType}/${item.id}/external_ids`)).imdb_id || null; } catch {}
    const epTitle = (item.title || item.name || '').trim() || `Recommendation ${i + 1}`;
    const epYear  = (item.release_date || item.first_air_date || '').slice(0, 4);
    const epDesc  = item.overview || '';
    const target  = imdbId ? `tt:${imdbId}` : `tmdb-${item.id}`;
    const kind    = recType === 'movie' ? 'movie' : 'series';

    return {
      season: 0,
      episode: i + 1,
      id: `recs:${kind}:${target}`,
      title: epYear ? `${epTitle} (${epYear})` : epTitle,
      overview: epDesc,
      thumbnail: tmdbImage(item.poster_path)
    };
  }));

  return { meta };
});

// ---------- STREAM handler ----------
builder.defineStreamHandler(async ({ id }) => {
  // A) Season-0 synthetic episodes for SERIES → open series detail
  const rs = id.match(/^recs:series:(tt:tt\d+|tmdb-\d+)$/i);
  if (rs) {
    let imdb = null, tmdbId = null;
    if (rs[1].startsWith('tt:')) imdb = rs[1].slice(3);
    else tmdbId = rs[1].slice(5);

    if (!imdb && tmdbId) {
      try { imdb = (await tmdb(`/tv/${tmdbId}/external_ids`)).imdb_id || null; } catch {}
    }
    if (imdb) {
      return { streams: [{
        name: 'Open series details',
        description: 'Go to the series page',
        externalUrl: `stremio://detail/series/${imdb}`
      }]};
    }
    let title = '';
    try { title = (await tmdb(`/tv/${tmdbId}`)).name || ''; } catch {}
    return { streams: [{
      name: title ? `Open: ${title}` : 'Open recommendation',
      description: 'Go to the series page (via search)',
      externalUrl: `stremio://search?search=${encodeURIComponent(title || 'recommendations')}`
    }]};
  }

  // B) Season-0 synthetic episodes for MOVIES → open movie detail (NEW)
  const rm = id.match(/^recs:movie:(tt:tt\d+|tmdb-\d+)$/i);
  if (rm) {
    let imdb = null, tmdbId = null;
    if (rm[1].startsWith('tt:')) imdb = rm[1].slice(3);
    else tmdbId = rm[1].slice(5);

    if (!imdb && tmdbId) {
      try { imdb = (await tmdb(`/movie/${tmdbId}/external_ids`)).imdb_id || null; } catch {}
    }
    if (imdb) {
      return { streams: [{
        name: 'Open movie details',
        description: 'Go to the movie page',
        externalUrl: `stremio://detail/movie/${imdb}`
      }]};
    }
    let title = '';
    try { title = (await tmdb(`/movie/${tmdbId}`)).title || ''; } catch {}
    return { streams: [{
      name: title ? `Open: ${title}` : 'Open recommendation',
      description: 'Go to the movie page (via search)',
      externalUrl: `stremio://search?search=${encodeURIComponent(title || 'recommendations')}`
    }]};
  }

  // C) Normal IMDb ids (movie or TV episode) → one “TMDB Recommendations” row in Streams
  const imdbMatch = id.match(/^(tt\d+)(?::\d+:\d+)?$/i);
  if (imdbMatch) {
    const imdb = imdbMatch[1];
    return { streams: [{
      name: 'TMDB Recommendations',
      description: 'Open Stremio Search to view recommendations.',
      externalUrl: `stremio://search?search=${encodeURIComponent(imdb)}`
    }]};
  }

  // D) tmdb fallback ids (if clicked directly)
  const tmdbMatch = id.match(/^tmdb:(movie|tv):(\d+)(?::\d+:\d+)?$/i);
  if (tmdbMatch) {
    const tmdbType = tmdbMatch[1] === 'movie' ? 'movie' : 'tv';
    const tmdbId = tmdbMatch[2];
    let imdb = null, title = '';
    try { imdb = (await tmdb(`/${tmdbType}/${tmdbId}/external_ids`)).imdb_id || null; } catch {}
    try { const d = await tmdb(`/${tmdbType}/${tmdbId}`); title = (d.title || d.name || '').trim(); } catch {}
    return { streams: [{
      name: 'TMDB Recommendations',
      description: 'Open Stremio Search to view recommendations.',
      externalUrl: `stremio://search?search=${encodeURIComponent(imdb || title || 'recommendations')}`
    }]};
  }

  return { streams: [] };
});

// ---------- serve ----------
serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
console.log(`Add-on running at http://localhost:${process.env.PORT || 7000}/manifest.json`);
