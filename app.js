// =========================
// VERSION (меняй при каждом деплое)
// =========================
const APP_VERSION = "1.2.2";

// =========================
// KAABA coords
// =========================
const KAABA_LAT = 21.422487;
const KAABA_LON = 39.826206;

// =========================
// UI
// =========================
const compassEl = document.getElementById("compass");
const dial = document.getElementById("dial");
const qiblaMark = document.getElementById("qiblaMark");

const headingEl = document.getElementById("heading");
const qiblaEl = document.getElementById("qibla");
const verEl = document.getElementById("ver");
const subEl = document.getElementById("sub");
const hintEl = document.getElementById("hint");
const errEl = document.getElementById("err");

const btn = document.getElementById("btn");
const locBtn = document.getElementById("locBtn");

verEl.textContent = "v" + APP_VERSION;

function showErr(msg){ errEl.textContent = msg || ""; }
function setSub(msg){ subEl.textContent = msg || ""; }
function setHint(msg, good){
  hintEl.textContent = msg || "";
  hintEl.classList.toggle("good", !!good);
}
function setAligned(on){
  compassEl.classList.toggle("aligned", !!on);
}

// =========================
// Math helpers (не меняем суть)
// =========================
function toRad(d){ return d * Math.PI / 180; }
function toDeg(r){ return r * 180 / Math.PI; }

function normalize360(d){
  d = d % 360;
  return d < 0 ? d + 360 : d;
}

function shortestDelta(fromDeg, toDeg){
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function screenAngle(){
  if (screen.orientation && typeof screen.orientation.angle === "number") return screen.orientation.angle;
  if (typeof window.orientation === "number") return window.orientation;
  return 0;
}

// bearing from (lat1,lon1) to (lat2,lon2)
function bearingDeg(lat1, lon1, lat2, lon2){
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return normalize360(toDeg(θ));
}

// =========================
// State
// =========================
let qiblaBearing = null;   // azimuth to Kaaba (0..360)
let headingTarget = null;  // target heading
let headingCurrent = null; // rendered heading
let headingFiltered = null; // сглаженный target


const TARGET_SMOOTH = 0.18;
const DEADZONE = 0.9;
const STEP_LIMIT = 3.6;
const SMOOTH_MIN = 0.06;
const SMOOTH_MAX = 0.20;

const ALIGN_TOL = 3.0;


// =========================
// Location
// =========================
function requestLocation(){
  showErr("");
  setHint("Определи геолокацию и вращай телефон.", false);
  setAligned(false);

  if (!navigator.geolocation) {
    showErr("Геолокация недоступна в этом окружении.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      qiblaBearing = bearingDeg(lat, lon, KAABA_LAT, KAABA_LON);
      qiblaEl.textContent = String(Math.round(qiblaBearing));

      // зелёная стрелка Кыйблы по азимуту (не меняем)
      qiblaMark.style.transform = `translate(-50%,-50%) rotate(${qiblaBearing}deg)`;

      // без “OK/координаты” — просто инструкция
      setSub("Поверни телефон — совмести белую стрелку с зелёной.");
    },
    (err) => {
      let msg = "Не удалось получить геолокацию.";
      if (err && err.code === 1) msg = "Доступ к геолокации запрещён.";
      if (err && err.code === 2) msg = "Геолокация недоступна (нет сигнала).";
      if (err && err.code === 3) msg = "Таймаут геолокации. Попробуй ещё раз.";

      showErr(msg);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
}

locBtn.addEventListener("click", requestLocation);

// =========================
// Compass input
// =========================
function setHeadingTarget(h){
  h = normalize360(h + screenAngle());

  // инициализация
  if (headingFiltered == null) headingFiltered = h;

  // сглаживание по окружности (важно! углы по кругу)
  const delta = shortestDelta(headingFiltered, h);
  headingFiltered = normalize360(headingFiltered + delta * TARGET_SMOOTH);

  headingTarget = headingFiltered;

  if (headingCurrent == null) headingCurrent = headingTarget;
}


let seenAbsolute = false;

function onOrientation(e){
  if (e.type === "deviceorientationabsolute") seenAbsolute = true;
  if (e.type === "deviceorientation" && seenAbsolute) return;

  if (typeof e.webkitCompassHeading === "number") {
    setHeadingTarget(e.webkitCompassHeading);
    return;
  }
  if (typeof e.alpha === "number") {
    setHeadingTarget(360 - e.alpha);
  }
}


function startListening(){
  window.addEventListener("deviceorientationabsolute", onOrientation, true);
  window.addEventListener("deviceorientation", onOrientation, true);
  window.addEventListener("orientationchange", () => {
    headingFiltered = null;
    headingCurrent = null;
  });


  setTimeout(() => {
    if (headingEl.textContent === "--") {
      showErr(
        "Компас не отдаёт данные.\n" +
        "Проверь разрешение на датчики и HTTPS."
      );
    }
  }, 1500);
}

// iOS permission (по клику — неизбежно)
async function initSensors(){
  showErr("");

  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {

    btn.classList.remove("hidden");
    btn.textContent = "Разрешить датчики";

    btn.onclick = async () => {
      showErr("");
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== "granted") {
          showErr("Доступ к датчикам не выдан.");
          return;
        }
        btn.classList.add("hidden");
        startListening();
      } catch (e) {
        showErr("Ошибка permission: " + (e && e.message ? e.message : String(e)));
      }
    };

  } else {
    // Android: автозапуск
    startListening();
  }
}

// =========================
// Render loop (плавно, без рывков)
// =========================
function render(){
  if (headingTarget != null && headingCurrent != null) {
    let d = shortestDelta(headingCurrent, headingTarget);

    // deadzone: мелкую дрожь игнорируем
    if (Math.abs(d) < DEADZONE) d = 0;

    // clamp рывков
    if (d > STEP_LIMIT) d = STEP_LIMIT;
    if (d < -STEP_LIMIT) d = -STEP_LIMIT;

    // адаптивное сглаживание: чем больше разница, тем быстрее догоняем
    const t = Math.min(1, Math.abs(d) / STEP_LIMIT); // 0..1
    const smooth = SMOOTH_MIN + (SMOOTH_MAX - SMOOTH_MIN) * t;

    headingCurrent = normalize360(headingCurrent + d * smooth);


    dial.style.transform = `rotate(${-headingCurrent}deg)`;
    headingEl.textContent = String(Math.round(headingCurrent));

    if (qiblaBearing != null) {
      const rel = shortestDelta(headingCurrent, qiblaBearing); // >0: поверни вправо, <0: поверни влево
      const abs = Math.abs(rel);

      if (abs <= ALIGN_TOL) {
        setAligned(true);
        setHint("Направление определено", true);
      } else {
        setAligned(false);

        // подсказка "левее/правее"
        // rel > 0 значит qibla "по часовой" от текущего -> поверни вправо
        if (rel > 0) setHint("Поверни телефон правее", false);
        else setHint("Поверни телефон левее", false);
      }
    }
  }

  requestAnimationFrame(render);
}

// =========================
// Init
// =========================
requestLocation();
initSensors();
requestAnimationFrame(render);
