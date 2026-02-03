const dial = document.getElementById("dial");
const degEl = document.getElementById("deg");
const srcEl = document.getElementById("src");
const errEl = document.getElementById("err");
const btn = document.getElementById("enable");

let started = false;
let last = null;
let sensor = null;

function normalize(d) {
  d = d % 360;
  return d < 0 ? d + 360 : d;
}

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === "number") return screen.orientation.angle;
  if (typeof window.orientation === "number") return window.orientation; // старый iOS
  return 0;
}

function smooth(prev, next, k = 0.2) {
  if (prev == null) return next;
  const diff = ((next - prev + 540) % 360) - 180; // кратчайшая дуга
  return normalize(prev + diff * k);
}

function setHeading(h, source) {
  h = normalize(h);
  last = smooth(last, h);

  dial.style.transform = `rotate(${-last}deg)`; // круг в обратную сторону
  degEl.textContent = String(Math.round(last));
  srcEl.textContent = source;
}

function showError(msg) {
  errEl.textContent = msg || "";
}

// ---------- 1) Generic Sensor API (Android часто лучше) ----------
function quaternionToYawDeg(q) {
  // q = [x, y, z, w]
  const x = q[0], y = q[1], z = q[2], w = q[3];

  // yaw (Z) from quaternion
  // yaw = atan2(2(wz + xy), 1 - 2(y^2 + z^2))
  const t0 = 2 * (w * z + x * y);
  const t1 = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(t0, t1); // radians

  // convert to degrees, then to compass heading (0=N, clockwise)
  let deg = yaw * 180 / Math.PI; // -180..180
  deg = normalize(deg);

  // yaw обычно дает "восток-положительный", но компас нужен 0=N.
  // Для большинства реализаций достаточно инверсии:
  return normalize(360 - deg);
}

function tryStartAbsoluteOrientationSensor() {
  if (!("AbsoluteOrientationSensor" in window)) return false;

  try {
    sensor = new AbsoluteOrientationSensor({ frequency: 60 });

    sensor.addEventListener("reading", () => {
      if (!sensor.quaternion) return;
      let heading = quaternionToYawDeg(sensor.quaternion);
      heading = heading + screenAngle();
      setHeading(heading, "AbsoluteOrientationSensor");
    });

    sensor.addEventListener("error", (e) => {
      showError("Sensor error: " + (e.error ? e.error.name : "unknown"));
    });

    sensor.start();
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- 2) DeviceOrientation fallback ----------
function onOrientation(e) {
  // iOS
  if (typeof e.webkitCompassHeading === "number") {
    setHeading(e.webkitCompassHeading, "webkitCompassHeading");
    return;
  }

  // Android/другие
  if (typeof e.alpha === "number") {
    const heading = (360 - e.alpha) + screenAngle();
    setHeading(heading, e.absolute ? "deviceorientation (absolute)" : "deviceorientation");
  }
}

function startDeviceOrientation() {
  window.addEventListener("deviceorientationabsolute", onOrientation, true);
  window.addEventListener("deviceorientation", onOrientation, true);
}

// ---------- Enable (с разрешениями) ----------
async function enable() {
  if (started) return;
  started = true;

  showError("");

  // iOS 13+ — permission только по клику
  try {
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== "granted") {
        showError("Не дали доступ к датчикам. Без этого компас не работает.");
        started = false;
        return;
      }
    }
  } catch (e) {
    showError("Permission error: " + (e && e.message ? e.message : String(e)));
    started = false;
    return;
  }

  // 1) сначала пробуем Sensor API
  const okSensor = tryStartAbsoluteOrientationSensor();

  // 2) fallback
  startDeviceOrientation();

  // Если через 1.5s всё еще пусто — значит датчики реально не отдаются
  setTimeout(() => {
    if (degEl.textContent === "--") {
      showError(
        "Нет данных компаса.\n" +
        "Проверь: сайт открыт по HTTPS, и сервер НЕ запрещает датчики (Permissions-Policy).\n" +
        "Если это Telegram WebView на некоторых Android — датчики могут быть заблокированы системой."
      );
      srcEl.textContent = okSensor ? "Sensor started, no readings" : "No sensor, no events";
    }
  }, 1500);
}

btn.addEventListener("click", enable, { passive: true });
