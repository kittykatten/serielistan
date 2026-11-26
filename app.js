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
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

// Voting with thumbs: the value is the number of thumbs up (0 = thumbs down).
const THUMB = `<svg class="thumb" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 21h4V9H2v12zM23 10c0-1.1-.9-2-2-2h-6.3l1-4.6v-.3c0-.4-.2-.8-.4-1.1L14.2 1 7.6 7.6C7.2 7.9 7 8.4 7 9v10c0 1.1.9 2 2 2h9c.8 0 1.5-.5 1.8-1.2l3-7.1c.1-.2.2-.5.2-.7v-2z"/></svg>`;
const thumbs = (v) => (v === 0 ? `<span class="thumbs down">${THUMB}</span>` : `<span class="thumbs">${THUMB.repeat(v)}</span>`);
const INTEREST = [
  { v: 0, label: "No thanks" },
  { v: 1, label: "Maybe" },
  { v: 2, label: "Yes please" },
];
const OURS_MIN = 3; // total thumbs up needed for "Our shows"
const STATUS = { want: "List", watching: "Watching", done: "Finished", dropped: "Dropped" };

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
const APP_VERSION = "v18";

// Look for a new version on every start and when the app comes back to the foreground.
// When a new service worker takes over, reload once so the new files are used.
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
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

// ---------- State ----------
const state = {
  user: null,
  users: {}, // uid -> {name}
  shows: [],
  loaded: false,
  tab: localStorage.getItem("tab") || "watching",
  wantFilter: "all",
  openId: null,
  preview: null, // show data for a search result that is not in the list
  sheetSeason: null,
  search: { q: "", results: null, trending: null, loading: false },
  // Movies
  mode: localStorage.getItem("mode") || "series",
  mtab: localStorage.getItem("mtab") || "watchlist",
  movies: [], // my own watchlist and seen log
  shared: [], // movies suggested to watch together
  moviesLoaded: false,
  moviesError: null,
  mf: { q: "", onServices: false, sort: "added", limit: 60 },
  pick: { open: false, time: "any", mood: "any", onServices: true, results: null, skipped: new Set() },
  togetherFilter: "all",
  seenLimit: 60,
  msearch: { q: "", results: null, trending: null, loading: false },
  openMovieId: null,
  moviePreview: null,
};
const showById = (id) => state.shows.find((s) => String(s.tmdbId) === String(id));
const members = () => Object.entries(state.users).map(([uid, u]) => ({ uid, name: u.name || "?" }))
  .sort((a, b) => (a.uid === state.user?.uid ? -1 : b.uid === state.user?.uid ? 1 : a.name.localeCompare(b.name)));
const myName = () => state.users[state.user?.uid]?.name;

// ---------- Sign-in ----------
let unsubs = [];
onAuthStateChanged(auth, async (user) => {
  unsubs.forEach((u) => u()); unsubs = [];
  state.user = user;
  state.loaded = false;
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
let refreshedThisSession = false;
function startListening() {
  if (unsubs.length) return;
  unsubs.push(onSnapshot(collection(db, "users"), (snap) => {
    state.users = {};
    snap.forEach((d) => (state.users[d.id] = d.data()));
    render();
  }, renderNoAccess));
  unsubs.push(onSnapshot(collection(db, "shows"), (snap) => {
    state.shows = snap.docs.map((d) => d.data());
    state.loaded = true;
    render();
    if (!refreshedThisSession) { refreshedThisSession = true; refreshStale(); }
  }, renderNoAccess));
  const moviesFailed = (err) => { state.moviesError = err; state.moviesLoaded = true; render(); };
  unsubs.push(onSnapshot(collection(db, "users", state.user.uid, "movies"), (snap) => {
    state.movies = snap.docs.map((d) => d.data());
    state.moviesLoaded = true;
    state.moviesError = null;
    render();
    if (!refreshedMovies) { refreshedMovies = true; refreshStaleMovies(); }
  }, moviesFailed));
  unsubs.push(onSnapshot(collection(db, "sharedMovies"), (snap) => {
    state.shared = snap.docs.map((d) => d.data());
    render();
  }, moviesFailed));
  renderShell();
}

// Fetch new episodes and streaming info for active shows (at most once a day, or when the language changed).
async function refreshStale() {
  const stale = state.shows.filter((s) => (s.status === "watching" || s.status === "want") && needsRefresh(s, DAY));
  for (const s of stale.slice(0, 40)) {
    try { await updateDoc(doc(db, "shows", String(s.tmdbId)), await fetchShowData(s.tmdbId)); } catch {}
  }
}

async function addShow(id) {
  if (showById(id)) return toast("This show is already in your list");
  try {
    const data = await fetchShowData(id);
    await setDoc(doc(db, "shows", String(id)), {
      ...data,
      status: "want",
      progress: { s: 0, e: 0 },
      interest: { [state.user.uid]: 2 },
      addedBy: state.user.uid,
      addedAt: Date.now(),
      updatedAt: Date.now(),
    });
    toast(`${data.name} added to the list`);
  } catch (err) { toast("Could not add: " + err.message); }
}

function update(id, patch) {
  return updateDoc(doc(db, "shows", String(id)), { ...patch, updatedAt: Date.now() })
    .catch((err) => toast("Could not save: " + err.message));
}

// Watching, but every aired episode is watched: shown under Watched until new episodes air.
const caughtUp = (show) => show.status === "watching" && seasonsOf(show).length > 0 && !nextEp(show);

function advance(id) {
  const show = showById(id);
  const n = show && nextEp(show);
  if (!n) return;
  const patch = { progress: { s: n.s, e: n.e } };
  if (show.status !== "watching") patch.status = "watching";
  const after = nextEp({ ...show, progress: n });
  if (!after && show.ended) { patch.status = "done"; toast(`🎉 You finished ${show.name}!`); }
  else if (!after) toast(`✓ Caught up – moved to Watched until new episodes air`);
  else toast(`✓ ${epLabel(n)} watched`);
  update(id, patch);
}

// ---------- Main view ----------
const TABS = {
  series: [["want", "🍿", "List"], ["watching", "▶️", "Watching"], ["done", "✅", "Watched"], ["search", "🔍", "Search"]],
  movies: [["watchlist", "🎬", "Watchlist"], ["together", "👥", "Together"], ["seen", "✅", "Seen"], ["search", "🔍", "Search"]],
};
function renderShell() {
  $("#app").innerHTML = `
    <header class="top">
      <div class="top-row">
        <h1>What are we watching now?</h1>
        <button class="avatar" data-action="menu" aria-label="Menu">${esc((myName() || "?").slice(0, 1).toUpperCase())}</button>
      </div>
      <div class="modes">
        <button data-action="mode" data-m="series">📺 Series <span class="chip-count" data-mbadge="series"></span></button>
        <button data-action="mode" data-m="movies">🎬 Movies <span class="chip-count" data-mbadge="movies"></span></button>
      </div>
    </header>
    <main id="main"></main>
    <nav class="tabs">
      ${TABS[state.mode]
        .map(([k, i, l]) => `<button data-action="tab" data-tab="${k}"><span class="ti">${i}</span><span>${l}</span><span class="badge" data-badge="${k}"></span></button>`).join("")}
    </nav>`;
  render();
}

function render() {
  if (!$("#main")) return;
  const av = $(".avatar");
  if (av) av.textContent = (myName() || "?").slice(0, 1).toUpperCase();
  const movies = state.mode === "movies";
  const activeTab = movies ? state.mtab : state.tab;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === activeTab));
  document.querySelectorAll(".modes button").forEach((b) => b.classList.toggle("on", b.dataset.m === state.mode));
  // Badges for things waiting for your vote
  const pending = myPending().length;
  const pendingMovies = myPendingMovies().length;
  const setBadge = (el, n) => { if (el) { el.textContent = n || ""; el.hidden = !n; } };
  setBadge(document.querySelector('[data-badge="want"]'), pending);
  setBadge(document.querySelector('[data-badge="together"]'), pendingMovies);
  setBadge(document.querySelector('[data-mbadge="series"]'), movies ? pending : 0);
  setBadge(document.querySelector('[data-mbadge="movies"]'), movies ? 0 : pendingMovies);

  if (movies) renderMovies();
  else if (state.tab === "search") renderSearch();
  else renderList();
  if (state.openId || state.openMovieId) renderSheet();
  renderSettings();
}

