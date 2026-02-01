/* =========================================================
   QIBLA COMPASS — DUAL FLOW (iOS / ANDROID SAFE)
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

const SMOOTHING = 0.12;
const JITTER = 0.25;
const FRAME_MS = 16;

/* ================================
   STATE
================================ */
let qiblaAzimuth = null;
let rawHeading = null;
let smoothHeading = null;
let rafId = null;
let lastTs = 0;

/* ================================
   UTILS
================================ */
function normalize(deg) {
  deg %= 360;
  return deg < 0 ? deg + 360 : deg;
}

function delta(a, b) {
  return ((b - a + 540) % 360) - 180;
}

function smooth(prev, next) {
  const d = delta(prev, next);
  if (Math.abs(d) < JITTER) return prev;
  return normalize(prev + d * SMOOTHING);
}

/* ================================
   VINCENTY — TRUE AZIMUTH
================================ */
function vincenty(lat1, lon1, lat2, lon2) {
  const a = 6378137;
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

    const sinα = cosU1 * cosU2 * sinλ / sinσ;
    const cos2α = 1 - sinα ** 2;

    const cos2σm = cos2α
      ? cosσ - 2 * sinU1 * sinU2 / cos2α
      : 0;

    const C = f / 16 * cos2α * (4 + f * (4 - 3 * cos2α));
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
   HEADING EXTRACTION
================================ */
function extractHeading(e) {

  // 🍎 iOS — TRUE NORTH
  if (typeof e.webkitCompassHeading === "number") {
    hintEl.textContent = "✔ Истинный север (iOS)";
    return normalize(e.webkitCompassHeading);
  }

  // 🤖 Android — deviceorientation (ALREADY CLOCKWISE FROM NORTH)
  if (typeof e.alpha === "number") {
    hintEl.textContent =
      "⚠ Магнитный север (Android). Возможна локальная погрешность.";
    return normalize(e.alpha);
  }

  return null;
}


/* ================================
   RENDER LOOP
================================ */
function render(ts) {
  rafId = requestAnimationFrame(render);
  if (ts - lastTs < FRAME_MS) return;
  lastTs = ts;

  if (rawHeading == null) return;

  smoothHeading =
    smoothHeading == null
      ? rawHeading
      : smooth(smoothHeading, rawHeading);

  hAzEl.textContent = smoothHeading.toFixed(1);
  dialEl.style.transform = `rotate(${-smoothHeading}deg)`;

  if (qiblaAzimuth != null) {
    const a = normalize(qiblaAzimuth - smoothHeading);
    arrowEl.style.transform =
      `translate(-50%, -92%) rotate(${a}deg)`;
  }
}

/* ================================
   START AFTER PERMISSION
================================ */
async function startAfterPermission() {
  statusEl.textContent = "📍 Получаем координаты…";

  const pos = await new Promise((res, rej) =>
    navigator.geolocation.getCurrentPosition(res, rej, {
      enableHighAccuracy: true, timeout: 15000
    })
  );

  qiblaAzimuth = vincenty(
    pos.coords.latitude,
    pos.coords.longitude,
    KAABA_LAT,
    KAABA_LON
  );

  qAzEl.textContent = qiblaAzimuth.toFixed(1);
  statusEl.textContent = "🧭 Калибруйте компас…";

  window.addEventListener("deviceorientation", e => {
    const h = extractHeading(e);
    if (h != null) rawHeading = h;
  }, true);

  rafId = requestAnimationFrame(render);
  statusEl.textContent = "✅ Готово";
}

/* ================================
   BUTTON — DUAL FLOW
================================ */
btnStart.addEventListener("click", () => {

  btnStart.disabled = true;

  // 🍎 iOS STRICT FLOW
  if (
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function"
  ) {
    try {
      DeviceOrientationEvent.requestPermission()
        .then(p => {
          if (p !== "granted") {
            throw new Error("Нет доступа к датчикам");
          }
          startAfterPermission();
        })
        .catch(err => {
          statusEl.textContent = "❌ Нет доступа к датчикам";
          btnStart.disabled = false;
          console.error(err);
        });
    } catch (e) {
      statusEl.textContent = "❌ Ошибка доступа к датчикам";
      btnStart.disabled = false;
    }
    return;
  }

  // 🤖 ANDROID FLOW
  startAfterPermission();
});
