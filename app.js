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
const qAzEl    = document.getElementById("qAz");
const hAzEl    = document.getElementById("hAz");

// ================================
// Constants
// ================================
const KAABA_LAT = 21.422487;
const KAABA_LON = 39.826206;
const SMOOTHING = 0.15; // чем меньше — тем плавнее

// ================================
// State
// ================================
let qiblaAzimuth = null;
let smoothHeading = null;

// ================================
// Utils
// ================================
function normalizeAngle(a) {
  let x = a % 360;
  return x < 0 ? x + 360 : x;
}

function setStatus(t) {
  statusEl.textContent = t;
}

// ================================
// Java-compatible Qibla formula
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
// Permissions
// ================================
async function requestSensorsPermissionIfNeeded() {
  if (typeof DeviceOrientationEvent?.requestPermission === "function") {
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
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });
  });
}

// ================================
// Orientation
// ================================
function onOrientation(e) {
  let heading;

  if (typeof e.webkitCompassHeading === "number") {
    heading = e.webkitCompassHeading;
  } else if (typeof e.alpha === "number") {
    heading = 360 - e.alpha;
  } else {
    return;
  }

  heading = normalizeAngle(heading);

  // smoothing
  if (smoothHeading == null) {
    smoothHeading = heading;
  } else {
    smoothHeading =
      smoothHeading + SMOOTHING * (heading - smoothHeading);
  }

  hAzEl.textContent = smoothHeading.toFixed(1);

  if (qiblaAzimuth == null) return;

  const angle = normalizeAngle(qiblaAzimuth - smoothHeading);
  arrowEl.style.transform =
    `translate(-50%, -90%) rotate(${angle}deg)`;
}

// ================================
// Start
// ================================
btnStart.addEventListener("click", async () => {
  try {
    tg?.expand();
    tg?.ready();

    setStatus("Запрашиваем доступ к датчикам…");
    await requestSensorsPermissionIfNeeded();

    setStatus("Получаем геолокацию…");
    const pos = await getLocation();

    qiblaAzimuth = calculateQiblaAzimuth(
      pos.coords.latitude,
      pos.coords.longitude
    );

    qAzEl.textContent = qiblaAzimuth.toFixed(1);

    setStatus("Готово. Поворачивайте телефон.");
    window.addEventListener("deviceorientation", onOrientation, true);
    window.addEventListener("deviceorientationabsolute", onOrientation, true);

  } catch (e) {
    console.error(e);
    setStatus("Ошибка: " + e.message);
  }
});