// Streaming services each person has picked in Settings. The app shows the union of everyone's picks;
// with no picks at all, every service is shown.
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

const awaitsMyVote = (show) => show.interest?.[state.user.uid] === undefined;
const myPending = () => state.shows.filter((s) => s.status === "want" && awaitsMyVote(s));

function interestRow(show) {
  return `<div class="votes">${members().map((m) => {
    const v = show.interest?.[m.uid];
    return `<span class="vote ${v === undefined ? "pending" : ""}">${v === undefined ? "–" : thumbs(v)} ${esc(m.name)}</span>`;
  }).join("")}</div>`;
}

const thumbsTotal = (show) => members().reduce((sum, m) => sum + (show.interest?.[m.uid] ?? 0), 0);
const isOurs = (show) => thumbsTotal(show) >= OURS_MIN;
const iWant = (show) => (show.interest?.[state.user.uid] ?? 0) >= 1;
// Everyone gave at least one thumb up, but not enough for Our shows: interesting, lower priority.
const isMaybeLater = (show) => {
  const ms = members();
  return ms.length > 1 && !isOurs(show) && ms.every((m) => (show.interest?.[m.uid] ?? 0) >= 1);
};
const interestScore = (show) => members().reduce((sum, m) => sum + (show.interest?.[m.uid] ?? 1), 0);

function card(show) {
  let extra = "";
  if (show.status === "want") {
    extra = `${isOurs(show) ? `<span class="pill good">Our shows</span>` : ""}${isMaybeLater(show) ? `<span class="pill later">Maybe later</span>` : ""}${awaitsMyVote(show) ? `<span class="pill ask">Waiting for your vote</span>` : ""}${interestRow(show)}${totalText(show) ? `<div class="muted small">${totalText(show)}</div>` : ""}`;
  } else if (show.status === "watching") {
    const n = nextEp(show);
    const { total, seen } = episodeCounts(show);
    const pct = total ? Math.round((seen / total) * 100) : 0;
    extra = `
      <div class="next">${n ? `Next: <b>${epLabel(n)}</b>` : show.nextAir ? `Caught up · new episode ${fmtDate(show.nextAir.date)}` : show.ended ? "All episodes watched" : "Caught up · waiting for new episodes"}</div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      ${n ? `<div class="muted small">${timeLeft(show)}</div>` : ""}`;
  } else {
    extra = `<div class="muted small">${STATUS[show.status]}${show.status === "done" && !show.ended && show.nextAir ? ` · new season ${fmtDate(show.nextAir.date)}` : ""}</div>`;
  }
  const quick = show.status === "watching" && nextEp(show)
    ? `<button class="quick" data-action="advance" data-id="${show.tmdbId}" aria-label="Mark next episode as watched">✓</button>` : "";
  return `
    <article class="card show" data-action="open" data-id="${show.tmdbId}">
      <div class="poster">${show.poster ? `<img loading="lazy" src="${img(show.poster, "w185")}" alt="">` : "📺"}</div>
      <div class="info">
        <h3>${esc(show.name)} <span class="muted year">${esc(show.year)}</span></h3>
        ${extra}
        ${providerLogos(show)}
      </div>
      ${quick}
    </article>`;
}

function renderList() {
  const main = $("#main");
  if (!state.loaded) { main.innerHTML = `<div class="splash"><div class="spinner"></div></div>`; return; }
  let list;
  let header = "";
  if (state.tab === "want") {
    list = state.shows.filter((s) => s.status === "want");
    if (state.wantFilter === "both") list = list.filter(isOurs);
    if (state.wantFilter === "later") list = list.filter(isMaybeLater);
    if (state.wantFilter === "mine") list = list.filter((s) => iWant(s) && !isOurs(s) && !isMaybeLater(s));
    if (state.wantFilter === "pending") list = list.filter(awaitsMyVote);
    list.sort((a, b) => isOurs(b) - isOurs(a) || isMaybeLater(b) - isMaybeLater(a) || interestScore(b) - interestScore(a) || (b.addedAt || 0) - (a.addedAt || 0));
    header = `<div class="chips">
      ${[["all", "All"], ["both", "Our shows"], ["later", "Maybe later"], ["mine", "My shows"], ["pending", "Waiting for me"]]
        .map(([k, l]) => {
          const count = k === "pending" ? myPending().length : 0;
          return `<button class="chip ${state.wantFilter === k ? "on" : ""}" data-action="wantFilter" data-f="${k}">${l}${count ? ` <span class="chip-count">${count}</span>` : ""}</button>`;
        }).join("")}
    </div>`;
  } else if (state.tab === "watching") {
    list = state.shows.filter((s) => s.status === "watching" && !caughtUp(s))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } else {
    // Caught-up shows wait here until new episodes air, then move back to Watching.
    const waiting = state.shows.filter(caughtUp)
      .sort((a, b) => (a.nextAir?.date || "9999").localeCompare(b.nextAir?.date || "9999"));
    const finished = state.shows.filter((s) => s.status === "done" || s.status === "dropped")
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (waiting.length) {
      header = `<h2 class="section">Waiting for new episodes</h2><div class="list">${waiting.map(card).join("")}</div>`
        + (finished.length ? `<h2 class="section">Finished</h2>` : "");
    }
    list = finished;
  }
  const empty = {
    want: state.wantFilter === "all" ? "No shows here yet. Tap <b>Search</b> to add one." : "No shows match this filter.",
    watching: "You are not watching anything right now. Pick a show from <b>List</b>.",
    done: "Shows you have finished end up here.",
  }[state.tab];
  main.innerHTML = header + (list.length ? `<div class="list">${list.map(card).join("")}</div>` : header && state.tab === "done" ? "" : `<p class="empty">${empty}</p>`);
}

// ---------- Search ----------
let searchTimer;
function renderSearch() {
  const main = $("#main");
  if (!$("#searchInput")) {
    main.innerHTML = `
      <div class="searchbar"><input id="searchInput" type="search" placeholder="Search TV shows…" autocomplete="off" value="${esc(state.search.q)}"></div>
      <div id="results"></div>`;
    $("#searchInput").oninput = (e) => {
      state.search.q = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(doSearch, 350);
    };
    if (!state.search.trending) loadTrending();
  }
  renderResults();
}

