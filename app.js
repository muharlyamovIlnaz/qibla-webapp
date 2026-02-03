const dial = document.getElementById("dial");
const degEl = document.getElementById("deg");
const statusEl = document.getElementById("status");
const errEl = document.getElementById("err");
const btn = document.getElementById("btn");

function showErr(msg){ errEl.textContent = msg || ""; }
function setStatus(msg){ statusEl.textContent = msg; }

setStatus("JS loaded ✅");

function normalize(d){
  d = d % 360;
  return d < 0 ? d + 360 : d;
}

function screenAngle(){
  if (screen.orientation && typeof screen.orientation.angle === "number") return screen.orientation.angle;
  if (typeof window.orientation === "number") return window.orientation;
  return 0;
}

// Разница по кратчайшей дуге (-180..180)
function shortestDelta(fromDeg, toDeg){
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

/**
 * Настройки плавности:
 * SMOOTH ближе к 1 -> быстрее/резче, ближе к 0 -> плавнее
 * STEP_LIMIT ограничивает максимальный рывок за один кадр (в градусах)
 */
const SMOOTH = 0.12;      // попробуй 0.08..0.18
const STEP_LIMIT = 6.0;   // 4..10 (меньше = менее дергано)

let target = null;  // куда хотим прийти
let current = null; // что рисуем

function setTargetHeading(h){
  target = normalize(h + screenAngle());
  if (current == null) current = target;
}

function render(){
  if (target != null && current != null) {
    let d = shortestDelta(current, target);        // -180..180
    // режем аномальные скачки
    if (d > STEP_LIMIT) d = STEP_LIMIT;
    if (d < -STEP_LIMIT) d = -STEP_LIMIT;

    current = normalize(current + d * SMOOTH);

    dial.style.transform = `rotate(${-current}deg)`;
    degEl.textContent = String(Math.round(current));
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

// ---- Источник данных ----
function onOrientation(e){
  // iOS — готовый heading
  if (typeof e.webkitCompassHeading === "number") {
    setStatus("Source: iOS webkitCompassHeading");
    setTargetHeading(e.webkitCompassHeading);
    return;
  }

  // Android — alpha
  if (typeof e.alpha === "number") {
    setStatus(e.absolute ? "Source: deviceorientation absolute" : "Source: deviceorientation");
    // стандартно: heading = 360 - alpha
    setTargetHeading(360 - e.alpha);
  }
}

function startListening(){
  window.addEventListener("deviceorientationabsolute", onOrientation, true);
  window.addEventListener("deviceorientation", onOrientation, true);

  setTimeout(() => {
    if (degEl.textContent === "--") {
      showErr(
        "События не приходят. Проверь HTTPS / Permissions-Policy / ограничения WebView."
      );
      setStatus(`secure=${window.isSecureContext ? "yes" : "no"}, proto=${location.protocol}`);
    }
  }, 1500);
}

// iOS permission: нельзя без тапа
async function init(){
  showErr("");

  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {

    btn.classList.remove("hidden");
    setStatus("iOS: нужен тап для разрешения датчиков");

    btn.onclick = async () => {
      showErr("");
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== "granted") {
          showErr("Permission denied: датчики не разрешены.");
          return;
        }
        btn.classList.add("hidden");
        setStatus("iOS: permission granted");
        startListening();
      } catch (e) {
        showErr("Permission error: " + (e && e.message ? e.message : String(e)));
      }
    };

  } else {
    // Android/прочие — автостарт
    setStatus("Auto start…");
    startListening();
  }
}

init();
