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

// Сглаживание (0.06..0.15). Меньше => плавнее, но медленнее реакция.
// Я поставил очень плавно, но адекватно.
const SMOOTHING = 0.08;

// Иногда Android отдаёт "шум" +/-2..5 градусов.
// Этот порог отбрасывает микродрожь, но не ломает повороты.
const JITTER_DEADZONE_DEG = 0.35;

// ================================
// State
// ================================
let qiblaAzimuth = null;

// сырые показания и сглаженные
let rawHeading = null;
let smoothHeading = null;

// for requestAnimationFrame loop
let rafId = null;
let lastRenderTs = 0;

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

// Правильное сглаживание углов по кратчайшей дуге
function smoothAngle(prev, next, factor) {
  const d = shortestDeltaDeg(prev, next);
  if (Math.abs(d) < JITTER_DEADZONE_DEG) return prev; // убираем микродрожь
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
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    const res = await DeviceOrientationEvent.requestPermission();
    if (res !== "granted") throw new Error("Нет доступа к датчикам");
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
// Важно: heading = азимут устройства, 0 = North.
function extractHeadingDeg(e) {
  // iOS Safari: абсолютный компас, лучший вариант
  if (typeof e.webkitCompassHeading === "number") {
    return normalizeAngle(e.webkitCompassHeading);
  }

  // Android/Chrome: alpha часто noisy и не всегда "absolute".
  // Но для большинства устройств работает как heading fallback.
  if (typeof e.alpha === "number") {
    return normalizeAngle(360 - e.alpha);
  }

  return null;
}

function onOrientation(e) {
  const h = extractHeadingDeg(e);
  if (h == null) return;
  rawHeading = h;

  if (smoothHeading == null) smoothHeading = rawHeading;
}

// ================================
// Render loop (requestAnimationFrame)
// ================================
function render(ts) {
  rafId = requestAnimationFrame(render);

  // ограничим частоту обновления, чтобы не "рвать" анимацию (60fps)
  if (ts - lastRenderTs < 16) return;
  lastRenderTs = ts;

  if (rawHeading == null) return;

  if (smoothHeading == null) {
    smoothHeading = rawHeading;
  } else {
    smoothHeading = smoothAngle(smoothHeading, rawHeading, SMOOTHING);
  }

  // Показ heading
  hAzEl.textContent = smoothHeading.toFixed(1);

  // 1) Вращаем ЦИФЕРБЛАТ так, чтобы "N" всегда указывал на реальный север.
  // Телефон повернули вправо => heading растёт => dial крутится влево.
  dialEl.style.transform = `rotate(${-smoothHeading}deg)`;

  // 2) Стрелка Кыблы: относительный угол от направления устройства.
  if (qiblaAzimuth != null) {
    const qiblaAngle = normalizeAngle(qiblaAzimuth - smoothHeading);
    arrowEl.style.transform = `translate(-50%, -92%) rotate(${qiblaAngle}deg)`;
  }
}

// ================================
// Start
// ================================
function startSensors() {
  // Подписка на события (двойная — на разных браузерах по-разному)
  window.addEventListener("deviceorientationabsolute", onOrientation, true);
  window.addEventListener("deviceorientation", onOrientation, true);

  // запускаем rAF
  if (!rafId) rafId = requestAnimationFrame(render);
}

btnStart.addEventListener("click", async () => {
  try {
    tg?.expand();
    tg?.ready();

    btnStart.disabled = true;

    setStatus("🔐 Запрашиваем доступ к датчикам…");
    await requestSensorsPermissionIfNeeded();

    setStatus("📍 Получаем геолокацию…");
    const pos = await getLocation();

    setStatus("🧭 Вычисляем направление Кыблы…");
    qiblaAzimuth = calculateQiblaAzimuth(
      pos.coords.latitude,
      pos.coords.longitude
    );

    qAzEl.textContent = qiblaAzimuth.toFixed(1);

    setStatus("✅ Готово. Поворачивайте телефон — циферблат покажет реальный север, стрелка — Кыблу.");
    startSensors();
  } catch (e) {
    console.error(e);
    setStatus("❌ Ошибка: " + (e?.message || e));
    btnStart.disabled = false;
  }
});

// Авто: если запущено в Telegram, можно сразу подготовиться
if (tg) {
  try {
    tg.ready();
  } catch (_) {}
}
