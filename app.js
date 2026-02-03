/* Minimal Qibla Compass for Telegram Mini App
   - Gets location (GPS)
   - Computes Qibla bearing to Kaaba
   - Reads compass heading from deviceorientation
   - Rotates arrow to point to Qibla
*/

const tg = window.Telegram?.WebApp ?? null;

const KAABA_LAT = 21.422487;
const KAABA_LON = 39.826206;

const btnStart = document.getElementById("btnStart");
const arrowEl  = document.getElementById("arrow");
const qAzEl    = document.getElementById("qAz");
const hAzEl    = document.getElementById("hAz");
const locEl    = document.getElementById("loc");
const statEl   = document.getElementById("stat");
const subEl    = document.getElementById("sub");

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

let qiblaAzimuth = null;     // 0..360 (true north)
let heading = null;          // 0..360 (device compass heading)
let hasOrientation = false;

function setStatus(s) { statEl.textContent = "Статус: " + s; }

function clamp360(deg) {
  let x = deg % 360;
  if (x < 0) x += 360;
  return x;
}

// Bearing from (lat1,lon1) to (lat2,lon2) relative to true north
function bearingTo(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * DEG2RAD;
  const φ2 = lat2 * DEG2RAD;
  const Δλ = (lon2 - lon1) * DEG2RAD;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  const θ = Math.atan2(y, x) * RAD2DEG;
  return clamp360(θ);
}

function updateUI() {
  if (qiblaAzimuth == null) return;

  qAzEl.textContent = qiblaAzimuth.toFixed(1) + "°";

  if (heading == null) {
    hAzEl.textContent = "—";
    return;
  }

  hAzEl.textContent = heading.toFixed(1) + "°";

  // Rotate arrow: when phone faces north (heading=0), arrow points to qiblaAzimuth
  const rotation = clamp360(qiblaAzimuth - heading);
  arrowEl.style.transform = `translate(-50%, -85%) rotate(${rotation}deg)`;
}

function getScreenAngle() {
  // 0 / 90 / 180 / -90
  const a = (screen.orientation && typeof screen.orientation.angle === "number")
    ? screen.orientation.angle
    : (typeof window.orientation === "number" ? window.orientation : 0);
  return a || 0;
}

function onOrientation(e) {
  hasOrientation = true;

  // iOS Safari provides webkitCompassHeading (0..360, already relative to true north)
  if (typeof e.webkitCompassHeading === "number" && !Number.isNaN(e.webkitCompassHeading)) {
    heading = clamp360(e.webkitCompassHeading);
    updateUI();
    return;
  }

  // Generic DeviceOrientationEvent:
  // alpha is 0..360 (rotation around z-axis). On many Android devices it acts like compass.
  // Need to compensate for screen orientation.
  if (typeof e.alpha === "number" && !Number.isNaN(e.alpha)) {
    const screenAngle = getScreenAngle();
    heading = clamp360(e.alpha + screenAngle);
    updateUI();
    return;
  }
}

async function requestMotionPermissionIfNeeded() {
  // iOS 13+ requires user gesture + explicit permission
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
    const res = await DeviceOrientationEvent.requestPermission();
    if (res !== "granted") throw new Error("Доступ к датчикам отклонён");
  }
}

function startOrientation() {
  window.addEventListener("deviceorientation", onOrientation, true);
}

function stopOrientation() {
  window.removeEventListener("deviceorientation", onOrientation, true);
}

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) reject(new Error("Геолокация не поддерживается"));
    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos),
      err => reject(err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

async function start() {
  try {
    btnStart.disabled = true;
    btnStart.textContent = "Запускаю…";

    tg?.ready();
    tg?.expand();

    setStatus("запрос разрешений");
    await requestMotionPermissionIfNeeded();

    setStatus("получаю геолокацию");
    const pos = await getLocation();

    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    locEl.textContent = `Локация: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;

    qiblaAzimuth = bearingTo(lat, lon, KAABA_LAT, KAABA_LON);
    subEl.textContent = "Держи телефон горизонтально — стрелка покажет направление";
    setStatus("ожидаю компас");

    stopOrientation();
    startOrientation();

    // Если компас не пришёл за 2 сек — покажем подсказку
    setTimeout(() => {
      if (!hasOrientation) {
        setStatus("компас недоступен (попробуй другой браузер/устройство)");
      }
    }, 2000);

    updateUI();
  } catch (e) {
    console.error(e);
    setStatus("ошибка: " + (e?.message || e));
    btnStart.disabled = false;
    btnStart.textContent = "Старт";
    return;
  }

  btnStart.textContent = "Перезапустить";
  btnStart.disabled = false;
}

btnStart.addEventListener("click", start);
