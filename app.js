import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc, deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { CONFIG } from "./config.js";

// ---------- Hjälpfunktioner ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const img = (p, size = "w342") => (p ? `https://image.tmdb.org/t/p/${size}${p}` : "");
const DAY = 86400000;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("sv-SE", { day: "numeric", month: "short" }) : "");

const INTEREST = [
  { v: 2, emoji: "😍", label: "Vill gärna" },
  { v: 1, emoji: "🤔", label: "Kanske" },
  { v: 0, emoji: "🙅", label: "Nej tack" },
];
const interestEmoji = (v) => INTEREST.find((i) => i.v === v)?.emoji ?? "❔";
const STATUS = { want: "Vill se", watching: "Tittar på", done: "Sett klart", dropped: "Avbruten" };

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- Kontroll av inställningar ----------
const configured = !JSON.stringify(CONFIG).includes("KLISTRA-IN");
if (!configured) {
  $("#app").innerHTML = `
    <div class="center-page">
      <div class="logo">📺</div>
      <h1>Nästan klart!</h1>
      <p>Öppna <b>config.js</b> och fyll i dina nycklar från Firebase och TMDB.
      Instruktioner finns i <b>INSTALLERA.md</b>.</p>
    </div>`;
  throw new Error("config.js är inte ifylld");
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

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

// Vid serverfel hos TMDB: försök igen, och sist på engelska.
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

async function fetchShowData(id) {
  const d = await tmdb(`/tv/${id}`, { append_to_response: "watch/providers" });
  let overview = d.overview;
  if (!overview) {
    try { overview = (await tmdb(`/tv/${id}`, { language: "en-US" })).overview; } catch {}
  }
  const wp = d["watch/providers"]?.results?.[CONFIG.region] || {};
  const ep = (x) => (x ? { s: x.season_number, e: x.episode_number, date: x.air_date || null } : null);
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
    seasons: (d.seasons || []).filter((s) => s.season_number > 0 && s.episode_count > 0)
      .map((s) => ({ n: s.season_number, eps: s.episode_count })),
    lastAired: ep(d.last_episode_to_air),
    nextAir: ep(d.next_episode_to_air),
    providers: {
      stream: providerList(wp.flatrate, wp.free, wp.ads),
      rent: providerList(wp.rent, wp.buy),
      link: wp.link || null,
    },
    fetchedAt: Date.now(),
  };
}

// ---------- Avsnittslogik ----------
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
const epLabel = (x) => `S${x.s} · A${x.e}`;

// ---------- Tillstånd ----------
const state = {
  user: null,
  users: {}, // uid -> {name}
  shows: [],
  loaded: false,
  tab: localStorage.getItem("tab") || "watching",
  wantFilter: "all",
  openId: null,
  sheetSeason: null,
  search: { q: "", results: null, trending: null, loading: false },
};
const showById = (id) => state.shows.find((s) => String(s.tmdbId) === String(id));
const members = () => Object.entries(state.users).map(([uid, u]) => ({ uid, name: u.name || "?" }))
  .sort((a, b) => (a.uid === state.user?.uid ? -1 : b.uid === state.user?.uid ? 1 : a.name.localeCompare(b.name)));
const myName = () => state.users[state.user?.uid]?.name;

