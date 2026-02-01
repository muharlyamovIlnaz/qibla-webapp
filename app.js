/* =========================================================
   QIBLA COMPASS — PRO-GRADE (Telegram WebApp)
   - No trust in alpha
   - Heading from alpha/beta/gamma (+ screen orientation)
   - Posture detection (near-flat / vertical)
   - WMM declination compensation (true north)
   ========================================================= */

const tg = window.Telegram?.WebApp ?? null;

/* ================================
   DOM
================================ */
const statusEl = document.getElementById("status");
const hintEl   = document.getElementById("hint");
const btnStart = document.getElementById("btnStart");
const arrowEl  = document.getElementById("arrow");
const dialEl   = document.getElementById("dial");
const qAzEl    = document.getElementById("qAz");
const hAzEl    = document.getElementById("hAz");

/* ================================
   CONSTANTS
================================ */
const KAABA_LAT = 21.422487;
const KAABA_LON = 39.826206;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const FRAME_MS = 16;

// Smoothing is adaptive based on posture/quality
const BASE_SMOOTH = 0.12;
const BASE_JITTER = 0.25;

// Posture thresholds
const FLAT_BETA_MAX  = 25; // degrees: screen-up near-flat => beta ~ 0
const FLAT_GAMMA_MAX = 25;
const VERT_BETA_MIN  = 60; // vertical-ish => |beta| >= 60

// Declination cache granularity
const DECL_LATLON_GRID = 0.2;  // degrees
const DECL_TTL_DAYS = 30;

/* ================================
   STATE
================================ */
let qiblaAzimuthTrue = null;     // true-north bearing to Kaaba
let rawHeadingTrue = null;       // true-north device heading
let smoothHeadingTrue = null;

let lastEuler = null;            // {alpha,beta,gamma,absolute}
let posture = "unknown";         // "flat" | "vertical" | "tilted"
let quality = 0;                 // 0..1

let declinationDeg = null;       // magnetic -> true correction (+east)
let declStatus = "pending";      // "pending" | "ready" | "unavailable"

let rafId = null;
let lastTs = 0;