async function loadTrending() {
  try {
    const d = await tmdb("/trending/tv/week");
    state.search.trending = d.results || [];
    renderResults();
  } catch (err) { $("#results").innerHTML = `<p class="error">Could not reach TMDB (${esc(err.message)}). Check the API key in config.js.</p>`; }
}

async function doSearch() {
  const q = state.search.q.trim();
  if (!q) { state.search.results = null; return renderResults(); }
  state.search.loading = true; renderResults();
  try {
    const d = await tmdb("/search/tv", { query: q, include_adult: "false" });
    if (q !== state.search.q.trim()) return;
    state.search.results = d.results || [];
  } catch (err) { toast("Search failed: " + err.message); }
  state.search.loading = false; renderResults();
}

function renderResults() {
  const box = $("#results");
  if (!box) return;
  const { results, trending, loading } = state.search;
  const items = results ?? trending;
  if (loading && !results) { box.innerHTML = `<div class="splash small"><div class="spinner"></div></div>`; return; }
  if (!items) { box.innerHTML = `<div class="splash small"><div class="spinner"></div></div>`; return; }
  if (!items.length) { box.innerHTML = `<p class="empty">No results.</p>`; return; }
  box.innerHTML = `${results ? "" : `<h2 class="section">Popular this week</h2>`}
    <div class="list">${items.slice(0, 20).map((r) => {
      const have = showById(r.id);
      return `
      <article class="card show result" data-action="open" data-id="${r.id}">
        <div class="poster">${r.poster_path ? `<img loading="lazy" src="${img(r.poster_path, "w185")}" alt="">` : "📺"}</div>
        <div class="info">
          <h3>${esc(r.name)} <span class="muted year">${esc((r.first_air_date || "").slice(0, 4))}</span></h3>
          <p class="overview clamp">${esc(r.overview || "")}</p>
        </div>
        ${have
          ? `<button class="add done" data-action="open" data-id="${r.id}" aria-label="Show">✓</button>`
          : `<button class="add" data-action="add" data-id="${r.id}" aria-label="Add">＋</button>`}
      </article>`;
    }).join("")}</div>
    <p class="attribution">Show data from TMDB. Streaming info from JustWatch.</p>`;
}

// ---------- Detail sheet ----------
function openSheet(id) {
  state.openId = String(id);
  const show = showById(id);
  state.sheetSeason = show ? (nextEp(show)?.s || show.progress?.s || seasonsOf(show)[0]?.n || 1) : 1;
  history.pushState({ sheet: id }, "");
  $("#sheet").hidden = false;
  document.body.classList.add("noscroll");
  renderSheet();
  $("#sheet").scrollTop = 0;
  if (show && needsRefresh(show, 3 * DAY)) {
    fetchShowData(id).then((d) => updateDoc(doc(db, "shows", String(id)), d)).catch(() => {});
  }
  // A search result that is not in the list: fetch the details just for viewing.
  if (!show) {
    state.preview = null;
    fetchShowData(id)
      .then((d) => { if (state.openId === String(id)) { state.preview = d; state.sheetSeason = null; renderSheet(); } })
      .catch((err) => { toast("Could not load the show: " + err.message); if (state.openId === String(id)) history.back(); });
  }
}
function closeSheet() {
  state.openId = null;
  state.preview = null;
  state.openMovieId = null;
  state.moviePreview = null;
  $("#sheet").hidden = true;
  $("#sheet").innerHTML = "";
  document.body.classList.remove("noscroll");
}
window.addEventListener("popstate", () => {
  if (settingsOpen) closeSettings();
  else if (state.openId || state.openMovieId) closeSheet();
});

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
  if (!state.openId && !state.openMovieId) document.body.classList.remove("noscroll");
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
          <section>
            <h3>Your streaming services</h3>
            <p class="muted small">Pick the services you have. Series show the services that any of you has. Movies in your own watchlist show only yours. Other services are not shown. Pick none to show all.</p>
            <div id="svcOthers"></div>
            <input id="svcFilter" type="search" placeholder="Find a service…" autocomplete="off">
            <div id="svcList"></div>
          </section>
        </div>
      </div>`;
    $("#svcFilter").oninput = (e) => { svcQuery = e.target.value; renderSettings(); };
  }
  const mine = new Set(state.users[state.user.uid]?.services || []);
  const others = members().filter((m) => m.uid !== state.user.uid);
  $("#acct").innerHTML = `
    <h3>Account</h3>
    <p>Signed in as <b>${esc(myName())}</b> <span class="muted">(${esc(state.user.email)})</span></p>
    <p class="muted small">The series list is shared by ${esc(members().map((m) => m.name).join(" & "))} · App version ${APP_VERSION}</p>
    <button class="btn danger wide" data-action="logout">Sign out</button>`;
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

function sheetHeader(show) {
  const statusText = { Ended: "Ended", Canceled: "Cancelled", "Returning Series": "Returning", "In Production": "In production" }[show.tmdbStatus] || "";
  const n = seasonsOf(show).length;
  return `
      <div class="hero" style="${show.backdrop ? `background-image:url('${img(show.backdrop, "w780")}')` : ""}">
        <button class="close" data-action="close" aria-label="Close">←</button>
      </div>
      <div class="sheet-body">
        <div class="title-row">
          ${show.poster ? `<img class="poster-lg" src="${img(show.poster, "w185")}" alt="">` : ""}
          <div>
            <h2>${esc(show.name)}</h2>
            ${show.originalName ? `<div class="muted small">${esc(show.originalName)}</div>` : ""}
            <div class="muted small">${[show.year, statusText, n ? `${n} season${n === 1 ? "" : "s"}` : "", show.rating ? `★ ${show.rating}` : ""].filter(Boolean).join(" · ")}</div>
            <div class="muted small">${esc(show.genres?.join(", ") || "")}</div>
          </div>
        </div>`;
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

function aboutSection(show) {
  const links = [
    show.trailer && [`https://www.youtube.com/watch?v=${encodeURIComponent(show.trailer)}`, "▶ Trailer"],
    [`https://www.themoviedb.org/tv/${show.tmdbId}`, "TMDB"],
    show.imdbId && [`https://www.imdb.com/title/${encodeURIComponent(show.imdbId)}/`, "IMDb"],
  ].filter(Boolean);
  const facts = [
    show.creators?.length && `<div><span class="muted">Created by</span> ${esc(show.creators.join(", "))}</div>`,
    show.networks?.length && `<div><span class="muted">Network</span> ${esc(show.networks.join(", "))}</div>`,
    totalText(show) && `<div><span class="muted">Length</span> ${totalText(show)}${show.nextAir ? " so far" : ""}</div>`,
  ].filter(Boolean).join("");
  return `
        ${show.overview ? `<p class="overview">${esc(show.overview)}</p>` : `<p class="muted">No description available.</p>`}
        ${facts ? `<div class="facts small">${facts}</div>` : ""}
        <div class="links">${links.map(([href, label]) => `<a class="linkbtn" href="${esc(href)}" target="_blank" rel="noopener">${label} ↗</a>`).join("")}</div>
        ${show.nextAir ? `<p class="muted small">Next episode (${epLabel(show.nextAir)}) airs ${fmtDate(show.nextAir.date)}.</p>` : ""}`;
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
function renderPreview(el, show) {
  el.innerHTML = `
    <div class="sheet-inner">
      ${sheetHeader(show)}
        <button class="btn primary wide" data-action="add" data-id="${show.tmdbId}">＋ Add to list</button>
        ${aboutSection(show)}
        ${providersSection(show)}
        ${castSection(show)}
      </div>
    </div>`;
}

