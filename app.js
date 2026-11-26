import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc, deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { CONFIG } from "./config.js";

// ---------- Helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const img = (p, size = "w342") => (p ? `https://image.tmdb.org/t/p/${size}${p}` : "");
const DAY = 86400000;
// Dates look the same as in the book app: "25 jan 2026", always with the year.
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const fmtDate = (d) => {
  if (!d) return "";
  const m = typeof d === "string" && /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (m) return `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}`;
  const dt = new Date(d);
  return isNaN(dt) ? "" : `${dt.getDate()} ${MON[dt.getMonth()]} ${dt.getFullYear()}`;
};

// Voting with thumbs: the value is the number of thumbs up (0 = thumbs down).
const THUMB = `<svg class="thumb" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 21h4V9H2v12zM23 10c0-1.1-.9-2-2-2h-6.3l1-4.6v-.3c0-.4-.2-.8-.4-1.1L14.2 1 7.6 7.6C7.2 7.9 7 8.4 7 9v10c0 1.1.9 2 2 2h9c.8 0 1.5-.5 1.8-1.2l3-7.1c.1-.2.2-.5.2-.7v-2z"/></svg>`;
const thumbs = (v) => (v === 0 ? `<span class="thumbs down">${THUMB}</span>` : `<span class="thumbs">${THUMB.repeat(v)}</span>`);
const INTEREST = [
  { v: 0, label: "No thanks" },
  { v: 1, label: "Maybe" },
  { v: 2, label: "Yes please" },
];
const OURS_MIN = 3; // total thumbs up needed for "Our shows"
const STATUS = { want: "Watchlist", watching: "Watching", done: "Finished", dropped: "Dropped" };

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- Config check ----------
const configured = !JSON.stringify(CONFIG).includes("KLISTRA-IN");
if (!configured) {
  $("#app").innerHTML = `
    <div class="center-page">
      <div class="logo">📺</div>
      <h1>Almost there!</h1>
      <p>Open <b>config.js</b> and fill in your Firebase and TMDB keys.</p>
    </div>`;
  throw new Error("config.js is not filled in");
}

// Keep in step with VERSION in sw.js. Shown in the menu so you can check you have the latest.
const APP_VERSION = "v34";

// Look for a new version on every start and when the app comes back to the foreground.
// When a new service worker takes over, reload once so the new files are used.
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    // Never reload in the middle of a movie import; reload when it has finished instead.
    const reloadWhenIdle = () => (typeof imp !== "undefined" && ["checking", "planned", "applying"].includes(imp.phase) ? setTimeout(reloadWhenIdle, 3000) : location.reload());
    reloadWhenIdle();
  });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update().catch(() => {});
    });
  }).catch(() => {});
}

// ---------- Firebase ----------
const fb = initializeApp(CONFIG.firebase);
const auth = getAuth(fb);
const db = initializeFirestore(fb, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

// ---------- TMDB ----------
async function tmdbOnce(path, params) {
  const url = new URL("https://api.themoviedb.org/3" + path);
  const key = CONFIG.tmdbApiKey;
  const headers = { accept: "application/json" };
  if (key.length > 60) headers.Authorization = `Bearer ${key}`; // v4-token
  else url.searchParams.set("api_key", key); // v3-nyckel
  url.searchParams.set("language", params.language || CONFIG.language);
  for (const [k, v] of Object.entries(params)) if (k !== "language") url.searchParams.set(k, v);
  const res = await fetch(url, { headers });
  if (!res.ok) { const err = new Error(`TMDB ${res.status}`); err.status = res.status; throw err; }
  return res.json();
}

// On TMDB server errors: retry, then fall back to English.
async function tmdb(path, params = {}) {
  try { return await tmdbOnce(path, params); }
  catch (err) {
    if (!(err.status >= 500) && err.status !== 429) throw err;
    await new Promise((r) => setTimeout(r, 700));
    try { return await tmdbOnce(path, params); }
    catch (err2) {
      if (params.language === "en-US") throw err2;
      return tmdbOnce(path, { ...params, language: "en-US" });
    }
  }
}

function providerList(...lists) {
  const seen = new Set();
  return lists.flat().filter(Boolean)
    .sort((a, b) => a.display_priority - b.display_priority)
    .filter((p) => !seen.has(p.provider_id) && seen.add(p.provider_id))
    .map((p) => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path }));
}

// Bump when fetchShowData stores new fields, so saved shows are fetched again.
const DATA_V = 2;
const needsRefresh = (s, maxAge) => Date.now() - (s.fetchedAt || 0) > maxAge || s.lang !== CONFIG.language || s.dataV !== DATA_V
  || (s.foreignKey || "") !== foreignKey();

// Services from other countries that someone has picked in Settings (e.g. Kanopy via a US library card).
// Stored per person as users/{uid}.foreign = [{ r: "US", id: 191, name: "Kanopy" }].
const foreignServices = () => Object.values(state.users).flatMap((u) => u.foreign || []);
const foreignKey = () => [...new Set(foreignServices().map((f) => `${f.r}:${f.id}`))].sort().join(",");
// Picks out the chosen foreign services from TMDB's watch/providers results (all countries).
function foreignProviders(results, already) {
  const out = [];
  for (const f of foreignServices()) {
    const wp = results?.[f.r];
    if (!wp || already.some((p) => p.id === f.id) || out.some((p) => p.id === f.id)) continue;
    const hit = [...(wp.flatrate || []), ...(wp.free || []), ...(wp.ads || [])].find((p) => p.provider_id === f.id);
    if (hit) out.push({ id: f.id, name: `${hit.provider_name} (${f.r})`, logo: hit.logo_path || null });
  }
  return out;
}
function streamList(d) {
  const wp = d["watch/providers"]?.results?.[CONFIG.region] || {};
  const local = providerList(wp.flatrate, wp.free, wp.ads);
  return [...local, ...foreignProviders(d["watch/providers"]?.results, local)];
}

// Runtime (minutes) per episode, fetched season by season (max 20 seasons per request).
async function fetchRuntimes(id, seasons) {
  const out = {};
  for (let i = 0; i < seasons.length; i += 20) {
    const chunk = seasons.slice(i, i + 20);
    const d = await tmdb(`/tv/${id}`, { append_to_response: chunk.map((x) => `season/${x.n}`).join(",") });
    for (const x of chunk) {
      const eps = d[`season/${x.n}`]?.episodes || [];
      const rt = Array(x.eps).fill(null);
      for (const e of eps) if (e.episode_number >= 1 && e.episode_number <= x.eps) rt[e.episode_number - 1] = e.runtime || null;
      out[x.n] = rt;
    }
  }
  return out;
}

async function fetchShowData(id) {
  const d = await tmdb(`/tv/${id}`, { append_to_response: "watch/providers,aggregate_credits,external_ids,videos" });
  let overview = d.overview;
  if (!overview) {
    try { overview = (await tmdb(`/tv/${id}`, { language: "en-US" })).overview; } catch {}
  }
  const wp = d["watch/providers"]?.results?.[CONFIG.region] || {};
  const ep = (x) => (x ? { s: x.season_number, e: x.episode_number, date: x.air_date || null } : null);
  const seasons = (d.seasons || []).filter((s) => s.season_number > 0 && s.episode_count > 0)
    .map((s) => ({ n: s.season_number, eps: s.episode_count }));
  try {
    const rts = await fetchRuntimes(d.id, seasons);
    for (const x of seasons) x.rt = rts[x.n] || [];
  } catch {}
  const vids = (d.videos?.results || []).filter((v) => v.site === "YouTube");
  const trailer = vids.find((v) => v.type === "Trailer" && v.official) || vids.find((v) => v.type === "Trailer") || vids.find((v) => v.type === "Teaser");
  return {
    tmdbId: d.id,
    name: d.name,
    originalName: d.original_name !== d.name ? d.original_name : null,
    poster: d.poster_path || null,
    backdrop: d.backdrop_path || null,
    overview: overview || "",
    year: (d.first_air_date || "").slice(0, 4),
    genres: (d.genres || []).map((g) => g.name),
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    tmdbStatus: d.status,
    ended: ["Ended", "Canceled"].includes(d.status),
    seasons,
    runtime: d.episode_run_time?.[0] || d.last_episode_to_air?.runtime || null,
    creators: (d.created_by || []).map((c) => c.name),
    networks: (d.networks || []).map((n) => n.name),
    cast: (d.aggregate_credits?.cast || []).slice(0, 15).map((c) => ({
      id: c.id, name: c.name, profile: c.profile_path || null,
      character: c.roles?.[0]?.character || "", episodes: c.total_episode_count || null,
    })),
    imdbId: d.external_ids?.imdb_id || null,
    trailer: trailer?.key || null,
    lastAired: ep(d.last_episode_to_air),
    nextAir: ep(d.next_episode_to_air),
    providers: {
      stream: streamList(d),
      rent: providerList(wp.rent, wp.buy),
      link: wp.link || null,
    },
    lang: CONFIG.language,
    foreignKey: foreignKey(),
    dataV: DATA_V,
    fetchedAt: Date.now(),
  };
}

// ---------- Episode logic ----------
const seasonsOf = (s) => s.seasons || [];
const isAired = (show, s, e) => !show.lastAired || s < show.lastAired.s || (s === show.lastAired.s && e <= show.lastAired.e);
const isWatched = (show, s, e) => {
  const p = show.progress;
  return !!p && (s < p.s || (s === p.s && e <= p.e));
};
function nextEp(show) {
  const ss = seasonsOf(show);
  if (!ss.length) return null;
  const p = show.progress || { s: 0, e: 0 };
  let cand = null;
  const cur = ss.find((x) => x.n === p.s);
  if (cur && p.e < cur.eps) cand = { s: p.s, e: p.e + 1 };
  else cand = ss.find((x) => x.n > p.s) ? { s: ss.find((x) => x.n > p.s).n, e: 1 } : null;
  return cand && isAired(show, cand.s, cand.e) ? cand : null;
}
function episodeCounts(show) {
  let total = 0, seen = 0;
  for (const s of seasonsOf(show)) for (let e = 1; e <= s.eps; e++) {
    if (!isAired(show, s.n, e)) continue;
    total++;
    if (isWatched(show, s.n, e)) seen++;
  }
  return { total, seen };
}
const epLabel = (x) => `S${x.s} · E${x.e}`;

// Total runtime in minutes, either for everything aired or only what is left to watch.
// Episodes without a runtime count as the show's average.
function runtimeMinutes(show, onlyUnwatched) {
  const known = seasonsOf(show).flatMap((s) => s.rt || []).filter(Boolean);
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : show.runtime;
  if (!avg) return null;
  let min = 0;
  for (const s of seasonsOf(show)) for (let e = 1; e <= s.eps; e++) {
    if (!isAired(show, s.n, e)) continue;
    if (onlyUnwatched && isWatched(show, s.n, e)) continue;
    min += s.rt?.[e - 1] || avg;
  }
  return Math.round(min);
}
function fmtDuration(min) {
  if (min == null) return "";
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}
// "20 episodes · 16 h 2 min" for everything aired so far.
function totalText(show) {
  const { total } = episodeCounts(show);
  if (!total) return "";
  const m = runtimeMinutes(show, false);
  return `${total} episode${total === 1 ? "" : "s"}${m ? ` · ${fmtDuration(m)}` : ""}`;
}

// "17 episodes · 13 h 30 min left" for aired episodes not yet watched.
function timeLeft(show) {
  const { total, seen } = episodeCounts(show);
  const left = total - seen;
  if (!left) return "";
  const m = runtimeMinutes(show, true);
  return `${left} episode${left === 1 ? "" : "s"}${m ? ` · ${fmtDuration(m)}` : ""} left`;
}

async function fetchMovieData(id) {
  const d = await tmdb(`/movie/${id}`, { append_to_response: "watch/providers,credits,videos,release_dates" });
  // The year a movie was first shown anywhere (festival premiere included), as Letterboxd and IMDb show it.
  // TMDB's own release date is often the later cinema release in the home country.
  const firstShown = (d.release_dates?.results || []).flatMap((c) => c.release_dates || []).map((r) => r.release_date).filter(Boolean).sort()[0];
  let overview = d.overview;
  if (!overview) {
    try { overview = (await tmdb(`/movie/${id}`, { language: "en-US" })).overview; } catch {}
  }
  const wp = d["watch/providers"]?.results?.[CONFIG.region] || {};
  const vids = (d.videos?.results || []).filter((v) => v.site === "YouTube");
  const trailer = vids.find((v) => v.type === "Trailer" && v.official) || vids.find((v) => v.type === "Trailer") || vids.find((v) => v.type === "Teaser");
  return {
    tmdbId: d.id,
    title: d.title || "",
    originalTitle: d.original_title && d.original_title !== d.title ? d.original_title : null,
    poster: d.poster_path || null,
    backdrop: d.backdrop_path || null,
    overview: overview || "",
    year: (firstShown || d.release_date || "").slice(0, 4),
    releaseDate: d.release_date || null,
    firstShown: firstShown ? firstShown.slice(0, 10) : null,
    runtime: d.runtime || null,
    genres: (d.genres || []).map((g) => g.name),
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    directors: (d.credits?.crew || []).filter((c) => c.job === "Director").map((c) => c.name),
    cast: (d.credits?.cast || []).slice(0, 12).map((c) => ({
      id: c.id, name: c.name, profile: c.profile_path || null, character: c.character || "",
    })),
    imdbId: d.imdb_id || null,
    country: (d.origin_country || [])[0] || d.production_countries?.[0]?.iso_3166_1 || null,
    trailer: trailer?.key || null,
    providers: {
      stream: streamList(d),
      rent: providerList(wp.rent, wp.buy),
      link: wp.link || null,
    },
    lang: CONFIG.language,
    foreignKey: foreignKey(),
    dataV: MOVIE_DATA_V,
    fetchedAt: Date.now(),
  };
}

// ---------- Series and movies: the same model ----------
// Every series and movie lives in "My stuff" (private: users/{uid}/shows and users/{uid}/movies)
// and/or "Our stuff" (shared: shows and sharedMovies), where you vote with thumbs.
const MOVIE_DATA_V = 2; // 2: year = first time shown anywhere
const K = {
  tv: {
    mine: (uid) => ["users", uid, "shows"], ours: ["shows"], fetch: (id) => fetchShowData(id), path: "tv",
    noun: "series", nouns: "series", emoji: "📺", doneStatus: "done", maxAge: DAY,
    stale: (s, age) => needsRefresh(s, age),
  },
  movie: {
    mine: (uid) => ["users", uid, "movies"], ours: ["sharedMovies"], fetch: (id) => fetchMovieData(id), path: "movie",
    noun: "movie", nouns: "movies", emoji: "🎬", doneStatus: "seen", maxAge: 30 * DAY,
    stale: (m, age) => Date.now() - (m.fetchedAt || 0) > age || m.lang !== CONFIG.language || m.dataV !== MOVIE_DATA_V
      || (m.foreignKey || "") !== foreignKey(),
  },
};
const KINDS = ["tv", "movie"];
const titleOf = (x) => x.name || x.title || "";
// The year to show: the one from your Letterboxd export if there is one, else the first time it was shown.
const yearShown = (x) => x.lbYear || x.year || "";
const PERSONAL_FIELDS = ["status", "addedAt", "seenAt", "myRating", "review", "lbYear", "suggested", "importKey", "tags", "where", "note", "progress", "updatedAt"];
const SHARED_FIELDS = ["interest", "suggestedBy", "suggestedAt", "addedBy", "addedFor"];
// Only the TMDB data of an item, without anyone's personal or shared fields.
const baseData = (x) => Object.fromEntries(Object.entries(x).filter(([k]) => !PERSONAL_FIELDS.includes(k) && !SHARED_FIELDS.includes(k)));