/* ================================
   MATH UTILS
================================ */
function normalize(deg) {
  deg %= 360;
  return deg < 0 ? deg + 360 : deg;
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function delta(a, b) {
  return ((b - a + 540) % 360) - 180;
}

function smoothAngle(prev, next, smoothing, jitter) {
  const d = delta(prev, next);
  if (Math.abs(d) < jitter) return prev;
  return normalize(prev + d * smoothing);
}

function nowIsoDate() {
  // Declination doesn't change fast; day precision ok
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/* ================================
   GEO — VINCENTY (initial bearing)
================================ */
function vincentyBearing(lat1, lon1, lat2, lon2) {
  const f = 1 / 298.257223563;

  const φ1 = lat1 * DEG2RAD;
  const φ2 = lat2 * DEG2RAD;
  const L = (lon2 - lon1) * DEG2RAD;

  const U1 = Math.atan((1 - f) * Math.tan(φ1));
  const U2 = Math.atan((1 - f) * Math.tan(φ2));

  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

  let λ = L, λp;
  let iter = 0;

  do {
    const sinλ = Math.sin(λ);
    const cosλ = Math.cos(λ);

    const sinσ = Math.sqrt(
      (cosU2 * sinλ) ** 2 +
      (cosU1 * sinU2 - sinU1 * cosU2 * cosλ) ** 2
    );
    if (!sinσ) return 0;

    const cosσ = sinU1 * sinU2 + cosU1 * cosU2 * cosλ;
    const σ = Math.atan2(sinσ, cosσ);

    const sinα = (cosU1 * cosU2 * sinλ) / sinσ;
    const cos2α = 1 - sinα ** 2;

    const cos2σm = cos2α ? (cosσ - (2 * sinU1 * sinU2) / cos2α) : 0;

    const C = (f / 16) * cos2α * (4 + f * (4 - 3 * cos2α));
    λp = λ;
    λ = L + (1 - C) * f * sinα *
      (σ + C * sinσ * (cos2σm + C * cosσ * (-1 + 2 * cos2σm ** 2)));
  } while (Math.abs(λ - λp) > 1e-12 && ++iter < 100);

  const α1 = Math.atan2(
    cosU2 * Math.sin(λ),
    cosU1 * sinU2 - sinU1 * cosU2 * Math.cos(λ)
  );

  return normalize(α1 * RAD2DEG);
}

/* ================================
   SCREEN ORIENTATION
================================ */
function getScreenAngleDeg() {
  const a =
    (screen.orientation && typeof screen.orientation.angle === "number")
      ? screen.orientation.angle
      : (typeof window.orientation === "number" ? window.orientation : 0);
  return a || 0;
}

/* ================================
   POSTURE + QUALITY
   - flat: best for compass in web
   - vertical: often unstable in WebView
================================ */
function evaluatePosture(beta, gamma) {
  const ab = Math.abs(beta);
  const ag = Math.abs(gamma);

  const isFlat = (ab <= FLAT_BETA_MAX && ag <= FLAT_GAMMA_MAX);
  const isVertical = (ab >= VERT_BETA_MIN);

  let p;
  if (isFlat) p = "flat";
  else if (isVertical) p = "vertical";
  else p = "tilted";

  // Quality model:
  // flat -> 1.0
  // tilted -> 0.5..0.8 depending on closeness to flat
  // vertical -> 0.25..0.5 depending on how extreme tilt is
  let q;
  if (p === "flat") {
    q = 1.0;
  } else if (p === "tilted") {
    // degrade with distance from flat thresholds
    const db = clamp((ab - FLAT_BETA_MAX) / 45, 0, 1);
    const dg = clamp((ag - FLAT_GAMMA_MAX) / 45, 0, 1);
    q = 0.85 - 0.35 * Math.max(db, dg); // 0.5..0.85
  } else {
    // vertical: compass is often less reliable in WebView
    const dv = clamp((ab - VERT_BETA_MIN) / 30, 0, 1);
    q = 0.50 - 0.25 * dv; // 0.25..0.50
  }

  return { posture: p, quality: clamp(q, 0, 1) };
}

/* ================================
   ORIENTATION — PROFESSIONAL HEADING
   headingFromEuler:
   - Compute azimuth from rotation matrix components
   - Apply screen orientation compensation
   Output is "magnetic-like" in most Android WebViews, "true" on iOS webkitCompassHeading.
================================ */
function headingFromEuler(alphaDeg, betaDeg, gammaDeg) {
  const alpha = alphaDeg * DEG2RAD;
  const beta  = betaDeg  * DEG2RAD;
  const gamma = gammaDeg * DEG2RAD;

  const cA = Math.cos(alpha), sA = Math.sin(alpha);
  const cB = Math.cos(beta),  sB = Math.sin(beta);
  const cG = Math.cos(gamma), sG = Math.sin(gamma);

  // Standard derivation used in robust web compass implementations:
  // https://w3c.github.io/deviceorientation/ (conceptually) + common compassHeading snippets
  const rA = -cA * sG - sA * sB * cG;
  const rB = -sA * sG + cA * sB * cG;

  let headingRad = Math.atan2(rA, rB);

  // screen rotation compensation
  headingRad += getScreenAngleDeg() * DEG2RAD;

  return normalize(headingRad * RAD2DEG);
}

/* ================================
   DECLINATION SERVICE (WMM)
   Goal: magnetic heading -> true heading
   Approach:
   - Prefer local cached declination
   - Load WMM library via ESM CDN (no build tools)
   - Cache results in localStorage

   Why CDN import:
   - NOAA/NCEI API programmatic access often requires registration
   - Embedding full WMM coefficients manually is bulky
   - This gives professional-grade declination using NOAA WMM logic
================================ */
const DeclinationService = (() => {
  const LS_KEY = "qibla_decl_cache_v1";

  function roundGrid(x, step) {
    return Math.round(x / step) * step;
  }

  function cacheKey(lat, lon, dateIso) {
    const glat = roundGrid(lat, DECL_LATLON_GRID).toFixed(2);
    const glon = roundGrid(lon, DECL_LATLON_GRID).toFixed(2);
    const ym = dateIso.slice(0, 7); // YYYY-MM
    return `${glat},${glon},${ym}`;
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveCache(obj) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(obj));
    } catch {
      // ignore
    }
  }

  function isFresh(tsMs) {
    const ageDays = (Date.now() - tsMs) / (1000 * 60 * 60 * 24);
    return ageDays <= DECL_TTL_DAYS;
  }

  async function computeDeclination(lat, lon, altitudeMeters, dateObj) {
    // Use ESM shim that can import commonjs packages.
    // If this fails in some WebViews, we gracefully fallback.
    // Note: altitude for WMM is in kilometers above MSL in this library.
    const altitudeKm = (altitudeMeters || 0) / 1000;

    // Try esm.sh first (it typically works well in WebViews)
    const mod = await import("https://esm.sh/geomagnetism@0.2.0");
    const geomagnetism = mod?.default ?? mod;

    const model = geomagnetism.model(dateObj, { allowOutOfBoundsModel: true });
    const info = model.point([lat, lon, altitudeKm]);
    // info.decl: positive if magnetic north is east of true north
    return Number(info.decl);
  }

  async function getDeclination(lat, lon, altitudeMeters) {
    const dateIso = nowIsoDate();
    const key = cacheKey(lat, lon, dateIso);

    const cache = loadCache();
    const cached = cache[key];
    if (cached && typeof cached.decl === "number" && isFresh(cached.ts)) {
      return { decl: cached.decl, source: "cache" };
    }

    // Compute fresh
    const decl = await computeDeclination(lat, lon, altitudeMeters, new Date(dateIso));
    if (!Number.isFinite(decl)) {
      throw new Error("Declination is not finite");
    }

    cache[key] = { decl, ts: Date.now() };
    saveCache(cache);

    return { decl, source: "wmm" };
  }

  return { getDeclination };
})();

