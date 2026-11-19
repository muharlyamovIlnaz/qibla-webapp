import {bearing, centralAngle, declination, wrap} from './compass-math.js';
import {setDestination, showHeading, showNotice, showTilt} from './instrument.js?v=eac4b23578';

const orientationEvents = ['deviceorientationabsolute', 'deviceorientation'];
const browserLink = document.getElementById('browser-link');
const browserUrl = location.origin + location.pathname + '?external=1';
browserLink.href = browserUrl;
browserLink.addEventListener('click', event => {
  if (window.WebApp?.initData && typeof window.WebApp.openLink === 'function') {
    event.preventDefault();
    window.WebApp.openLink(browserUrl);
  }
});
const startButton = document.getElementById('start');
let session = 0, correction = null, lastSignal = 0, watchdog;
let fieldRequest;
let sensorsReady = false;
let problem = null, problemSince = 0, warningShown = false;
let lastCalibrationTip = -Infinity;

function reportSensorProblem(kind, now) {
  if (problem !== kind) {
    problem = kind;
    problemSince = now;
    warningShown = false;
  }
  const delay = kind === 'tilt' ? 1500 : 4000;
  if (warningShown || now - problemSince < delay) return;
  warningShown = true;
  if (kind === 'tilt') {
    showTilt();
  } else if (now - lastCalibrationTip >= 60000) {
    lastCalibrationTip = now;
    showNotice('calibrate', 'Настройте компас', 'Медленно опишите телефоном восьмёрку.');
  } else {
    showNotice('waiting', 'Уточняем направление', 'Отойдите от металлических предметов.');
  }
}

function loadField() {
  fieldRequest ??= fetch('field.json').then(response => {
    if (!response.ok) throw new Error('Нет модели магнитного поля');
    return response.json();
  }).catch(() => {
    fieldRequest = null;
    return null;
  });
  return fieldRequest;
}

function schedulePosition() {
  const payload = window.WebApp?.initDataUnsafe?.start_param;
  const match = /^cell_(-?\d{1,5})_(-?\d{1,5})$/.exec(payload ?? '');
  if (!match) return null;
  const latitude = Number(match[1]) / 100, longitude = Number(match[2]) / 100;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return {coords: {latitude, longitude, accuracy: 5000}};
}

function locate(precise) {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, {
    enableHighAccuracy: precise, maximumAge: precise ? 0 : 60000, timeout: precise ? 15000 : 8000
  }));
}

function sufficientlyAccurate({latitude, longitude, accuracy}) {
  return Number.isFinite(accuracy) && accuracy <= 6371000 * Math.sin(centralAngle(latitude, longitude)) * .07;
}

async function getPosition(id) {
  try {
    const coarse = await locate(false);
    if (sufficientlyAccurate(coarse.coords) || id !== session) return coarse;
  } catch (error) {
    if (![2, 3].includes(error.code) || id !== session) throw error;
  }
  showNotice('waiting', 'Уточняем местоположение', 'Держите мини-приложение открытым.');
  return locate(true);
}

function locationFailure(error) {
  switch (error.code) {
    case 1: {
      const external = new URLSearchParams(location.search).get('external') === '1';
      fail('Нет доступа к геопозиции', external
        ? 'Разрешите этому сайту использовать местоположение в настройках браузера и повторите попытку.'
        : 'Страница не получила доступ к местоположению. Если разрешение MAX уже выдано, откройте компас в браузере.');
      browserLink.hidden = external;
      return;
    }
    case 2: return fail('Телефон не определил местоположение', 'Проверьте, включена ли геолокация телефона, и попробуйте у окна или на улице.');
    case 3: return fail('Определение места заняло слишком много времени', 'Попробуйте ещё раз у окна или на улице.');
    default: return fail('Не удалось определить местоположение', 'Проверьте геолокацию телефона и повторите попытку.');
  }
}

function pauseSensors() {
  problem = null;
  warningShown = false;
  clearInterval(watchdog);
  for (const event of orientationEvents) window.removeEventListener(event, onOrientation);
  watchdog = undefined;
}

function stop() {
  session++;
  sensorsReady = false;
  pauseSensors();
  correction = null;
  setDestination(null, null);
}

function fail(title, hint) {
  stop();
  showNotice('error', title, hint);
}