const MOODS = {
  light: { label: "Light & fun", genres: ["Comedy", "Animation", "Family", "Romance", "Music", "Kids"] },
  tense: { label: "Tense", genres: ["Thriller", "Horror", "Crime", "Mystery"] },
  epic: { label: "Big & epic", genres: ["Action", "Adventure", "Science Fiction", "Fantasy", "War", "Western", "Action & Adventure", "Sci-Fi & Fantasy", "War & Politics"] },
  deep: { label: "Deep", genres: ["Drama", "History", "Documentary"] },
};
const TIMES = {
  movie: [["any", "Any length"], ["105", "Under 1 h 45"], ["135", "Under 2 h 15"]],
  tv: [["any", "Any length"], ["300", "Under 5 h"], ["720", "Under 12 h"]],
};
const SORTS = [["added", "Recently added"], ["short", "Shortest"], ["rating", "Highest rated"], ["title", "A–Z"]];
const REMOVED_TAGS = ["Att se 2026"];
const SCOPE_LABEL = { mine: "My stuff", ours: "Our stuff" };

// ---------- State ----------
const savedMode = localStorage.getItem("mode");
const newFilters = () => ({ q: "", onServices: false, sort: "added", limit: 60, tag: null });
const newPick = () => ({ open: false, time: "any", mood: "any", onServices: true, results: null, skipped: new Set() });
const state = {
  user: null,
  users: {}, // uid -> {name, services, foreign}
  data: { tv: { mine: [], ours: [] }, movie: { mine: [], ours: [] } },
  loaded: { tv: { mine: false, ours: false }, movie: { mine: false, ours: false } },
  err: { tv: null, movie: null },
  mode: savedMode === "movies" || savedMode === "movie" ? "movie" : "tv",
  tab: { tv: localStorage.getItem("tab-tv") || "watchlist", movie: localStorage.getItem("tab-movie") || "watchlist" },
  scope: { tv: { watchlist: "mine", watched: "mine" }, movie: { watchlist: "mine", watched: "mine" } },
  filters: { tv: newFilters(), movie: newFilters() },
  ourFilter: { tv: "all", movie: "all" },
  pick: { tv: newPick(), movie: newPick() },
  search: { tv: { q: "", results: null, trending: null, loading: false }, movie: { q: "", results: null, trending: null, loading: false } },
  watchedLimit: 60,
  open: null, // { kind, id } for the detail sheet
  preview: null, // TMDB data for an item that is in neither list
  sheetSeason: null,
};
if (!["watchlist", "watching", "watched", "search"].includes(state.tab.tv)) state.tab.tv = "watchlist";
if (!["watchlist", "watched", "stats", "search"].includes(state.tab.movie)) state.tab.movie = "watchlist";

const list = (kind, scope) => state.data[kind][scope];
const get = (kind, scope, id) => list(kind, scope).find((x) => String(x.tmdbId) === String(id));
const ref = (kind, scope, id) => doc(db, ...(scope === "mine" ? K[kind].mine(state.user.uid) : K[kind].ours), String(id));
const members = () => Object.entries(state.users).map(([uid, u]) => ({ uid, name: u.name || "?" }))
  .sort((a, b) => (a.uid === state.user?.uid ? -1 : b.uid === state.user?.uid ? 1 : a.name.localeCompare(b.name)));
const myName = () => state.users[state.user?.uid]?.name;
const otherNames = () => members().filter((m) => m.uid !== state.user.uid).map((m) => m.name).join(" & ");
const isDone = (kind, x) => x.status === K[kind].doneStatus || x.status === "dropped";
// A series you watch together lives in Our stuff; your own copy then steps aside.
const oursActive = (kind, id) => { const o = get(kind, "ours", id); return !!o && o.status !== "want"; };
// Which copy the detail sheet works on (episodes, status)
function activeScope(kind, id) {
  if (oursActive(kind, id)) return "ours";
  if (get(kind, "mine", id)) return "mine";
  if (get(kind, "ours", id)) return "ours";
  return null;
}

// Compatibility with the movie import code
const myMovie = (id) => get("movie", "mine", id);
const myMovieRef = (id) => ref("movie", "mine", id);

// ---------- Votes ----------
const awaitsMyVote = (x) => x.interest?.[state.user.uid] === undefined;
const thumbsTotal = (x) => members().reduce((sum, m) => sum + (x.interest?.[m.uid] ?? 0), 0);
const isOurs = (x) => thumbsTotal(x) >= OURS_MIN;
const isMaybeLater = (x) => {
  const ms = members();
  return ms.length > 1 && !isOurs(x) && ms.every((m) => (x.interest?.[m.uid] ?? 0) >= 1);
};
const interestScore = (x) => members().reduce((sum, m) => sum + (x.interest?.[m.uid] ?? 1), 0);
const pendingVotes = (kind) => list(kind, "ours").filter((x) => x.status === "want" && awaitsMyVote(x));
function interestRow(x) {
  return `<div class="votes">${members().map((m) => {
    const v = x.interest?.[m.uid];
    return `<span class="vote ${v === undefined ? "pending" : ""}">${v === undefined ? "–" : thumbs(v)} ${esc(m.name)}</span>`;
  }).join("")}</div>`;
}

// ---------- Sign-in ----------
let unsubs = [];
onAuthStateChanged(auth, async (user) => {
  unsubs.forEach((u) => u()); unsubs = [];
  state.user = user;
  if (!user) return renderLogin();
  try {
    const me = await getDoc(doc(db, "users", user.uid));
    if (!me.exists() || !me.data().name) {
      const name = (user.displayName || user.email.split("@")[0]).split(" ")[0];
      await setDoc(doc(db, "users", user.uid), { name, email: user.email });
    }
  } catch (err) {
    return renderNoAccess(err);
  }
  startListening();
});

function renderLogin(error = "") {
  $("#app").innerHTML = `
    <div class="center-page">
      <div class="logo">📺</div>
      <h1>What are we watching now?</h1>
      <p class="muted">Series and movies to watch</p>
      <button class="btn google" data-action="login">
        <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
        Sign in with Google
      </button>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
    </div>`;
}

function renderNoAccess(err) {
  $("#app").innerHTML = `
    <div class="center-page">
      <div class="logo">🔒</div>
      <h1>No access</h1>
      <p><b>${esc(state.user?.email)}</b> is not on the list of allowed email addresses in the Firestore rules.</p>
      <p class="muted small">${esc(err?.code || err?.message || "")}</p>
      <button class="btn" data-action="logout">Sign out</button>
    </div>`;
}

// ---------- Realtime data ----------
let startedBackgroundWork = false;
function startListening() {
  if (unsubs.length) return;
  unsubs.push(onSnapshot(collection(db, "users"), (snap) => {
    state.users = {};
    snap.forEach((d) => (state.users[d.id] = d.data()));
    render();
  }, renderNoAccess));
  for (const kind of KINDS) {
    for (const scope of ["mine", "ours"]) {
      const path = scope === "mine" ? K[kind].mine(state.user.uid) : K[kind].ours;
      unsubs.push(onSnapshot(collection(db, ...path), (snap) => {
        state.data[kind][scope] = snap.docs.map((d) => d.data());
        state.loaded[kind][scope] = true;
        render();
        afterLoad();
      }, (err) => {
        state.err[kind] = err;
        state.loaded[kind][scope] = true;
        render();
      }));
    }
  }
  renderShell();
  importFromLink();
}
const allLoaded = () => KINDS.every((k) => state.loaded[k].mine && state.loaded[k].ours) && !KINDS.some((k) => state.err[k]);

// Runs after every data update: one-time clean-ups, then syncing of things watched together.
function afterLoad() {
  if (!allLoaded()) return;
  if (!startedBackgroundWork) {
    startedBackgroundWork = true;
    migrate().then(() => refreshStale());
  }
  syncTogether();
}

// One-time moves when the app changes how data is stored.
async function migrate() {
  const uid = state.user.uid;
  const me = state.users[uid] || {};
  // v23: series not being watched together move from the shared list to your own list.
  if (!me.migratedSeries) {
    try {
      for (const s of list("tv", "ours").filter((x) => x.status !== "watching" && (x.addedBy || x.suggestedBy) === uid)) {
        const { interest, addedBy, suggestedBy, suggestedAt, addedFor, ...rest } = s;
        await setDoc(ref("tv", "mine", s.tmdbId), { ...rest, addedAt: s.addedAt || Date.now() });
        await deleteDoc(ref("tv", "ours", s.tmdbId));
      }
      await updateDoc(doc(db, "users", uid), { migratedSeries: true });
    } catch (err) { console.warn("Series move failed", err); }
  }
  // Corrections you confirmed: viewing dates
  const VIEW_FIXES = { 680813: ["2021-02-06", "2022-02-06"] }; // Flee, seen twice
  for (const [fid, views] of Object.entries(VIEW_FIXES)) {
    const m = get("movie", "mine", fid);
    if (m && JSON.stringify(m.views || []) !== JSON.stringify(views)) {
      updateDoc(ref("movie", "mine", fid), { views, seenAt: new Date(views[views.length - 1] + "T12:00:00").getTime() }).catch(() => {});
    }
  }
  // Labels you no longer want, and festival labels shortened to "GFF 2022"
  const fixTag = (t) => t.replace(/^Göteborg Film Festival (\d+)/, "GFF $1");
  for (const kind of KINDS) {
    for (const m of list(kind, "mine").filter((x) => x.tags?.some((t) => REMOVED_TAGS.includes(t) || fixTag(t) !== t))) {
      updateDoc(ref(kind, "mine", m.tmdbId), { tags: [...new Set(m.tags.filter((t) => !REMOVED_TAGS.includes(t)).map(fixTag))] }).catch(() => {});
    }
  }
}

// When something is marked as watched together, it is added to each person's own Watched list once.
const syncing = new Set();
async function syncTogether() {
  const uid = state.user.uid;
  for (const kind of KINDS) {
    const done = K[kind].doneStatus;
    for (const o of list(kind, "ours").filter((x) => x.status === done && !x.addedFor?.[uid])) {
      const key = `${kind}:${o.tmdbId}`;
      if (syncing.has(key)) continue;
      syncing.add(key);
      try {
        const m = get(kind, "mine", o.tmdbId);
        const patch = kind === "movie" ? { status: "seen", seenAt: o.seenAt || Date.now() } : { status: "done", progress: o.progress || { s: 0, e: 0 }, updatedAt: Date.now() };
        if (m) { if (m.status !== done) await updateDoc(ref(kind, "mine", o.tmdbId), patch); }
        else await setDoc(ref(kind, "mine", o.tmdbId), { ...baseData(o), ...patch, addedAt: Date.now() });
        await updateDoc(ref(kind, "ours", o.tmdbId), { [`addedFor.${uid}`]: true });
      } catch (err) { console.warn("Sync failed", err); }
      syncing.delete(key);
    }
  }
}

// Fetch new episodes and streaming info for active items, a limited number per start.
async function refreshStale() {
  if (typeof imp !== "undefined" && imp.phase !== "idle" && imp.phase !== "applied") return;
  const jobs = [];
  for (const kind of KINDS) for (const scope of ["mine", "ours"]) {
    for (const x of list(kind, scope)) {
      const active = x.status === "want" || x.status === "watching";
      if (active && K[kind].stale(x, K[kind].maxAge)) jobs.push([kind, scope, x.tmdbId]);
    }
  }
  // A few per start keeps mobile data use low. Series you are watching come first.
  jobs.sort((a, b) => (a[0] === "tv" ? 0 : 1) - (b[0] === "tv" ? 0 : 1));
  if (navigator.connection?.saveData) return;
  for (const [kind, scope, id] of jobs.slice(0, 25)) {
    try { await updateDoc(ref(kind, scope, id), await K[kind].fetch(id)); } catch {}
  }
}

// ---------- Changing things ----------
function save(kind, scope, id, patch) {
  if (kind === "tv") patch = { ...patch, updatedAt: Date.now() };
  return updateDoc(ref(kind, scope, id), patch).catch((err) => toast("Could not save: " + err.message));
}

async function addMine(kind, id, data) {
  if (get(kind, "mine", id)) return toast("Already in your watchlist");
  try {
    data = data || (await K[kind].fetch(id));
    const extra = kind === "tv" ? { progress: { s: 0, e: 0 }, updatedAt: Date.now() } : {};
    await setDoc(ref(kind, "mine", id), { ...baseData(data), status: "want", addedAt: Date.now(), ...extra });
    toast(`${titleOf(data)} added to your watchlist`);
  } catch (err) { toast("Could not add: " + err.message); }
}

async function suggest(kind, id) {
  const uid = state.user.uid;
  const base = get(kind, "mine", id) || (String(state.preview?.tmdbId) === String(id) ? state.preview : null);
  if (!base) return;
  try {
    if (!get(kind, "mine", id)) await addMine(kind, id, base);
    const extra = kind === "tv" ? { progress: { s: 0, e: 0 }, updatedAt: Date.now() } : {};
    await setDoc(ref(kind, "ours", id), {
      ...baseData(base), status: "want", interest: { [uid]: 2 }, suggestedBy: uid, suggestedAt: Date.now(), addedAt: Date.now(), ...extra,
    });
    toast(`Suggested to ${otherNames() || "watch together"}`);
  } catch (err) { toast("Could not share: " + err.message); }
}

// Watching, but every aired episode is watched: shown under Watched until new episodes air.
const caughtUp = (show) => show.status === "watching" && seasonsOf(show).length > 0 && !nextEp(show);

function advance(kind, scope, id) {
  const show = get(kind, scope, id);
  const n = show && nextEp(show);
  if (!n) return;
  const patch = { progress: { s: n.s, e: n.e } };
  if (show.status !== "watching") patch.status = "watching";
  const after = nextEp({ ...show, progress: n });
  if (!after && show.ended) { patch.status = "done"; toast(`🎉 You finished ${show.name}!`); }
  else if (!after) toast(`✓ Caught up – moved to Watched until new episodes air`);
  else toast(`✓ ${epLabel(n)} watched`);
  save(kind, scope, id, patch);
}