function renderSheet() {
  const el = $("#sheet");
  if (state.openMovieId) return renderMovieSheet(el);
  const listed = showById(state.openId);
  const show = listed || (String(state.preview?.tmdbId) === state.openId ? state.preview : null);
  if (!show) {
    el.innerHTML = `<div class="sheet-inner"><div class="hero"><button class="close" data-action="close" aria-label="Close">←</button></div><div class="splash small"><div class="spinner"></div></div></div>`;
    return;
  }
  if (!listed) return renderPreview(el, show);
  const uid = state.user.uid;
  const n = nextEp(show);
  const { total, seen } = episodeCounts(show);
  const season = seasonsOf(show).find((s) => s.n === state.sheetSeason) || seasonsOf(show)[0];

  el.innerHTML = `
    <div class="sheet-inner">
      ${sheetHeader(show)}

        <div class="seg">${Object.entries(STATUS).map(([k, l]) =>
          `<button class="${show.status === k ? "on" : ""}" data-action="status" data-s="${k}">${l}</button>`).join("")}</div>

        ${aboutSection(show)}

        ${providersSection(show)}

        <section>
          <h3>Who wants to watch it?</h3>
          ${members().map((m) => {
            const v = show.interest?.[m.uid];
            const mine = m.uid === uid;
            return `<div class="vote-row">
              <span class="who">${esc(m.name)}${mine ? " (you)" : ""}</span>
              <div class="vote-btns">${INTEREST.map((i) => `<button class="${v === i.v ? "on" : ""}" ${mine ? `data-action="interest" data-v="${i.v}"` : "disabled"} title="${i.label}" aria-label="${i.label}">${thumbs(i.v)}<small>${i.label}</small></button>`).join("")}</div>
            </div>`;
          }).join("")}
          ${isOurs(show) ? `<p class="pill good">Our shows · ${thumbsTotal(show)} thumbs up</p>` : ""}
          ${isMaybeLater(show) ? `<p class="pill later">Maybe later · you both gave it a thumb up</p>` : ""}
        </section>

        ${seasonsOf(show).length ? `
        <section>
          <h3>Episodes <span class="muted small">${seen} of ${total} watched</span></h3>
          ${seen < total ? `<p class="left">${timeLeft(show)}</p>` : ""}
          <div class="bar big"><span style="width:${total ? Math.round((seen / total) * 100) : 0}%"></span></div>
          ${n ? `<div class="next-row"><div><span class="muted small">Next episode</span><b>${epLabel(n)}</b></div><button class="btn primary" data-action="advance" data-id="${show.tmdbId}">✓ Mark as watched</button></div>`
              : `<p class="muted">${show.nextAir ? `Next episode (${epLabel(show.nextAir)}) airs ${fmtDate(show.nextAir.date)}.` : seen && seen === total ? "You have watched every episode so far." : ""}</p>`}
          <div class="chips">${seasonsOf(show).map((s) => {
            const allSeen = isWatched(show, s.n, s.eps);
            return `<button class="chip ${s.n === season?.n ? "on" : ""}" data-action="season" data-n="${s.n}">S${s.n}${allSeen ? " ✓" : ""}</button>`;
          }).join("")}</div>
          ${season ? `<div class="eps">${Array.from({ length: season.eps }, (_, i) => i + 1).map((e) => {
            const seen = isWatched(show, season.n, e);
            // A watched episode can always be tapped (to unmark it), even if TMDB says it has not aired.
            const tappable = seen || isAired(show, season.n, e);
            return `<button class="ep ${seen ? "seen" : ""}" ${tappable ? `data-action="setEp" data-s="${season.n}" data-e="${e}"` : "disabled"}>${e}</button>`;
          }).join("")}</div>
          <p class="muted small">Tap an episode to mark it and everything before it as watched. Tap a watched episode to unmark it and everything after it.</p>` : ""}
          ${show.progress?.s ? `<button class="btn link small" data-action="resetEp">Reset episodes</button>` : ""}
        </section>` : ""}

        ${castSection(show)}

        <button class="btn danger wide" data-action="delete">Remove from list</button>
        <div class="danger-zone">
          <button class="btn link small" data-action="refresh">↻ Refresh info</button>
        </div>
      </div>
    </div>`;
}

// ---------- Movies ----------
// Your own watchlist and log live in users/{uid}/movies (private to you).
// Movies you suggest to watch together are copied to sharedMovies, where everyone votes with thumbs.
const MOVIE_DATA_V = 1;
const MOODS = {
  light: { label: "Light & fun", genres: ["Comedy", "Animation", "Family", "Romance", "Music"] },
  tense: { label: "Tense", genres: ["Thriller", "Horror", "Crime", "Mystery"] },
  epic: { label: "Big & epic", genres: ["Action", "Adventure", "Science Fiction", "Fantasy", "War", "Western"] },
  deep: { label: "Deep", genres: ["Drama", "History", "Documentary"] },
};
const TIMES = [["any", "Any length"], ["105", "Under 1 h 45"], ["135", "Under 2 h 15"]];
const SORTS = [["added", "Recently added"], ["short", "Shortest"], ["rating", "Highest rated"], ["title", "A–Z"]];
const PERSONAL_FIELDS = ["status", "addedAt", "seenAt", "myRating", "suggested"];

async function fetchMovieData(id) {
  const d = await tmdb(`/movie/${id}`, { append_to_response: "watch/providers,credits,videos" });
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
    year: (d.release_date || "").slice(0, 4),
    releaseDate: d.release_date || null,
    runtime: d.runtime || null,
    genres: (d.genres || []).map((g) => g.name),
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    directors: (d.credits?.crew || []).filter((c) => c.job === "Director").map((c) => c.name),
    cast: (d.credits?.cast || []).slice(0, 12).map((c) => ({
      id: c.id, name: c.name, profile: c.profile_path || null, character: c.character || "",
    })),
    imdbId: d.imdb_id || null,
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
const movieNeedsRefresh = (m, maxAge) => Date.now() - (m.fetchedAt || 0) > maxAge || m.lang !== CONFIG.language || m.dataV !== MOVIE_DATA_V
  || (m.foreignKey || "") !== foreignKey();
const movieOnly = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => !PERSONAL_FIELDS.includes(k) && k !== "interest" && !k.startsWith("suggested")));

const myMovieRef = (id) => doc(db, "users", state.user.uid, "movies", String(id));
const sharedRef = (id) => doc(db, "sharedMovies", String(id));
const myMovie = (id) => state.movies.find((m) => String(m.tmdbId) === String(id));
const sharedMovie = (id) => state.shared.find((m) => String(m.tmdbId) === String(id));
const myServices = () => {
  const u = state.users[state.user?.uid] || {};
  const s = [...(u.services || []), ...(u.foreign || []).map((f) => f.id)];
  return s.length ? new Set(s) : null;
};
const onServices = (m, set) => (m.providers?.stream || []).some((p) => set.has(p.id));
const otherNames = () => members().filter((m) => m.uid !== state.user.uid).map((m) => m.name).join(" & ");
const myPendingMovies = () => state.shared.filter((m) => m.status === "want" && awaitsMyVote(m));

