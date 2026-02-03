const dial = document.getElementById("dial");
const degEl = document.getElementById("deg");
const errEl = document.getElementById("err");
const btn = document.getElementById("enable");

let started = false;
let last = null;

function normalize(d) {
  d = d % 360;
  return d < 0 ? d + 360 : d;
}

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === "number") return screen.orientation.angle;
  if (typeof window.orientation === "number") return window.orientation; // старый iOS
  return 0;
}

// мягко сглаживаем (чтобы не дергалось)
function smooth(prev, next, k = 0.18) {
  if (prev == null) return next;
  let diff = ((next - prev + 540) % 360) - 180; // кратчайшая дуга
  return normalize(prev + diff * k);
}

function applyHeading(h) {
  h = normalize(h);
  last = smooth(last, h);

  // фиксированная стрелка; крутим круг в обратную сторону
  dial.style.transform = `rotate(${-last}deg)`;
  degEl.textContent = String(Math.round(last));
}

function onOrientation(e) {
  // iOS (Safari/WebView): есть webkitCompassHeading
  if (typeof e.webkitCompassHeading === "number") {
    applyHeading(e.webkitCompassHeading);
    return;
  }

  // Android/прочие: alpha
  if (typeof e.alpha === "number") {
    const raw = 360 - e.alpha;
    const corrected = raw + screenAngle();
    applyHeading(corrected);
  }
}

function showError(msg) {
  errEl.textContent = msg;
}

function start() {
  if (started) return;
  started = true;

  showError("");

  window.addEventListener("deviceorientationabsolute", onOrientation, true);
  window.addEventListener("deviceorientation", onOrientation, true);

  // если через 1.2 сек ничего не пришло — скажем пользователю
  setTimeout(() => {
    if (degEl.textContent === "--") {
      showError("Нет данных компаса. Проверь разрешение на датчики и что устройство поддерживает компас.");
    }
  }, 1200);
}

async function enable() {
  showError("");

  try {
    // iOS 13+: permission только по клику
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== "granted") {
        showError("Доступ к датчикам не разрешён. Компас не сможет работать.");
        return;
      }
    }
    start();
  } catch (e) {
    showError("Ошибка включения: " + (e && e.message ? e.message : String(e)));
  }
}

btn.addEventListener("click", enable, { passive: true });