function onOrientation(event) {
  const appleHeading = Number.isFinite(event.webkitCompassHeading);
  if (!appleHeading && (!event.absolute || !Number.isFinite(event.alpha))) return;
  lastSignal = performance.now();

  const limit = problem === 'tilt' && warningShown ? 30 : 38;
  if (!Number.isFinite(event.beta) || !Number.isFinite(event.gamma) ||
      Math.max(Math.abs(event.beta), Math.abs(event.gamma)) > limit) {
    reportSensorProblem('tilt', lastSignal);
    return;
  }

  let heading = 360 - event.alpha;
  if (appleHeading) {
    if (correction === null) {
      fail('Не удалось уточнить север', 'Попробуйте снова, когда доступна модель магнитного поля для вашего места.');
      return;
    }
    const accuracy = event.webkitCompassAccuracy;
    if (event.webkitCompassHeading < 0 || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 15) {
      reportSensorProblem('accuracy', lastSignal);
      return;
    }
    heading = event.webkitCompassHeading + correction;
  }
  const resumed = problem !== null;
  problem = null;
  warningShown = false;
  const course = wrap(heading + (screen.orientation?.angle ?? window.orientation ?? 0));
  if (showHeading(course, lastSignal, resumed)) navigator.vibrate?.(55);
}

async function startCompass(fromTap) {
  browserLink.hidden = true;
  stop();
  const id = session;
  showNotice('waiting', 'Подключаем компас', '');
  try {
    const saved = schedulePosition();
    if (!window.isSecureContext || (!saved && !navigator.geolocation) || !window.DeviceOrientationEvent) {
      throw new Error('Откройте компас на телефоне по HTTPS и разрешите доступ к датчикам.');
    }
    const orientation = window.DeviceOrientationEvent;
    if (orientation.requestPermission) {
      let permission;
      try {
        permission = await orientation.requestPermission(true);
      } catch (error) {
        if (!fromTap && error.name === 'NotAllowedError') {
          if (id === session) showNotice('idle', 'Разрешите доступ к компасу', 'Нажмите «Включить компас», чтобы открыть запрос телефона.');
          return;
        }
        throw new Error('Проверьте разрешение на доступ к датчикам для MAX.');
      }
      if (permission !== 'granted') throw new Error('Разрешите доступ к ориентации устройства в настройках MAX.');
    }
    if (id !== session) return;
    showNotice('waiting', saved ? 'Используем локацию расписания' : 'Определяем местоположение', saved ? '' : 'Разрешите доступ к геопозиции.');
    document.getElementById('location-source').hidden = !saved;
    const [position, field] = await Promise.all([
      saved ?? getPosition(id).catch(error => {
        if (id === session) locationFailure(error);
        return null;
      }),
      loadField()
    ]);
    if (id !== session) return;
    const {latitude, longitude} = position.coords;
    const angle = centralAngle(latitude, longitude);
    if (!sufficientlyAccurate(position.coords)) {
      throw new Error('Для этого места нужна более точная геопозиция. Попробуйте у окна или на улице.');
    }
    const target = bearing(latitude, longitude);
    if (target === null) throw new Error('В этой точке однозначное направление определить нельзя.');
    const now = new Date(), year = now.getUTCFullYear();
    const fraction = (now - Date.UTC(year, 0)) / (Date.UTC(year + 1, 0) - Date.UTC(year, 0));
    correction = declination(field, latitude, longitude, year + fraction);
    setDestination(target, angle * 6371);
    sensorsReady = true;
    listenWhenVisible();
  } catch (error) {
    if (id === session) fail('Компас пока недоступен', error.message);
  }
}

function listenWhenVisible() {
  if (!sensorsReady || document.hidden || watchdog !== undefined) return;
  showNotice('waiting', 'Ожидаем компас', 'Держите телефон горизонтально.');
  lastSignal = performance.now();
  for (const event of orientationEvents) window.addEventListener(event, onOrientation);
  watchdog = setInterval(() => {
    if (performance.now() - lastSignal > 5000) {
      fail('Нет надёжного сигнала', 'Телефон не передал направление. Проверьте доступ к датчикам или откройте компас в браузере.');
      browserLink.hidden = new URLSearchParams(location.search).get('external') === '1';
    }
  }, 500);
}

startButton.addEventListener('click', () => startCompass(true));
let pendingAutoStart = true;
function startWhenVisible() {
  if (pendingAutoStart && !document.hidden) {
    pendingAutoStart = false;
    startCompass(false);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (sensorsReady) {
      pauseSensors();
      showNotice('waiting', 'Компас на паузе', '');
    }
  } else {
    startWhenVisible();
    listenWhenVisible();
  }
});
startWhenVisible();
window.WebApp?.ready?.();
