import {bearing, centralAngle, declination, wrap} from './compass-math.js';
import {setDestination, showHeading, showNotice, showTilt} from './instrument.js';

const orientationEvents = ['deviceorientationabsolute', 'deviceorientation'];
const startButton = document.getElementById('start');
let session = 0, correction = null, lastSignal = 0, watchdog;
let fieldRequest;

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

function stop() {
  session++;
  clearInterval(watchdog);
  for (const event of orientationEvents) window.removeEventListener(event, onOrientation);
  correction = null;
  setDestination(null, null);
}

function fail(title, hint) {
  stop();
  showNotice('error', title, hint);
}

function onOrientation(event) {
  let heading;
  if (Number.isFinite(event.webkitCompassHeading)) {
    lastSignal = performance.now();
    if (correction === null) {
      fail('Не удалось уточнить север', 'Попробуйте снова, когда доступна модель магнитного поля для вашего места.');
      return;
    }
    const accuracy = event.webkitCompassAccuracy;
    if (event.webkitCompassHeading < 0 || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 15) {
      showNotice('calibrate', 'Настройте компас', 'Медленно опишите телефоном восьмёрку. Образец движения — в «Калибровке».');
      return;
    }
    heading = event.webkitCompassHeading + correction;
  } else {
    if (!event.absolute || !Number.isFinite(event.alpha)) return;
    lastSignal = performance.now();
    heading = 360 - event.alpha;
  }
  if (!Number.isFinite(event.beta) || !Number.isFinite(event.gamma) || Math.abs(event.beta) > 16 || Math.abs(event.gamma) > 16) {
    showTilt();
    return;
  }
  const course = wrap(heading + (screen.orientation?.angle ?? window.orientation ?? 0));
  if (showHeading(course, lastSignal)) navigator.vibrate?.(55);
}

startButton.addEventListener('click', async () => {
  stop();
  const id = session;
  showNotice('waiting', 'Подключаем компас', '');
  try {
    if (!window.isSecureContext || !navigator.geolocation || !window.DeviceOrientationEvent) {
      throw new Error('Откройте компас на телефоне по HTTPS и разрешите доступ к датчикам.');
    }
    const orientation = window.DeviceOrientationEvent;
    if (orientation.requestPermission && await orientation.requestPermission(true) !== 'granted') {
      throw new Error('Разрешите доступ к ориентации устройства в настройках MAX.');
    }
    if (id !== session) return;
    showNotice('waiting', 'Определяем местоположение', 'Разрешите доступ к геопозиции.');
    const [position, field] = await Promise.all([
      new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, timeout: 15000, maximumAge: 30000
      })),
      loadField()
    ]);
    if (id !== session) return;
    const {latitude, longitude, accuracy} = position.coords;
    const angle = centralAngle(latitude, longitude);
    if (!Number.isFinite(accuracy) || accuracy > 6371000 * Math.sin(angle) * .07) {
      throw new Error('Для этого места нужна более точная геопозиция. Попробуйте у окна или на улице.');
    }
    const target = bearing(latitude, longitude);
    if (target === null) throw new Error('В этой точке однозначное направление определить нельзя.');
    const now = new Date(), year = now.getUTCFullYear();
    const fraction = (now - Date.UTC(year, 0)) / (Date.UTC(year + 1, 0) - Date.UTC(year, 0));
    correction = declination(field, latitude, longitude, year + fraction);
    setDestination(target, angle * 6371);
    showNotice('waiting', 'Ожидаем компас', 'Держите телефон горизонтально.');
    lastSignal = performance.now();
    for (const event of orientationEvents) window.addEventListener(event, onOrientation);
    watchdog = setInterval(() => {
      if (performance.now() - lastSignal > 5000) fail('Нет надёжного сигнала', 'Проверьте доступ к датчикам и отойдите от металла.');
    }, 500);
  } catch (error) {
    if (id === session) fail('Компас пока недоступен', error.code ? 'Проверьте разрешение на геопозицию и попробуйте снова.' : error.message);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stop();
    showNotice('idle', 'Держите телефон ровно', '');
  }
});
window.WebApp?.ready?.();