// Letterboxd-style stars: 3.5 -> ★★★½
const starText = (r) => (r ? "★".repeat(Math.floor(r)) + (r % 1 ? "½" : "") : "");

function saveMovie(ref, patch) {
  return updateDoc(ref, patch).catch((err) => toast("Could not save: " + err.message));
}

let refreshedMovies = false;
// Streaming availability changes, so refresh watchlist movies about once a week (a few per start).
async function refreshStaleMovies() {
  const stale = state.movies.filter((m) => m.status === "want" && movieNeedsRefresh(m, 7 * DAY));
  for (const m of stale.slice(0, 200)) {
    try { await updateDoc(myMovieRef(m.tmdbId), await fetchMovieData(m.tmdbId)); } catch {}
  }
}

async function addMovie(id) {
  if (myMovie(id)) return toast("Already in your watchlist");
  try {
    const data = await fetchMovieData(id);
    await setDoc(myMovieRef(id), { ...data, status: "want", addedAt: Date.now() });
    toast(`${data.title} added to your watchlist`);
  } catch (err) { toast("Could not add: " + err.message); }
}

// ----- Movie views -----
function renderMovies() {
  const main = $("#main");
  if (!state.moviesLoaded) { main.innerHTML = `<div class="splash"><div class="spinner"></div></div>`; return; }
  if (state.moviesError) {
    main.innerHTML = `<div class="notice">
      <h3>Movies need a database update</h3>
      <p>The database rules in Firebase have to be updated before movies can be saved. Follow the steps Claude gave you for <b>Firebase → Firestore → Rules</b>, then reload the app.</p>
      <p class="muted small">${esc(state.moviesError.code || state.moviesError.message || "")}</p>
    </div>`;
    return;
  }
  if (state.mtab === "search") return renderMovieSearch();
  if (state.mtab === "together") return renderTogether();
  if (state.mtab === "seen") return renderSeen();
  return renderWatchlist();
}

function movieCard(m, { shared = false, skip = false } = {}) {
  const meta = [m.runtime && fmtDuration(m.runtime), m.directors?.[0], m.rating && `★ ${m.rating}`].filter(Boolean).join(" · ");
  let extra = "";
  if (shared) {
    extra = m.status === "seen"
      ? `<div class="muted small">Watched together ${fmtDate(m.seenAt)}</div>`
      : `${isOurs(m) ? `<span class="pill good">Watch together</span>` : ""}${isMaybeLater(m) ? `<span class="pill later">Maybe later</span>` : ""}${awaitsMyVote(m) ? `<span class="pill ask">Waiting for your vote</span>` : ""}${interestRow(m)}`;
  } else if (m.status === "seen") {
    extra = `<div class="small">${m.myRating ? `<span class="stars">${starText(m.myRating)}</span> ` : ""}<span class="muted">Seen ${fmtDate(m.seenAt)}</span></div>`;
  } else if (sharedMovie(m.tmdbId)) {
    extra = `<span class="pill later">Suggested to watch together</span>`;
  }
  return `
    <article class="card show" data-action="mv-open" data-id="${m.tmdbId}">
      <div class="poster">${m.poster ? `<img loading="lazy" src="${img(m.poster, "w185")}" alt="">` : "🎬"}</div>
      <div class="info">
        <h3>${esc(m.title)} <span class="muted year">${esc(m.year)}</span></h3>
        ${meta ? `<div class="muted small">${esc(meta)}</div>` : ""}
        ${extra}
        ${providerLogos(m, 3, shared ? ourServices() : myServices())}
      </div>
      ${skip ? `<button class="quick ghost" data-action="mv-skip" data-id="${m.tmdbId}" aria-label="Not tonight" title="Not tonight">✕</button>` : ""}
    </article>`;
}

function renderWatchlist() {
  const main = $("#main");
  if (!$("#wlFilter")) {
    main.innerHTML = `
      <div id="pick"></div>
      <div class="searchbar"><input id="wlFilter" type="search" placeholder="Filter your watchlist…" autocomplete="off" value="${esc(state.mf.q)}"></div>
      <div id="wlControls"></div>
      <div id="wlList"></div>`;
    $("#wlFilter").oninput = (e) => { state.mf.q = e.target.value; state.mf.limit = 60; renderWatchlist(); };
  }
  renderPick();
  const f = state.mf;
  const svc = myServices();
  const all = state.movies.filter((m) => m.status === "want");
  let list = all;
  const q = f.q.trim().toLowerCase();
  if (q) list = list.filter((m) => [m.title, m.originalTitle, ...(m.directors || [])].filter(Boolean).join(" ").toLowerCase().includes(q));
  if (f.onServices && svc) list = list.filter((m) => onServices(m, svc));
  const by = {
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    short: (a, b) => (a.runtime || 999) - (b.runtime || 999),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    title: (a, b) => a.title.localeCompare(b.title),
  }[f.sort];
  list = [...list].sort(by);

  $("#wlControls").innerHTML = `
    <div class="chips">
      ${svc ? `<button class="chip ${f.onServices ? "on" : ""}" data-action="mv-onServices">On my services</button>` : ""}
      ${SORTS.map(([k, l]) => `<button class="chip ${f.sort === k ? "on" : ""}" data-action="mv-sort" data-k="${k}">${l}</button>`).join("")}
    </div>
    <p class="muted small count">${list.length === all.length ? `${all.length} movie${all.length === 1 ? "" : "s"}` : `${list.length} of ${all.length} movies`}${!svc ? ` · <a href="#" data-action="menu">Pick your streaming services</a> to filter by them` : ""}</p>`;
  const shown = list.slice(0, f.limit);
  $("#wlList").innerHTML = list.length
    ? `<div class="list">${shown.map((m) => movieCard(m)).join("")}</div>
       ${list.length > shown.length ? `<button class="btn wide" data-action="mv-more">Show more (${list.length - shown.length} left)</button>` : ""}`
    : `<p class="empty">${all.length ? "No movies match." : "Your watchlist is empty. Tap <b>Search</b> to add movies."}</p>`;
}