// ---------- Inloggning ----------
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
      <h1>Serielistan</h1>
      <p class="muted">Er gemensamma lista över tv-serier</p>
      <button class="btn google" data-action="login">
        <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
        Logga in med Google
      </button>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
    </div>`;
}

function renderNoAccess(err) {
  $("#app").innerHTML = `
    <div class="center-page">
      <div class="logo">🔒</div>
      <h1>Ingen behörighet</h1>
      <p><b>${esc(state.user?.email)}</b> finns inte med i listan över tillåtna e-postadresser i Firestore-reglerna.</p>
      <p class="muted small">${esc(err?.code || err?.message || "")}</p>
      <button class="btn" data-action="logout">Logga ut</button>
    </div>`;
}

// ---------- Data i realtid ----------
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
  renderShell();
}

// Hämta nya avsnitt och streaminginfo för serier ni tittar på (högst en gång per dygn).
async function refreshStale() {
  const stale = state.shows.filter((s) => (s.status === "watching" || s.status === "want") && Date.now() - (s.fetchedAt || 0) > DAY);
  for (const s of stale.slice(0, 15)) {
    try { await updateDoc(doc(db, "shows", String(s.tmdbId)), await fetchShowData(s.tmdbId)); } catch {}
  }
}

async function addShow(id) {
  if (showById(id)) return toast("Serien finns redan i listan");
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
    toast(`${data.name} lades till i Vill se`);
  } catch (err) { toast("Kunde inte lägga till: " + err.message); }
}

function update(id, patch) {
  return updateDoc(doc(db, "shows", String(id)), { ...patch, updatedAt: Date.now() })
    .catch((err) => toast("Kunde inte spara: " + err.message));
}

function advance(id) {
  const show = showById(id);
  const n = show && nextEp(show);
  if (!n) return;
  const patch = { progress: { s: n.s, e: n.e } };
  if (show.status !== "watching") patch.status = "watching";
  const after = nextEp({ ...show, progress: n });
  if (!after && show.ended) { patch.status = "done"; toast(`🎉 Ni har sett klart ${show.name}!`); }
  else toast(`✓ ${epLabel(n)} sett`);
  update(id, patch);
}

// ---------- Huvudvy ----------
function renderShell() {
  $("#app").innerHTML = `
    <header class="top">
      <h1>📺 Serielistan</h1>
      <button class="avatar" data-action="menu" aria-label="Meny">${esc((myName() || "?").slice(0, 1).toUpperCase())}</button>
    </header>
    <main id="main"></main>
    <nav class="tabs">
      ${[["want", "🍿", "Vill se"], ["watching", "▶️", "Tittar på"], ["done", "✅", "Sett"], ["search", "🔍", "Sök"]]
        .map(([k, i, l]) => `<button data-action="tab" data-tab="${k}"><span class="ti">${i}</span><span>${l}</span><span class="badge" data-badge="${k}"></span></button>`).join("")}
    </nav>`;
  render();
}

function render() {
  if (!$("#main")) return;
  const av = $(".avatar");
  if (av) av.textContent = (myName() || "?").slice(0, 1).toUpperCase();
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  // Märk fliken Vill se när du har serier att ta ställning till
  const pending = state.shows.filter((s) => s.status === "want" && s.interest?.[state.user.uid] === undefined).length;
  const badge = document.querySelector('[data-badge="want"]');
  if (badge) { badge.textContent = pending || ""; badge.hidden = !pending; }

  if (state.tab === "search") renderSearch();
  else renderList();
  if (state.openId) renderSheet();
}

function providerLogos(show, max = 3) {
  const p = show.providers?.stream || [];
  if (!p.length) return "";
  return `<div class="logos">${p.slice(0, max).filter((x) => x.logo).map((x) => `<img src="${img(x.logo, "w92")}" alt="${esc(x.name)}" title="${esc(x.name)}">`).join("")}${p.length > max ? `<span class="more">+${p.length - max}</span>` : ""}</div>`;
}

function interestRow(show) {
  return `<div class="votes">${members().map((m) => {
    const v = show.interest?.[m.uid];
    return `<span class="vote ${v === undefined ? "pending" : ""}">${interestEmoji(v)} ${esc(m.name)}</span>`;
  }).join("")}</div>`;
}

const everyoneWants = (show) => {
  const ms = members();
  return ms.length > 1 && ms.every((m) => show.interest?.[m.uid] === 2);
};
const interestScore = (show) => members().reduce((sum, m) => sum + (show.interest?.[m.uid] ?? 1), 0);

function card(show) {
  let extra = "";
  if (show.status === "want") {
    extra = `${everyoneWants(show) ? `<span class="pill good">💚 Ni vill båda se</span>` : ""}${interestRow(show)}`;
  } else if (show.status === "watching") {
    const n = nextEp(show);
    const { total, seen } = episodeCounts(show);
    const pct = total ? Math.round((seen / total) * 100) : 0;
    extra = `
      <div class="next">${n ? `Nästa: <b>${epLabel(n)}</b>` : show.nextAir ? `Ikapp · nytt avsnitt ${fmtDate(show.nextAir.date)}` : show.ended ? "Alla avsnitt sedda" : "Ikapp · väntar på nya avsnitt"}</div>
      <div class="bar"><span style="width:${pct}%"></span></div>`;
  } else {
    extra = `<div class="muted small">${STATUS[show.status]}${show.status === "done" && !show.ended && show.nextAir ? ` · ny säsong ${fmtDate(show.nextAir.date)}` : ""}</div>`;
  }
  const quick = show.status === "watching" && nextEp(show)
    ? `<button class="quick" data-action="advance" data-id="${show.tmdbId}" aria-label="Markera nästa avsnitt som sett">✓</button>` : "";
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
    if (state.wantFilter === "both") list = list.filter(everyoneWants);
    if (state.wantFilter === "mine") list = list.filter((s) => s.interest?.[state.user.uid] === undefined);
    list.sort((a, b) => everyoneWants(b) - everyoneWants(a) || interestScore(b) - interestScore(a) || (b.addedAt || 0) - (a.addedAt || 0));
    header = `<div class="chips">
      ${[["all", "Alla"], ["both", "💚 Båda vill"], ["mine", "❔ Väntar på mig"]]
        .map(([k, l]) => `<button class="chip ${state.wantFilter === k ? "on" : ""}" data-action="wantFilter" data-f="${k}">${l}</button>`).join("")}
    </div>`;
  } else if (state.tab === "watching") {
    list = state.shows.filter((s) => s.status === "watching")
      .sort((a, b) => !!nextEp(b) - !!nextEp(a) || (b.updatedAt || 0) - (a.updatedAt || 0));
  } else {
    list = state.shows.filter((s) => s.status === "done" || s.status === "dropped")
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  const empty = {
    want: state.wantFilter === "all" ? "Inga serier här än. Tryck på <b>Sök</b> för att lägga till en." : "Inga serier matchar filtret.",
    watching: "Ni tittar inte på något just nu. Välj en serie från <b>Vill se</b>.",
    done: "Här hamnar serierna ni har sett klart.",
  }[state.tab];
  main.innerHTML = header + (list.length ? `<div class="list">${list.map(card).join("")}</div>` : `<p class="empty">${empty}</p>`);
}

// ---------- Sök ----------
let searchTimer;
function renderSearch() {
  const main = $("#main");
  if (!$("#searchInput")) {
    main.innerHTML = `
      <div class="searchbar"><input id="searchInput" type="search" placeholder="Sök tv-serie…" autocomplete="off" value="${esc(state.search.q)}"></div>
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
  } catch (err) { $("#results").innerHTML = `<p class="error">Kunde inte nå TMDB (${esc(err.message)}). Kontrollera API-nyckeln i config.js.</p>`; }
}

