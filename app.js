// =========================
// VERSION (меняй при каждом деплое)
// =========================
const APP_VERSION = "1.0.0";

// =========================
// KAABA coords (точка Каабы)
// =========================
const KAABA_LAT = 21.422487;
const KAABA_LON = 39.826206;

// =========================
// UI
// =========================
const dial = document.getElementById("dial");
const qiblaMark = document.getElementById("qiblaMark");
const headingEl = document.getElementById("heading");
const qiblaEl = document.getElementById("qibla");
const verEl = document.getElementById("ver");
const subEl = document.getElementById("sub");
const errEl = document.getElementById("err");
const okEl = document.getElementById("ok");
const btn = document.getElementById("btn");
const locBtn = document.getElementById("locBtn");

verEl.textContent = "v" + APP_VERSION;

function showErr(msg){ errEl.textContent = msg || ""; }
function setSub(msg){ subEl.textContent = msg || ""; }
function showOk(on){ okEl.classList.toggle("hidden", !on); }

// =========================
// Math helpers
// =========================
function toRad(d){ return d * Math.PI / 180; }
function toDeg(r){ return r * 180 / Math.PI; }

function normalize360(d){
  d = d % 360;
  return d < 0 ? d + 360 : d;
}

// shortest delta (-180..180)
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
let qiblaBearing = null;   // абсолютный азимут на Каабу (0..360)
let headingTarget = null;  // куда хотим прийти
let headingCurrent = null; // что рисуем

// Плавность/стабильность
const SMOOTH = 0.12;     // 0.08..0.18 (меньше = плавнее)
const STEP_LIMIT = 6.0;  // град/кадр, режет рывки (4..10)
const ALIGN_TOL = 3.0;   // допуск попадания на Кыблу (градусы)

// =========================
// Location
// =========================
function requestLocation(){
  showErr("");
  setSub("Определяем геолокацию…");

  if (!navigator.geolocation) {
    showErr("Геолокация недоступна в этом окружении.");
    setSub("Нужен HTTPS и доступ к Location.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      qiblaBearing = bearingDeg(lat, lon, KAABA_LAT, KAABA_LON);
      qiblaEl.textContent = String(Math.round(qiblaBearing));

      // Маркер Кыблы ставим внутрь диска на нужный азимут (0=N, 90=E…)
      qiblaMark.style.transform = `translate(-50%,-50%) rotate(${qiblaBearing}deg)`;

      setSub(`Локация OK: ${lat.toFixed(5)}, ${lon.toFixed(5)}. Поверни телефон — маркер покажет Кыблу.`);
    },
    (err) => {
      let msg = "Не удалось получить геолокацию.";
      if (err && err.code === 1) msg = "Доступ к геолокации запрещён.";
      if (err && err.code === 2) msg = "Геолокация недоступна (нет сигнала/служб).";
      if (err && err.code === 3) msg = "Таймаут геолокации. Попробуй ещё раз.";

      showErr(msg);
      setSub("Без локации азимут Кыблы не вычислить.");
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
}

locBtn.addEventListener("click", requestLocation);

// =========================
// Compass input
// =========================
function setHeadingTarget(h){
  // Учитываем поворот экрана (portrait/landscape)
  h = normalize360(h + screenAngle());
  headingTarget = h;

  if (headingCurrent == null) headingCurrent = h;
}

function onOrientation(e){
  // iOS: готовый heading
  if (typeof e.webkitCompassHeading === "number") {
    setHeadingTarget(e.webkitCompassHeading);
    return;
  }

  // Android/others: alpha
  if (typeof e.alpha === "number") {
    // стандартно: heading = 360 - alpha
    setHeadingTarget(360 - e.alpha);
  }
}

function startListening(){
  window.addEventListener("deviceorientationabsolute", onOrientation, true);
  window.addEventListener("deviceorientation", onOrientation, true);

  // Проверка: если ничего не приходит
  setTimeout(() => {
    if (headingEl.textContent === "--") {
      showErr(
        "Компас не отдаёт данные.\n" +
        "Частые причины:\n" +
        "• нет разрешения на датчики (особенно iOS)\n" +
        "• WebView/браузер блокирует deviceorientation\n" +
        "• страница не HTTPS (secure context)"
      );
      setSub(`secure=${window.isSecureContext ? "yes" : "no"}, proto=${location.protocol}`);
    }
  }, 1500);
}

// iOS permission: только через клик (так устроено)
async function initSensors(){
  showErr("");

  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {

    btn.classList.remove("hidden");
    btn.textContent = "Разрешить датчики";
    setSub("Нужен один тап, чтобы iPhone дал доступ к компасу.");

    btn.onclick = async () => {
      showErr("");
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== "granted") {
          showErr("Доступ к датчикам не выдан. Без этого компас не работает.");
          return;
        }
        btn.classList.add("hidden");
        setSub("Датчики разрешены. Вращай телефон — компас работает.");
        startListening();
      } catch (e) {
        showErr("Ошибка permission: " + (e && e.message ? e.message : String(e)));
      }
    };

  } else {
    // Android/прочие: автозапуск
    setSub("Вращай телефон — компас работает.");
    startListening();
  }
}

// =========================
// Render loop (smooth & stable)
// =========================
function render(){
  if (headingTarget != null && headingCurrent != null) {
    // Плавно тянем к target по кратчайшей дуге
    let d = shortestDelta(headingCurrent, headingTarget);

    // Режем рывки датчика
    if (d > STEP_LIMIT) d = STEP_LIMIT;
    if (d < -STEP_LIMIT) d = -STEP_LIMIT;

    headingCurrent = normalize360(headingCurrent + d * SMOOTH);

    // Вращаем диск так, чтобы "верх" = направление телефона.
    // (диск крутится в обратную сторону heading)
    dial.style.transform = `rotate(${-headingCurrent}deg)`;
    headingEl.textContent = String(Math.round(headingCurrent));

    // Проверяем совпадение направления телефона с Кыблой
    if (qiblaBearing != null) {
      const rel = shortestDelta(headingCurrent, qiblaBearing); // куда повернуть, чтобы смотреть на Кыблу
      showOk(Math.abs(rel) <= ALIGN_TOL);
      // Можно ещё подсказку в sub при желании, но оставим чисто.
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
