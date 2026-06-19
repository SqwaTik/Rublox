// Веб-чат: WebSocket-соединение, рендер сообщений, автоподстановка команд,
// селектор модели и температуры, индикатор статуса Studio.

const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const typing = document.getElementById('typing');
const suggest = document.getElementById('suggest');
const providerSel = document.getElementById('provider');
const tempSlider = document.getElementById('temp');
const tempVal = document.getElementById('tempVal');
const studioStatus = document.getElementById('studioStatus');

const COMMANDS = [
  ['/help', 'список команд'],
  ['/connect', 'статус подключения к Studio'],
  ['/disconnect', 'отключить плагин'],
  ['/status', 'состояние сессии и соединения'],
  ['/models', 'список провайдеров'],
  ['/model ', 'сменить провайдера'],
  ['/setmodel ', 'имя модели у провайдера'],
  ['/temp ', 'температура 0..2'],
  ['/persona ', 'задать роль'],
  ['/context ', 'добавить заметку в контекст'],
  ['/compact', 'свернуть историю'],
  ['/reset', 'очистить историю'],
  ['/run ', 'выполнить Lua в Studio'],
  ['/insert ', 'вставить ассет по id'],
  ['/console', 'вывод консоли Studio'],
  ['/tree', 'оглавление place'],
  ['/play', 'запустить Play-режим'],
  ['/stop', 'остановить Play-режим'],
  ['/playrun ', 'выполнить код в Play'],
  ['/templates', 'список шаблонов кода'],
  ['/template ', 'вставить шаблон'],
  ['/local ', 'команда на ПК'],
];

let ws;
let suggestIndex = -1;
let streamEl = null; // активный бабл ассистента во время стрима

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    setTyping(false);
    setTimeout(connect, 1500); // авто-переподключение
  };
}

function onMessage(m) {
  if (m.type === 'assistant_start') startStream();
  else if (m.type === 'assistant_delta') appendStream(m.text);
  else if (m.type === 'assistant_end') endStream(m.text);
  else if (m.type === 'assistant') addMsg('assistant', m.text); // совместимость
  else if (m.type === 'error') {
    endStream();
    addMsg('tool err', 'Ошибка: ' + m.text);
  } else if (m.type === 'tool') addMsg('tool', `→ ${m.name}(${JSON.stringify(m.args)})`);
  else if (m.type === 'tool_result')
    addMsg('tool' + (m.ok ? '' : ' err'), `← ${m.name}: ${truncate(m.result, 400)}`);
  else if (m.type === 'typing') setTyping(true);
  else if (m.type === 'done') {
    endStream();
    setTyping(false);
  } else if (m.type === 'status') renderStatus(m.status);
  else if (m.type === 'providers') renderProviders(m.providers);
  else if (m.type === 'session') renderSession(m.info);
}

// ── Стриминговый рендер ────────────────────────────────
function startStream() {
  setTyping(false);
  streamEl = document.createElement('div');
  streamEl.className = 'msg assistant streaming';
  streamEl.textContent = '';
  chat.appendChild(streamEl);
  chat.scrollTop = chat.scrollHeight;
}

function appendStream(chunk) {
  if (!streamEl) startStream();
  streamEl.textContent += chunk;
  chat.scrollTop = chat.scrollHeight;
}

function endStream(finalText) {
  if (!streamEl) return;
  if (typeof finalText === 'string' && finalText.length) {
    streamEl.textContent = finalText;
  }
  streamEl.classList.remove('streaming');
  // Пустой бабл (был только tool-call без текста) убираем.
  if (!streamEl.textContent) streamEl.remove();
  streamEl = null;
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function addMsg(cls, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function setTyping(on) {
  typing.classList.toggle('hidden', !on);
  sendBtn.disabled = on;
}

function renderStatus(s) {
  const connected = s && s.connected;
  studioStatus.classList.toggle('connected', connected);
  studioStatus.classList.toggle('disconnected', !connected);
  const place = s?.studioInfo?.placeName ? ` (${s.studioInfo.placeName})` : '';
  studioStatus.innerHTML =
    `<span class="dot"></span> Studio: ${connected ? 'подключён' + place : 'отключён'}`;
}

function renderProviders(providers) {
  if (!Array.isArray(providers) || !providers.length) return;
  const current = providerSel.value;
  providerSel.innerHTML = '';
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label + (p.ready ? '' : ' (нет ключа)');
    opt.title = p.model || '';
    providerSel.appendChild(opt);
  }
  if (current && providers.some((p) => p.id === current)) providerSel.value = current;
}

function renderSession(info) {
  if (!info) return;
  if (info.provider && [...providerSel.options].some((o) => o.value === info.provider))
    providerSel.value = info.provider;
  if (typeof info.temperature === 'number') {
    tempSlider.value = info.temperature;
    tempVal.textContent = info.temperature;
  }
}

function send(text) {
  if (!text.trim() || ws.readyState !== WebSocket.OPEN) return;
  if (!text.startsWith('/')) addMsg('user', text);
  else addMsg('user', text);
  ws.send(JSON.stringify({ type: 'message', text }));
}

// ── Отправка ───────────────────────────────────────────
function submit() {
  const text = input.value;
  if (!text.trim()) return;
  send(text);
  input.value = '';
  input.style.height = 'auto';
  hideSuggest();
}

sendBtn.addEventListener('click', submit);

input.addEventListener('keydown', (e) => {
  if (!suggest.classList.contains('hidden')) {
    const items = suggest.querySelectorAll('div');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      suggestIndex = Math.min(suggestIndex + 1, items.length - 1);
      updateActive(items);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      suggestIndex = Math.max(suggestIndex - 1, 0);
      updateActive(items);
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && suggestIndex >= 0)) {
      e.preventDefault();
      applySuggest(items[suggestIndex] || items[0]);
      return;
    }
    if (e.key === 'Escape') return hideSuggest();
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  updateSuggest();
});

// ── Автоподстановка команд ─────────────────────────────
function updateSuggest() {
  const val = input.value;
  // Подсказки показываем, только пока вводится имя команды (без пробела).
  if (!val.startsWith('/') || val.includes(' ')) {
    return hideSuggest();
  }
  const matches = COMMANDS.filter(([c]) => c.startsWith(val.trim()));
  if (!matches.length) return hideSuggest();
  suggest.innerHTML = '';
  matches.forEach(([cmd, desc]) => {
    const div = document.createElement('div');
    div.innerHTML = `<b>${cmd}</b> — ${desc}`;
    div.dataset.cmd = cmd;
    div.addEventListener('click', () => applySuggest(div));
    suggest.appendChild(div);
  });
  suggestIndex = 0;
  updateActive(suggest.querySelectorAll('div'));
  suggest.classList.remove('hidden');
}

function updateActive(items) {
  items.forEach((it, i) => it.classList.toggle('active', i === suggestIndex));
}

function applySuggest(item) {
  if (!item) return;
  input.value = item.dataset.cmd;
  hideSuggest();
  input.focus();
}

function hideSuggest() {
  suggest.classList.add('hidden');
  suggestIndex = -1;
}

// ── Контролы модели и температуры ──────────────────────
providerSel.addEventListener('change', () => send('/model ' + providerSel.value));
tempSlider.addEventListener('input', () => {
  tempVal.textContent = tempSlider.value;
});
tempSlider.addEventListener('change', () => send('/temp ' + tempSlider.value));

connect();