async function doSearch() {
  const q = state.search.q.trim();
  if (!q) { state.search.results = null; return renderResults(); }
  state.search.loading = true; renderResults();
  try {
    const d = await tmdb("/search/tv", { query: q, include_adult: "false" });
    if (q !== state.search.q.trim()) return;
    state.search.results = d.results || [];
  } catch (err) { toast("Sökningen misslyckades: " + err.message); }
  state.search.loading = false; renderResults();
}

function renderResults() {
  const box = $("#results");
  if (!box) return;
  const { results, trending, loading } = state.search;
  const items = results ?? trending;
  if (loading && !results) { box.innerHTML = `<div class="splash small"><div class="spinner"></div></div>`; return; }
  if (!items) { box.innerHTML = `<div class="splash small"><div class="spinner"></div></div>`; return; }
  if (!items.length) { box.innerHTML = `<p class="empty">Inga träffar.</p>`; return; }
  box.innerHTML = `${results ? "" : `<h2 class="section">Populärt den här veckan</h2>`}
    <div class="list">${items.slice(0, 20).map((r) => {
      const have = showById(r.id);
      return `
      <article class="card show result">
        <div class="poster">${r.poster_path ? `<img loading="lazy" src="${img(r.poster_path, "w185")}" alt="">` : "📺"}</div>
        <div class="info">
          <h3>${esc(r.name)} <span class="muted year">${esc((r.first_air_date || "").slice(0, 4))}</span></h3>
          <p class="overview clamp">${esc(r.overview || "")}</p>
        </div>
        ${have
          ? `<button class="add done" data-action="open" data-id="${r.id}" aria-label="Visa">✓</button>`
          : `<button class="add" data-action="add" data-id="${r.id}" aria-label="Lägg till">＋</button>`}
      </article>`;
    }).join("")}</div>
    <p class="attribution">Seriedata från TMDB. Streaminginfo från JustWatch.</p>`;
}

