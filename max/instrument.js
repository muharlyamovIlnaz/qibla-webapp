import {delta, wrap} from './compass-math.js';

const svgNamespace = 'http://www.w3.org/2000/svg';
const byId = id => document.getElementById(id);
const panel = byId('console');
const rose = byId('rose');
const needle = byId('needle');
const petals = byId('petals');
const numberFormat = new Intl.NumberFormat('ru-RU');
const directions = ['С', 'ССВ', 'СВ', 'ВСВ', 'В', 'ВЮВ', 'ЮВ', 'ЮЮВ', 'Ю', 'ЮЮЗ', 'ЮЗ', 'ЗЮЗ', 'З', 'ЗСЗ', 'СЗ', 'ССЗ'];
const centerX = 200, centerY = 426;
const holdTime = 800, acquireAngle = 5, releaseAngle = 9;
let target = null, course = null, lastSample = null, holdStart = null, locked = false;
let displayedAngle, shownSector, filledPetals;
const holdTrack = byId('hold-track');

function svgElement(name, attributes) {
  const element = document.createElementNS(svgNamespace, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function text(id, value) {
  const node = byId(id);
  if (node.textContent !== value) node.textContent = value;
}

function displayAngle(angle) {
  if (angle === displayedAngle) return;
  displayedAngle = angle;
  const formatted = angle === null ? '—' : angle + '°';
  text('angle-display', formatted);
  text('offset-value', angle === null ? 'Нет показания' : 'Отклонение ' + formatted);
}

function pointOnDial(degrees, radius) {
  const radians = degrees * Math.PI / 180;
  return [(centerX + radius * Math.sin(radians)).toFixed(2), (centerY - radius * Math.cos(radians)).toFixed(2)].join(' ');
}

function buildDial() {
  const ticks = ['', '', ''];
  for (let angle = 0; angle < 360; angle++) {
    const weight = angle % 15 === 0 ? 2 : angle % 5 === 0 ? 1 : 0;
    ticks[weight] += 'M' + pointOnDial(angle, 350) + 'L' + pointOnDial(angle, [343, 336, 328][weight]);
    if (weight !== 2) continue;
    const cardinal = angle % 90 === 0;
    const label = svgElement('text', {x: centerX, y: 121, transform: 'rotate(' + angle + ' 200 426)'});
    if (cardinal) label.setAttribute('class', angle === 0 ? 'cardinal north' : 'cardinal');
    label.textContent = cardinal ? directions[angle / 22.5] : angle;
    rose.append(label);
  }
  ticks.forEach((d, i) => rose.append(svgElement('path', {
    d, fill: 'none', stroke: ['#94968a', '#b6b8aa', '#e9e8da'][i], 'stroke-width': [.8, 1, 1.6][i]
  })));
  for (let i = 0; i < 8; i++) petals.append(svgElement('path', {
    d: 'M30.5 14.2Q29.6 11.9 32 11.2A31 31 0 0 1 50 11.2Q52.4 11.9 51.5 14.2L44.4 32.1Q43.7 34 41.9 34H40.1Q38.3 34 37.6 32.1Z',
    transform: 'rotate(' + (45 * i) + ' 41 41)'
  }));
}

function showSectors(active, filled) {
  if (active === shownSector && filled === filledPetals) return;
  shownSector = active;
  filledPetals = filled;
  Array.from(petals.children).forEach((petal, index) => {
    petal.classList.toggle('lit', index === active);
    petal.classList.toggle('held', index < filled);
  });
}

function bindDialog(trigger, dialog) {
  trigger.addEventListener('click', () => {
    if (!dialog.open) dialog.showModal();
  });
  dialog.querySelectorAll('button').forEach(button => button.addEventListener('click', () => dialog.close()));
}

function setState(state, title, hint = '') {
  if (panel.dataset.state !== state) panel.dataset.state = state;
  text('status', title);
  text('hint', hint);
  text('sector-label', {hold: 'Удержание', locked: 'Наведено'}[state] || 'Обзор 360°');
  byId('start').hidden = state !== 'idle' && state !== 'error';
}

export function setDestination(bearing, kilometers) {
  target = bearing;
  const bearingText = bearing === null ? '—' : Math.round(bearing) % 360 + '°';
  const distanceText = kilometers === null ? '—' : kilometers < 1 ? '< 1 км' : numberFormat.format(Math.round(kilometers)) + ' км';
  text('bearing', bearingText);
  text('info-bearing', bearingText);
  text('distance', distanceText);
  text('info-distance', distanceText);
}

export function showNotice(state, title, hint) {
  setState(state, title, hint);
  course = lastSample = holdStart = null;
  locked = false;
  panel.removeAttribute('data-tracking');
  displayAngle(null);
  showSectors(-1, 0);
  needle.setAttribute('visibility', 'hidden');
  byId('course-arc').removeAttribute('d');
  text('heading', '—');
  text('cardinal', '');
  text('info-heading', '—');
  byId('start').firstChild.textContent = state === 'error' ? 'Попробовать снова ' : 'Включить компас ';
}

export function showTilt() {
  showNotice('tilt', 'Выровняйте телефон', 'Держите экран горизонтально, лицевой стороной вверх.');
}

export function showHeading(heading, now = performance.now()) {
  if (target === null || !Number.isFinite(heading)) return;
  const elapsed = lastSample === null ? Infinity : now - lastSample;
  if (elapsed > 1500) {
    course = heading;
    holdStart = null;
    locked = false;
  } else {
    course = wrap(course + (1 - Math.exp(-elapsed / 115)) * delta(heading - course));
  }
  lastSample = now;
  const turn = delta(target - course);
  // Demand agreement from the raw and smoothed readings before marking a lock.
  const error = Math.max(Math.abs(turn), Math.abs(delta(target - heading)));
  let acquired = false;
  if (error > (locked ? releaseAngle : acquireAngle)) {
    holdStart = null;
    locked = false;
  } else {
    holdStart ??= now;
    if (!locked && now - holdStart >= holdTime) {
      locked = true;
      acquired = true;
    }
  }

  const isLeft = turn < 0;
  if (locked) setState('locked', 'Вы смотрите в сторону Каабы');
  else if (holdStart !== null) setState('hold', 'Удерживайте направление');
  else if (error <= 24) setState('near', isLeft ? 'Чуть левее' : 'Чуть правее');
  else setState('seek', isLeft ? 'Поверните влево' : 'Поверните вправо');

  panel.setAttribute('data-tracking', '');
  panel.dataset.turn = isLeft ? 'left' : 'right';
  displayAngle(Math.round(Math.abs(turn)));
  const sector = holdStart === null ? Math.round(wrap(turn) / 45) % 8 : -1;
  const held = holdStart === null ? 0 : Math.min(1, (now - holdStart) / holdTime);
  showSectors(sector, Math.floor(8 * held));
  if (holdStart !== null) holdTrack.style.strokeDashoffset = String(100 * (1 - held));

  rose.setAttribute('transform', 'rotate(' + (-course) + ' 200 426)');
  needle.setAttribute('visibility', Math.abs(turn) <= 90 ? 'visible' : 'hidden');
  needle.setAttribute('transform', 'rotate(' + turn + ' 200 426)');
  byId('course-arc').setAttribute('d', 'M200 64A362 362 0 0 ' + (isLeft ? 0 : 1) + ' ' + pointOnDial(turn, 362));

  const azimuth = Math.round(course) % 360 + '°';
  const cardinal = directions[Math.round(course / 22.5) % 16];
  text('heading', azimuth);
  text('cardinal', cardinal);
  text('info-heading', azimuth + ' ' + cardinal);
  return acquired;
}

buildDial();
displayAngle(null);
bindDialog(byId('help'), byId('guide'));
bindDialog(byId('details'), byId('readings'));