// ---------- Main view ----------
const TABS = {
  tv: [["watchlist", "🍿", "Watchlist"], ["watching", "▶️", "Watching"], ["watched", "✅", "Watched"], ["search", "🔍", "Search"]],
  movie: [["watchlist", "🎬", "Watchlist"], ["watched", "✅", "Watched"], ["stats", "📊", "Stats"], ["search", "🔍", "Search"]],
};
function renderShell() {
  $("#app").innerHTML = `
    <header class="top">
      <div class="top-row">
        <h1>What are we watching now?</h1>
        <button class="avatar" data-action="menu" aria-label="Menu">${esc((myName() || "?").slice(0, 1).toUpperCase())}</button>
      </div>
      <div class="modes">
        <button data-action="mode" data-m="tv">📺 Series <span class="chip-count" data-mbadge="tv"></span></button>
        <button data-action="mode" data-m="movie">🎬 Movies <span class="chip-count" data-mbadge="movie"></span></button>
      </div>
    </header>
    <main id="main"></main>
    <nav class="tabs">
      ${TABS[state.mode]
        .map(([k, i, l]) => `<button data-action="tab" data-tab="${k}"><span class="ti">${i}</span><span>${l}</span><span class="badge" data-badge="${k}"></span></button>`).join("")}
    </nav>`;
  render();
}

// Data updates can come in quick bursts (an import saves thousands of movies). Draw at most once per
// animation frame, and only every couple of seconds while an import is saving, so the browser keeps up.
let renderTimer = null;
function render() {
  if (renderTimer) return;
  const busy = typeof imp !== "undefined" && imp.phase === "applying";
  renderTimer = setTimeout(() => requestAnimationFrame(() => { renderTimer = null; renderNow(); }), busy ? 2000 : 0);
}
function renderNow() {
  if (!$("#main")) return;
  const kind = state.mode;
  const av = $(".avatar");
  if (av) av.textContent = (myName() || "?").slice(0, 1).toUpperCase();
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab[kind]));
  document.querySelectorAll(".modes button").forEach((b) => b.classList.toggle("on", b.dataset.m === kind));
  const setBadge = (el, n) => { if (el) { el.textContent = n || ""; el.hidden = !n; } };
  setBadge(document.querySelector('[data-badge="watchlist"]'), pendingVotes(kind).length);
  for (const k of KINDS) setBadge(document.querySelector(`[data-mbadge="${k}"]`), k === kind ? 0 : pendingVotes(k).length);

  const main = $("#main");
  const tab = state.tab[kind];
  if (!state.loaded[kind].mine || !state.loaded[kind].ours) main.innerHTML = `<div class="splash"><div class="spinner"></div></div>`;
  else if (state.err[kind]) renderDbNotice(main, kind);
  else if (tab === "search") renderSearch(kind);
  else if (tab === "watching") renderWatching(kind);
  else if (tab === "watched") renderWatched(kind);
  else if (tab === "stats") renderStats();
  else renderWatchlist(kind);
  if (state.open) renderSheet();
  renderSettings();
}

function renderDbNotice(main, kind) {
  main.innerHTML = `<div class="notice">
    <h3>The database needs an update</h3>
    <p>The database rules in Firebase have to be updated before ${K[kind].nouns} work. Follow the steps Claude gave you for <b>Firebase → Firestore → Rules</b>, then reload the app.</p>
    <p class="muted small">${esc(state.err[kind].code || state.err[kind].message || "")}</p>
  </div>`;
}

// "My stuff | Our stuff" switch at the top of Watchlist and Watched
function scopeSwitch(kind, tab) {
  const cur = state.scope[kind][tab];
  const pending = tab === "watchlist" ? pendingVotes(kind).length : 0;
  return `<div class="modes scope">${["mine", "ours"].map((s) => `
    <button class="${cur === s ? "on" : ""}" data-action="scope" data-s="${s}">${SCOPE_LABEL[s]}${s === "ours" && pending ? ` <span class="chip-count">${pending}</span>` : ""}</button>`).join("")}</div>`;
}

// ---------- Streaming services ----------
const myServices = () => {
  const u = state.users[state.user?.uid] || {};
  const s = [...(u.services || []), ...(u.foreign || []).map((f) => f.id)];
  return s.length ? new Set(s) : null;
};
const servicesFor = (scope) => (scope === "ours" ? ourServices() : myServices());
const onServices = (x, set) => (x.providers?.stream || []).some((p) => set.has(p.id));

// ---------- Cards ----------
const lengthOf = (kind, x) => (kind === "movie" ? x.runtime || null : runtimeMinutes(x, false));
// Seen dates show the year unless it is this year.
const fmtSeen = (d) => fmtDate(d);
// Letterboxd-style stars: 3.5 -> ★★★½
const starText = (r) => (r ? "★".repeat(Math.floor(r)) + (r % 1 ? "½" : "") : "");

function card(kind, x, scope, { skip = false, label = null } = {}) {
  const id = x.tmdbId;
  const meta = kind === "movie"
    ? [x.runtime && fmtDuration(x.runtime), x.directors?.[0], x.rating && `★ ${x.rating}`].filter(Boolean).join(" · ")
    : x.status === "want" ? totalText(x) : "";
  let extra = "";
  const pills = [];
  if (label) pills.push(label);
  if (scope === "ours" && x.status === "want") {
    if (isOurs(x)) pills.push(`<span class="pill good">Watch together</span>`);
    if (isMaybeLater(x)) pills.push(`<span class="pill later">Maybe later</span>`);
    if (awaitsMyVote(x)) pills.push(`<span class="pill ask">Waiting for your vote</span>`);
    extra = interestRow(x);
  } else if (scope === "mine" && x.status === "want" && get(kind, "ours", id)) {
    pills.push(`<span class="pill later">Suggested</span>`);
  }
  if (x.status === "watching" && kind === "tv") {
    const n = nextEp(x);
    const { total, seen } = episodeCounts(x);
    const pct = total ? Math.round((seen / total) * 100) : 0;
    extra += `
      <div class="next">${n ? `Next: <b>${epLabel(n)}</b>` : x.nextAir ? `Caught up · new episode ${fmtDate(x.nextAir.date)}` : x.ended ? "All episodes watched" : "Caught up · waiting for new episodes"}</div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      ${n ? `<div class="muted small">${timeLeft(x)}</div>` : ""}`;
  } else if (isDone(kind, x)) {
    if (kind === "movie") {
      const together = scope === "mine" && get("movie", "ours", id)?.status === "seen";
      extra += `<div class="small">${x.myRating && scope === "mine" ? `<span class="stars">${starText(x.myRating)}</span> ` : ""}<span class="muted">${scope === "ours" ? "Watched together" : "Seen"}${x.seenAt ? ` ${fmtSeen(x.seenAt)}` : ""}${x.where && scope === "mine" ? ` · ${esc(x.where)}` : ""}${together ? " · together" : ""}</span></div>`;
    } else {
      extra += `<div class="muted small">${STATUS[x.status]}${x.status === "done" && !x.ended && x.nextAir ? ` · new season ${fmtDate(x.nextAir.date)}` : ""}</div>`;
    }
  } else if (scope === "mine" && x.tags?.length) {
    extra += `<div class="muted small">${esc(x.tags.join(" · "))}</div>`;
  }
  const quick = kind === "tv" && x.status === "watching" && nextEp(x)
    ? `<button class="quick" data-action="advance" data-kind="${kind}" data-scope="${scope}" data-id="${id}" aria-label="Mark next episode as watched">✓</button>` : "";
  const skipBtn = skip ? `<button class="quick ghost" data-action="skip" data-id="${id}" aria-label="Not tonight" title="Not tonight">✕</button>` : "";
  return `
    <article class="card show" data-action="open" data-kind="${kind}" data-id="${id}">
      <div class="poster">${x.poster ? `<img loading="lazy" src="${img(x.poster, "w185")}" alt="">` : K[kind].emoji}</div>
      <div class="info">
        <h3>${esc(titleOf(x))} <span class="muted year">${esc(yearShown(x))}</span></h3>
        ${meta ? `<div class="muted small">${esc(meta)}</div>` : ""}
        ${pills.join("")}
        ${extra}
        ${x.status === "want" || x.status === "watching" ? providerLogos(x, 3, servicesFor(scope)) : ""}
      </div>
      ${quick}${skipBtn}
    </article>`;
}

// ---------- Watchlist ----------
const myWatchlist = (kind) => list(kind, "mine").filter((x) => x.status === "want" && !oursActive(kind, x.tmdbId));