// ---------- Detaljvy ----------
function openSheet(id) {
  state.openId = String(id);
  const show = showById(id);
  state.sheetSeason = show ? (nextEp(show)?.s || show.progress?.s || seasonsOf(show)[0]?.n || 1) : 1;
  history.pushState({ sheet: id }, "");
  $("#sheet").hidden = false;
  document.body.classList.add("noscroll");
  renderSheet();
  $("#sheet").scrollTop = 0;
  if (show && Date.now() - (show.fetchedAt || 0) > 3 * DAY) {
    fetchShowData(id).then((d) => updateDoc(doc(db, "shows", String(id)), d)).catch(() => {});
  }
}
function closeSheet() {
  state.openId = null;
  $("#sheet").hidden = true;
  $("#sheet").innerHTML = "";
  document.body.classList.remove("noscroll");
}
window.addEventListener("popstate", () => { if (state.openId) closeSheet(); });

function renderSheet() {
  const show = showById(state.openId);
  const el = $("#sheet");
  if (!show) { history.back(); return; }
  const uid = state.user.uid;
  const n = nextEp(show);
  const { total, seen } = episodeCounts(show);
  const season = seasonsOf(show).find((s) => s.n === state.sheetSeason) || seasonsOf(show)[0];
  const prov = show.providers || {};
  const statusText = show.tmdbStatus === "Ended" ? "Avslutad" : show.tmdbStatus === "Canceled" ? "Nedlagd" : show.tmdbStatus === "Returning Series" ? "Pågående" : show.tmdbStatus === "In Production" ? "I produktion" : "";

  el.innerHTML = `
    <div class="sheet-inner">
      <div class="hero" style="${show.backdrop ? `background-image:url('${img(show.backdrop, "w780")}')` : ""}">
        <button class="close" data-action="close" aria-label="Stäng">←</button>
      </div>
      <div class="sheet-body">
        <div class="title-row">
          ${show.poster ? `<img class="poster-lg" src="${img(show.poster, "w185")}" alt="">` : ""}
          <div>
            <h2>${esc(show.name)}</h2>
            ${show.originalName ? `<div class="muted small">${esc(show.originalName)}</div>` : ""}
            <div class="muted small">${[show.year, statusText, seasonsOf(show).length ? `${seasonsOf(show).length} säs.` : "", show.rating ? `★ ${show.rating}` : ""].filter(Boolean).join(" · ")}</div>
            <div class="muted small">${esc(show.genres?.join(", ") || "")}</div>
          </div>
        </div>

        <div class="seg">${Object.entries(STATUS).map(([k, l]) =>
          `<button class="${show.status === k ? "on" : ""}" data-action="status" data-s="${k}">${l}</button>`).join("")}</div>

        ${show.overview ? `<p class="overview">${esc(show.overview)}</p>` : ""}

        <section>
          <h3>Var kan vi se den?</h3>
          ${prov.stream?.length
            ? `<div class="providers">${prov.stream.map((p) => `<div class="prov">${p.logo ? `<img src="${img(p.logo, "w92")}" alt="">` : ""}<span>${esc(p.name)}</span></div>`).join("")}</div>`
            : `<p class="muted">Ingår inte i någon streamingtjänst i Sverige just nu.</p>`}
          ${prov.rent?.length ? `<p class="muted small">Hyra/köpa: ${prov.rent.map((p) => esc(p.name)).join(", ")}</p>` : ""}
          ${prov.link ? `<a class="small" href="${esc(prov.link)}" target="_blank" rel="noopener">Visa alla alternativ ↗</a>` : ""}
          <p class="attribution">Streaminginfo från JustWatch · uppdaterad ${fmtDate(show.fetchedAt)}</p>
        </section>

        <section>
          <h3>Vem vill se den?</h3>
          ${members().map((m) => {
            const v = show.interest?.[m.uid];
            const mine = m.uid === uid;
            return `<div class="vote-row">
              <span class="who">${esc(m.name)}${mine ? " (du)" : ""}</span>
              <div class="vote-btns">${INTEREST.map((i) => `<button class="${v === i.v ? "on" : ""}" ${mine ? `data-action="interest" data-v="${i.v}"` : "disabled"} title="${i.label}">${i.emoji}<small>${i.label}</small></button>`).join("")}</div>
            </div>`;
          }).join("")}
          ${everyoneWants(show) ? `<p class="pill good">💚 Ni vill båda se den här!</p>` : ""}
        </section>

        ${seasonsOf(show).length ? `
        <section>
          <h3>Avsnitt <span class="muted small">${seen} av ${total} sedda</span></h3>
          <div class="bar big"><span style="width:${total ? Math.round((seen / total) * 100) : 0}%"></span></div>
          ${n ? `<button class="btn primary wide" data-action="advance" data-id="${show.tmdbId}">✓ Vi har sett ${epLabel(n)}</button>`
              : `<p class="muted">${show.nextAir ? `Nästa avsnitt (${epLabel(show.nextAir)}) kommer ${fmtDate(show.nextAir.date)}.` : seen && seen === total ? "Ni har sett alla avsnitt som finns." : ""}</p>`}
          <div class="chips">${seasonsOf(show).map((s) => {
            const allSeen = isWatched(show, s.n, s.eps);
            return `<button class="chip ${s.n === season?.n ? "on" : ""}" data-action="season" data-n="${s.n}">S${s.n}${allSeen ? " ✓" : ""}</button>`;
          }).join("")}</div>
          ${season ? `<div class="eps">${Array.from({ length: season.eps }, (_, i) => i + 1).map((e) => {
            const aired = isAired(show, season.n, e);
            return `<button class="ep ${isWatched(show, season.n, e) ? "seen" : ""}" ${aired ? `data-action="setEp" data-s="${season.n}" data-e="${e}"` : "disabled"}>${e}</button>`;
          }).join("")}</div>
          <p class="muted small">Tryck på ett avsnitt för att markera allt fram till och med det som sett.</p>` : ""}
          ${show.progress?.s ? `<button class="btn link small" data-action="resetEp">Nollställ avsnitt</button>` : ""}
        </section>` : ""}

        <div class="danger-zone">
          <button class="btn link small" data-action="refresh">↻ Uppdatera info</button>
          <button class="btn link small red" data-action="delete">Ta bort från listan</button>
        </div>
      </div>
    </div>`;
}

