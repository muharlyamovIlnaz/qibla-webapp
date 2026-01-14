// ================================
// Telegram WebApp
// ================================
const tg = window.Telegram?.WebApp ?? null;

// ================================
// Safe send to bot (analytics/debug)
// ================================
function sendToBot(payload) {
  if (!tg || typeof tg.sendData !== "function") return;
  try { tg.sendData(JSON.stringify(payload)); } catch (_) {}
}

// ================================
// DOM
// ================================
const statusEl = document.getElementById("status");
const hintEl   = document.getElementById("hint");
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

// Smoothing (lower = smoother but slower)
const SMOOTHING = 0.10;

// Deadzone for micro-jitter
const JITTER_DEADZONE_DEG = 0.35;

// Render limit (ms)
const MIN_FRAME_MS = 16;

// ================================
// State
// ================================
let qiblaAzimuth = null;

let rawHeading = null;
let smoothHeading = null;

let rafId = null;
let lastTs = 0;
let listening = false;

// ================================
// Utils
// ================================
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function setStatus(t) {
  statusEl.textContent = t;
}

function normalizeAngle(deg) {
  let x = deg % 360;
  return x < 0 ? x + 360 : x;
}

// shortest delta in degrees [-180..180]
function shortestDeltaDeg(from, to) {
  return ((to - from + 540) % 360) - 180;
}

// smooth angle along shortest arc + deadzone
function smoothAngle(prev, next, factor) {
  const d = shortestDeltaDeg(prev, next);
  if (Math.abs(d) < JITTER_DEADZONE_DEG) return prev;
  return normalizeAngle(prev + d * factor);
}

function getScreenOrientationDeg() {
  // modern browsers
  const a = (screen.orientation && typeof screen.orientation.angle === "number")
    ? screen.orientation.angle
    : (typeof window.orientation === "number" ? window.orientation : 0);

  // normalize to {0,90,180,270}
  return ((a % 360) + 360) % 360;
}

// ================================
// Qibla azimuth (WGS-84 Vincenty inverse) — more accurate than spherical
// Returns initial bearing from point1(lat,lon) to Kaaba(lat2,lon2).
// ================================
function vincentyInitialBearing(lat1, lon1, lat2, lon2) {
  // WGS-84 ellipsoid
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const b = (1 - f) * a;

  const φ1 = lat1 * DEG2RAD;
  const φ2 = lat2 * DEG2RAD;
  const L  = (lon2 - lon1) * DEG2RAD;

  const U1 = Math.atan((1 - f) * Math.tan(φ1));
  const U2 = Math.atan((1 - f) * Math.tan(φ2));

  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

  let λ = L;
  let λPrev;
  let iter = 0;

  let sinλ, cosλ, sinσ, cosσ, σ, sinα, cosSqα, cos2σm, C;

  // Iterate until change is tiny
  do {
    sinλ = Math.sin(λ);
    cosλ = Math.cos(λ);

    const t1 = cosU2 * sinλ;
    const t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosλ;

    sinσ = Math.sqrt(t1 * t1 + t2 * t2);
    if (sinσ === 0) return 0; // coincident points

    cosσ = sinU1 * sinU2 + cosU1 * cosU2 * cosλ;
    σ = Math.atan2(sinσ, cosσ);

    sinα = (cosU1 * cosU2 * sinλ) / sinσ;
    cosSqα = 1 - sinα * sinα;

    // cos2σm can be undefined for equatorial line
    cos2σm = (cosSqα !== 0)
      ? (cosσ - (2 * sinU1 * sinU2) / cosSqα)
      : 0;

    C = (f / 16) * cosSqα * (4 + f * (4 - 3 * cosSqα));

    λPrev = λ;
    λ = L + (1 - C) * f * sinα * (
      σ + C * sinσ * (
        cos2σm + C * cosσ * (-1 + 2 * cos2σm * cos2σm)
      )
    );

    iter++;
    if (iter > 100) break; // fail-safe
  } while (Math.abs(λ - λPrev) > 1e-12);

  // Initial bearing
  const α1 = Math.atan2(
    cosU2 * sinλ,
    cosU1 * sinU2 - sinU1 * cosU2 * cosλ
  );

  return normalizeAngle(α1 * RAD2DEG);
}

// Wrapper for qibla
function calculateQiblaAzimuth(lat, lon) {
  return vincentyInitialBearing(lat, lon, KAABA_LAT, KAABA_LON);
}

// ================================
// Permissions (iOS)
// ================================
async function requestSensorsPermissionIfNeeded() {
  if (typeof DeviceOrientationEvent === "undefined") {
    throw new Error("Датчики ориентации не поддерживаются");
  }

  // iOS 13+ explicit permission
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    const res = await DeviceOrientationEvent.requestPermission();
    if (res !== "granted") {
      throw new Error("Нет доступа к датчикам");
    }
  }
}

// ================================
// Geolocation
// ================================
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation не поддерживается"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });
  });
}