function renderWatchlist(kind) {
  const scope = state.scope[kind].watchlist;
  if (scope === "ours") return renderOurWatchlist(kind);
  const main = $("#main");
  const f = state.filters[kind];
  if (!$("#wlFilter") || main.dataset.view !== `wl-${kind}`) {
    main.dataset.view = `wl-${kind}`;
    main.innerHTML = `
      ${scopeSwitch(kind, "watchlist")}
      <div id="pick"></div>
      <div class="searchbar"><input id="wlFilter" type="search" placeholder="Search your watchlist…" autocomplete="off" value="${esc(f.q)}"></div>
      <div id="wlControls"></div>
      <div id="wlList"></div>`;
    $("#wlFilter").oninput = (e) => { f.q = e.target.value; f.limit = 60; renderWatchlist(kind); };
  }
  renderPick(kind, "mine");
  const svc = myServices();
  const all = myWatchlist(kind);
  let items = all;
  const q = f.q.trim().toLowerCase();
  if (q) items = items.filter((x) => [titleOf(x), x.originalTitle, x.originalName, ...(x.directors || []), ...(x.creators || [])].filter(Boolean).join(" ").toLowerCase().includes(q));
  if (f.onServices && svc) items = items.filter((x) => onServices(x, svc));
  if (f.tag) items = items.filter((x) => x.tags?.includes(f.tag));
  const tags = [...new Set(all.flatMap((x) => x.tags || []))].sort((a, b) => a.localeCompare(b));
  const by = {
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    short: (a, b) => (lengthOf(kind, a) || 1e9) - (lengthOf(kind, b) || 1e9),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    title: (a, b) => titleOf(a).localeCompare(titleOf(b)),
  }[f.sort];
  items = [...items].sort(by);
  const noun = (n) => `${n} ${n === 1 ? K[kind].noun : K[kind].nouns}`;
  $("#wlControls").innerHTML = `
    <div class="controls">
      <div class="ctl-row">
        <span class="ctl-label">Filter</span>
        ${svc ? `<button class="chip ${f.onServices ? "on" : ""}" data-action="onServices">On my services</button>` : ""}
        ${tags.length ? `<select data-change="tagFilter" aria-label="Filter by label" class="${f.tag ? "on" : ""}">
          <option value="">All labels</option>
          ${tags.map((tg) => `<option value="${esc(tg)}" ${f.tag === tg ? "selected" : ""}>${esc(tg)}</option>`).join("")}
        </select>` : ""}
      </div>
      <div class="ctl-row">
        <span class="ctl-label">Sort</span>
        <select data-change="sort" aria-label="Sort">${SORTS.map(([k, l]) => `<option value="${k}" ${f.sort === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      </div>
    </div>
    <p class="muted small count">${items.length === all.length ? noun(all.length) : `${items.length} of ${noun(all.length)}`}${!svc ? ` · <a href="#" data-action="menu">Pick your streaming services</a> to filter by them` : ""}</p>`;
  const shown = items.slice(0, f.limit);
  $("#wlList").innerHTML = items.length
    ? `<div class="list">${shown.map((x) => card(kind, x, "mine")).join("")}</div>
       ${items.length > shown.length ? `<button class="btn wide" data-action="more">Show more (${items.length - shown.length} left)</button>` : ""}`
    : `<p class="empty">${all.length ? "Nothing matches." : `Your watchlist is empty. Tap <b>Search</b> to add ${K[kind].nouns}.`}</p>`;
}

function renderOurWatchlist(kind) {
  const main = $("#main");
  main.dataset.view = `owl-${kind}`;
  const f = state.ourFilter[kind];
  let items = list(kind, "ours").filter((x) => x.status === "want");
  if (f === "both") items = items.filter(isOurs);
  if (f === "later") items = items.filter(isMaybeLater);
  if (f === "pending") items = items.filter(awaitsMyVote);
  items.sort((a, b) => isOurs(b) - isOurs(a) || isMaybeLater(b) - isMaybeLater(a) || interestScore(b) - interestScore(a) || (b.suggestedAt || b.addedAt || 0) - (a.suggestedAt || a.addedAt || 0));
  const pending = pendingVotes(kind).length;
  const chips = [["all", "All"], ["both", "Watch together"], ["later", "Maybe later"], ["pending", "Waiting for me"]]
    .map(([k, l]) => `<button class="chip ${f === k ? "on" : ""}" data-action="ourFilter" data-f="${k}">${l}${k === "pending" && pending ? ` <span class="chip-count">${pending}</span>` : ""}</button>`).join("");
  const empty = f === "all"
    ? `Nothing shared yet. Open a ${K[kind].noun} in My stuff and tap <b>Suggest to ${esc(otherNames() || "watch together")}</b>.`
    : "Nothing matches this filter.";
  main.innerHTML = `${scopeSwitch(kind, "watchlist")}<div id="pick"></div><div class="chips">${chips}</div>`
    + (items.length ? `<div class="list">${items.map((x) => card(kind, x, "ours")).join("")}</div>` : `<p class="empty">${empty}</p>`);
  renderPick(kind, "ours");
}

// ---------- Help me pick ----------
function pickCandidates(kind, scope) {
  const p = state.pick[kind];
  const svc = servicesFor(scope);
  const pool = scope === "mine"
    ? myWatchlist(kind)
    : list(kind, "ours").filter((x) => x.status === "want" && !members().some((m) => x.interest?.[m.uid] === 0));
  return pool.filter((x) => {
    if (p.skipped.has(x.tmdbId)) return false;
    const len = lengthOf(kind, x);
    if (p.time !== "any" && !(len && len <= Number(p.time))) return false;
    if (p.mood !== "any" && !(x.genres || []).some((g) => MOODS[p.mood].genres.includes(g))) return false;
    if (p.onServices && svc && !onServices(x, svc)) return false;
    return true;
  });
}
function doPick(kind, scope) {
  const c = pickCandidates(kind, scope);
  for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
  state.pick[kind].results = c.slice(0, 3).map((x) => x.tmdbId);
}
function renderPick(kind, scope) {
  const box = $("#pick");
  if (!box) return;
  const p = state.pick[kind];
  const noun = K[kind].noun;
  if (!p.open) {
    box.innerHTML = `<button class="btn primary wide pickbtn" data-action="pickOpen">🎲 Help me pick ${kind === "tv" ? "a series" : "a movie"}${scope === "ours" ? " for us" : ""}</button>`;
    return;
  }
  const svc = servicesFor(scope);
  const n = pickCandidates(kind, scope).length;
  const results = (p.results || []).map((id) => get(kind, scope, id)).filter((x) => x && x.status === "want" && !p.skipped.has(x.tmdbId));
  const chip = (key, val, label) => `<button class="chip ${p[key] === val ? "on" : ""}" data-action="pickSet" data-k="${key}" data-v="${val}">${label}</button>`;
  box.innerHTML = `
    <section class="pick card">
      <h3>Help me pick <button class="btn link small" data-action="pickClose">Close</button></h3>
      <div class="pick-label">How much time?</div>
      <div class="chips">${TIMES[kind].map(([v, l]) => chip("time", v, l)).join("")}</div>
      <div class="pick-label">What mood?</div>
      <div class="chips">${chip("mood", "any", "Anything")}${Object.entries(MOODS).map(([k, m]) => chip("mood", k, m.label)).join("")}</div>
      ${svc ? `<div class="chips"><button class="chip ${p.onServices ? "on" : ""}" data-action="pickServices">${scope === "ours" ? "Only on our services" : "Only on my services"}</button></div>` : ""}
      <button class="btn primary wide" data-action="pick" data-scope="${scope}" ${n ? "" : "disabled"}>${results.length ? "🎲 Pick again" : `🎲 Pick 3`}</button>
      <p class="muted small">${n} ${n === 1 ? noun : K[kind].nouns} match.${p.skipped.size ? ` ${p.skipped.size} skipped tonight · <a href="#" data-action="unskip">bring back</a>` : ""}</p>
      ${results.length ? `<div class="list">${results.map((x) => card(kind, x, scope, { skip: true })).join("")}</div><p class="muted small">Tap ✕ for “not tonight”.</p>` : ""}
    </section>`;
}

// ---------- Watching (series) ----------
function renderWatching(kind) {
  const main = $("#main");
  main.dataset.view = "watching";
  const ours = list(kind, "ours").filter((x) => x.status === "watching" && !caughtUp(x));
  const mine = list(kind, "mine").filter((x) => x.status === "watching" && !caughtUp(x) && !oursActive(kind, x.tmdbId));
  const items = [...ours.map((x) => [x, "ours"]), ...mine.map((x) => [x, "mine"])]
    .sort(([a], [b]) => (b.updatedAt || 0) - (a.updatedAt || 0));
  main.innerHTML = items.length
    ? `<div class="list">${items.map(([x, s]) => card(kind, x, s, { label: s === "ours" ? `<span class="pill good">Together</span>` : `<span class="pill later">Just me</span>` })).join("")}</div>`
    : `<p class="empty">Nothing on right now. Pick a series from <b>Watchlist</b>.</p>`;
}

// ---------- Watched ----------
function renderWatched(kind) {
  const main = $("#main");
  main.dataset.view = `watched-${kind}`;
  const scope = state.scope[kind].watched;
  const all = list(kind, scope);
  let html = scopeSwitch(kind, "watched");
  if (kind === "tv") {
    // Caught-up series wait here until new episodes air, then move back to Watching.
    const waiting = all.filter((x) => caughtUp(x) && (scope === "ours" || !oursActive(kind, x.tmdbId)))
      .sort((a, b) => (a.nextAir?.date || "9999").localeCompare(b.nextAir?.date || "9999"));
    const finished = all.filter((x) => isDone(kind, x)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (waiting.length) html += `<h2 class="section">Waiting for new episodes</h2><div class="list">${waiting.map((x) => card(kind, x, scope, { label: scope === "mine" ? "" : null })).join("")}</div>`;
    if (finished.length) html += `${waiting.length ? `<h2 class="section">Finished</h2>` : ""}<div class="list">${finished.slice(0, state.watchedLimit).map((x) => card(kind, x, scope)).join("")}</div>`
      + (finished.length > state.watchedLimit ? `<button class="btn wide" data-action="watchedMore">Show more</button>` : "");
    if (!waiting.length && !finished.length) html += `<p class="empty">${scope === "ours" ? "Series you finish together end up here." : "Series you have finished end up here."}</p>`;
  } else {
    const wtags = scope === "mine" ? [...new Set(all.filter((x) => x.status === "seen").flatMap((x) => x.tags || []))].sort((a, b) => a.localeCompare(b)) : [];
    const wtag = state.filters.movie.watchedTag;
    const seen = all.filter((x) => x.status === "seen" && (!wtag || x.tags?.includes(wtag))).sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0));
    if (wtags.length) html += `<div class="controls"><div class="ctl-row"><span class="ctl-label">Filter</span>
      <select data-change="watchedTag" aria-label="Filter by label" class="${wtag ? "on" : ""}"><option value="">All labels</option>
      ${wtags.map((tg) => `<option value="${esc(tg)}" ${wtag === tg ? "selected" : ""}>${esc(tg)}</option>`).join("")}</select></div></div>`;
    const year = new Date().getFullYear();
    const thisYear = seen.filter((x) => x.seenAt && new Date(x.seenAt).getFullYear() === year).length;
    html += seen.length
      ? `<p class="muted small count">${seen.length} movie${seen.length === 1 ? "" : "s"} ${scope === "ours" ? "watched together" : "seen"} · ${thisYear} in ${year}</p>
         <div class="list">${seen.slice(0, state.watchedLimit).map((x) => card(kind, x, scope)).join("")}</div>
         ${seen.length > state.watchedLimit ? `<button class="btn wide" data-action="watchedMore">Show more</button>` : ""}`
      : `<p class="empty">${scope === "ours" ? "Movies you watch together end up here." : "Movies you have seen end up here. Open a movie and tap <b>Mark as seen</b>."}</p>`;
  }
  main.innerHTML = html;
}

// ---------- Search ----------
let searchTimer;
function renderSearch(kind) {
  const main = $("#main");
  const s = state.search[kind];
  if (!$("#searchInput") || main.dataset.view !== `search-${kind}`) {
    main.dataset.view = `search-${kind}`;
    main.innerHTML = `
      <div class="searchbar"><input id="searchInput" type="search" placeholder="Search ${kind === "tv" ? "series" : "movies"}…" autocomplete="off" value="${esc(s.q)}"></div>
      <div id="results"></div>`;
    $("#searchInput").oninput = (e) => {
      s.q = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => doSearch(kind), 350);
    };
    if (!s.trending) {
      tmdb(`/trending/${K[kind].path}/week`)
        .then((d) => { s.trending = d.results || []; renderResults(kind); })
        .catch((err) => { const b = $("#results"); if (b) b.innerHTML = `<p class="error">Could not reach TMDB (${esc(err.message)}).</p>`; });
    }
  }
  renderResults(kind);
}
async function doSearch(kind) {
  const s = state.search[kind];
  const q = s.q.trim();
  if (!q) { s.results = null; return renderResults(kind); }
  s.loading = true; renderResults(kind);
  try {
    const d = await tmdb(`/search/${K[kind].path}`, { query: q, include_adult: "false" });
    if (q !== s.q.trim()) return;
    s.results = d.results || [];
  } catch (err) { toast("Search failed: " + err.message); }
  s.loading = false; renderResults(kind);
}
function renderResults(kind) {
  const box = $("#results");
  if (!box || state.mode !== kind) return;
  const { results, trending, loading } = state.search[kind];
  const items = results ?? trending;
  if ((loading && !results) || !items) { box.innerHTML = `<div class="splash small"><div class="spinner"></div></div>`; return; }
  if (!items.length) { box.innerHTML = `<p class="empty">No results.</p>`; return; }
  box.innerHTML = `${results ? "" : `<h2 class="section">Popular this week</h2>`}
    <div class="list">${items.slice(0, 20).map((r) => {
      const have = get(kind, "mine", r.id) || get(kind, "ours", r.id);
      return `
      <article class="card show result" data-action="open" data-kind="${kind}" data-id="${r.id}">
        <div class="poster">${r.poster_path ? `<img loading="lazy" src="${img(r.poster_path, "w185")}" alt="">` : K[kind].emoji}</div>
        <div class="info">
          <h3>${esc(r.name || r.title)} <span class="muted year">${esc((r.first_air_date || r.release_date || "").slice(0, 4))}</span></h3>
          <p class="overview clamp">${esc(r.overview || "")}</p>
        </div>
        ${have
          ? `<button class="add done" data-action="open" data-kind="${kind}" data-id="${r.id}" aria-label="Show">✓</button>`
          : `<button class="add" data-action="add" data-kind="${kind}" data-id="${r.id}" aria-label="Add to my watchlist">＋</button>`}
      </article>`;
    }).join("")}</div>
    <p class="attribution">Data from TMDB. Streaming info from JustWatch.</p>`;
}

// ---------- Detail sheet ----------
function openSheet(kind, id) {
  id = String(id);
  state.open = { kind, id };
  state.preview = null;
  const x = get(kind, activeScope(kind, id) || "mine", id);
  state.sheetSeason = kind === "tv" && x ? (nextEp(x)?.s || x.progress?.s || seasonsOf(x)[0]?.n || 1) : null;
  history.pushState({ sheet: id }, "");
  $("#sheet").hidden = false;
  document.body.classList.add("noscroll");
  renderSheet();
  $("#sheet").scrollTop = 0;
  for (const scope of ["mine", "ours"]) {
    const c = get(kind, scope, id);
    if (c && K[kind].stale(c, 3 * DAY)) K[kind].fetch(id).then((d) => updateDoc(ref(kind, scope, id), d)).catch(() => {});
  }
  if (!get(kind, "mine", id) && !get(kind, "ours", id)) {
    K[kind].fetch(id)
      .then((d) => { if (state.open?.id === id) { state.preview = d; state.sheetSeason = seasonsOf(d)[0]?.n || null; renderSheet(); } })
      .catch((err) => { toast("Could not load: " + err.message); if (state.open?.id === id) history.back(); });
  }
}
function closeSheet() {
  state.open = null;
  state.preview = null;
  $("#sheet").hidden = true;
  $("#sheet").innerHTML = "";
  document.body.classList.remove("noscroll");
}
window.addEventListener("popstate", () => {
  if (settingsOpen) closeSettings();
  else if (state.open) closeSheet();
});

function movieStars(r) {
  return `<div class="rate">${[1, 2, 3, 4, 5].map((n) => {
    const cls = r >= n ? "full" : r >= n - 0.5 ? "half" : "";
    return `<button class="star ${cls}" data-action="rate" data-n="${n}" aria-label="${n} stars">★</button>`;
  }).join("")}</div>`;
}

const STATUS_BTNS = { tv: [["want", "Watchlist"], ["watching", "Watching"], ["done", "Finished"], ["dropped", "Dropped"]] };

function renderSheet() {
  const el = $("#sheet");
  if (!state.open) return;
  // Do not redraw while you are typing a comment (the text would be lost)
  if (["reviewText", "whereText", "seenDate", "noteText"].includes(document.activeElement?.id)) return;
  const { kind, id } = state.open;
  const mine = get(kind, "mine", id), ours = get(kind, "ours", id);
  const scope = activeScope(kind, id);
  const x = mine && scope === "mine" ? mine : ours || mine || (String(state.preview?.tmdbId) === id ? state.preview : null);
  if (!x) {
    el.innerHTML = `<div class="sheet-inner"><div class="hero"><button class="close" data-action="close" aria-label="Close">←</button></div><div class="splash small"><div class="spinner"></div></div></div>`;
    return;
  }
  const scrollTop = el.scrollTop;
  const others = otherNames();
  const uid = state.user.uid;

  // Header
  const statusText = { Ended: "Ended", Canceled: "Cancelled", "Returning Series": "Returning", "In Production": "In production" }[x.tmdbStatus] || "";
  const nSeasons = seasonsOf(x).length;
  const meta = kind === "movie"
    ? [yearShown(mine || x), x.runtime && fmtDuration(x.runtime), x.rating && `★ ${x.rating}`]
    : [x.year, statusText, nSeasons ? `${nSeasons} season${nSeasons === 1 ? "" : "s"}` : "", x.rating && `★ ${x.rating}`];

  // My stuff
  let myBlock;
  if (!mine) {
    myBlock = `<button class="btn primary wide" data-action="add" data-kind="${kind}" data-id="${id}">＋ Add to my watchlist</button>`;
  } else if (kind === "tv") {
    myBlock = scope === "mine" || !oursActive(kind, id)
      ? `<div class="block-label">My stuff</div><div class="seg">${STATUS_BTNS.tv.map(([k, l]) => `<button class="${mine.status === k ? "on" : ""}" data-action="status" data-scope="mine" data-s="${k}">${l}</button>`).join("")}</div>`
      : `<p class="muted small">You watch this together, so episodes are shared below.</p>`;
  } else if (mine.status !== "seen") {
    myBlock = `<button class="btn primary wide" data-action="seen">✓ Mark as seen</button>`;
  } else {
    const together = ours?.status === "seen";
    myBlock = `
      <section>
        <h3>${mine.seenAt ? `You saw it ${fmtSeen(mine.seenAt)}` : "You have seen it"} <button class="btn link small" data-action="unseen">Not seen</button></h3>
        ${mine.views?.length > 1 ? `<p class="muted small">Seen ${mine.views.length} times: ${mine.views.map((d) => fmtSeen(new Date(d + "T12:00:00").getTime())).join(", ")}</p>` : ""}
        <button class="btn link small" data-action="seenAgain">＋ Seen it again today</button>
        ${movieStars(mine.myRating || 0)}
        <p class="muted small">Tap a star to rate. Tap it again for half a star.</p>
        <label class="field-label" for="seenDate">${mine.views?.length > 1 ? "Date of the latest viewing" : "When did you see it?"}</label>
        <input id="seenDate" inputmode="numeric" placeholder="YYYY-MM-DD" pattern="\\d{4}-\\d{2}-\\d{2}" value="${esc(lastView(mine) || "")}" autocomplete="off">
        <label class="field-label" for="whereText">Where did you watch it?</label>
        <input id="whereText" list="wherePlaces" value="${esc(mine.where || "")}" placeholder="For example Bio, Roy or Netflix" autocomplete="off">
        <datalist id="wherePlaces">${[...new Set(list("movie", "mine").map((m) => m.where).filter(Boolean))].sort().map((w) => `<option value="${esc(w)}">`).join("")}</datalist>
        <label class="field-label" for="noteText">Note <span class="muted">(for example GFF2026#21 if you saw it at the festival)</span></label>
        <input id="noteText" value="${esc(mine.note || "")}" placeholder="Note" autocomplete="off">
        ${!mine.note ? `<button class="chip small" data-action="useGffNumber">Use ${esc(nextGffNote())}</button>` : ""}
        <label class="field-label" for="reviewText">Comment</label>
        <textarea id="reviewText" rows="${mine.review ? Math.min(10, 3 + Math.floor(mine.review.length / 60)) : 3}" placeholder="Write a comment…">${esc(mine.review || "")}</textarea>
        <button class="btn small" data-action="saveReview">Save</button>
        ${together
          ? `<p class="small">👥 Watched together with ${esc(others || "someone")}. <button class="btn link small" data-action="togetherUnseen">Undo</button></p>`
          : `<button class="btn wide" data-action="seenTogether">👥 We watched it together</button>`}
      </section>`;
  }

  // Our stuff
  let ourBlock;
  if (!ours) {
    ourBlock = `
      <section>
        <h3>Watch together?</h3>
        <button class="btn wide" data-action="suggest">👥 Suggest to ${esc(others || "watch together")}</button>
        <p class="muted small">Only this ${K[kind].noun} is shared. The rest of your lists stay private.</p>
      </section>`;
  } else {
    const by = ours.suggestedBy || ours.addedBy;
    ourBlock = `
      <section>
        <h3>Our stuff ${by ? `<span class="muted small">Suggested by ${esc(state.users[by]?.name || "?")}</span>` : ""}</h3>
        ${ours.status === "want" ? `
          ${members().map((m) => {
            const v = ours.interest?.[m.uid];
            const me = m.uid === uid;
            return `<div class="vote-row">
              <span class="who">${esc(m.name)}${me ? " (you)" : ""}</span>
              <div class="vote-btns">${INTEREST.map((i) => `<button class="${v === i.v ? "on" : ""}" ${me ? `data-action="vote" data-v="${i.v}"` : "disabled"} title="${i.label}" aria-label="${i.label}">${thumbs(i.v)}<small>${i.label}</small></button>`).join("")}</div>
            </div>`;
          }).join("")}
          ${isOurs(ours) ? `<p class="pill good">Watch together · ${thumbsTotal(ours)} thumbs up</p>` : ""}
          ${isMaybeLater(ours) ? `<p class="pill later">Maybe later · you both gave it a thumb up</p>` : ""}` : ""}
        ${kind === "tv"
          ? `<div class="seg">${STATUS_BTNS.tv.map(([k, l]) => `<button class="${ours.status === k ? "on" : ""}" data-action="status" data-scope="ours" data-s="${k}">${l}</button>`).join("")}</div>`
          : ours.status === "seen"
            ? `<p>Watched together ${fmtSeen(ours.seenAt)} <button class="btn link small" data-action="togetherUnseen">Undo</button></p>`
            : `<button class="btn wide" data-action="togetherSeen">✓ We watched it together</button>`}
        <button class="btn link small red" data-action="unshare">Remove from Our stuff</button>
      </section>`;
  }

  // About
  const links = [
    x.trailer && [`https://www.youtube.com/watch?v=${encodeURIComponent(x.trailer)}`, "▶ Trailer"],
    [`https://www.themoviedb.org/${K[kind].path}/${x.tmdbId}`, "TMDB"],
    x.imdbId && [`https://www.imdb.com/title/${encodeURIComponent(x.imdbId)}/`, "IMDb"],
    kind === "movie" && [`https://letterboxd.com/tmdb/${x.tmdbId}/`, "Letterboxd"],
  ].filter(Boolean);
  const facts = [
    x.directors?.length && `<div><span class="muted">Directed by</span> ${esc(x.directors.join(", "))}</div>`,
    x.creators?.length && `<div><span class="muted">Created by</span> ${esc(x.creators.join(", "))}</div>`,
    x.networks?.length && `<div><span class="muted">Network</span> ${esc(x.networks.join(", "))}</div>`,
    (x.originalTitle || x.originalName) && `<div><span class="muted">Original title</span> ${esc(x.originalTitle || x.originalName)}</div>`,
    kind === "tv" && totalText(x) && `<div><span class="muted">Length</span> ${totalText(x)}${x.nextAir ? " so far" : ""}</div>`,
    kind === "movie" && (x.firstShown || x.releaseDate) && `<div><span class="muted">First shown</span> ${fmtDate(x.firstShown || x.releaseDate)}</div>`,
    mine?.where && mine.status !== "seen" && `<div><span class="muted">Watched at</span> ${esc(mine.where)}</div>`,
    mine?.note && mine.status !== "seen" && `<div><span class="muted">Note</span> ${esc(mine.note)}</div>`,
    mine?.tags?.length && `<div><span class="muted">Lists</span> ${esc(mine.tags.join(", "))}</div>`,
  ].filter(Boolean).join("");

  // Episodes (series): on the copy you are watching, together or alone
  let episodes = "";
  if (kind === "tv" && scope && seasonsOf(x).length) {
    const show = get(kind, scope, id);
    const n = nextEp(show);
    const { total, seen } = episodeCounts(show);
    const season = seasonsOf(show).find((s) => s.n === state.sheetSeason) || seasonsOf(show)[0];
    episodes = `
      <section>
        <h3>Episodes ${scope === "ours" && others ? `<span class="pill good">Together</span>` : ""} <span class="muted small">${seen} of ${total} watched</span></h3>
        ${seen < total ? `<p class="left">${timeLeft(show)}</p>` : ""}
        <div class="bar big"><span style="width:${total ? Math.round((seen / total) * 100) : 0}%"></span></div>
        ${n ? `<div class="next-row"><div><span class="muted small">Next episode</span><b>${epLabel(n)}</b></div><button class="btn primary" data-action="advance" data-kind="tv" data-scope="${scope}" data-id="${id}">✓ Mark as watched</button></div>`
            : `<p class="muted">${show.nextAir ? `Next episode (${epLabel(show.nextAir)}) airs ${fmtDate(show.nextAir.date)}.` : seen && seen === total ? "You have watched every episode so far." : ""}</p>`}
        <div class="chips">${seasonsOf(show).map((s) => `<button class="chip ${s.n === season?.n ? "on" : ""}" data-action="season" data-n="${s.n}">S${s.n}${isWatched(show, s.n, s.eps) ? " ✓" : ""}</button>`).join("")}</div>
        ${season ? `<div class="eps">${Array.from({ length: season.eps }, (_, i) => i + 1).map((e) => {
          const w = isWatched(show, season.n, e);
          // A watched episode can always be tapped (to unmark it), even if TMDB says it has not aired.
          const tappable = w || isAired(show, season.n, e);
          return `<button class="ep ${w ? "seen" : ""}" ${tappable ? `data-action="setEp" data-scope="${scope}" data-s="${season.n}" data-e="${e}"` : "disabled"}>${e}</button>`;
        }).join("")}</div>
        <p class="muted small">Tap an episode to mark it and everything before it as watched. Tap a watched episode to unmark it and everything after it.</p>` : ""}
        ${show.progress?.s ? `<button class="btn link small" data-action="resetEp" data-scope="${scope}">Reset episodes</button>` : ""}
      </section>`;
  }

  el.innerHTML = `
    <div class="sheet-inner">
      <div class="hero" style="${x.backdrop ? `background-image:url('${img(x.backdrop, "w780")}')` : ""}">
        <button class="close" data-action="close" aria-label="Close">←</button>
      </div>
      <div class="sheet-body">
        <div class="title-row">
          ${x.poster ? `<img class="poster-lg" src="${img(x.poster, "w185")}" alt="">` : ""}
          <div>
            <h2>${esc(titleOf(x))}</h2>
            <div class="muted small">${esc(meta.filter(Boolean).join(" · "))}</div>
            <div class="muted small">${esc(x.genres?.join(", ") || "")}</div>
          </div>
        </div>
        ${myBlock}
        ${mine ? labelsSection(kind, mine) : ""}
        ${x.overview ? `<p class="overview">${esc(x.overview)}</p>` : `<p class="muted">No description available.</p>`}
        ${facts ? `<div class="facts small">${facts}</div>` : ""}
        <div class="links">${links.map(([href, label]) => `<a class="linkbtn" href="${esc(href)}" target="_blank" rel="noopener">${label} ↗</a>`).join("")}</div>
        ${kind === "tv" && x.nextAir ? `<p class="muted small">Next episode (${epLabel(x.nextAir)}) airs ${fmtDate(x.nextAir.date)}.</p>` : ""}
        ${providersSection(x, scope === "ours" ? ourServices() : myServices(), scope === "ours" ? "Where can we watch it?" : "Where can I watch it?")}
        ${episodes}
        ${ourBlock}
        ${castSection(x, K[kind].path)}
        ${mine ? `<button class="btn danger wide" data-action="delete">Remove from my list</button>` : ""}
        <div class="danger-zone">
          <button class="btn link small" data-action="refresh">↻ Refresh info</button>
        </div>
      </div>
    </div>`;
  el.scrollTop = scrollTop;
}
function ourServices() {
  const ids = new Set(Object.values(state.users).flatMap((u) => [...(u.services || []), ...(u.foreign || []).map((f) => f.id)]));
  return ids.size ? ids : null;
}
function splitProviders(show, mine = ourServices()) {
  const all = show.providers?.stream || [];
  if (!mine) return { ours: all, others: [] };
  return { ours: all.filter((p) => mine.has(p.id)), others: all.filter((p) => !mine.has(p.id)) };
}

// Where to watch, on a card: only the services you have picked. Other services are left out on purpose.
function providerLogos(show, max = 3, services = ourServices()) {
  if (!show.providers) return "";
  const { ours } = splitProviders(show, services);
  if (ours.length) {
    return `<div class="logos">${ours.slice(0, max).map((x) => x.logo
      ? `<img src="${img(x.logo, "w92")}" alt="${esc(x.name)}" title="${esc(x.name)}">`
      : `<span class="more">${esc(x.name)}</span>`).join("")}${ours.length > max ? `<span class="more">+${ours.length - max}</span>` : ""}</div>`;
  }
  return services ? `<div class="muted small">Not on your services</div>` : "";
}

function providersSection(show, services = ourServices(), title = "Where can we watch it?") {
  const prov = show.providers || {};
  const { ours } = splitProviders(show, services);
  return `
        <section>
          <h3>${title}</h3>
          ${ours.length
            ? `<div class="providers">${ours.map((p) => `<div class="prov">${p.logo ? `<img src="${img(p.logo, "w92")}" alt="">` : ""}<span>${esc(p.name)}</span></div>`).join("")}</div>`
            : `<p class="muted">${services ? "Not on any of your services right now." : "Not included in any streaming service right now."}</p>`}
          ${prov.link ? `<a class="small" href="${esc(prov.link)}" target="_blank" rel="noopener">See all options ↗</a>` : ""}
          <p class="attribution">Streaming info from JustWatch · updated ${fmtDate(show.fetchedAt)}</p>
        </section>`;
}

function castSection(show, kind = "tv") {
  if (!show.cast?.length) return "";
  return `
        <section>
          <h3>Cast <a class="small" href="https://www.themoviedb.org/${kind}/${show.tmdbId}/cast" target="_blank" rel="noopener">Full cast ↗</a></h3>
          <div class="cast">${show.cast.map((c) => `
            <a class="person" href="https://www.themoviedb.org/person/${c.id}" target="_blank" rel="noopener">
              <div class="face">${c.profile ? `<img loading="lazy" src="${img(c.profile, "w185")}" alt="">` : esc(c.name.slice(0, 1))}</div>
              <b>${esc(c.name)}</b>
              <span class="muted">${esc(c.character)}</span>
            </a>`).join("")}</div>
        </section>`;
}

// Details for a search result that is not in the list yet.
// ---------- Settings ----------
let settingsOpen = false;
let allServices = null; // every streaming service in the region, from TMDB
let svcQuery = "";
let svcRegion = CONFIG.region; // which country's services the settings list shows
const REGIONS = [["SE", "Sweden"], ["US", "USA"], ["GB", "UK"], ["CA", "Canada"], ["AU", "Australia"]];
const regionServices = {}; // region -> list of services, from TMDB

function openSettings() {
  settingsOpen = true;
  history.pushState({ settings: true }, "");
  $("#settings").hidden = false;
  document.body.classList.add("noscroll");
  renderSettings();
  loadRegionServices(svcRegion);
}
// Services for series and for movies differ a little (e.g. film-only services), so combine both lists.
function loadRegionServices(region) {
  if (regionServices[region]) return;
  regionServices[region] = "loading";
  Promise.all(["tv", "movie"].map((k) => tmdb(`/watch/providers/${k}`, { watch_region: region })))
    .then((lists) => {
      const seen = new Set();
      regionServices[region] = lists.flatMap((d) => d.results || [])
        .sort((a, b) => (a.display_priorities?.[region] ?? a.display_priority) - (b.display_priorities?.[region] ?? b.display_priority))
        .filter((p) => !seen.has(p.provider_id) && seen.add(p.provider_id))
        .map((p) => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path }));
      if (region === CONFIG.region) allServices = regionServices[region];
      renderSettings();
    })
    .catch((err) => { delete regionServices[region]; toast("Could not load services: " + err.message); });
}

