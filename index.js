// index.js (ESM) — Stremio add-on + custom landing page with single-page config and backdrop
import 'dotenv/config';
import express from 'express';
import sdk from 'stremio-addon-sdk';
const { addonBuilder } = sdk;

// ---------- server/env ----------
const PORT = process.env.PORT || 7000;
const TMDB_KEY = process.env.TMDB_API_KEY;
if (!TMDB_KEY) { console.error('Missing TMDB_API_KEY in environment'); process.exit(1); }

const TMDB_IMG_W500 = 'https://image.tmdb.org/t/p/w500';
const TMDB_IMG_BG   = 'https://image.tmdb.org/t/p/w1280';

const DEFAULTS = {
  enableOnAir: true,
  enableRecsTv: true,
  enableRecsMovie: true,
  enableStreamsRecs: true,
  compatPopularImdb: false
};

// ---------- helpers ----------
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
const webSearch = (q) => `https://web.stremio.com/#/search?search=${encodeURIComponent(q)}`;
const webDetail = (kind, id) => `https://web.stremio.com/#/detail/${kind}/${encodeURIComponent(id)}`;

function cfgFromQuery(q = {}) {
  const bool = (v, d) => (v === '1' || v === 'true' || v === true) ? true : (v === '0' || v === 'false') ? false : d;
  return {
    enableOnAir:       bool(q.onair,   DEFAULTS.enableOnAir),
    enableRecsTv:      bool(q.recsTv,  DEFAULTS.enableRecsTv),
    enableRecsMovie:   bool(q.recsMov, DEFAULTS.enableRecsMovie),
    enableStreamsRecs: bool(q.streams, DEFAULTS.enableStreamsRecs),
    compatPopularImdb: bool(q.compat,  DEFAULTS.compatPopularImdb)
  };
}

// ---------- TMDB id helpers ----------
async function imdbForTv(id)    { try { return (await tmdb(`/tv/${id}/external_ids`)).imdb_id || null; } catch { return null; } }
async function imdbForMovie(id) { try { return (await tmdb(`/movie/${id}/external_ids`)).imdb_id || null; } catch { return null; } }
async function tmdbFromImdb(imdb) {
  try {
    const r = await tmdb(`/find/${imdb}`, { external_source: 'imdb_id' });
    if (r.movie_results?.[0]) return { tmdbType: 'movie', tmdbId: r.movie_results[0].id };
    if (r.tv_results?.[0])    return { tmdbType: 'tv',    tmdbId: r.tv_results[0].id };
  } catch {}
  return null;
}
const getOnAir   = (p) => tmdb('/tv/on_the_air', { page: String(p) });
const getPopTv   = (p) => tmdb('/tv/popular',    { page: String(p) });
const getPopMov  = (p) => tmdb('/movie/popular', { page: String(p) });
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

// ---------- Stremio manifest ----------
const manifest = {
  id: 'org.example.tmdb.onair',
  version: '2.6.0',
  name: 'TMDB Recs',
  description:
    'Discovery add-on for Stremio. Optional rails: “On the air” (TV) and “Recommendations” (TV/Movies). ' +
    'Open any title from this add-on to see a Season-0 list with 20 recommendations.',

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
  const persisted = cfgFromQuery(extra || {});
  const cfg = { ...persisted, ...(config || {}) };

  const tmdbPerPage = 20, maxReturn = 100;
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
  const m = id.match(/^tmdb:(movie|tv):(\d+)$/i);
  if (m) {
    const tmdbType = m[1] === 'movie' ? 'movie' : 'tv';
    const tmdbId = m[2];

    const details = await tmdb(`/${tmdbType}/${tmdbId}`);
    const title = (details.title || details.name || '').trim();
    const meta = {
      id, type,
      name: title || id,
      description: details.overview || '',
      poster: img(details.poster_path),
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
      return { season: 0, episode: i + 1, id: `recs:${kind}:${target}`, title: year ? `${displayTitle} (${year})` : displayTitle, overview: item.overview || '', thumbnail: img(item.poster_path) };
    }));

    return { meta };
  }

  // Fallback synthetic page
  const r = id.match(/^recs:(movie|series):(tt:tt\d+|tmdb-\d+)$/i);
  if (r) {
    const isMovie = r[1] === 'movie';
    return { meta: { id, type: isMovie ? 'movie' : 'series', name: 'More recommendations', description: `Additional related ${isMovie ? 'movies' : 'shows'} based on TMDB.`, seasons: [{ season: 0, name: 'Recommendations' }], videos: [] } };
  }

  return { meta: {} };
});