// ----- "Help me pick" -----
function pickCandidates() {
  const p = state.pick;
  const svc = myServices();
  return state.movies.filter((m) => {
    if (m.status !== "want" || p.skipped.has(m.tmdbId)) return false;
    if (p.time !== "any" && !(m.runtime && m.runtime <= Number(p.time))) return false;
    if (p.mood !== "any" && !(m.genres || []).some((g) => MOODS[p.mood].genres.includes(g))) return false;
    if (p.onServices && svc && !onServices(m, svc)) return false;
    return true;
  });
}
function doPick() {
  const c = pickCandidates();
  for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
  state.pick.results = c.slice(0, 3).map((m) => m.tmdbId);
}
function renderPick() {
  const box = $("#pick");
  if (!box) return;
  const p = state.pick;
  if (!p.open) {
    box.innerHTML = `<button class="btn primary wide pickbtn" data-action="mv-pickOpen">🎲 Help me pick a movie</button>`;
    return;
  }
  const svc = myServices();
  const n = pickCandidates().length;
  const results = (p.results || []).map((id) => myMovie(id)).filter((m) => m && m.status === "want" && !p.skipped.has(m.tmdbId));
  const chip = (key, val, label) => `<button class="chip ${p[key] === val ? "on" : ""}" data-action="mv-pickSet" data-k="${key}" data-v="${val}">${label}</button>`;
  box.innerHTML = `
    <section class="pick card">
      <h3>Help me pick <button class="btn link small" data-action="mv-pickClose">Close</button></h3>
      <div class="pick-label">How much time?</div>
      <div class="chips">${TIMES.map(([v, l]) => chip("time", v, l)).join("")}</div>
      <div class="pick-label">What mood?</div>
      <div class="chips">${chip("mood", "any", "Anything")}${Object.entries(MOODS).map(([k, m]) => chip("mood", k, m.label)).join("")}</div>
      ${svc ? `<div class="chips"><button class="chip ${p.onServices ? "on" : ""}" data-action="mv-pickServices">Only on my services</button></div>` : ""}
      <button class="btn primary wide" data-action="mv-pick" ${n ? "" : "disabled"}>${results.length ? "🎲 Pick again" : "🎲 Pick 3 movies"}</button>
      <p class="muted small">${n} movie${n === 1 ? "" : "s"} match${n === 1 ? "es" : ""}.${p.skipped.size ? ` ${p.skipped.size} skipped tonight · <a href="#" data-action="mv-unskip">bring back</a>` : ""}</p>
      ${results.length ? `<div class="list">${results.map((m) => movieCard(m, { skip: true })).join("")}</div><p class="muted small">Tap ✕ for “not tonight”.</p>` : ""}
    </section>`;
}

// ----- Together -----
function renderTogether() {
  const main = $("#main");
  const f = state.togetherFilter;
  let list = state.shared.filter((m) => (f === "seen" ? m.status === "seen" : m.status !== "seen"));
  if (f === "both") list = list.filter(isOurs);
  if (f === "later") list = list.filter(isMaybeLater);
  if (f === "pending") list = list.filter(awaitsMyVote);
  if (f === "seen") list.sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0));
  else list.sort((a, b) => isOurs(b) - isOurs(a) || isMaybeLater(b) - isMaybeLater(a) || interestScore(b) - interestScore(a) || (b.suggestedAt || 0) - (a.suggestedAt || 0));
  const pending = myPendingMovies().length;
  const chips = [["all", "All"], ["both", "Watch together"], ["later", "Maybe later"], ["pending", "Waiting for me"], ["seen", "Watched"]]
    .map(([k, l]) => `<button class="chip ${f === k ? "on" : ""}" data-action="mv-tFilter" data-f="${k}">${l}${k === "pending" && pending ? ` <span class="chip-count">${pending}</span>` : ""}</button>`).join("");
  const empty = f === "all"
    ? "Nothing suggested yet. Open a movie in your watchlist and tap <b>Suggest to watch together</b>. Only the movies you suggest are shared."
    : f === "seen" ? "Movies you watch together end up here." : "No movies match this filter.";
  main.innerHTML = `<div class="chips">${chips}</div>`
    + (list.length ? `<div class="list">${list.map((m) => movieCard(m, { shared: true })).join("")}</div>` : `<p class="empty">${empty}</p>`);
}

// ----- Seen -----
function renderSeen() {
  const main = $("#main");
  const list = state.movies.filter((m) => m.status === "seen").sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0));
  const year = new Date().getFullYear();
  const thisYear = list.filter((m) => new Date(m.seenAt).getFullYear() === year).length;
  main.innerHTML = list.length
    ? `<p class="muted small count">${list.length} movie${list.length === 1 ? "" : "s"} seen · ${thisYear} in ${year}</p>
       <div class="list">${list.slice(0, state.seenLimit).map((m) => movieCard(m)).join("")}</div>
       ${list.length > state.seenLimit ? `<button class="btn wide" data-action="mv-seenMore">Show more</button>` : ""}`
    : `<p class="empty">Movies you have seen end up here. Open a movie and tap <b>Mark as seen</b>.</p>`;
}

// ----- Search -----
let movieSearchTimer;
function renderMovieSearch() {
  const main = $("#main");
  if (!$("#mSearchInput")) {
    main.innerHTML = `
      <div class="searchbar"><input id="mSearchInput" type="search" placeholder="Search movies…" autocomplete="off" value="${esc(state.msearch.q)}"></div>
      <div id="mResults"></div>`;
    $("#mSearchInput").oninput = (e) => {
      state.msearch.q = e.target.value;
      clearTimeout(movieSearchTimer);
      movieSearchTimer = setTimeout(doMovieSearch, 350);
    };
    if (!state.msearch.trending) {
      tmdb("/trending/movie/week")
        .then((d) => { state.msearch.trending = d.results || []; renderMovieResults(); })
        .catch((err) => { const b = $("#mResults"); if (b) b.innerHTML = `<p class="error">Could not reach TMDB (${esc(err.message)}).</p>`; });
    }
  }
  renderMovieResults();
}
async function doMovieSearch() {
  const q = state.msearch.q.trim();
  if (!q) { state.msearch.results = null; return renderMovieResults(); }
  state.msearch.loading = true; renderMovieResults();
  try {
    const d = await tmdb("/search/movie", { query: q, include_adult: "false" });
    if (q !== state.msearch.q.trim()) return;
    state.msearch.results = d.results || [];
  } catch (err) { toast("Search failed: " + err.message); }
  state.msearch.loading = false; renderMovieResults();
}
function renderMovieResults() {
  const box = $("#mResults");
  if (!box) return;
  const { results, trending, loading } = state.msearch;
  const items = results ?? trending;
  if ((loading && !results) || !items) { box.innerHTML = `<div class="splash small"><div class="spinner"></div></div>`; return; }
  if (!items.length) { box.innerHTML = `<p class="empty">No results.</p>`; return; }
  box.innerHTML = `${results ? "" : `<h2 class="section">Popular this week</h2>`}
    <div class="list">${items.slice(0, 20).map((r) => {
      const have = myMovie(r.id);
      return `
      <article class="card show result" data-action="mv-open" data-id="${r.id}">
        <div class="poster">${r.poster_path ? `<img loading="lazy" src="${img(r.poster_path, "w185")}" alt="">` : "🎬"}</div>
        <div class="info">
          <h3>${esc(r.title)} <span class="muted year">${esc((r.release_date || "").slice(0, 4))}</span></h3>
          <p class="overview clamp">${esc(r.overview || "")}</p>
        </div>
        ${have
          ? `<button class="add done" data-action="mv-open" data-id="${r.id}" aria-label="Show">✓</button>`
          : `<button class="add" data-action="mv-add" data-id="${r.id}" aria-label="Add to watchlist">＋</button>`}
      </article>`;
    }).join("")}</div>
    <p class="attribution">Movie data from TMDB. Streaming info from JustWatch.</p>`;
}

