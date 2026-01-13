// ================================
// Telegram WebApp
// ================================
const tg = window.Telegram?.WebApp ?? null;

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

// Сглаживание (меньше = плавнее, но медленнее реакция)
const SMOOTHING = 0.10;

// Мёртвая зона от микродрожи компаса
const JITTER_DEADZONE_DEG = 0.35;

// Ограничение частоты рендера (мс)
const MIN_FRAME_MS = 16;

// ================================
// State
// ================================
let qiblaAzimuth = null;

let rawHeading = null;     // последние сырые показания компаса
let smoothHeading = null;  // сглаженные

let rafId = null;
let lastTs = 0;

let listening = false;

// ================================
// Utils
// ================================
function setStatus(t) {
  statusEl.textContent = t;
}

function normalizeAngle(a) {
  let x = a % 360;
  return x < 0 ? x + 360 : x;
}

// Кратчайшая разница углов [-180..180]
function shortestDeltaDeg(from, to) {
  return ((to - from + 540) % 360) - 180;
}

// Сглаживание угла по кратчайшей дуге + deadzone
function smoothAngle(prev, next, factor) {
  const d = shortestDeltaDeg(prev, next);
  if (Math.abs(d) < JITTER_DEADZONE_DEG) return prev;
  return normalizeAngle(prev + d * factor);
}

// ================================
// Qibla calculation (Java-compatible)
// ================================
function calculateQiblaAzimuth(lat, lon) {
  const φ1 = lat * Math.PI / 180;
  const φ2 = KAABA_LAT * Math.PI / 180;
  const Δλ = (KAABA_LON - lon) * Math.PI / 180;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  return normalizeAngle(Math.atan2(y, x) * 180 / Math.PI);
}

// ================================
// Permissions (iOS)
// ================================
async function requestSensorsPermissionIfNeeded() {
  if (typeof DeviceOrientationEvent === "undefined") {
    throw new Error("Датчики ориентации не поддерживаются");
  }

  // iOS 13+ требует явного запроса
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
// Orientation (heading)
// ================================
// heading = азимут устройства, 0 = North.
function extractHeadingDeg(e) {
  // iOS Safari: точный компас
  if (typeof e.webkitCompassHeading === "number") {
    return normalizeAngle(e.webkitCompassHeading);
  }

  // Android/Chrome: alpha
  if (typeof e.alpha === "number") {
    // если absolute=false — это может быть не “настоящий север”, но это лучше чем ничего
    return normalizeAngle(360 - e.alpha);
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

  // Показ heading
  hAzEl.textContent = smoothHeading.toFixed(1);

  // 1) Циферблат крутится по heading: N/E/S/W показывают реальный мир
  dialEl.style.transform = `rotate(${-smoothHeading}deg)`;

  // 2) Стрелка крутится относительно телефона:
  //    arrowAngle = qiblaAzimuth - heading
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

    btnStart.disabled = true;
    setStatus("🔐 Запрашиваем доступ к датчикам…");
    await requestSensorsPermissionIfNeeded();

    setStatus("📍 Получаем геолокацию…");
    const pos = await getLocation();

    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;

    setStatus("🧭 Вычисляем направление Кыблы…");
    qiblaAzimuth = calculateQiblaAzimuth(lat, lon);
    qAzEl.textContent = qiblaAzimuth.toFixed(1);

    resetState();
    startSensors();

    setStatus("✅ Готово. Поворачивайте телефон: циферблат = стороны света, стрелка = Кыбла.");
  } catch (e) {
    console.error(e);
    setStatus("❌ Ошибка: " + (e?.message || e));
    btnStart.disabled = false;
  }
});

// Auto-ready for Telegram
if (tg) {
  try { tg.ready(); } catch (_) {}
}