// ---------- STREAMS ----------
builder.defineStreamHandler(async ({ id, config, extra }) => {
  const persisted = cfgFromQuery(extra || {});
  const cfg = { ...persisted, ...(config || {}) };

  const appRow = (label, url) => ({ name: `APP • ${label}`, description: 'Open in Stremio app', externalUrl: url });
  const webRow = (label, url) => ({ name: `WEB • ${label}`, description: 'Open in Stremio Web', externalUrl: url });

  // Series synthetic recs
  const rs = id.match(/^recs:series:(tt:tt\d+|tmdb-\d+)$/i);
  if (rs) {
    let imdb = rs[1].startsWith('tt:') ? rs[1].slice(3) : null;
    let tmdbId = rs[1].startsWith('tmdb-') ? rs[1].slice(5) : null;
    if (!tmdbId && imdb) { const f = await tmdbFromImdb(imdb); if (f?.tmdbType === 'tv') tmdbId = String(f.tmdbId); }
    if (!imdb && tmdbId) imdb = await imdbForTv(tmdbId);

    const streams = [];
    if (imdb) { streams.push(appRow('Open details', `stremio://detail/series/${imdb}`)); streams.push(webRow('Open details', webDetail('series', imdb))); }
    else {
      let title = ''; try { title = (await tmdb(`/tv/${tmdbId}`)).name || ''; } catch {}
      const q = title || 'recommendations';
      streams.push(appRow('Open details (via search)', `stremio://search?search=${encodeURIComponent(q)}`));
      streams.push(webRow('Open details (via search)', webSearch(q)));
    }
    if (tmdbId) {
      const tmdbSeriesId = `tmdb:tv:${tmdbId}`;
      streams.push(appRow('See more recs', `stremio://detail/series/${tmdbSeriesId}`));
      streams.push(webRow('See more recs', webDetail('series', tmdbSeriesId)));
    }
    return { streams };
  }

  // Movie synthetic recs
  const rm = id.match(/^recs:movie:(tt:tt\d+|tmdb-\d+)$/i);
  if (rm) {
    let imdb = rm[1].startsWith('tt:') ? rm[1].slice(3) : null;
    let tmdbId = rm[1].startsWith('tmdb-') ? rm[1].slice(5) : null;
    if (!tmdbId && imdb) { const f = await tmdbFromImdb(imdb); if (f?.tmdbType === 'movie') tmdbId = String(f.tmdbId); }
    if (!imdb && tmdbId) imdb = await imdbForMovie(tmdbId);

    const streams = [];
    if (imdb) { streams.push(appRow('Open details', `stremio://detail/movie/${imdb}`)); streams.push(webRow('Open details', webDetail('movie', imdb))); }
    else {
      let title = ''; try { title = (await tmdb(`/movie/${tmdbId}`)).title || ''; } catch {}
      const q = title || 'recommendations';
      streams.push(appRow('Open details (via search)', `stremio://search?search=${encodeURIComponent(q)}`));
      streams.push(webRow('Open details (via search)', webSearch(q)));
    }
    if (tmdbId) {
      const tmdbMovieId = `tmdb:movie:${tmdbId}`;
      streams.push(appRow('See more recs', `stremio://detail/movie/${tmdbMovieId}`));
      streams.push(webRow('See more recs', webDetail('movie', tmdbMovieId)));
    }
    return { streams };
  }

  // Normal IMDb items
  const imdbMatch = id.match(/^(tt\d+)(?::\d+:\d+)?$/i);
  if (imdbMatch) {
    if (cfg.enableStreamsRecs === false) return { streams: [] };
    const imdb = imdbMatch[1];
    return { streams: [
      appRow('TMDB recs', `stremio://search?search=${encodeURIComponent(imdb)}`),
      webRow('TMDB recs', webSearch(imdb))
    ] };
  }

  // tmdb fallback ids
  const t = id.match(/^tmdb:(movie|tv):(\d+)(?::\d+:\d+)?$/i);
  if (t) {
    if (cfg.enableStreamsRecs === false) return { streams: [] };
    const tmdbType = t[1] === 'movie' ? 'movie' : 'tv';
    const tmdbId   = t[2];
    let imdb = null, title = '';
    try { imdb = tmdbType === 'movie' ? await imdbForMovie(tmdbId) : await imdbForTv(tmdbId); } catch {}
    try { const d = await tmdb(`/${tmdbType}/${tmdbId}`); title = (d.title || d.name || '').trim(); } catch {}
    const query = imdb || title || 'recommendations';
    return { streams: [
      appRow('TMDB recs', `stremio://search?search=${encodeURIComponent(query)}`),
      webRow('TMDB recs', webSearch(query))
    ] };
  }

  return { streams: [] };
});

