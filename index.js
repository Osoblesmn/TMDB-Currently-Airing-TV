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

// ---------- tiny helpers ----------
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

// Stremio Web links (work in browsers & web client)
const webSearch = (q) => `https://web.stremio.com/#/search?search=${encodeURIComponent(q)}`;
const webDetail = (kind, id) => `https://web.stremio.com/#/detail/${kind}/${encodeURIComponent(id)}`; // kind: movie|series

// YouTube trailer for ranking our stream row
async function getTrailerYtId(tmdbType, tmdbId) {
  const vids = await tmdb(`/${tmdbType}/${tmdbId}/videos`);
  const list = vids.results || [];
  const official = list.find(v => v.site === 'YouTube' && v.type === 'Trailer' && v.official);
  if (official?.key) return official.key;
  const anyYT = list.find(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
  return anyYT?.key || null;
}
async function findTmdbFromImdb(imdb) {
  const data = await tmdb(`/find/${imdb}`, { external_source: 'imdb_id' });
  if (data.movie_results?.[0]) return { tmdbType: 'movie', tmdbId: data.movie_results[0].id };
  if (data.tv_results?.[0])    return { tmdbType: 'tv',    tmdbId: data.tv_results[0].id };
  return null;
}

// TMDB lists
async function fetchOnTheAirPage(page)      { return tmdb('/tv/on_the_air', { page: String(page) }); }
async function fetchPopularTvPage(page)     { return tmdb('/tv/popular',    { page: String(page) }); }
async function fetchPopularMoviePage(page)  { return tmdb('/movie/popular', { page: String(page) }); }

// Catalog meta builders
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

// Query resolution for the search rails
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

// ---------- manifest (with Configure on install page) ----------
const manifest = {
  id: 'org.example.tmdb.onair',
  version: '2.1.0',
  name: 'TMDB Recommendations & Popular',
  description:
    'Discovery-focused add-on for Stremio. Optional rails: “On the air” (TV) and “Recommendations” (TV/Movies). ' +
    'Open titles from this add-on to see a Recommendations list for quick discovery. ' +
    'Use the Popular rails to browse trending titles and jump between related ones.',

  behaviorHints: {
    configurable: true,          // show ⚙️ Configure next to Install
    configurationRequired: false // but still allow one-click Install
  },

  // Options shown on /configure (and in-app gear)
  config: [
    { key: 'enableOnAir',       type: 'boolean', default: 'checked', title: 'Enable “On the air” rail (TV)' },
    { key: 'enableRecsTv',      type: 'boolean', default: 'checked', title: 'Enable “Recommendations” rail (TV)' },
    { key: 'enableRecsMovie',   type: 'boolean', default: 'checked', title: 'Enable “Recommendations” rail (Movies)' },
    { key: 'enableStreamsRecs', type: 'boolean', default: 'checked', title: 'Enable “Recommendations” button in Streams' }
  ],

  resources: [
    'catalog',
    // We serve meta for our own IDs (tmdb:*) AND for our synthetic "recs:*" pages
    { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tmdb', 'recs'] },
    'stream'
  ],
  types: ['series', 'movie'],
  // streams: handle IMDb + tmdb + synthetic rec IDs
  idPrefixes: ['tt', 'tmdb', 'recs'],

  catalogs: [
    { type: 'series', id: 'tmdb-on-air',         name: 'On The Air (TMDB)',               extra: [{ name: 'skip', isRequired: false }] },
    { type: 'series', id: 'tmdb-popular-series', name: 'Popular series recommendations',   extra: [{ name: 'skip', isRequired: false }] },
    { type: 'movie',  id: 'tmdb-popular-movies', name: 'Popular movies recommendations',   extra: [{ name: 'skip', isRequired: false }] },
    // Search-triggered rails (TV & Movies), toggleable via config
    { type: 'movie',  id: 'tmdb-recs-movie',     name: 'TMDB Recommendations',             extra: [{ name: 'search', isRequired: true }, { name: 'skip', isRequired: false }] },
    { type: 'series', id: 'tmdb-recs-series',    name: 'TMDB Recommendations',             extra: [{ name: 'search', isRequired: true }, { name: 'skip', isRequired: false }] }
  ]
};

const builder = new addonBuilder(manifest);

// ---------- CATALOG handler ----------
builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
  const cfg = config || {};
  const tmdbPerPage = 20;
  const maxReturn = 100;
  const skip = Number(extra?.skip || 0);
  const startPage = Math.floor(skip / tmdbPerPage) + 1;
  const endIndexExclusive = skip + maxReturn;
  const endPage = Math.ceil(endIndexExclusive / tmdbPerPage);

  // Respect config toggles
  if (id === 'tmdb-on-air'      && cfg.enableOnAir       === false) return { metas: [] };
  if (id === 'tmdb-recs-series' && cfg.enableRecsTv      === false) return { metas: [] };
  if (id === 'tmdb-recs-movie'  && cfg.enableRecsMovie   === false) return { metas: [] };

  // On The Air
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

  // Popular series -> open tmdb:tv:* so our meta shows the Recommendations list
  if (type === 'series' && id === 'tmdb-popular-series') {
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

  // Popular movies -> open tmdb:movie:* so our meta shows the Recommendations list
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

  // Search-triggered recommendations rails
  if (id === 'tmdb-recs-movie' || id === 'tmdb-recs-series') {
    const q = (extra?.search || '').trim();
    const PAGE_SIZE = 50;

    const resolved = await resolveQueryToTmdb(q);
    if (!resolved) return { metas: [] };

    const wantType = (id === 'tmdb-recs-movie') ? 'movie' : 'tv';
    if (resolved.tmdbType !== wantType) return { metas: [] };

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
        // series recs → open our tmdb page (so our Recommendations list is available)
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
        // movie recs → prefer IMDb if present, else tmdb
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

// ---------- META handler ----------
// 1) Our normal tmdb:* pages — show a "Recommendations" list (20 items)
// 2) Dedicated "recs:*" pages for "See more recommendations for this"
builder.defineMetaHandler(async ({ id }) => {
  // A) tmdb:* page
  const tm = id.match(/^tmdb:(movie|tv):(\d+)$/i);
  if (tm) {
    const tmdbType = tm[1] === 'movie' ? 'movie' : 'tv';
    const tmdbId = tm[2];

    const [details, ext] = await Promise.all([
      tmdb(`/${tmdbType}/${tmdbId}`),
      tmdb(`/${tmdbType}/${tmdbId}/external_ids`).catch(() => ({}))
    ]);

    const title = (details.title || details.name || '').trim();
    const imdb  = ext?.imdb_id || null;

    const meta = {
      id,
      type: tmdbType === 'movie' ? 'movie' : 'series',
      name: title || id,
      description: details.overview || '',
      poster: tmdbImage(details.poster_path),
      background: details.backdrop_path ? `${TMDB_IMG_BG}${details.backdrop_path}` : undefined,
      releaseInfo: (details.release_date || details.first_air_date || '').slice(0, 4),
      // Helpful chip to jump to Cinemeta if desired
      links: imdb ? [{
        name: tmdbType === 'movie' ? 'Open standard movie page' : 'Open standard series page',
        url: tmdbType === 'movie' ? `stremio://detail/movie/${imdb}` : `stremio://detail/series/${imdb}`
      }] : []
    };

    // Label and populate the Recommendations list (20 items)
    meta.seasons = [{ season: 0, name: 'Recommendations' }];

    const recs = await getRecs({ tmdbType, tmdbId, page: 1 });
    const first20 = (recs.results || []).slice(0, 20);

    meta.videos = await Promise.all(first20.map(async (item, i) => {
      let imdbId = null;
      try { imdbId = (await tmdb(`/${tmdbType}/${item.id}/external_ids`)).imdb_id || null; } catch {}
      const epTitle = (item.title || item.name || '').trim() || `Recommendation ${i + 1}`;
      const epYear  = (item.release_date || item.first_air_date || '').slice(0, 4);
      const epDesc  = item.overview || '';
      const target  = imdbId ? `tt:${imdbId}` : `tmdb-${item.id}`;
      const kind    = tmdbType === 'movie' ? 'movie' : 'series';

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
  }

  // B) recs:* page (for "See more recommendations for this")
  const rm = id.match(/^recs:(movie|series):(tt:tt\d+|tmdb-\d+)$/i);
  if (rm) {
    const isMovie = rm[1] === 'movie';
    let tmdbType  = isMovie ? 'movie' : 'tv';
    let imdb = null, tmdbId = null;

    if (rm[2].startsWith('tt:')) {
      imdb = rm[2].slice(3);
      const found = await findTmdbFromImdb(imdb);
      if (found) { tmdbType = found.tmdbType; tmdbId = String(found.tmdbId); }
    } else {
      tmdbId = rm[2].slice(5);
    }

    let baseTitle = '';
    if (tmdbId) {
      try {
        const d = await tmdb(`/${tmdbType}/${tmdbId}`);
        baseTitle = (d.title || d.name || '').trim();
        if (!imdb) {
          const ext = await tmdb(`/${tmdbType}/${tmdbId}/external_ids`);
          imdb = ext.imdb_id || null;
        }
      } catch (_) {}
    }

    const meta = {
      id,
      type: isMovie ? 'movie' : 'series',
      name: baseTitle ? `More recommendations for: ${baseTitle}` : 'More recommendations',
      description: `Additional related ${isMovie ? 'movies' : 'shows'} based on TMDB.`,
      seasons: [{ season: 0, name: 'Recommendations' }],
      links: imdb ? [{
        name: isMovie ? 'Open standard movie page' : 'Open standard series page',
        url: isMovie ? `stremio://detail/movie/${imdb}` : `stremio://detail/series/${imdb}`
      }] : []
    };

    if (tmdbId) {
      const recs = await getRecs({ tmdbType, tmdbId, page: 1 });
      const first20 = (recs.results || []).slice(0, 20);

      meta.videos = await Promise.all(first20.map(async (item, i) => {
        let imdbId = null;
        try { imdbId = (await tmdb(`/${tmdbType}/${item.id}/external_ids`)).imdb_id || null; } catch {}
        const epTitle = (item.title || item.name || '').trim() || `Recommendation ${i + 1}`;
        const epYear  = (item.release_date || item.first_air_date || '').slice(0, 4);
        const epDesc  = item.overview || '';
        const target  = imdbId ? `tt:${imdbId}` : `tmdb-${item.id}`;
        const kind    = tmdbType === 'movie' ? 'movie' : 'series';

        return {
          season: 0,
          episode: i + 1,
          id: `recs:${kind}:${target}`,
          title: epYear ? `${epTitle} (${epYear})` : epTitle,
          overview: epDesc,
          thumbnail: tmdbImage(item.poster_path)
        };
      }));
    } else {
      meta.videos = [];
    }

    return { meta };
  }

  return { meta: {} };
});

// ---------- STREAM handler ----------
builder.defineStreamHandler(async ({ id, config }) => {
  const cfg = config || {};

  // helper for the in-app playable row (with optional trailer to rank higher)
  const makeRecRow = (label, searchQuery, ytId) => ({
    ...(ytId ? { ytId } : {}),
    name: label,
    description: 'Open Stremio Search to view related titles.',
    externalUrl: `stremio://search?search=${encodeURIComponent(searchQuery)}`
  });

  // A) Synthetic recommendation items → show both details + "See more", with browser variants
  // Series: recs:series:(t