function closeSettings() {
  settingsOpen = false;
  $("#settings").hidden = true;
  $("#settings").innerHTML = "";
  svcQuery = "";
  svcRegion = CONFIG.region;
  if (!state.open) document.body.classList.remove("noscroll");
}

function renderSettings() {
  if (!settingsOpen) return;
  const el = $("#settings");
  if (!$("#svcFilter")) {
    el.innerHTML = `
      <div class="sheet-inner">
        <header class="settings-top">
          <button class="close static" data-action="close" aria-label="Close">←</button>
          <h2>Settings</h2>
        </header>
        <div class="sheet-body flat">
          <section id="acct"></section>
          <section id="labelsBox"></section>
          <section id="importBox"></section>
          <section>
            <h3>Your streaming services</h3>
            <p class="muted small">Pick the services you have. My stuff shows your services, Our stuff shows the services any of you has. Other services are not shown. Pick none to show all.</p>
            <div id="svcOthers"></div>
            <input id="svcFilter" type="search" placeholder="Find a service…" autocomplete="off">
            <div id="svcList"></div>
          </section>
        </div>
      </div>`;
    $("#svcFilter").oninput = (e) => { svcQuery = e.target.value; renderSettings(); };
    renderImport();
  }
  const mine = new Set(state.users[state.user.uid]?.services || []);
  const others = members().filter((m) => m.uid !== state.user.uid);
  $("#acct").innerHTML = `
    <h3>Account</h3>
    <p>Signed in as <b>${esc(myName())}</b> <span class="muted">(${esc(state.user.email)})</span></p>
    <p class="muted small">Our stuff is shared by ${esc(members().map((m) => m.name).join(" & "))} · App version ${APP_VERSION}</p>
    <button class="btn danger wide" data-action="logout">Sign out</button>`;
  const tags = allTags();
  $("#labelsBox").innerHTML = `
    <h3>Labels</h3>
    ${tags.length ? `<div class="svc-list">${tags.map(([tg, n]) => `
      <div class="label-row"><span>${esc(tg)} <span class="muted small">${n}</span></span>
        <span><button class="btn link small" data-action="renameTag" data-k="${esc(tg)}">Rename</button><button class="btn link small red" data-action="deleteTag" data-k="${esc(tg)}">Remove</button></span></div>`).join("")}</div>`
      : `<p class="muted small">No labels yet. Add them on a series or movie in My stuff.</p>`}`;
  $("#svcOthers").innerHTML = others.map((m) => {
    const theirs = (state.users[m.uid]?.services || []).map((id) => allServices?.find((p) => p.id === id)?.name).filter(Boolean);
    return theirs.length ? `<p class="muted small">${esc(m.name)} has: ${esc(theirs.join(", "))}</p>` : "";
  }).join("");
  const me = state.users[state.user.uid] || {};
  const myForeign = me.foreign || [];
  const isOn = (p, r) => (r === CONFIG.region ? mine.has(p.id) : myForeign.some((f) => f.r === r && f.id === p.id));
  const serviceBtn = (p, r) => `
    <button class="svc ${isOn(p, r) ? "on" : ""}" data-action="toggleService" data-pid="${p.id}" data-r="${r}">
      ${p.logo ? `<img src="${img(p.logo, "w92")}" alt="">` : `<span class="nologo"></span>`}
      <span>${esc(p.name)}${r !== CONFIG.region ? ` (${r})` : ""}</span>
      <span class="check">${isOn(p, r) ? "✓" : ""}</span>
    </button>`;
  // Everything you have picked, from all countries
  const pickedAll = [
    ...(allServices || []).filter((p) => mine.has(p.id)).map((p) => serviceBtn(p, CONFIG.region)),
    ...myForeign.map((f) => serviceBtn({ id: f.id, name: f.name, logo: f.logo }, f.r)),
  ];
  const regionList = regionServices[svcRegion];
  const q = svcQuery.trim().toLowerCase();
  const list = Array.isArray(regionList) ? regionList.filter((p) => !isOn(p, svcRegion) && (!q || p.name.toLowerCase().includes(q))) : [];
  const regionName = REGIONS.find(([k]) => k === svcRegion)?.[1] || svcRegion;
  $("#svcList").innerHTML = `
    ${pickedAll.length ? `<h4 class="muted small">Your services (${pickedAll.length})</h4><div class="svc-list">${pickedAll.join("")}</div>` : ""}
    <h4 class="muted small">Services in</h4>
    <div class="chips">${REGIONS.map(([k, l]) => `<button class="chip ${svcRegion === k ? "on" : ""}" data-action="svcRegion" data-r="${k}">${l}</button>`).join("")}</div>
    ${svcRegion !== CONFIG.region ? `<p class="muted small">Pick a service here if you can use it from Sweden, for example through a library card. Movies and series then show it when it has them in ${esc(regionName)}.</p>` : ""}
    ${!Array.isArray(regionList) ? `<div class="splash small"><div class="spinner"></div></div>`
      : list.length ? `<div class="svc-list">${list.map((p) => serviceBtn(p, svcRegion)).join("")}</div>`
      : `<p class="muted">${q ? `No service matches “${esc(svcQuery)}”.` : "No more services here."}</p>`}`;
}