// ---------- Express server + landing ----------
const iface = builder.getInterface();
const app = express();

// CORS for Stremio clients
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.redirect('/configure'));

app.get('/configure', async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const q = cfgFromQuery(req.query);
  const params = new URLSearchParams();
  params.set('onair',   q.enableOnAir ? '1' : '0');
  params.set('recsTv',  q.enableRecsTv ? '1' : '0');
  params.set('recsMov', q.enableRecsMovie ? '1' : '0');
  params.set('streams', q.enableStreamsRecs ? '1' : '0');
  params.set('compat',  q.compatPopularImdb ? '1' : '0');

  const manifestHttp = `${base}/manifest.json?${params.toString()}`;
  const manifestDeep = `stremio://${req.get('host')}/manifest.json?${params.toString()}`; // stremio deep link installs addon (replace scheme) — supported by clients like Vidi and Stremio. See Vidi docs. :contentReference[oaicite:0]{index=0}
  const webAddonsUrl = `https://web.stremio.com/#/addons/community`;

  // Try to fetch a trending backdrop for the page background
  let bgUrl = '';
  try {
    const trending = await tmdb('/trending/all/week', { page: '1' });
    const withBg = (trending.results || []).find(x => x.backdrop_path);
    if (withBg?.backdrop_path) bgUrl = `${TMDB_IMG_BG}${withBg.backdrop_path}`;
  } catch { /* ignore */ }

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>TMDB Recs — Configure & Install</title>
<style>
  :root{--text:#eaf1f7;--muted:#b7c0cb;--glass:rgba(17,19,26,0.68);--glass2:rgba(20,24,36,0.55);--stroke:rgba(255,255,255,0.08);--accent:#6aa9ff;}
  *{box-sizing:border-box}
  body{margin:0;color:var(--text);font:16px/1.5 system-ui,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial;min-height:100vh;position:relative;overflow-x:hidden}
  /* backdrop */
  body:before{
    content:"";position:fixed;inset:0;
    background:${bgUrl ? `url('${bgUrl}') center/cover no-repeat` : '#0f1115'};
    filter:blur(10px) brightness(0.6);
    transform:scale(1.03);
    z-index:-2;
  }
  body:after{
    content:"";position:fixed;inset:0;
    background:radial-gradient(1200px 600px at 20% 10%, transparent, rgba(0,0,0,.45)),
               linear-gradient(to bottom, rgba(4,8,18,0.55), rgba(4,8,18,0.85));
    z-index:-1;
  }
  .container{max-width:980px;margin:0 auto;padding:28px 16px 40px}
  header{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-bottom:16px}
  .logo{font-weight:800;font-size:22px;letter-spacing:.4px}
  .sub{color:var(--muted);font-size:13px}
  .card{background:var(--glass);border:1px solid var(--stroke);border-radius:16px;padding:18px;margin:14px 0;backdrop-filter: saturate(120%) blur(6px)}
  h2{margin:6px 0 10px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media (max-width:860px){ .grid2{grid-template-columns:1fr} }
  .row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
  .btn{display:inline-block;background:var(--accent);color:#001b3d;padding:10px 14px;border-radius:10px;font-weight:700;border:none;cursor:pointer;text-decoration:none}
  .btn.alt{background:var(--glass2);color:var(--text);border:1px solid var(--stroke)}
  label{display:inline-flex;align-items:center;gap:8px;margin:6px 10px 6px 0}
  input[type=checkbox]{transform:scale(1.1)}
  pre{white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--glass2);border:1px solid var(--stroke);padding:10px;border-radius:10px}
  .small{font-size:13px;color:var(--muted)}
</style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">TMDB Recs</div>
      <div class="sub">Discovery add-on for Stremio • Recommendations & Popular rails</div>
    </header>

    <section class="card">
      <h2>Intro</h2>
      <p>Add Season-0 <b>Recommendations</b> on title pages (top 20 from TMDB) and optional discovery rails: <b>On the air</b>, <b>Popular series</b>, and <b>Popular movies</b>.</p>
      <p class="small">Note: Stremio Web opens external links in a new tab by design. Use Season-0 or install in the app for the smoothest flow.</p>
    </section>

    <section class="card">
      <h2>How to use</h2>
      <div class="grid2">
        <div>
          <h3>From a rail</h3>
          <ol>
            <li>Open a title from <b>Popular</b> or <b>Recommendations</b>.</li>
            <li>Switch to <b>Season 0 (Recommendations)</b>.</li>
            <li>Select a recommendation to jump to its detail page.</li>
          </ol>
        </div>
        <div>
          <h3>From Streams</h3>
          <ol>
            <li>Open any movie/series page.</li>
            <li>In <b>Streams</b>, pick <b>APP • TMDB recs</b> (native) or <b>WEB • TMDB recs</b>.</li>
          </ol>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Configure & Install</h2>
      <form id="cfgForm" class="row" action="/configure" method="GET">
        <label><input type="checkbox" name="onair"  ${q.enableOnAir ? 'checked' : ''}/> On the air (TV)</label>
        <label><input type="checkbox" name="recsTv" ${q.enableRecsTv ? 'checked' : ''}/> Recs rail (TV)</label>
        <label><input type="checkbox" name="recsMov" ${q.enableRecsMovie ? 'checked' : ''}/> Recs rail (Movies)</label>
        <label><input type="checkbox" name="streams" ${q.enableStreamsRecs ? 'checked' : ''}/> Streams helpers</label>
        <label><input type="checkbox" name="compat" ${q.compatPopularImdb ? 'checked' : ''}/> Popular rails: IMDb compatibility</label>
        <button class="btn" type="submit">Apply</button>
      </form>

      <div class="row" style="margin-top:12px">
        <a class="btn" id="installApp" href="${manifestDeep}">Install in Stremio app</a>
        <button class="btn alt" id="copyBtn" type="button">Copy Manifest URL</button>
        <a class="btn alt" id="openWeb" href="${webAddonsUrl}">Open Stremio Web Add-ons</a>
      </div>
      <p class="small" style="margin-top:10px">If the Install button does nothing, copy the URL below and use “Install via URL” in Stremio Web/Desktop.</p>
      <pre class="mono" id="manifestUrl">${manifestHttp}</pre>
    </section>
  </div>

<script>
  // keep web links in same tab
  document.getElementById('openWeb').setAttribute('target','_self');

  // copy manifest
  document.getElementById('copyBtn').addEventListener('click', async ()=>{
    const txt = document.getElementById('manifestUrl').textContent.trim();
    try { await navigator.clipboard.writeText(txt); alert('Manifest URL copied!'); }
    catch { alert('Copy failed. Please select & copy manually.'); }
  });
</script>
</body>
</html>`);
});

// ---------- Stremio endpoints (GET & POST) ----------
const parseBody = express.json();
const iface = builder.getInterface();
const sendJSON = (res, obj) => res.type('application/json').send(JSON.stringify(obj));

app.get('/manifest.json', (req, res) => res.json(manifest));

app.get('/catalog/:type/:id.json', (req, res) => {
  iface.get('catalog', req.params.type, req.params.id, req.query).then(r => sendJSON(res, r)).catch(e => res.status(500).json({ err: String(e) }));
});
app.post('/catalog/:type/:id.json', parseBody, (req, res) => {
  const extra = Object.assign({}, req.query, req.body || {});
  iface.get('catalog', req.params.type, req.params.id, extra).then(r => sendJSON(res, r)).catch(e => res.status(500).json({ err: String(e) }));
});

app.get('/meta/:type/:id.json', (req, res) => {
  iface.get('meta', req.params.type, req.params.id, req.query).then(r => sendJSON(res, r)).catch(e => res.status(500).json({ err: String(e) }));
});
app.post('/meta/:type/:id.json', parseBody, (req, res) => {
  const extra = Object.assign({}, req.query, req.body || {});
  iface.get('meta', req.params.type, req.params.id, extra).then(r => sendJSON(res, r)).catch(e => res.status(500).json({ err: String(e) }));
});

app.get('/stream/:type/:id.json', (req, res) => {
  iface.get('stream', req.params.type, req.params.id, req.query).then(r => sendJSON(res, r)).catch(e => res.status(500).json({ err: String(e) }));
});
app.post('/stream/:type/:id.json', parseBody, (req, res) => {
  const extra = Object.assign({}, req.query, req.body || {});
  iface.get('stream', req.params.type, req.params.id, extra).then(r => sendJSON(res, r)).catch(e => res.status(500).json({ err: String(e) }));
});

// start
app.listen(PORT, () => {
  console.log(`TMDB Recs running on http://localhost:${PORT}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
  console.log(`Configure: http://localhost:${PORT}/configure`);
});
