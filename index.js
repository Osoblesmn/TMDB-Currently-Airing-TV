// index.js (ESM)
import 'dotenv/config';
import sdk from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP } = sdk;

const TMDB_KEY = process.env.TMDB_API_KEY;
if (!TMDB_KEY) { console.error('Missing TMDB_API_KEY in .env'); process.exit(1); }

const tmdbImage = (p) => (p ? `https://image.tmdb.org/t/p/w500${p}` : null);

async function fetchOnTheAirPage(page, language = 'en-GB') {
  const url = new URL('https://api.themoviedb.org/3/tv/on_the_air');
  url.searchParams.set('api_key', TMDB_KEY);
  url.searchParams.set('language', language);
  url.searchParams.set('page', String(page));
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TMDB on_the_air ${r.status}`);
  return r.json(); // { page, results:[...], total_pages, total_results }
}

async function fetchImdbId(tvId) {
  const url = new URL(`https://api.themoviedb.org/3/tv/${tvId}/external_ids`);
  url.searchParams.set('api_key', TMDB_KEY);
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  return j.imdb_id || null;
}

function toMetaPreviewFromTmdb(tv, imdbId) {
  // Use IMDb id when we have it -> lets Cinemeta + stream addons work
  const id = imdbId ? imdbId : `tmdb:tv:${tv.id}`;
  return {
    id,
    type: 'series',
    name: tv.name || tv.original_name,
    poster: tmdbImage(tv.poster_path),
    posterShape: 'regular',
    description: tv.overview || '',
    releaseInfo: (tv.first_air_date || '').slice(0, 4),
    year: tv.first_air_date ? Number(tv.first_air_date.slice(0, 4)) : undefined,
  };
}

const MANIFEST = {
  id: 'org.example.tmdb.onair',
  version: '1.1.0',
  name: 'On The Air (TMDB)',
  description: 'TV shows with an episode airing soon (TMDB). Lists only.',
  resources: ['catalog'], // let Cinemeta/other addons handle meta/streams for tt ids
  types: ['series'],
  catalogs: [
    {
      type: 'series',
      id: 'tmdb-on-air',
      name: 'On The Air (TMDB)',
      extra: [{ name: 'skip', isRequired: false }], // pagination via skip
    },
  ],
};

const builder = new addonBuilder(MANIFEST);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== 'series' || id !== 'tmdb-on-air') return { metas: [] };

  const tmdbPerPage = 20;
  const maxReturn = 100; // Stremio guideline: <= 100 items per page
  const skip = Number(extra?.skip || 0);

  // Figure out which TMDB pages cover [skip, skip+maxReturn)
  const startPage = Math.floor(skip / tmdbPerPage) + 1;
  const endIndexExclusive = skip + maxReturn;
  const endPage = Math.ceil(endIndexExclusive / tmdbPerPage);

  // Fetch required TMDB pages
  const pages = [];
  for (let p = startPage; p <= endPage; p++) {
    try {
      const data = await fetchOnTheAirPage(p);
      pages.push(data);
      if (p >= (data.total_pages || p)) break; // stop if last page
    } catch (_) { break; }
  }

  // Flatten and slice to the exact window
  const all = pages.flatMap(pg => pg.results || []);
  const startOffset = skip % tmdbPerPage;
  const window = all.slice(startOffset, startOffset + maxReturn);

  // Resolve IMDb IDs (so other addons can provide streams)
  const imdbIds = await Promise.all(window.map(tv => fetchImdbId(tv.id).catch(() => null)));
  const metas = window.map((tv, i) => toMetaPreviewFromTmdb(tv, imdbIds[i]));

  return { metas };
});

// Serve HTTP
serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
console.log(`Addon at http://localhost:${process.env.PORT || 7000}/manifest.json`);