// ---------- Movie import ----------
// Imports a file Claude made from your Letterboxd export and spreadsheet. It works in two steps:
// 1. Check: every title is looked up on TMDB. Only an exact title match counts as certain.
//    The result is a plan you can look through: corrections, uncertain matches, not found.
// 2. Apply: the plan is saved. Things you changed in the app are kept; the file only adds.
const imp = { items: null, details: null, phase: "idle", done: 0, total: 0, plan: null, keep: {}, notFound: [], failed: [], applied: 0 };
const importKey = (t, y) => `${t.toLowerCase().replace(/[^a-z0-9]/g, "")}|${y || ""}`;
const yearOf = (r) => Number((r.release_date || "").slice(0, 4)) || null;
const normTitle = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const sameTitle = (r, title) => { const n = normTitle(title); return !!n && (normTitle(r.title) === n || normTitle(r.original_title) === n); };
const nearYear = (r, y, d) => !y || (yearOf(r) && Math.abs(yearOf(r) - y) <= d);

// Looks a title up. "strict" is a result with exactly the same title (and about the same year).
// "loose" is what the first version of the import picked (the first search result), used to find
// movies that were matched wrongly before.
async function matchMovie(title, year, id, item = {}) {
  // A line with an exact TMDB id (checked by Claude) needs no search at all, so no data is used.
  if (id) {
    const hit = { id: Number(id), title, lite: true };
    return { strict: hit, loose: item.wasId ? { id: Number(item.wasId), title: item.wasTitle || "?" } : hit };
  }
  const clean = title.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const y = Number(year) || null;
  let loose = null, strict = null;
  const look = (results, d) => strict || (strict = results.find((r) => sameTitle(r, clean) && nearYear(r, y, d)) || null);
  if (y) {
    const d = await tmdb("/search/movie", { query: clean, primary_release_year: y, include_adult: "false" });
    loose = d.results?.[0] || null;
    look(d.results || [], 0);
  }
  if (!strict) {
    const d = await tmdb("/search/movie", { query: clean, include_adult: "false" });
    const res = d.results || [];
    if (!loose) loose = y ? res.find((r) => nearYear(r, y, 1)) || null : res[0] || null;
    look(res, 1);
    if (!strict && y) {
      const d2 = await tmdb("/search/movie", { query: clean, year: y, include_adult: "false" });
      look(d2.results || [], 1);
    }
    if (!strict) look(res, 2);
  }
  return { strict, loose };
}

function renderImport() {
  const box = $("#importBox");
  if (!box) return;
  const pct = imp.total ? Math.round((imp.done / imp.total) * 100) : 0;
  const li = (x) => `<li>${esc(x.t)} (${esc(x.y || "?")})</li>`;
  let body;
  if (imp.phase === "checking" || imp.phase === "applying") {
    body = `
      <p>${imp.phase === "checking" ? "Checking every title on TMDB… nothing is saved yet." : "Saving…"} Keep the app open.</p>
      <div class="bar big"><span style="width:${pct}%"></span></div>
      <p class="muted small">${imp.done} of ${imp.total}</p>`;
  } else if (imp.phase === "planned") {
    const p = imp.plan;
    body = `
      <p><b>Check finished.</b> Nothing has been saved yet. Look through the lists, then tap <b>Save</b>.</p>
      <ul class="small plan">
        <li>${p.ok.length} movies matched exactly</li>
        <li>${p.newCount} will be added, ${p.ok.length + p.moved.length + p.uncertain.length - p.newCount} are already in your lists (only new info is added: reviews, labels and so on)</li>
      </ul>
      ${p.moved.length ? `
        <details open><summary class="small"><b>Corrections (${p.moved.length})</b>: matched to the wrong movie before</summary>
          <ul class="small">${p.moved.map((m) => `<li>${esc(m.item.t)} (${esc(m.item.y || "?")}): was <a href="https://www.themoviedb.org/movie/${m.loose.id}" target="_blank" rel="noopener"><i>${esc(m.loose.title)}</i></a>, now <a href="https://www.themoviedb.org/movie/${m.strict.id}" target="_blank" rel="noopener"><b>${esc(m.strict.title)}</b></a></li>`).join("")}</ul>
        </details>` : ""}
      ${p.uncertain.length ? `
        <details open><summary class="small"><b>Please check (${p.uncertain.length})</b>: no movie with exactly this title</summary>
          <p class="muted small">Untick the ones that are wrong. They are then left out, and a wrong movie from before is removed.</p>
          <div class="checklist">${p.uncertain.map((u, i) => `
            <label class="small"><input type="checkbox" data-keep="${i}" ${imp.keep[i] !== false ? "checked" : ""}>
              ${esc(u.item.t)} (${esc(u.item.y || "?")}) → <a href="https://www.themoviedb.org/movie/${u.loose.id}" target="_blank" rel="noopener">${esc(u.loose.title)}</a> <span class="muted">(TMDB ${yearOf(u.loose) || "?"})</span></label>`).join("")}</div>
        </details>` : ""}
      ${p.series.length ? `<details><summary class="small"><b>Series (${p.series.length})</b>: added to your own series</summary><ul class="small">${p.series.map(li).join("")}</ul></details>` : ""}
      ${imp.notFound.length ? `<details><summary class="small">Not found on TMDB (${imp.notFound.length})</summary><ul class="small">${imp.notFound.map(li).join("")}</ul></details>` : ""}
      ${imp.failed.length ? `<details><summary class="small">Could not be checked (${imp.failed.length})</summary><p class="muted small">TMDB did not answer. Run the check again later for these.</p><ul class="small">${imp.failed.map(li).join("")}</ul></details>` : ""}
      <button class="btn primary wide" data-action="importApply">Save</button>
      <button class="btn link small" data-action="importReset">Cancel</button>`;
  } else if (imp.phase === "applied") {
    body = `<p><b>Done.</b> ${imp.applied} movies updated or added.</p><button class="btn link small" data-action="importReset">Import another file</button>`;
  } else if (imp.details) {
    body = `
      <p>The file has details for <b>${imp.details.length}</b> movies: length, genres, country, directors and viewing dates. Nothing needs to be looked up.</p>
      <button class="btn primary wide" data-action="importDetails">Save details</button>
      <button class="btn link small" data-action="importReset">Cancel</button>`;
  } else if (imp.items) {
    const want = imp.items.filter((i) => i.s === "want").length;
    body = `
      <p>The file has <b>${want}</b> movies to watch and <b>${imp.items.length - want}</b> seen movies.</p>
      <button class="btn primary wide" data-action="importStart">Check the file</button>
      <p class="muted small">First every title is checked against TMDB (a few minutes, keep the app open). You then see what will change before anything is saved.</p>`;
  } else {
    body = `
      <p class="muted small">Choose an import file that Claude made from your Letterboxd export and spreadsheet.</p>
      <label class="btn wide filebtn">Choose file…<input id="importFile" type="file" accept=".json,application/json" hidden></label>`;
  }
  box.innerHTML = `<h3>Import movies</h3>${body}`;
  box.querySelectorAll("[data-keep]").forEach((cb) => (cb.onchange = () => { imp.keep[cb.dataset.keep] = cb.checked; }));
  const input = $("#importFile");
  if (input) input.onchange = async (e) => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (data.kind === "serielistan-movie-details") imp.details = data.items;
      else if (data.kind !== "serielistan-movie-import") throw new Error("This is not an import file from Claude.");
      else imp.items = data.items;
    } catch (err) { toast("Could not read the file: " + err.message); }
    renderImport();
  };
}

async function runInParallel(items, fn, n = 3) {
  const queue = [...items];
  let last = 0;
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
      imp.done++;
      if (Date.now() - last > 400) { last = Date.now(); renderImport(); }
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
}

// Step 1: look everything up and make a plan
async function runImport() {
  if (!imp.items || imp.phase === "checking") return;
  Object.assign(imp, { phase: "checking", done: 0, total: imp.items.length, notFound: [], failed: [], keep: {} });
  renderImport();
  const ok = [], moved = [], uncertain = [];
  const series = imp.items.filter((i) => i.kind === "tv" && i.id);
  imp.done = series.length;
  await runInParallel(imp.items.filter((i) => i.kind !== "tv"), async (item) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const { strict, loose } = await matchMovie(item.t, item.y, item.id, item);
        if (strict && (!loose || loose.id === strict.id)) ok.push({ item, strict, loose });
        else if (strict) moved.push({ item, strict, loose });
        else if (loose) uncertain.push({ item, loose });
        else imp.notFound.push(item);
        return;
      } catch (err) {
        if (attempt === 3) { imp.failed.push(item); return; }
        await new Promise((r) => setTimeout(r, [2000, 5000, 10000][attempt]));
      }
    }
  });
  const sortT = (a, b) => a.item.t.localeCompare(b.item.t);
  moved.sort(sortT); uncertain.sort(sortT);
  const targets = new Set([...ok, ...moved].map((m) => m.strict.id).concat(uncertain.map((u) => u.loose.id)));
  const newCount = [...targets].filter((id) => !get("movie", "mine", id)).length;
  imp.plan = { ok, moved, uncertain, newCount, series };
  imp.phase = "planned";
  renderImport();
}

// What the file says about a movie, from all the lines that point to it
function fromItems(items) {
  const seen = items.filter((i) => i.s === "seen");
  const day = (d) => (d ? new Date(d + "T12:00:00").getTime() : null);
  const pick = (k) => seen.map((i) => i[k]).find((v) => v != null) ?? items.map((i) => i[k]).find((v) => v != null) ?? null;
  return {
    status: seen.length ? "seen" : "want",
    seenAt: seen.map((i) => day(i.seen)).filter(Boolean).sort((a, b) => b - a)[0] || null,
    myRating: pick("r"),
    where: pick("where"),
    note: pick("note"),
    review: pick("rv"),
    tags: [...new Set(items.flatMap((i) => i.tags || []))].filter((t) => !REMOVED_TAGS.includes(t)),
    addedAt: items.map((i) => day(i.added)).filter(Boolean).sort((a, b) => a - b)[0] || Date.now(),
    importKey: importKey(items[0].t, items[0].y),
    lbYear: items.map((i) => i.y).find(Boolean) || null,
  };
}

