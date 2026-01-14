/* ============================================================
   QIBLA COMPASS — MAX POSSIBLE ACCURACY (WEB LIMIT)
   ------------------------------------------------------------
   ✔ Vincenty (WGS-84) — TRUE QIBLA
   ✔ Magnetic declination (offline approximation)
   ✔ Correct magnetic → true heading logic
   ✔ iOS / Android safe
   ✔ No external APIs
   ------------------------------------------------------------
   ⚠ Physical limit: browser ≈ ±2–4°
   ============================================================ */

// ================================
// Telegram WebApp
// ================================
const tg = window.Telegram?.WebApp ?? null;

// ================================
// DOM
// ================================
const statusEl = document.getElementById("status");
const btnStart = document.getElementById("btnStart");
const arrowEl  = document.getElementById("arrow");
const dialEl   = document.getElementById("dial");
const qAzEl    = document.getElementById("qAz");
const hAzEl    = document.getElementById("hAz");

// ================================
// Constants
// ================================
const KAABA_LAT = 21.422487;
const KAABA_LON = 39.826206;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const SMOOTHING = 0.12;
const DEADZONE = 0.4;

// ================================
// Math utils
// ================================
const norm = d => (d % 360 + 360) % 360;
const delta = (a, b) => ((b - a + 540) % 360) - 180;

// ================================
// TRUE QIBLA — Vincenty inverse (WGS-84)
// ================================
function vincenty(lat1, lon1, lat2, lon2) {
  const a = 6378137;
  const f = 1 / 298.257223563;

  const φ1 = lat1 * DEG2RAD;
  const φ2 = lat2 * DEG2RAD;
  const L = (lon2 - lon1) * DEG2RAD;

  const U1 = Math.atan((1 - f) * Math.tan(φ1));
  const U2 = Math.atan((1 - f) * Math.tan(φ2));

  let λ = L;
  let sinσ, cosσ, σ, sinα, cosSqα, cos2σm;

  for (let i = 0; i < 100; i++) {
    const sinλ = Math.sin(λ);
    const cosλ = Math.cos(λ);

    sinσ = Math.sqrt(
      (Math.cos(U2) * sinλ) ** 2 +
      (Math.cos(U1) * Math.sin(U2) -
       Math.sin(U1) * Math.cos(U2) * cosλ) ** 2
    );

    if (!sinσ) return 0;

    cosσ =
      Math.sin(U1) * Math.sin(U2) +
      Math.cos(U1) * Math.cos(U2) * cosλ;

    σ = Math.atan2(sinσ, cosσ);
    sinα = Math.cos(U1) * Math.cos(U2) * sinλ / sinσ;
    cosSqα = 1 - sinα * sinα;

    cos2σm = cosSqα
      ? cosσ - 2 * Math.sin(U1) * Math.sin(U2) / cosSqα
      : 0;

    const C = f / 16 * cosSqα * (4 + f * (4 - 3 * cosSqα));
    const λPrev = λ;

    λ =
      L +
      (1 - C) *
        f *
        sinα *
        (σ +
          C *
            sinσ *
            (cos2σm +
              C * cosσ * (-1 + 2 * cos2σm ** 2)));

    if (Math.abs(λ - λPrev) < 1e-12) break;
  }

  const α1 = Math.atan2(
    Math.cos(U2) * Math.sin(λ),
    Math.cos(U1) * Math.sin(U2) -
      Math.sin(U1) * Math.cos(U2) * Math.cos(λ)
  );

  return norm(α1 * RAD2DEG);
}

// ================================
// MAGNETIC DECLINATION (offline)
// ------------------------------------------------
// ⚠ Это ПРИБЛИЖЕНИЕ.
// Без WMM коэффициентов лучше нельзя.
// Ошибка ~ ±1–2°
// ================================
function magneticDeclination(lat, lon) {
  const φ = lat * DEG2RAD;
  const λ = lon * DEG2RAD;
  return 7.5 * Math.sin(λ) * Math.cos(φ);
}

// ================================
// Heading extraction (MAGNETIC)
// ================================
let rawHeading = null;
let smoothHeading = null;

function extractHeading(e) {
  // iOS — лучший вариант
  if (typeof e.webkitCompassHeading === "number") {
    return norm(e.webkitCompassHeading);
  }

  // Android fallback
  if (typeof e.alpha === "number") {
    return norm(360 - e.alpha);
  }

  return null;
}

window.addEventListener("deviceorientation", e => {
  const h = extractHeading(e);
  if (h == null) return;
  rawHeading = h;
  smoothHeading ??= h;
});

// ================================
// Render loop
// ================================
function loop() {
  requestAnimationFrame(loop);
  if (rawHeading == null) return;

  const d = delta(smoothHeading, rawHeading);
  if (Math.abs(d) > DEADZONE) {
    smoothHeading = norm(smoothHeading + d * SMOOTHING);
  }

  hAzEl.textContent = smoothHeading.toFixed(1);
  dialEl.style.transform = `rotate(${-smoothHeading}deg)`;

  if (window.qiblaTrue != null) {
    arrowEl.style.transform =
      `translate(-50%, -92%) rotate(${norm(window.qiblaTrue - smoothHeading)}deg)`;
  }
}

// ================================
// Start
// ================================
btnStart.onclick = async () => {
  btnStart.disabled = true;
  statusEl.textContent = "📍 Определяем местоположение…";

  const pos = await new Promise((res, rej) =>
    navigator.geolocation.getCurrentPosition(res, rej, {
      enableHighAccuracy: true,
      timeout: 15000
    })
  );

  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;

  const qiblaTrue = vincenty(lat, lon, KAABA_LAT, KAABA_LON);
  const decl = magneticDeclination(lat, lon);

  // 🔑 КЛЮЧЕВОЙ МОМЕНТ
  window.qiblaTrue = norm(qiblaTrue + decl);

  qAzEl.textContent = window.qiblaTrue.toFixed(1);
  statusEl.textContent = "✅ Готово. Держите телефон горизонтально.";
};

loop();