// ----- Movie detail sheet -----
function openMovie(id) {
  state.openMovieId = String(id);
  state.moviePreview = null;
  history.pushState({ movie: id }, "");
  $("#sheet").hidden = false;
  document.body.classList.add("noscroll");
  renderSheet();
  $("#sheet").scrollTop = 0;
  const mine = myMovie(id), shared = sharedMovie(id);
  if (mine && movieNeedsRefresh(mine, 3 * DAY)) fetchMovieData(id).then((d) => updateDoc(myMovieRef(id), d)).catch(() => {});
  if (shared && movieNeedsRefresh(shared, 3 * DAY)) fetchMovieData(id).then((d) => updateDoc(sharedRef(id), d)).catch(() => {});
  if (!mine && !shared) {
    fetchMovieData(id)
      .then((d) => { if (state.openMovieId === String(id)) { state.moviePreview = d; renderSheet(); } })
      .catch((err) => { toast("Could not load the movie: " + err.message); if (state.openMovieId === String(id)) history.back(); });
  }
}

function movieStars(r) {
  return `<div class="rate">${[1, 2, 3, 4, 5].map((n) => {
    const cls = r >= n ? "full" : r >= n - 0.5 ? "half" : "";
    return `<button class="star ${cls}" data-action="mv-rate" data-n="${n}" aria-label="${n} stars">★</button>`;
  }).join("")}</div>`;
}

function renderMovieSheet(el) {
  const id = state.openMovieId;
  const mine = myMovie(id), shared = sharedMovie(id);
  const m = mine || shared || (String(state.moviePreview?.tmdbId) === id ? state.moviePreview : null);
  if (!m) {
    el.innerHTML = `<div class="sheet-inner"><div class="hero"><button class="close" data-action="close" aria-label="Close">←</button></div><div class="splash small"><div class="spinner"></div></div></div>`;
    return;
  }
  const meta = [m.year, m.runtime && fmtDuration(m.runtime), m.rating && `★ ${m.rating}`].filter(Boolean).join(" · ");
  const links = [
    m.trailer && [`https://www.youtube.com/watch?v=${encodeURIComponent(m.trailer)}`, "▶ Trailer"],
    [`https://www.themoviedb.org/movie/${m.tmdbId}`, "TMDB"],
    m.imdbId && [`https://www.imdb.com/title/${encodeURIComponent(m.imdbId)}/`, "IMDb"],
    [`https://letterboxd.com/tmdb/${m.tmdbId}/`, "Letterboxd"],
  ].filter(Boolean);
  const facts = [
    m.directors?.length && `<div><span class="muted">Directed by</span> ${esc(m.directors.join(", "))}</div>`,
    m.originalTitle && `<div><span class="muted">Original title</span> ${esc(m.originalTitle)}</div>`,
    m.releaseDate && `<div><span class="muted">Released</span> ${new Date(m.releaseDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</div>`,
  ].filter(Boolean).join("");

  let mineBlock;
  if (!mine) mineBlock = `<button class="btn primary wide" data-action="mv-add" data-id="${m.tmdbId}">＋ Add to my watchlist</button>`;
  else if (mine.status !== "seen") mineBlock = `<button class="btn primary wide" data-action="mv-seen">✓ Mark as seen</button>`;
  else mineBlock = `
    <section>
      <h3>You saw it ${fmtDate(mine.seenAt)} <button class="btn link small" data-action="mv-unseen">Not seen</button></h3>
      ${movieStars(mine.myRating || 0)}
      <p class="muted small">Tap a star to rate. Tap it again for half a star.</p>
    </section>`;

  const others = otherNames();
  let togetherBlock;
  if (!shared) {
    togetherBlock = `
      <section>
        <h3>Watch together?</h3>
        <button class="btn wide" data-action="mv-suggest">👥 Suggest to ${others ? esc(others) : "watch together"}</button>
        <p class="muted small">Only this movie is shared. The rest of your watchlist stays private.</p>
      </section>`;
  } else {
    const uid = state.user.uid;
    togetherBlock = `
      <section>
        <h3>Watch together? ${shared.suggestedBy ? `<span class="muted small">Suggested by ${esc(state.users[shared.suggestedBy]?.name || "?")}</span>` : ""}</h3>
        ${members().map((mb) => {
          const v = shared.interest?.[mb.uid];
          const me = mb.uid === uid;
          return `<div class="vote-row">
            <span class="who">${esc(mb.name)}${me ? " (you)" : ""}</span>
            <div class="vote-btns">${INTEREST.map((i) => `<button class="${v === i.v ? "on" : ""}" ${me ? `data-action="mv-vote" data-v="${i.v}"` : "disabled"} title="${i.label}" aria-label="${i.label}">${thumbs(i.v)}<small>${i.label}</small></button>`).join("")}</div>
          </div>`;
        }).join("")}
        ${isOurs(shared) ? `<p class="pill good">Watch together · ${thumbsTotal(shared)} thumbs up</p>` : ""}
        ${isMaybeLater(shared) ? `<p class="pill later">Maybe later · you both gave it a thumb up</p>` : ""}
        ${shared.status === "seen"
          ? `<p>Watched together ${fmtDate(shared.seenAt)} <button class="btn link small" data-action="mv-togetherUnseen">Undo</button></p>`
          : `<button class="btn wide" data-action="mv-togetherSeen">✓ We watched it together</button>`}
        <button class="btn link small red" data-action="mv-unshare">Remove from Together</button>
      </section>`;
  }

  el.innerHTML = `
    <div class="sheet-inner">
      <div class="hero" style="${m.backdrop ? `background-image:url('${img(m.backdrop, "w780")}')` : ""}">
        <button class="close" data-action="close" aria-label="Close">←</button>
      </div>
      <div class="sheet-body">
        <div class="title-row">
          ${m.poster ? `<img class="poster-lg" src="${img(m.poster, "w185")}" alt="">` : ""}
          <div>
            <h2>${esc(m.title)}</h2>
            <div class="muted small">${esc(meta)}</div>
            <div class="muted small">${esc(m.genres?.join(", ") || "")}</div>
          </div>
        </div>
        ${mineBlock}
        ${m.overview ? `<p class="overview">${esc(m.overview)}</p>` : `<p class="muted">No description available.</p>`}
        ${facts ? `<div class="facts small">${facts}</div>` : ""}
        <div class="links">${links.map(([href, label]) => `<a class="linkbtn" href="${esc(href)}" target="_blank" rel="noopener">${label} ↗</a>`).join("")}</div>
        ${providersSection(m, shared && !mine ? ourServices() : myServices(), shared && !mine ? "Where can we watch it?" : "Where can I watch it?")}
        ${togetherBlock}
        ${castSection(m, "movie")}
        ${mine ? `<button class="btn danger wide" data-action="mv-delete">Remove from my list</button>` : ""}
        <div class="danger-zone">
          <button class="btn link small" data-action="mv-refresh">↻ Refresh info</button>
        </div>
      </div>
    </div>`;
}