// ================================
// Heading (compass) — robust
// Priority:
// 1) iOS webkitCompassHeading (best)
// 2) Compute compass heading from alpha/beta/gamma (MDN-like) + screen orientation
// ================================
function extractHeadingDeg(e) {
  // 1) iOS Safari: true compass heading (best)
  if (typeof e.webkitCompassHeading === "number") {
    return normalizeAngle(e.webkitCompassHeading);
  }

  // 2) If we have alpha/beta/gamma, compute compass heading
  // This is more correct than naive "360 - alpha", because it uses full 3D orientation.
  if (typeof e.alpha === "number" && typeof e.beta === "number" && typeof e.gamma === "number") {
    const alpha = e.alpha * DEG2RAD;
    const beta  = e.beta  * DEG2RAD;
    const gamma = e.gamma * DEG2RAD;

    const cA = Math.cos(alpha), sA = Math.sin(alpha);
    const cB = Math.cos(beta),  sB = Math.sin(beta);
    const cG = Math.cos(gamma), sG = Math.sin(gamma);

    // Rotation matrix components (Z-X'-Y'' intrinsic)
    // These formulas are commonly used to derive compass heading from DeviceOrientation angles.
    const r00 = cA * cG - sA * sB * sG;
    const r01 = -cB * sA;
    const r02 = cA * sG + cG * sA * sB;

    const r10 = cG * sA + cA * sB * sG;
    const r11 = cA * cB;
    const r12 = sA * sG - cA * cG * sB;

    // Heading (azimuth) from matrix
    // Different devices can flip signs; this variant is stable for most Android Chrome cases.
    let heading = Math.atan2(r01, r11) * RAD2DEG;
    heading = normalizeAngle(heading);

    // Compensate screen rotation
    const screenRot = getScreenOrientationDeg();
    heading = normalizeAngle(heading + screenRot);

    return heading;
  }

  // 3) Fallback: alpha only (least reliable)
  if (typeof e.alpha === "number") {
    const h = normalizeAngle(360 - e.alpha);
    const screenRot = getScreenOrientationDeg();
    return normalizeAngle(h + screenRot);
  }

  return null;
}

function onOrientation(e) {
  const h = extractHeadingDeg(e);
  if (h == null) return;

  rawHeading = h;
  if (smoothHeading == null) smoothHeading = h;
}

// ================================
// Render loop
// ================================
function render(ts) {
  rafId = requestAnimationFrame(render);

  if (ts - lastTs < MIN_FRAME_MS) return;
  lastTs = ts;

  if (rawHeading == null) return;

  if (smoothHeading == null) {
    smoothHeading = rawHeading;
  } else {
    smoothHeading = smoothAngle(smoothHeading, rawHeading, SMOOTHING);
  }

  // show heading
  hAzEl.textContent = smoothHeading.toFixed(1);

  // dial rotates by -heading so N/E/S/W align with real world
  dialEl.style.transform = `rotate(${-smoothHeading}deg)`;

  // arrow points to qibla relative to device
  if (qiblaAzimuth != null) {
    const arrowAngle = normalizeAngle(qiblaAzimuth - smoothHeading);
    arrowEl.style.transform = `translate(-50%, -92%) rotate(${arrowAngle}deg)`;
  }
}

// ================================
// Start/Stop
// ================================
function startSensors() {
  if (listening) return;
  listening = true;

  // Some Androids fire only one of these; subscribe to both.
  window.addEventListener("deviceorientationabsolute", onOrientation, true);
  window.addEventListener("deviceorientation", onOrientation, true);

  if (!rafId) rafId = requestAnimationFrame(render);
}

function resetState() {
  rawHeading = null;
  smoothHeading = null;
}

// ================================
// Main button
// ================================
btnStart.addEventListener("click", async () => {
  try {
    tg?.expand();
    tg?.ready();

    sendToBot({ event: "qibla_start_clicked", ts: Date.now() });

    btnStart.disabled = true;
    setStatus("🔐 Запрашиваем доступ к датчикам…");
    await requestSensorsPermissionIfNeeded();

    setStatus("📍 Получаем геолокацию…");
    const pos = await getLocation();

    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;

    setStatus("🧭 Вычисляем направление Кыблы…");
    // High-accuracy WGS-84 ellipsoid bearing
    qiblaAzimuth = calculateQiblaAzimuth(lat, lon);
    qAzEl.textContent = qiblaAzimuth.toFixed(1);

    resetState();
    startSensors();

    setStatus("✅ Готово.");

    sendToBot({
      event: "qibla_compass_started",
      qiblaAzimuth: qiblaAzimuth,
      lat: lat,
      lon: lon,
      ts: Date.now()
    });

  } catch (e) {
    console.error(e);

    sendToBot({
      event: "qibla_error",
      message: e?.message || String(e),
      ts: Date.now()
    });

    setStatus("❌ Ошибка: " + (e?.message || e));
    btnStart.disabled = false;
  }
});

// ================================
// Auto-ready for Telegram
// ================================
if (tg) {
  try {
    tg.ready();
    sendToBot({ event: "qibla_webapp_opened", version: "compass_v2_vincenty", ts: Date.now() });
  } catch (_) {}
}