/* ================================
   HEADING EXTRACTION (Unified)
================================ */
function extractHeadingAndMeta(e) {
  // 🍎 iOS: webkitCompassHeading is already TRUE heading (not magnetic)
  if (typeof e.webkitCompassHeading === "number") {
    return {
      headingDeg: normalize(e.webkitCompassHeading),
      isTrueNorth: true,
      meta: { platform: "ios", absolute: true }
    };
  }

  // 🤖 Android/WebView: compute from Euler (magnetic-like)
  if (
    typeof e.alpha === "number" &&
    typeof e.beta  === "number" &&
    typeof e.gamma === "number"
  ) {
    const h = headingFromEuler(e.alpha, e.beta, e.gamma);
    const { posture: p, quality: q } = evaluatePosture(e.beta, e.gamma);

    return {
      headingDeg: h,
      isTrueNorth: false,
      meta: { platform: "android", absolute: e.absolute === true, beta: e.beta, gamma: e.gamma, posture: p, quality: q }
    };
  }

  return null;
}

/* ================================
   RENDER
================================ */
function render(ts) {
  rafId = requestAnimationFrame(render);
  if (ts - lastTs < FRAME_MS) return;
  lastTs = ts;

  if (rawHeadingTrue == null) return;

  // Adaptive smoothing:
  // - better quality -> more responsive
  // - worse quality -> more smoothing and more jitter deadzone
  const q = quality || 0;
  const smoothing = clamp(BASE_SMOOTH + (1 - q) * 0.18, 0.08, 0.30);
  const jitter = clamp(BASE_JITTER + (1 - q) * 1.2, 0.25, 2.0);

  smoothHeadingTrue =
    smoothHeadingTrue == null
      ? rawHeadingTrue
      : smoothAngle(smoothHeadingTrue, rawHeadingTrue, smoothing, jitter);

  hAzEl.textContent = smoothHeadingTrue.toFixed(1);
  dialEl.style.transform = `rotate(${-smoothHeadingTrue}deg)`;

  if (qiblaAzimuthTrue != null) {
    // Relative angle between where the device points (true) and Kaaba (true)
    const rel = normalize(qiblaAzimuthTrue - smoothHeadingTrue);
    arrowEl.style.transform = `translate(-50%, -92%) rotate(${rel}deg)`;
  }
}