// ---------- Klick ----------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-action]");
  if (!t) return;
  const a = t.dataset.action;
  const id = t.dataset.id || state.openId;
  if (a === "advance" || a === "add") e.stopPropagation();

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
    case "logout": return signOut(auth);
    case "menu": {
      const ms = members().map((m) => m.name).join(" & ");
      if (confirm(`Inloggad som ${myName()} (${state.user.email}).\nListan delas av: ${ms}\n\nVill du logga ut?`)) signOut(auth);
      return;
    }
    case "tab":
      state.tab = t.dataset.tab;
      localStorage.setItem("tab", state.tab);
      $("#main").innerHTML = "";
      window.scrollTo(0, 0);
      return render();
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
      const patch = { progress: { s, e: ep } };
      if (show.status === "want") patch.status = "watching";
      return update(id, patch);
    }
    case "resetEp": return update(id, { progress: { s: 0, e: 0 } });
    case "refresh":
      try { await updateDoc(doc(db, "shows", String(id)), await fetchShowData(id)); toast("Uppdaterad"); } catch (err) { toast(err.message); }
      return;
    case "delete": {
      const show = showById(id);
      if (!confirm(`Ta bort ${show.name} från listan? Det går inte att ångra.`)) return;
      history.back();
      await deleteDoc(doc(db, "shows", String(id)));
      return toast("Borttagen");
    }
  }
});
