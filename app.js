const dial = document.getElementById("dial");
const degEl = document.getElementById("deg");
const statusEl = document.getElementById("status");
const errEl = document.getElementById("err");
const btn = document.getElementById("enable");

statusEl.textContent = "JS loaded ✅";

window.onerror = function (msg, src, line, col) {
  errEl.textContent = `JS ERROR: ${msg}\n${src}:${line}:${col}`;
};

function normalize(d) {
  d = d % 360;
  return d < 0 ? d + 360 : d;
}

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === "number") return screen.orientation.angle;
  if (typeof window.orientation === "number") return window.orientation;
  return 0;
}

let last = null;
function smooth(prev, next, k = 0.2) {
  if (prev == null) return next;
  const diff = ((next - prev + 540) % 360) - 180;
  return normalize(prev + diff * k);
}

function setHeading(h) {
  h = normalize(h + screenAngle());
  last = smooth(last, h);
  dial.style.transform = `rotate(${-last}deg)`;
  degEl.textContent = String(Math.round(last));
}

function onOrientation(e) {
  // iOS
  if (typeof e.webkitCompassHeading === "number") {
    statusEl.textContent = "Source: webkitCompassHeading";
    setHeading(e.webkitCompassHeading);
    return;
  }

  // Android / others
  if (typeof e.alpha === "number") {
    statusEl.textContent = e.absolute ? "Source: deviceorientation absolute" : "Source: deviceorientation";
    setHeading(360 - e.alpha);
  }
}

let started = false;

async function enable() {
  if (started) return;
  started = true;

  errEl.textContent = "";
  btn.textContent = "Запущено";
  statusEl.textContent = "Запуск…";

  // важно: покажем базовую инфу
  statusEl.textContent = `secure=${window.isSecureContext ? "yes" : "no"}, proto=${location.protocol}`;

  // iOS permission
  try {
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== "granted") {
        errEl.textContent = "Permission denied (iOS датчики не разрешены).";
        started = false;
        btn.textContent = "Включить компас";
        return;
      }
    }
  } catch (e) {
    errEl.textContent = "Permission error: " + (e && e.message ? e.message : String(e));
    started = false;
    btn.textContent = "Включить компас";
    return;
  }

  // слушаем
  window.addEventListener("deviceorientationabsolute", onOrientation, true);
  window.addEventListener("deviceorientation", onOrientation, true);

  // если через 1500мс ничего не пришло — сообщим
  setTimeout(() => {
    if (degEl.textContent === "--") {
      errEl.textContent =
        "Датчики не дают данных.\n" +
        "Причины чаще всего:\n" +
        "1) страница не HTTPS / не secure context\n" +
        "2) Permissions-Policy на сервере запрещает датчики\n" +
        "3) Telegram WebView на этом устройстве блокирует orientation events";
    }
  }, 1500);
}

btn.addEventListener("click", enable);