// Step 2: save the plan
async function applyImport() {
  const p = imp.plan;
  if (!p || imp.phase !== "planned") return;
  imp.phase = "applying";
  // Which file lines point to which movie, after your choices
  const groups = new Map(); // tmdbId -> { hit, items[] }
  const add = (hit, item) => { const g = groups.get(hit.id) || { hit, items: [] }; g.items.push(item); groups.set(hit.id, g); };
  for (const m of [...p.ok, ...p.moved]) add(m.strict, m.item);
  p.uncertain.forEach((u, i) => { if (imp.keep[i] !== false) add(u.loose, u.item); });
  // Movies that a line was wrongly matched to before
  const wrong = new Set([...p.moved.map((m) => m.loose?.id), ...p.uncertain.filter((u, i) => imp.keep[i] === false).map((u) => u.loose.id)].filter(Boolean));

  const jobs = [...[...wrong].map((id) => ["repair", id]), ...[...groups.keys()].map((id) => ["merge", id]), ...p.series.map((i) => ["series", i])];
  imp.total = jobs.length; imp.done = 0; imp.applied = 0;
  renderImport();
  await runInParallel(jobs, async ([kind, id]) => {
    try {
      if (kind === "series") {
        // A series from the file: add it to your own series (seen ones as Finished)
        const item = id;
        const sid = item.id;
        const cur = get("tv", "mine", sid);
        const tags = [...new Set([...(cur?.tags || []), ...(item.tags || [])])];
        if (cur) { if (tags.length !== (cur.tags || []).length) await updateDoc(ref("tv", "mine", sid), { tags }); return; }
        const data = await fetchShowData(sid);
        const last = [...(data.seasons || [])].reverse()[0];
        const done = item.s === "seen";
        await setDoc(ref("tv", "mine", sid), {
          ...data, status: done ? "done" : "want", tags,
          progress: done && data.lastAired ? { s: data.lastAired.s, e: data.lastAired.e } : done && last ? { s: last.n, e: last.eps } : { s: 0, e: 0 },
          addedAt: item.added ? new Date(item.added + "T12:00:00").getTime() : Date.now(), updatedAt: Date.now(),
        });
        imp.applied++;
        return;
      }
      const doc0 = get("movie", "mine", id);
      if (kind === "repair") {
        if (!doc0?.importKey) return; // only touch movies the import created
        if (groups.has(id)) {
          // Other lines really are this movie: rebuild it from them only
          const f = fromItems(groups.get(id).items);
          await updateDoc(ref("movie", "mine", id), {
            status: f.status, seenAt: f.seenAt, myRating: f.myRating, where: f.where, note: f.note, tags: f.tags, lbYear: f.lbYear,
          });
        } else {
          await deleteDoc(ref("movie", "mine", id));
        }
        imp.applied++;
        return;
      }
      const { hit, items } = groups.get(id);
      const f = fromItems(items);
      if (doc0 && !wrong.has(id)) {
        // Already there: only add what is missing, never overwrite what you changed in the app
        const patch = {};
        const tags = [...new Set([...(doc0.tags || []), ...f.tags])].filter((t) => !REMOVED_TAGS.includes(t));
        if (tags.length !== (doc0.tags || []).length) patch.tags = tags;
        if (f.review && !doc0.review) patch.review = f.review;
        if (f.myRating && !doc0.myRating) patch.myRating = f.myRating;
        if (f.where && !doc0.where) patch.where = f.where;
        if (f.note && !doc0.note) patch.note = f.note;
        if (f.status === "seen" && doc0.status !== "seen") { patch.status = "seen"; patch.seenAt = f.seenAt; }
        if (f.lbYear && doc0.lbYear !== f.lbYear) patch.lbYear = f.lbYear;
        if (f.seenAt && !doc0.seenAt && doc0.status === "seen") patch.seenAt = f.seenAt;
        if (Object.keys(patch).length) { await updateDoc(ref("movie", "mine", id), patch); imp.applied++; }
        return;
      }
      if (doc0) {
        // Repaired above; add the review, which a repair does not set
        if (f.review && !doc0.review) await updateDoc(ref("movie", "mine", id), { review: f.review });
        return;
      }
      let data;
      if (f.status === "want") data = await fetchMovieData(id); // full details: runtime, services, cast
      else if (hit.lite) {
        // Only the id is known: fetch the basics (small) for the poster and title
        const d = await tmdb(`/movie/${id}`);
        data = {
          tmdbId: id, title: d.title, originalTitle: d.original_title && d.original_title !== d.title ? d.original_title : null,
          poster: d.poster_path || null, backdrop: d.backdrop_path || null, overview: d.overview || "",
          year: (d.release_date || "").slice(0, 4), releaseDate: d.release_date || null,
          rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null, lang: CONFIG.language, dataV: 0, fetchedAt: 0,
        };
      }
      else data = { // seen movies only need the basics; details are fetched when you open one
        tmdbId: id, title: hit.title, originalTitle: hit.original_title && hit.original_title !== hit.title ? hit.original_title : null,
        poster: hit.poster_path || null, backdrop: hit.backdrop_path || null, overview: hit.overview || "",
        year: (hit.release_date || "").slice(0, 4), releaseDate: hit.release_date || null,
        rating: hit.vote_average ? Math.round(hit.vote_average * 10) / 10 : null,
        lang: CONFIG.language, dataV: 0, fetchedAt: 0,
      };
      const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null));
      await setDoc(ref("movie", "mine", id), { ...data, ...clean });
      imp.applied++;
    } catch (err) {
      console.warn("Import save failed", id, err);
    }
  }, 3);
  imp.phase = "applied";
  renderImport();
  toast("Import saved");
}

// An import link (#import=<gzip+base64url JSON>) opens Settings with the import ready to start.
// The part after # never leaves the browser, so the data is not sent to the web server.
async function importFromLink() {
  if (!location.hash.startsWith("#import=")) return;
  const b64 = location.hash.slice(8).replace(/-/g, "+").replace(/_/g, "/");
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const bytes = Uint8Array.from(atob(b64 + "===".slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0));
    const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    const data = JSON.parse(text);
    if (data.kind !== "serielistan-movie-import") throw new Error("not an import link");
    imp.items = data.items;
    state.mode = "movie";
    localStorage.setItem("mode", "movie");
    renderShell();
    openSettings();
  } catch (err) { toast("Could not read the import link: " + err.message); }
}


