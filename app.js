/* =========================================================
   QIBLA COMPASS — STABLE ALIGNMENT MODE (Telegram WebApp)
   Logic:
   - Arrow is FIXED (points up).
   - Dial rotates by -heading (true north heading).
   - Kaaba marker is placed on dial at qibla azimuth (true north).
   - User rotates phone to align arrow with Kaaba marker.
   - When aligned (|heading - qiblaAzimuth| < threshold) -> show success.
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
const kaabaEl  = document.getElementById("kaaba"); // NEW marker

/* ================================
   CONSTANTS
================================ */
const KAABA_LAT = 21.422487;
const KAABA_LON = 39.826206;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// Update rate (lower is calmer in WebView)
const FRAME_MS = 66; // ~15 FPS

// Simple smoothing (enough because arrow is fixed)
const SMOOTH = 0.18;        // 0..1 (higher = more responsive)
const JITTER_DEG = 0.6;     // ignore tiny noise

// Posture thresholds
const FLAT_BETA_MAX  = 25;
const FLAT_GAMMA_MAX = 25;
const VERT_BETA_MIN  = 60;

// Align threshold
const ALIGN_DEG = 3.0;      // success window

// Declination cache granularity
const DECL_LATLON_GRID = 0.2;
const DECL_TTL_DAYS = 30;

/* ================================
   STATE
================================ */
let qiblaAzimuthTrue = null;
let rawHeadingTrue = null;
let smoothHeadingTrue = null;

let posture = "unknown";
let quality = 0;

let declinationDeg = null;
let declStatus = "pending";

let rafId = null;
let lastTs = 0;
let started = false;

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
  // shortest signed diff from a -> b in degrees (-180..180)
  return ((b - a + 540) % 360) - 180;
}

function smoothAngle(prev, next, smoothing, jitter) {
  const d = delta(prev, next);
  if (Math.abs(d) < jitter) return prev;
  return normalize(prev + d * smoothing);
}

function nowIsoDate() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
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

  let q;
  if (p === "flat") {
    q = 1.0;
  } else if (p === "tilted") {
    const db = clamp((ab - FLAT_BETA_MAX) / 45, 0, 1);
    const dg = clamp((ag - FLAT_GAMMA_MAX) / 45, 0, 1);
    q = 0.85 - 0.35 * Math.max(db, dg);
  } else {
    const dv = clamp((ab - VERT_BETA_MIN) / 30, 0, 1);
    q = 0.50 - 0.25 * dv;
  }

  return { posture: p, quality: clamp(q, 0, 1) };
}

/* ================================
   ORIENTATION — HEADING FROM EULER
================================ */
function headingFromEuler(alphaDeg, betaDeg, gammaDeg) {
  const alpha = alphaDeg * DEG2RAD;
  const beta  = betaDeg  * DEG2RAD;
  const gamma = gammaDeg * DEG2RAD;

  const cA = Math.cos(alpha), sA = Math.sin(alpha);
  const cB = Math.cos(beta),  sB = Math.sin(beta);
  const cG = Math.cos(gamma), sG = Math.sin(gamma);

  const rA = -cA * sG - sA * sB * cG;
  const rB = -sA * sG + cA * sB * cG;

  let headingRad = Math.atan2(rA, rB);

  headingRad += getScreenAngleDeg() * DEG2RAD;

  return normalize(headingRad * RAD2DEG);
}