// ----- Movie clicks (actions start with "mv-") -----
async function movieClick(a, t) {
  const id = t.dataset.id || state.openMovieId;
  const uid = state.user.uid;
  switch (a) {
    case "open": return openMovie(id);
    case "add": t.disabled = true; return addMovie(id);
    case "sort": state.mf.sort = t.dataset.k; state.mf.limit = 60; return render();
    case "onServices": state.mf.onServices = !state.mf.onServices; state.mf.limit = 60; return render();
    case "more": state.mf.limit += 60; return render();
    case "seenMore": state.seenLimit += 60; return render();
    case "tFilter": state.togetherFilter = t.dataset.f; return render();
    case "pickOpen": state.pick.open = true; return render();
    case "pickClose": state.pick.open = false; state.pick.results = null; return render();
    case "pickSet": state.pick[t.dataset.k] = t.dataset.v; state.pick.results = null; return render();
    case "pickServices": state.pick.onServices = !state.pick.onServices; state.pick.results = null; return render();
    case "pick": doPick(); return render();
    case "skip": state.pick.skipped.add(Number(id)); return render();
    case "unskip": state.pick.skipped.clear(); return render();
    case "seen": return saveMovie(myMovieRef(id), { status: "seen", seenAt: Date.now() }).then(() => toast("Marked as seen. Rate it if you like!"));
    case "unseen": return saveMovie(myMovieRef(id), { status: "want", seenAt: deleteField(), myRating: deleteField() });
    case "rate": {
      const n = Number(t.dataset.n);
      const cur = myMovie(id)?.myRating || 0;
      const next = cur === n ? n - 0.5 : cur === n - 0.5 ? 0 : n;
      return saveMovie(myMovieRef(id), { myRating: next || deleteField() });
    }
    case "suggest": {
      const base = myMovie(id) || state.moviePreview;
      if (!base) return;
      try {
        await setDoc(sharedRef(id), { ...movieOnly(base), status: "want", interest: { [uid]: 2 }, suggestedBy: uid, suggestedAt: Date.now() });
        toast(`Suggested to ${otherNames() || "watch together"}`);
      } catch (err) { toast("Could not share: " + err.message); }
      return;
    }
    case "vote": {
      const v = Number(t.dataset.v);
      const cur = sharedMovie(id)?.interest?.[uid];
      return saveMovie(sharedRef(id), { [`interest.${uid}`]: cur === v ? deleteField() : v });
    }
    case "togetherSeen": {
      const now = Date.now();
      await saveMovie(sharedRef(id), { status: "seen", seenAt: now });
      const mine = myMovie(id);
      if (mine && mine.status !== "seen") await saveMovie(myMovieRef(id), { status: "seen", seenAt: now });
      else if (!mine) await setDoc(myMovieRef(id), { ...movieOnly(sharedMovie(id)), status: "seen", seenAt: now, addedAt: now }).catch(() => {});
      return toast("Marked as watched together");
    }
    case "togetherUnseen": return saveMovie(sharedRef(id), { status: "want", seenAt: deleteField() });
    case "unshare": {
      const m = sharedMovie(id);
      if (!confirm(`Remove ${m.title} from Together? The votes are removed too.`)) return;
      await deleteDoc(sharedRef(id));
      if (!myMovie(id)) history.back();
      return toast("Removed from Together");
    }
    case "refresh":
      try {
        const d = await fetchMovieData(id);
        if (myMovie(id)) await updateDoc(myMovieRef(id), d);
        if (sharedMovie(id)) await updateDoc(sharedRef(id), d);
        if (!myMovie(id) && !sharedMovie(id)) { state.moviePreview = d; renderSheet(); }
        toast("Updated");
      } catch (err) { toast(err.message); }
      return;
    case "delete": {
      const m = myMovie(id);
      if (!confirm(`Remove ${m.title} from your list? This cannot be undone.`)) return;
      history.back();
      await deleteDoc(myMovieRef(id));
      return toast("Removed");
    }
  }
}

// ---------- Clicks ----------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-action]");
  if (!t) return;
  const a = t.dataset.action;
  const id = t.dataset.id || state.openId;
  if (a === "advance" || a === "add" || a === "mv-add" || a === "mv-skip") e.stopPropagation();
  if (t.tagName === "A" && t.getAttribute("href") === "#") e.preventDefault();
  if (a.startsWith("mv-")) return movieClick(a.slice(3), t);

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
      const me = state.users[state.user.uid] || {};
      let patch;
      if (r === CONFIG.region) {
        const cur = me.services || [];
        patch = { services: cur.includes(pid) ? cur.filter((x) => x !== pid) : [...cur, pid] };
      } else {
        const cur = me.foreign || [];
        const has = cur.some((f) => f.r === r && f.id === pid);
        const p = (regionServices[r] || []).find?.((x) => x.id === pid);
        patch = { foreign: has ? cur.filter((f) => !(f.r === r && f.id === pid)) : [...cur, { r, id: pid, name: p?.name || "?", logo: p?.logo || null }] };
      }
      state.users[state.user.uid] = { ...me, ...patch };
      renderSettings();
      await updateDoc(doc(db, "users", state.user.uid), patch).catch((err) => toast("Could not save: " + err.message));
      // A new foreign service means stored streaming info must be fetched again.
      if (patch.foreign) { refreshStale(); refreshStaleMovies(); toast("Updating streaming info…"); }
      return;
    }
    case "svcRegion": svcRegion = t.dataset.r; loadRegionServices(svcRegion); return renderSettings();
    case "tab":
      if (state.mode === "movies") { state.mtab = t.dataset.tab; localStorage.setItem("mtab", state.mtab); }
      else { state.tab = t.dataset.tab; localStorage.setItem("tab", state.tab); }
      $("#main").innerHTML = "";
      window.scrollTo(0, 0);
      return render();
    case "mode":
      if (state.mode === t.dataset.m) return;
      state.mode = t.dataset.m;
      localStorage.setItem("mode", state.mode);
      window.scrollTo(0, 0);
      return renderShell();
    case "wantFilter": state.wantFilter = t.dataset.f; return render();
    case "open": return openSheet(id);
    case "close": return history.back();
    case "add": t.disabled = true; return addShow(id);
    case "advance": return advance(id);
    case "status": {
      const s = t.dataset.s;
      const show = showById(id);
      const patch = { status: s };
      if (s === "done" && show.seasons?.length) {
        const last = [...seasonsOf(show)].reverse().find((x) => isAired(show, x.n, 1));
        if (last) {
          let e2 = last.eps;
          while (e2 > 1 && !isAired(show, last.n, e2)) e2--;
          patch.progress = { s: last.n, e: e2 };
        }
      }
      return update(id, patch);
    }
    case "interest": {
      const v = Number(t.dataset.v);
      const show = showById(id);
      const cur = show.interest?.[state.user.uid];
      return update(id, { [`interest.${state.user.uid}`]: cur === v ? deleteField() : v });
    }
    case "season": state.sheetSeason = Number(t.dataset.n); return renderSheet();
    case "setEp": {
      const s = Number(t.dataset.s), ep = Number(t.dataset.e);
      const show = showById(id);
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
      return update(id, patch);
    }
    case "resetEp": return update(id, { progress: { s: 0, e: 0 } });
    case "refresh":
      try { await updateDoc(doc(db, "shows", String(id)), await fetchShowData(id)); toast("Updated"); } catch (err) { toast(err.message); }
      return;
    case "delete": {
      const show = showById(id);
      if (!confirm(`Remove ${show.name} from the list? This cannot be undone.`)) return;
      history.back();
      await deleteDoc(doc(db, "shows", String(id)));
      return toast("Removed");
    }
  }
});