// ---------- Statistics (movies, only your own) ----------
// Every viewing counts, also movies you watched together: they are in your own Watched list too.
const STATS_FROM = 2020; // your sheet starts in 2020; earlier and undated viewings are left out
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const countryName = (() => {
  let dn = null;
  try { dn = new Intl.DisplayNames(["en"], { type: "region" }); } catch {}
  return (code) => { try { return (dn && code && dn.of(code)) || code || "Unknown"; } catch { return code || "Unknown"; } };
})();
// One row per viewing: { m, at (ms or null), year, month, gff }
function viewings() {
  const out = [];
  for (const m of list("movie", "mine")) {
    if (m.status !== "seen") continue;
    const dates = m.views?.length ? m.views.map((d) => new Date(d + "T12:00:00").getTime()) : [m.seenAt || null];
    for (const at of dates) {
      const dt = at ? new Date(at) : null;
      const year = dt ? dt.getFullYear() : null, month = dt ? dt.getMonth() : null;
      // A festival viewing: noted as GFF in your sheet, or labelled GFF that year and seen in Jan or Feb
      // Seen AT the festival: only what your sheet says (note GFF…). The GFF label only means
      // the movie was shown at the festival, which is not the same thing.
      // "GFF2021" only marks the viewing in 2021 (Flee was seen again in 2022, not at the festival)
      const noted = /gff\s*(\d{4})/i.exec(m.note || "");
      const gff = noted ? Number(noted[1]) === year : /gff/i.test(m.note || "");
      if (!year || year < STATS_FROM) continue;
      out.push({ m, at, year, month, gff });
    }
  }
  return out;
}
const hours = (vs) => vs.reduce((s, v) => s + (v.m.runtime || 0), 0) / 60;
const fmtH = (h) => `${Math.round(h)} h`;
function topList(vs, keyFn, n = 5) {
  const c = new Map();
  for (const v of vs) for (const k of [].concat(keyFn(v.m) || [])) if (k) c.set(k, (c.get(k) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
}
const statsState = { year: null }; // null = all years

function renderStats() {
  const main = $("#main");
  main.dataset.view = "stats";
  const all = viewings();
  const now = new Date();
  const years = [...new Set(all.map((v) => v.year).filter(Boolean))].sort((a, b) => b - a);
  const sel = statsState.year;
  const vs = sel ? all.filter((v) => v.year === sel) : all;
  const missingDetails = list("movie", "mine").filter((m) => m.status === "seen" && !m.runtime).length;

  // 1. Tiles
  const rated = [...new Set(vs.map((v) => v.m))].filter((m) => m.myRating);
  const avg = rated.length ? rated.reduce((s, m) => s + m.myRating, 0) / rated.length : null;
  let compare = "";
  if (sel === now.getFullYear()) {
    const dayOfYear = (d) => (d - new Date(d.getFullYear(), 0, 1)) / DAY;
    const lastYear = all.filter((v) => v.year === sel - 1 && dayOfYear(new Date(v.at)) <= dayOfYear(now)).length;
    const diff = vs.length - lastYear;
    compare = `<div class="tile"><div class="v">${diff >= 0 ? "+" : ""}${diff}</div><div class="l">vs ${sel - 1} by today</div></div>`;
  }
  const tiles = `
    <div class="tiles">
      <div class="tile"><div class="v">${vs.length}</div><div class="l">movies${sel ? "" : " in total"}</div></div>
      <div class="tile"><div class="v">${fmtH(hours(vs))}</div><div class="l">watched</div></div>
      <div class="tile"><div class="v">${avg ? avg.toFixed(1) + " ★" : "–"}</div><div class="l">average rating</div></div>
      ${compare || `<div class="tile"><div class="v">${vs.filter((v) => !v.gff).length}</div><div class="l">outside GFF</div></div>`}
    </div>`;

  // 3. Per year
  const perYear = years.map((y) => {
    const yv = all.filter((v) => v.year === y);
    const months = y === now.getFullYear() ? now.getMonth() + 1 : 12;
    const ng = yv.filter((v) => !v.gff);
    return `<tr class="${sel === y ? "sel" : ""}"><td>${y}</td><td>${yv.length}</td><td>${fmtH(hours(yv))}</td><td>${(yv.length / months).toFixed(1)}</td><td>${ng.length}</td><td>${fmtH(hours(ng))}</td></tr>`;
  }).join("");

  // 4. Month by month
  const maxCell = Math.max(1, ...years.flatMap((y) => MONTHS.map((_, i) => all.filter((v) => v.year === y && v.month === i).length)));
  const grid = `
    <table class="grid"><thead><tr><th></th>${[...years].reverse().map((y) => `<th>${String(y).slice(2)}</th>`).join("")}</tr></thead><tbody>
      ${MONTHS.map((mn, i) => `<tr><th>${mn}</th>${[...years].reverse().map((y) => {
        const n = all.filter((v) => v.year === y && v.month === i).length;
        return `<td style="--a:${n ? 0.15 + 0.85 * (n / maxCell) : 0}">${n || ""}</td>`;
      }).join("")}</tr>`).join("")}
    </tbody></table>`;

  // 5. Top lists
  const top = (title, rows, fmt = (k) => esc(k)) => `
    <div class="toplist"><h4>${title}</h4>${rows.length ? `<ol>${rows.map(([k, n]) => `<li><span>${fmt(k)}</span><b>${n}</b></li>`).join("")}</ol>` : `<p class="muted small">No data yet</p>`}</div>`;
  const decade = (m) => { const y = Number(m.firstShown?.slice(0, 4) || m.lbYear || m.year); return y ? `${Math.floor(y / 10) * 10}s` : null; };
  const tops = `
    <div class="tops">
      ${top("Countries", topList(vs, (m) => m.country), (k) => esc(countryName(k)))}
      ${top("Genres", topList(vs, (m) => m.genres))}
      ${top("Directors", topList(vs, (m) => m.directors))}
      ${top("Decades", topList(vs, decade))}
    </div>`;

  // 6. Where
  // "Bio, Roy" is the cinema Roy; everything else (Netflix, Draken, Nedladdad …) is somewhere else
  const isCinema = (w) => /^bio\b/i.test(w || "");
  const cinemaRows = topList(vs.filter((v) => isCinema(v.m.where)), (m) => m.where.replace(/^bio,?\s*/i, "") || "Cinema", 50);
  const otherRows = topList(vs.filter((v) => v.m.where && !isCinema(v.m.where)), (m) => m.where, 10);
  const cinema = cinemaRows.reduce((sum, [, n]) => sum + n, 0);
  const withWhere = vs.filter((v) => v.m.where).length;
  const where = `
    ${withWhere ? `<p class="small">${Math.round((cinema / withWhere) * 100)} % at the cinema · ${withWhere - cinema} elsewhere <span class="muted">(${withWhere} of ${vs.length} have a place)</span></p>` : ""}
    <div class="tops">${top("Cinemas", cinemaRows)}${top("Elsewhere", otherRows)}</div>`;

  // 7. Ratings
  const steps = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
  const ratedViews = vs.filter((v) => v.m.myRating);
  const maxR = Math.max(1, ...steps.map((s) => ratedViews.filter((v) => v.m.myRating === s).length));
  const best = [...new Set(vs.map((v) => v.m))].filter((m) => m.myRating).sort((a, b) => b.myRating - a.myRating || (b.seenAt || 0) - (a.seenAt || 0)).slice(0, 5);
  const ratings = `
    <div class="hist">${steps.map((s) => {
      const n = ratedViews.filter((v) => v.m.myRating === s).length;
      return `<div class="hcol"><div class="hbar" style="height:${Math.round((n / maxR) * 100)}%"><span>${n || ""}</span></div><div class="hlab">${s % 1 ? s : s + ""}</div></div>`;
    }).join("")}</div>
    ${best.length ? `<h4>Highest rated</h4><ol class="best">${best.map((m) => `<li data-action="open" data-kind="movie" data-id="${m.tmdbId}"><span>${esc(m.title)} <span class="muted">${esc(yearShown(m))}</span></span><span class="stars">${starText(m.myRating)}</span></li>`).join("")}</ol>` : ""}`;

  main.innerHTML = `
    <div class="chips">
      <button class="chip ${sel ? "" : "on"}" data-action="statsYear" data-y="">All years</button>
      ${years.map((y) => `<button class="chip ${sel === y ? "on" : ""}" data-action="statsYear" data-y="${y}">${y}</button>`).join("")}
    </div>
    ${missingDetails > 50 ? `<div class="notice small">Hours, countries, genres and directors are missing for ${missingDetails} movies. Import the details file from Claude under <a href="#" data-action="menu">Settings → Import movies</a>.</div>` : ""}
    ${tiles}
    <section class="card stat"><h3>Goals</h3><p class="muted small">Goals for 2027 (how many movies, and what kinds) are coming here.</p></section>
    <section class="card stat"><h3>Per year</h3>
      <table class="yt"><thead><tr><th>Year</th><th>Movies</th><th>Hours</th><th>/month</th><th>Excl. GFF</th><th>Hours</th></tr></thead><tbody>${perYear}</tbody></table>
      <p class="muted small">Counted from 2020, when your sheet starts. Every viewing counts, also rewatches.</p>
    </section>
    <section class="card stat"><h3>Month by month</h3>${grid}</section>
    <section class="card stat"><h3>Top lists ${sel ? sel : "· all years"}</h3>${tops}</section>
    <section class="card stat"><h3>Where you watch</h3>${where}</section>
    <section class="card stat"><h3>Ratings</h3>${ratings}</section>`;
}

// Applies a details file from Claude (runtime, genres, country, directors, viewing dates). No searching.
async function applyDetails(items) {
  Object.assign(imp, { phase: "applying", done: 0, total: items.length, applied: 0 });
  renderImport();
  await runInParallel(items, async (d) => {
    const m = get("movie", "mine", d.id);
    if (!m) return;
    const patch = {};
    if (d.runtime && !m.runtime) patch.runtime = d.runtime;
    if (d.genres?.length && !m.genres?.length) patch.genres = d.genres;
    if (d.directors?.length && !m.directors?.length) patch.directors = d.directors;
    if (d.country && !m.country) patch.country = d.country;
    if (d.firstShown && !m.firstShown) patch.firstShown = d.firstShown;
    if (d.views?.length && m.status === "seen" && JSON.stringify(m.views || []) !== JSON.stringify(d.views)) {
      patch.views = d.views;
      patch.seenAt = new Date(d.views[d.views.length - 1] + "T12:00:00").getTime();
    }
    if (Object.keys(patch).length) {
      try { await updateDoc(ref("movie", "mine", d.id), patch); imp.applied++; } catch (err) { console.warn(err); }
    }
  }, 3);
  imp.phase = "applied";
  renderImport();
  toast("Details saved");
}

const todayISO = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD in your time zone
const lastView = (m) => (m.views?.length ? m.views[m.views.length - 1] : m.seenAt ? new Date(m.seenAt).toLocaleDateString("sv-SE") : null);
// Next festival number this year, e.g. GFF2026#21 when GFF2026#20 is the highest so far
function nextGffNote() {
  const y = new Date().getFullYear();
  const nums = list("movie", "mine").map((m) => new RegExp(`gff\\s*${y}\\s*#\\s*(\\d+)`, "i").exec(m.note || "")).filter(Boolean).map((r) => Number(r[1]));
  return `GFF${y}#${nums.length ? Math.max(...nums) + 1 : 1}`;
}

// ---------- Labels ----------
// Labels (tags) belong to your own lists. They can be added per item and renamed or removed everywhere.
const allTags = () => {
  const count = {};
  for (const kind of KINDS) for (const x of list(kind, "mine")) for (const t of x.tags || []) count[t] = (count[t] || 0) + 1;
  return Object.entries(count).sort((a, b) => a[0].localeCompare(b[0]));
};
function labelsSection(kind, mine) {
  const tags = mine.tags || [];
  const known = allTags().map(([t]) => t);
  const choices = [...new Set([...tags, ...known])].sort((a, b) => a.localeCompare(b));
  return `
        <section>
          <h3>Labels</h3>
          ${choices.length ? `<div class="chips">${choices.map((t) => `<button class="chip small ${tags.includes(t) ? "on" : ""}" data-action="toggleTag" data-k="${esc(t)}">${tags.includes(t) ? "✓ " : ""}${esc(t)}</button>`).join("")}</div>` : ""}
          <button class="btn link small" data-action="newTag">＋ New label</button>
        </section>`;
}
async function renameTag(from, to) {
  for (const kind of KINDS) {
    for (const x of list(kind, "mine").filter((y) => y.tags?.includes(from))) {
      const next = [...new Set(x.tags.map((t) => (t === from ? to : t)).filter(Boolean))];
      await updateDoc(ref(kind, "mine", x.tmdbId), { tags: next }).catch(() => {});
    }
  }
  for (const k of KINDS) if (state.filters[k].tag === from) state.filters[k].tag = to || null;
}

// ---------- Dropdowns ----------
document.addEventListener("change", (e) => {
  const t = e.target.closest("[data-change]");
  if (!t) return;
  const f = state.filters[state.mode];
  if (t.dataset.change === "sort") f.sort = t.value;
  if (t.dataset.change === "tagFilter") f.tag = t.value || null;
  if (t.dataset.change === "watchedTag") f.watchedTag = t.value || null;
  f.limit = 60;
  render();
});

// ---------- Clicks ----------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-action]");
  if (!t) return;
  const a = t.dataset.action;
  if (["advance", "add", "skip"].includes(a)) e.stopPropagation();
  if (t.tagName === "A" && t.getAttribute("href") === "#") e.preventDefault();
  const kind = t.dataset.kind || state.open?.kind || state.mode;
  const id = t.dataset.id || state.open?.id;
  const uid = state.user?.uid;
  const f = state.filters[state.mode];
  const p = state.pick[state.mode];
  const scopeHere = () => state.scope[state.mode][state.tab[state.mode] === "watched" ? "watched" : "watchlist"];

  switch (a) {
    case "login": {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      try { await signInWithPopup(auth, provider); }
      catch (err) {
        if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment") return signInWithRedirect(auth, provider);
        if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") renderLogin(err.message);
      }
      return;
    }
    case "logout": if (settingsOpen) history.back(); return signOut(auth);
    case "menu": return openSettings();
    case "toggleService": {
      const pid = Number(t.dataset.pid), r = t.dataset.r || CONFIG.region;
      const me = state.users[uid] || {};
      let patch;
      if (r === CONFIG.region) {
        const cur = me.services || [];
        patch = { services: cur.includes(pid) ? cur.filter((x) => x !== pid) : [...cur, pid] };
      } else {
        const cur = me.foreign || [];
        const has = cur.some((x) => x.r === r && x.id === pid);
        const pr = (regionServices[r] || []).find?.((x) => x.id === pid);
        patch = { foreign: has ? cur.filter((x) => !(x.r === r && x.id === pid)) : [...cur, { r, id: pid, name: pr?.name || "?", logo: pr?.logo || null }] };
      }
      state.users[uid] = { ...me, ...patch };
      renderSettings();
      await updateDoc(doc(db, "users", uid), patch).catch((err) => toast("Could not save: " + err.message));
      // A new foreign service means stored streaming info must be fetched again.
      if (patch.foreign) { refreshStale(); toast("Updating streaming info…"); }
      return;
    }
    case "svcRegion": svcRegion = t.dataset.r; loadRegionServices(svcRegion); return renderSettings();
    case "importStart": return runImport();
    case "importApply": return applyImport();
    case "importReset": Object.assign(imp, { items: null, details: null, phase: "idle", plan: null }); return renderImport();
    case "useGffNumber": { const el = $("#noteText"); if (el) { el.value = nextGffNote(); el.focus(); } t.remove(); return; }
    case "saveReview": {
      const text = $("#reviewText")?.value.trim() || "";
      const where = $("#whereText")?.value.trim() || "";
      const date = ($("#seenDate")?.value || "").trim();
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + "T12:00:00")) || date > todayISO())) {
        return toast("Write the date as YYYY-MM-DD, for example 2026-01-25");
      }
      const note = $("#noteText")?.value.trim() || "";
      const patch = { review: text || deleteField(), where: where || deleteField(), note: note || deleteField() };
      if (date) {
        // The date belongs to the latest viewing
        const m = get("movie", "mine", id);
        const views = m.views?.length ? [...m.views] : [];
        if (views.length) views[views.length - 1] = date; else views.push(date);
        patch.views = views.sort();
        patch.seenAt = new Date(patch.views[patch.views.length - 1] + "T12:00:00").getTime();
      }
      await save("movie", "mine", id, patch);
      return toast("Saved");
    }
    case "renameTag": {
      const from = t.dataset.k;
      const to = prompt(`Rename the label “${from}” to:`, from)?.trim();
      if (!to || to === from) return;
      await renameTag(from, to);
      return toast("Label renamed");
    }
    case "deleteTag": {
      const from = t.dataset.k;
      if (!confirm(`Remove the label “${from}” from everything? The series and movies stay in your lists.`)) return;
      await renameTag(from, null);
      return toast("Label removed");
    }

    // Navigation
    case "mode":
      if (state.mode === t.dataset.m) return;
      state.mode = t.dataset.m;
      localStorage.setItem("mode", state.mode);
      window.scrollTo(0, 0);
      return renderShell();
    case "tab":
      state.tab[state.mode] = t.dataset.tab;
      localStorage.setItem(`tab-${state.mode}`, t.dataset.tab);
      $("#main").innerHTML = "";
      $("#main").dataset.view = "";
      window.scrollTo(0, 0);
      return render();
    case "scope": {
      const tab = state.tab[state.mode] === "watched" ? "watched" : "watchlist";
      state.scope[state.mode][tab] = t.dataset.s;
      state.pick[state.mode].results = null;
      $("#main").dataset.view = "";
      return render();
    }
    case "open": return openSheet(kind, id);
    case "close": return history.back();

    // Lists and filters
    case "sort": f.sort = t.dataset.k; f.limit = 60; return render();
    case "onServices": f.onServices = !f.onServices; f.limit = 60; return render();
    case "tag": f.tag = f.tag === t.dataset.k ? null : t.dataset.k; f.limit = 60; return render();
    case "more": f.limit += 60; return render();
    case "watchedMore": state.watchedLimit += 60; return render();
    case "ourFilter": state.ourFilter[state.mode] = t.dataset.f; return render();
    case "pickOpen": p.open = true; return render();
    case "pickClose": p.open = false; p.results = null; return render();
    case "pickSet": p[t.dataset.k] = t.dataset.v; p.results = null; return render();
    case "pickServices": p.onServices = !p.onServices; p.results = null; return render();
    case "pick": doPick(state.mode, t.dataset.scope || scopeHere()); return render();
    case "skip": p.skipped.add(Number(id)); return render();
    case "unskip": p.skipped.clear(); return render();

    // Adding and sharing
    case "add": t.disabled = true; return addMine(kind, id, String(state.preview?.tmdbId) === String(id) ? state.preview : null);
    case "suggest": return suggest(kind, id);
    case "vote": {
      const v = Number(t.dataset.v);
      const cur = get(kind, "ours", id)?.interest?.[uid];
      return save(kind, "ours", id, { [`interest.${uid}`]: cur === v ? deleteField() : v });
    }
    case "unshare": {
      const x = get(kind, "ours", id);
      if (!confirm(`Remove ${titleOf(x)} from Our stuff? The votes${kind === "tv" ? " and shared episodes" : ""} are removed too.`)) return;
      await deleteDoc(ref(kind, "ours", id));
      if (!get(kind, "mine", id)) history.back();
      return toast("Removed from Our stuff");
    }

    // Series
    case "advance": return advance(kind, t.dataset.scope, id);
    case "status": {
      const scope = t.dataset.scope, s = t.dataset.s;
      const show = get(kind, scope, id);
      const patch = { status: s };
      if (s === "done" && show.seasons?.length) {
        const last = [...seasonsOf(show)].reverse().find((x) => isAired(show, x.n, 1));
        if (last) {
          let e2 = last.eps;
          while (e2 > 1 && !isAired(show, last.n, e2)) e2--;
          patch.progress = { s: last.n, e: e2 };
        }
      }
      return save(kind, scope, id, patch);
    }
    case "season": state.sheetSeason = Number(t.dataset.n); return renderSheet();
    case "setEp": {
      const scope = t.dataset.scope;
      const s = Number(t.dataset.s), ep = Number(t.dataset.e);
      const show = get(kind, scope, id);
      let progress = { s, e: ep };
      // Tapping an episode that is already watched unmarks it and everything after it.
      if (isWatched(show, s, ep)) {
        if (ep > 1) progress = { s, e: ep - 1 };
        else {
          const prev = [...seasonsOf(show)].reverse().find((x) => x.n < s);
          progress = prev ? { s: prev.n, e: prev.eps } : { s: 0, e: 0 };
        }
      }
      const patch = { progress };
      if (show.status === "want" || show.status === "done") patch.status = "watching";
      return save(kind, scope, id, patch);
    }
    case "resetEp": return save(kind, t.dataset.scope, id, { progress: { s: 0, e: 0 } });

    // Movies
    case "seen": return save("movie", "mine", id, { status: "seen", seenAt: Date.now(), views: [todayISO()] }).then(() => toast("Marked as seen. Rate it if you like!"));
    case "seenAgain": {
      const m = get("movie", "mine", id);
      const views = [...(m.views?.length ? m.views : m.seenAt ? [new Date(m.seenAt).toLocaleDateString("sv-SE")] : []), todayISO()];
      return save("movie", "mine", id, { seenAt: Date.now(), views }).then(() => toast(`Seen ${views.length} times`));
    }
    case "unseen": {
      // Undo a logging: back to the watchlist, and everything you logged about the viewing is removed
      const m = get("movie", "mine", id);
      if (!confirm(`Mark ${m.title} as not seen? The date, rating, place, note and comment are removed.`)) return;
      return save("movie", "mine", id, { status: "want", seenAt: deleteField(), myRating: deleteField(), views: deleteField(), where: deleteField(), note: deleteField(), review: deleteField() });
    }
    case "statsYear": statsState.year = t.dataset.y ? Number(t.dataset.y) : null; return render();
    case "importDetails": { const items = imp.details; imp.details = null; return applyDetails(items); }
    case "rate": {
      const n = Number(t.dataset.n);
      const cur = get("movie", "mine", id)?.myRating || 0;
      const next = cur === n ? n - 0.5 : cur === n - 0.5 ? 0 : n;
      return save("movie", "mine", id, { myRating: next || deleteField() });
    }
    case "seenTogether": {
      // From your own Watched: record that you saw it together (shared, so the other person gets it too)
      const mine = get("movie", "mine", id);
      const ours = get("movie", "ours", id);
      const when = mine.seenAt || Date.now();
      try {
        if (ours) await updateDoc(ref("movie", "ours", id), { status: "seen", seenAt: when, [`addedFor.${uid}`]: true });
        else await setDoc(ref("movie", "ours", id), { ...baseData(mine), status: "seen", seenAt: when, interest: {}, suggestedBy: uid, suggestedAt: Date.now(), addedFor: { [uid]: true } });
        toast("Marked as watched together");
      } catch (err) { toast("Could not save: " + err.message); }
      return;
    }
    case "togetherSeen": {
      const now = Date.now();
      await save("movie", "ours", id, { status: "seen", seenAt: now });
      return toast("Marked as watched together");
    }
    case "togetherUnseen": return save("movie", "ours", id, { status: "want", seenAt: deleteField() });

    // Labels on an item
    case "toggleTag": {
      const mine = get(kind, "mine", id);
      const tg = t.dataset.k;
      const tags = mine.tags || [];
      return save(kind, "mine", id, { tags: tags.includes(tg) ? tags.filter((x) => x !== tg) : [...tags, tg] });
    }
    case "newTag": {
      const tg = prompt("Name of the new label:")?.trim();
      if (!tg) return;
      const mine = get(kind, "mine", id);
      return save(kind, "mine", id, { tags: [...new Set([...(mine.tags || []), tg])] });
    }

    // Both
    case "refresh":
      try {
        const d = await K[kind].fetch(id);
        for (const scope of ["mine", "ours"]) if (get(kind, scope, id)) await updateDoc(ref(kind, scope, id), d);
        if (!get(kind, "mine", id) && !get(kind, "ours", id)) { state.preview = d; renderSheet(); }
        toast("Updated");
      } catch (err) { toast(err.message); }
      return;
    case "delete": {
      const x = get(kind, "mine", id);
      if (!confirm(`Remove ${titleOf(x)} from your list? This cannot be undone.`)) return;
      if (!get(kind, "ours", id)) history.back();
      await deleteDoc(ref(kind, "mine", id));
      return toast("Removed");
    }
  }
});