/* ================================
   DECLINATION SERVICE (WMM)
================================ */
const DeclinationService = (() => {
  const LS_KEY = "qibla_decl_cache_v1";

  function roundGrid(x, step) {
    return Math.round(x / step) * step;
  }

  function cacheKey(lat, lon, dateIso) {
    const glat = roundGrid(lat, DECL_LATLON_GRID).toFixed(2);
    const glon = roundGrid(lon, DECL_LATLON_GRID).toFixed(2);
    const ym = dateIso.slice(0, 7);
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
    const altitudeKm = (altitudeMeters || 0) / 1000;

    const mod = await import("https://esm.sh/geomagnetism@0.2.0");
    const geomagnetism = mod?.default ?? mod;

    const model = geomagnetism.model(dateObj, { allowOutOfBoundsModel: true });
    const info = model.point([lat, lon, altitudeKm]);
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

    const decl = await computeDeclination(lat, lon, altitudeMeters, new Date(dateIso));
    if (!Number.isFinite(decl)) throw new Error("Declination not finite");

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
  // iOS: true heading
  if (typeof e.webkitCompassHeading === "number") {
    return {
      headingDeg: normalize(e.webkitCompassHeading),
      isTrueNorth: true,
      meta: { platform: "ios", absolute: true }
    };
  }

  // Android/WebView: Euler -> magnetic-like
  if (
    typeof e.alpha === "number" &&
    typeof e.beta  === "number" &&
    typeof e.gamma === "number"
  ) {
    const h = headingFromEuler(e.alpha, e.beta, e.gamma);
    const pq = evaluatePosture(e.beta, e.gamma);

    return {
      headingDeg: h,
      isTrueNorth: false,
      meta: {
        platform: "android",
        absolute: e.absolute === true,
        beta: e.beta,
        gamma: e.gamma,
        posture: pq.posture,
        quality: pq.quality
      }
    };
  }

  return null;
}

/* ================================
   UI HELPERS
================================ */
function setHintByPosture(p) {
  if (p === "vertical") {
    hintEl.textContent =
      "⚠ Телефон держится вертикально. Для точной кыблы положите телефон горизонтально (экран вверх).";
  } else if (p === "tilted") {
    hintEl.textContent =
      "ℹ Наклон влияет на точность. Держите телефон ближе к горизонтали.";
  } else {
    hintEl.textContent =
      "✔ Поверните телефон и совместите стрелку с меткой Каабы.";
  }
}

function updateStatusByAlignment(diffDeg) {
  if (!Number.isFinite(diffDeg)) return;

  if (diffDeg <= ALIGN_DEG) {
    statusEl.textContent = "🕋 Телефон направлен на Каабу";
  } else if (diffDeg <= 12) {
    statusEl.textContent = "✅ Почти! Ещё чуть-чуть поверните телефон";
  } else {
    statusEl.textContent = "🧭 Поверните телефон, чтобы совместить стрелку с Каабой";
  }
}

/* ================================
   RENDER LOOP
================================ */
function render(ts) {
  rafId = requestAnimationFrame(render);
  if (ts - lastTs < FRAME_MS) return;
  lastTs = ts;

  if (rawHeadingTrue == null) return;

  smoothHeadingTrue =
    smoothHeadingTrue == null
      ? rawHeadingTrue
      : smoothAngle(smoothHeadingTrue, rawHeadingTrue, SMOOTH, JITTER_DEG);

  hAzEl.textContent = smoothHeadingTrue.toFixed(1);

  // Dial rotates with heading (arrow is fixed)
  dialEl.style.transform = `rotate(${-smoothHeadingTrue}deg)`;

  if (qiblaAzimuthTrue != null) {
    const diff = Math.abs(delta(smoothHeadingTrue, qiblaAzimuthTrue));
    updateStatusByAlignment(diff);
  }
}

/* ================================
   START FLOW
================================ */
async function startAfterPermission() {
  if (started) return;
  started = true;

  // Arrow fixed (just to be explicit)
  arrowEl.style.transform = `translate(-50%, -92%) rotate(0deg)`;

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

  qiblaAzimuthTrue = vincentyBearing(lat, lon, KAABA_LAT, KAABA_LON);
  qAzEl.textContent = qiblaAzimuthTrue.toFixed(1);

  // Place Kaaba marker on the dial ONCE
  // Because dial rotates by -heading, Kaaba marker should be at +qiblaAzimuthTrue on dial
  if (kaabaEl) {
    kaabaEl.style.transform = `rotate(${qiblaAzimuthTrue}deg) translateY(-126px)`;
  }

  declinationDeg = null;
  declStatus = "pending";

  statusEl.textContent = "🧭 Датчики…";
  hintEl.textContent = "Поверните телефон и совместите стрелку с меткой Каабы.";

  const onOrientation = async (e) => {
    const res = extractHeadingAndMeta(e);
    if (!res) return;

    if (res.meta.platform === "android") {
      posture = res.meta.posture;
      quality = res.meta.quality;
      setHintByPosture(posture);
    } else {
      posture = "flat";
      quality = 1.0;
    }

    if (res.isTrueNorth) {
      rawHeadingTrue = res.headingDeg;
      declStatus = "ready";
      declinationDeg = 0;
      return;
    }

    // Android: heading is magnetic-like -> add declination
    if (declStatus === "pending") {
      declStatus = "loading";
      try {
        const { decl, source } = await DeclinationService.getDeclination(lat, lon, alt);
        declinationDeg = decl;
        declStatus = "ready";
        // keep status calm
        statusEl.textContent = source === "cache"
          ? "✅ Готово (WMM: кэш)"
          : "✅ Готово (WMM: рассчитано)";
      } catch (err) {
        declinationDeg = 0;
        declStatus = "unavailable";
        statusEl.textContent = "⚠ Не удалось загрузить WMM. Точность может снизиться.";
        console.warn("[WMM] declination unavailable:", err);
      }
    }

    const d = (declStatus === "ready" && Number.isFinite(declinationDeg)) ? declinationDeg : 0;
    rawHeadingTrue = normalize(res.headingDeg + d);
  };

  const hasAbsolute = "ondeviceorientationabsolute" in window;

  window.addEventListener(
    hasAbsolute ? "deviceorientationabsolute" : "deviceorientation",
    onOrientation,
    { capture: true }
  );

  if (hasAbsolute) {
    window.addEventListener("deviceorientation", onOrientation, { capture: true });
  }

  if (!rafId) rafId = requestAnimationFrame(render);
}

/* ================================
   BUTTON (Permissions)
================================ */
btnStart.addEventListener("click", () => {
  btnStart.disabled = true;

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
        started = false;
      });
    return;
  }

  startAfterPermission().catch(err => {
    console.error(err);
    statusEl.textContent = "❌ Ошибка запуска";
    btnStart.disabled = false;
    started = false;
  });
});