/* ================================
   START FLOW
================================ */
async function startAfterPermission() {
  statusEl.textContent = "📍 Получаем координаты…";

  const pos = await new Promise((res, rej) =>
    navigator.geolocation.getCurrentPosition(res, rej, {
      enableHighAccuracy: true,
      timeout: 15000
    })
  );

  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const alt = pos.coords.altitude || 0;

  // Qibla bearing is TRUE-NORTH by definition (geodesic azimuth)
  qiblaAzimuthTrue = vincentyBearing(lat, lon, KAABA_LAT, KAABA_LON);
  qAzEl.textContent = qiblaAzimuthTrue.toFixed(1);

  // Declination fetch (only needed for Android/WebView path)
  // We'll load it lazily after first sensor event determines platform.
  declinationDeg = null;
  declStatus = "pending";

  statusEl.textContent = "🧭 Датчики… держите телефон ровно";
  hintEl.textContent = "Держите телефон горизонтально (экран вверх) для максимальной точности.";

  const onOrientation = async (e) => {
    lastEuler = e;

    const res = extractHeadingAndMeta(e);
    if (!res) return;

    // posture/quality tracking (only for android path)
    if (res.meta.platform === "android") {
      posture = res.meta.posture;
      quality = res.meta.quality;

      // UX hint (auto-detect vertical)
      if (posture === "vertical") {
        hintEl.textContent =
          "⚠ Телефон держится вертикально. Для точной кыблы положите телефон горизонтально (экран вверх).";
      } else if (posture === "tilted") {
        hintEl.textContent =
          "ℹ Наклон влияет на точность. Постарайтесь держать телефон ближе к горизонтали.";
      } else {
        hintEl.textContent =
          "✔ Отлично. Горизонтальное положение даёт максимальную точность.";
      }
    } else {
      posture = "flat";
      quality = 1.0;
    }

    // Compute true heading
    if (res.isTrueNorth) {
      // iOS: already true
      rawHeadingTrue = res.headingDeg;
      declStatus = "ready";
      declinationDeg = 0;
    } else {
      // Android: res.headingDeg is magnetic-like => add WMM declination
      if (declStatus === "pending") {
        // Kick declination retrieval once
        declStatus = "loading";
        try {
          const { decl, source } = await DeclinationService.getDeclination(lat, lon, alt);
          declinationDeg = decl;
          declStatus = "ready";

          // Keep status calm; no user action needed
          statusEl.textContent = source === "cache"
            ? "✅ Готово (WMM: кэш)"
            : "✅ Готово (WMM: рассчитано)";
        } catch (err) {
          // If declination unavailable, we still run, but accuracy can be off by local declination.
          declinationDeg = 0;
          declStatus = "unavailable";
          statusEl.textContent = "⚠ Не удалось загрузить WMM. Точность может снизиться.";
          // keep app working
          console.warn("[WMM] declination unavailable:", err);
        }
      }

      const d = (declStatus === "ready" && Number.isFinite(declinationDeg)) ? declinationDeg : 0;

      // True heading = magnetic heading + declination (east-positive)
      rawHeadingTrue = normalize(res.headingDeg + d);
    }

    // If we are already rendering, nothing else to do
  };

  const hasAbsolute = "ondeviceorientationabsolute" in window;

  // Prefer absolute if present (some browsers provide better stability)
  window.addEventListener(
    hasAbsolute ? "deviceorientationabsolute" : "deviceorientation",
    onOrientation,
    { capture: true }
  );
  // Also listen to the other one if available — Telegram WebView can be inconsistent
  if (hasAbsolute) {
    window.addEventListener("deviceorientation", onOrientation, { capture: true });
  }

  // Start rendering loop
  if (!rafId) rafId = requestAnimationFrame(render);
  statusEl.textContent = "✅ Готово";
}

/* ================================
   BUTTON (Permissions)
================================ */
btnStart.addEventListener("click", () => {
  btnStart.disabled = true;

  // 🍎 iOS strict permission flow
  if (
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function"
  ) {
    DeviceOrientationEvent.requestPermission()
      .then(p => {
        if (p !== "granted") throw new Error("Denied");
        return startAfterPermission();
      })
      .catch(() => {
        statusEl.textContent = "❌ Нет доступа к датчикам";
        btnStart.disabled = false;
      });
    return;
  }

  // 🤖 Android flow
  startAfterPermission().catch(err => {
    console.error(err);
    statusEl.textContent = "❌ Ошибка запуска";
    btnStart.disabled = false;
  });
});
