/* Hexlens Offline-Speicher (Service Worker)
 *
 * Zwei Einsatzorte:
 * - Handy-Version auf GitHub Pages (?cloud=1): merkt sich die App, die Bilder und den
 *   verschlüsselten Datenstand (data.bin). Ohne Internet zeigt Hexlens den letzten Stand.
 * - Verschlüsselter Heimnetz-Zugang zum PC: merkt sich App, Bilder und die zuletzt
 *   geladenen Daten, damit Hexlens auch bei ausgeschaltetem PC läuft.
 * Es wird nichts an fremde Server geschickt – alles bleibt auf dem Handy.
 */

const CLOUD = new URL(self.location.href).searchParams.has('cloud');
// Ordner, in dem die App liegt ("/" am PC, "/<repository>/" auf GitHub Pages)
const BASE = new URL(self.registration.scope).pathname;

const SHELL = 'hexlens-shell-v2';
const STATIC = 'hexlens-static-v2';
const API = 'hexlens-api-v2';
const KEEP = [SHELL, STATIC, API];

// Diese Daten sind live oder nur am PC sinnvoll – nie aus dem Speicher liefern
const NO_CACHE = [/^\/api\/lcu\//, /^\/api\/lan/, /^\/api\/autostart/, /^\/api\/spotify/, /^\/api\/sound/];
const API_TIMEOUT = 3500;
const PAGE_TIMEOUT = 3500;
const DATA_TIMEOUT = 8000;
// Nach einem Fehlschlag kurz direkt aus dem Speicher liefern, statt jedes Mal zu warten
const OFFLINE_HOLD = 20_000;
let offlineUntil = 0;

/** Pfad innerhalb der App, z. B. "/assets/x.js" – unabhängig vom Ordner */
const rel = (pathname) => (pathname.startsWith(BASE) ? '/' + pathname.slice(BASE.length) : pathname);

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Antwort mit Zeitstempel speichern, damit die App „Stand vom …“ anzeigen kann */
async function store(cacheName, request, response) {
  const body = await response.clone().blob();
  const headers = new Headers(response.headers);
  headers.set('x-hexlens-cached-at', String(Date.now()));
  const copy = new Response(body, { status: response.status, statusText: response.statusText, headers });
  await (await caches.open(cacheName)).put(request, copy);
}

/** Gespeicherte Antwort als „offline“ markieren */
async function fromCache(cacheName, request) {
  const cached = await (await caches.open(cacheName)).match(request);
  if (!cached) return null;
  const headers = new Headers(cached.headers);
  headers.set('x-hexlens-offline', headers.get('x-hexlens-cached-at') || '0');
  return new Response(await cached.blob(), { status: cached.status, statusText: cached.statusText, headers });
}

/**
 * Die App selbst speichern: Startseite und alle Programmdateien (laut asset-list.json aus dem Build).
 * Läuft bei der Installation und bei jedem Auffrischen, damit nach einem Update nichts fehlt.
 */
async function cacheShell() {
  const shell = await caches.open(SHELL);
  const page = await fetch(BASE, { credentials: 'same-origin', cache: 'no-store' });
  if (!page.ok || page.redirected || !(page.headers.get('content-type') || '').includes('text/html')) return;
  await store(SHELL, BASE, page);
  await shell
    .addAll([`${BASE}manifest.webmanifest`, `${BASE}icons/icon-192.png`, `${BASE}icons/icon-512.png`])
    .catch(() => undefined);
  const list = await fetch(`${BASE}asset-list.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : []));
  const stat = await caches.open(STATIC);
  // Programmdateien alter Versionen entfernen
  if (list.length) {
    for (const req of await stat.keys()) {
      const p = new URL(req.url).pathname;
      if (rel(p).startsWith('/assets/') && !list.includes(p)) await stat.delete(req);
    }
  }
  const missing = [];
  for (const url of list) if (!(await stat.match(url))) missing.push(url);
  await Promise.all(
    missing.map((url) =>
      fetch(url)
        .then((r) => (r.ok ? stat.put(url, r) : undefined))
        .catch(() => undefined),
    ),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    cacheShell()
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function offlineJson(message) {
  return new Response(JSON.stringify({ error: message, offline: true }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-hexlens-offline': '0' },
  });
}

/** Netz zuerst (mit Zeitlimit), sonst gespeicherter Stand */
async function networkFirst(cacheName, request, timeout, onMissing) {
  if (Date.now() < offlineUntil) {
    const hit = await fromCache(cacheName, request);
    if (hit) return hit;
  }
  try {
    const res = await withTimeout(fetch(request, { cache: 'no-store' }), timeout);
    if (res.ok) {
      offlineUntil = 0;
      void store(cacheName, request, res);
    }
    return res;
  } catch {
    offlineUntil = Date.now() + OFFLINE_HOLD;
    return (await fromCache(cacheName, request)) || onMissing();
  }
}

async function handlePage(request) {
  if (Date.now() >= offlineUntil) {
    try {
      const res = await withTimeout(fetch(request), PAGE_TIMEOUT);
      // Nur die echte App-Seite merken – keine Weiterleitungen oder „nicht gekoppelt“-Seiten.
      // (Auf GitHub Pages kommen Unterseiten mit Status 404, aber mit der App als Inhalt.)
      const html = (res.headers.get('content-type') || '').includes('text/html');
      if (html && !res.redirected && (res.ok || CLOUD)) offlineUntil = 0;
      if (html && res.ok && !res.redirected && new URL(request.url).pathname === BASE) void store(SHELL, BASE, res);
      return res;
    } catch {
      offlineUntil = Date.now() + OFFLINE_HOLD;
    }
  }
  const shell = await fromCache(SHELL, BASE);
  return (
    shell ||
    new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#070b14;color:#eaf2ff;padding:24px"><h2>Hexlens</h2><p>Offline – und noch nichts gespeichert. Öffne Hexlens einmal mit Verbindung.</p></body>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
    )
  );
}

/** Bilder, Schriften und App-Dateien: haben feste Namen, also zuerst aus dem Speicher */
async function cacheFirst(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok || res.type === 'opaque') void cache.put(request, res.clone());
    return res;
  } catch {
    return new Response('', { status: 504 });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Champion-, Item- und Runenbilder direkt von Riot (Handy-Version)
  if (url.hostname === 'ddragon.leagueoflegends.com') {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  const path = rel(url.pathname);

  if (CLOUD && path === '/data.bin') {
    event.respondWith(networkFirst(SHELL, request, DATA_TIMEOUT, () => new Response('', { status: 503 })));
    return;
  }
  if (!CLOUD && path.startsWith('/api/')) {
    if (NO_CACHE.some((r) => r.test(path))) return;
    event.respondWith(
      networkFirst(API, request, API_TIMEOUT, () =>
        offlineJson('Offline: Diese Ansicht wurde noch nie im WLAN geöffnet. Öffne sie einmal, während Hexlens am PC läuft.'),
      ),
    );
    return;
  }
  if (request.mode === 'navigate') {
    // Kopplungs-Links und die Einrichtungsseite immer live laden
    if (url.searchParams.has('pair') || path === '/handy') return;
    event.respondWith(handlePage(request));
    return;
  }
  if (/^\/(assets|dd|ranks|icons)\//.test(path) || path === '/manifest.webmanifest' || path === '/favicon.svg') {
    event.respondWith(cacheFirst(request));
  }
});

/** Alle schon einmal geladenen Ansichten im Hintergrund auffrischen (wenn der PC erreichbar ist) */
async function refreshKnown() {
  try {
    await cacheShell();
  } catch {
    return; // nicht erreichbar
  }
  if (CLOUD) return;
  const cache = await caches.open(API);
  const keys = (await cache.keys()).slice(0, 250);
  let i = 0;
  const worker = async () => {
    while (i < keys.length) {
      const req = keys[i++];
      try {
        const res = await withTimeout(fetch(req), 8000);
        if (res.ok) await store(API, req, res);
      } catch {
        return; // PC nicht erreichbar – abbrechen
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

self.addEventListener('message', (event) => {
  if (event.data === 'refresh-known') event.waitUntil(refreshKnown());
});
