// ================================
// Telegram WebApp
// ================================
const tg = window.Telegram ? window.Telegram.WebApp : null;

// ================================
// DOM
// ================================
const statusEl = document.getElementById("status");
const btnStart = document.getElementById("btnStart");
const arrowEl = document.getElementById("arrow");

const qAzEl = document.getElementById("qAz");
const hAzEl = document.getElementById("hAz");
const aAzEl = document.getElementById("aAz");

// ================================
// State
// ================================
let qiblaAzimuth = null;
let lastHeading = null;

// ================================
// Constants
// ================================
const KAABA_LAT = 21.422487;
const KAABA_LON = 39.826206;

// ================================
// Utils
// ================================
function setStatus(text) {
  statusEl.textContent = text;
}

function normalizeAngle(a) {
  let x = a % 360;
  if (x < 0) x += 360;
  return x;
}

// ================================
// Permissions (iOS required)
// ================================
async function requestSensorsPermissionIfNeeded() {
  if (typeof DeviceOrientationEvent === "undefined") {
    throw new Error("Датчики ориентации не поддерживаются");
  }

  // iOS 13+
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    const res = await DeviceOrientationEvent.requestPermission();
    if (res !== "granted") {
      throw new Error("Доступ к датчикам не разрешён");
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

    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      (err) => reject(err),
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0,
      }
    );
  });
}

// ================================
// Qibla calculation (CLIENT SIDE)
// Формула полностью совпадает с Java
// ================================
function calculateQiblaAzimuth(lat, lon) {
  const φ1 = lat * Math.PI / 180;
  const φ2 = KAABA_LAT * Math.PI / 180;
  const Δλ = (KAABA_LON - lon) * Math.PI / 180;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  const az = Math.atan2(y, x) * 180 / Math.PI;
  return normalizeAngle(az);
}

// ================================
// Orientation listener
// ================================
function startOrientationListener() {
  window.addEventListener("deviceorientationabsolute", onOrientation, true);
  window.addEventListener("deviceorientation", onOrientation, true);
}

function onOrientation(e) {
  let heading = null;

  // iOS
  if (typeof e.webkitCompassHeading === "number") {
    heading = e.webkitCompassHeading;
  }
  // Android
  else if (typeof e.alpha === "number") {
    heading = 360 - e.alpha;
  }

  if (heading == null) return;

  heading = normalizeAngle(heading);
  lastHeading = heading;

  hAzEl.textContent = heading.toFixed(1);

  if (qiblaAzimuth == null) return;

  const angle = normalizeAngle(qiblaAzimuth - heading);

  qAzEl.textContent = qiblaAzimuth.toFixed(1);
  aAzEl.textContent = angle.toFixed(1);

  arrowEl.style.transform =
    `translate(-50%, -90%) rotate(${angle}deg)`;
}

// ================================
// Start button
// ================================
btnStart.addEventListener("click", async () => {
  try {
    if (tg) {
      tg.expand();
      tg.ready();
    }

    setStatus("🔐 Запрашиваем доступ к датчикам…");
    await requestSensorsPermissionIfNeeded();

    setStatus("📍 Получаем геолокацию…");
    const pos = await getLocation();

    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;

    setStatus("🧭 Вычисляем направление Кыблы…");
    qiblaAzimuth = calculateQiblaAzimuth(lat, lon);

    setStatus("✅ Готово! Поворачивайте телефон — стрелка укажет направление на Каабу.");
    startOrientationListener();

  } catch (e) {
    console.error(e);
    setStatus("❌ Ошибка: " + (e.message || e));
  }
});
