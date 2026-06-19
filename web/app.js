// Веб-чат: WebSocket, мультичаты, поповеры модели/мышления, настройки
// провайдеров с авто-подгрузкой моделей, markdown-рендеринг, статус Studio.

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const input = $('input');
const sendBtn = $('send');
const typing = $('typing');
const suggest = $('suggest');

let ws;
let suggestIndex = -1;
let streamEl = null;
let activeChat = 'default';
let providers = [];
let chats = [];
let modelsCache = {}; // providerId -> [models]

const THINK_LABELS = { minimal: 'Минимум', low: 'Низкий', medium: 'Средний', high: 'Глубокий' };
let current = { provider: 'anthropic', model: 'Claude', thinking: 'medium' };

const COMMANDS = [
  ['/help', 'список команд'], ['/connect', 'статус Studio'], ['/disconnect', 'отключить плагин'],
  ['/status', 'состояние'], ['/models', 'провайдеры'], ['/model ', 'сменить провайдера'],
  ['/setmodel ', 'имя модели'], ['/think ', 'уровень мышления'], ['/persona ', 'роль'],
  ['/context ', 'заметка в контекст'], ['/compact', 'свернуть историю'], ['/reset', 'очистить'],
  ['/run ', 'Lua в Studio'], ['/insert ', 'ассет по id'], ['/console', 'консоль Studio'],
  ['/tree', 'оглавление place'], ['/play', 'запустить Play'], ['/stop', 'остановить Play'],
  ['/playrun ', 'код в Play'], ['/templates', 'шаблоны'], ['/template ', 'вставить шаблон'],
  ['/local ', 'команда на ПК'],
];

// ── WebSocket ──────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => { setTyping(false); setTimeout(connect, 1500); };
}

function onMessage(m) {
  switch (m.type) {
    case 'assistant_start': startStream(); break;
    case 'assistant_delta': appendStream(m.text); break;
    case 'assistant_end': endStream(m.text); break;
    case 'assistant': addMsg('assistant', m.text); break;
    case 'error': endStream(); addMsg('tool err', 'Ошибка: ' + m.text); break;
    case 'tool': addMsg('tool', `→ ${m.name}(${shortArgs(m.args)})`); break;
    case 'tool_result': addMsg('tool' + (m.ok ? '' : ' err'), `← ${m.name}: ${truncate(m.result, 300)}`); break;
    case 'typing': setTyping(true); break;
    case 'done': endStream(); setTyping(false); break;
    case 'status': renderStatus(m.status); break;
    case 'providers': providers = m.providers; renderProviderPickers(); break;
    case 'chats': chats = m.chats; renderChats(); break;
    case 'session': applySession(m.info); break;
  }
}

function shortArgs(a) { const s = JSON.stringify(a || {}); return s.length > 80 ? s.slice(0, 80) + '…' : s; }
function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }

// ── Рендер сообщений ───────────────────────────────────
function addMsg(cls, text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + cls;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (cls.startsWith('assistant')) bubble.innerHTML = window.mdRender(text);
  else bubble.textContent = text;
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  bindCopyButtons(bubble);
  scrollDown();
}

function startStream() {
  setTyping(false);
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.dataset.raw = '';
  bubble.textContent = '';
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  streamEl = bubble;
  scrollDown();
}

function appendStream(chunk) {
  if (!streamEl) startStream();
  streamEl.dataset.raw += chunk;
  streamEl.innerHTML = window.mdRender(streamEl.dataset.raw);
  scrollDown();
}

function endStream(finalText) {
  if (!streamEl) return;
  const raw = typeof finalText === 'string' && finalText.length ? finalText : streamEl.dataset.raw;
  if (!raw) { streamEl.parentElement.remove(); streamEl = null; return; }
  streamEl.innerHTML = window.mdRender(raw);
  bindCopyButtons(streamEl);
  streamEl = null;
}

function bindCopyButtons(scope) {
  scope.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.onclick = () => {
      const code = btn.parentElement.querySelector('code');
      navigator.clipboard.writeText(code.textContent);
      btn.textContent = '✓';
      setTimeout(() => (btn.textContent = 'copy'), 1200);
    };
  });
}

function setTyping(on) { typing.classList.toggle('hidden', !on); sendBtn.disabled = on; }
function scrollDown() { chat.scrollTop = chat.scrollHeight; }

// ── Статус Studio (кликабельный) ───────────────────────
function renderStatus(s) {
  const connected = s && s.connected;
  const chip = $('studioStatus');
  chip.classList.toggle('connected', connected);
  chip.classList.toggle('disconnected', !connected);
  const place = s?.studioInfo?.placeName ? ` (${s.studioInfo.placeName})` : '';
  $('studioText').textContent = connected ? 'Studio: подключён' + place : 'Studio: отключён';
}

$('studioStatus').onclick = async () => {
  // Клик по статусу: если отключён — предлагаем установить плагин.
  const s = await fetch('/api/status').then((r) => r.json()).catch(() => null);
  if (s && s.connected) {
    send('/disconnect');
  } else {
    if (confirm('Studio не подключён. Установить плагин в Roblox автоматически?')) {
      installPlugin();
    }
  }
};

// ── Чаты ───────────────────────────────────────────────
function renderChats() {
  const list = $('chatList');
  list.innerHTML = '';
  const seen = new Set();
  const all = [{ id: 'default', title: 'Главный чат' }, ...chats.filter((c) => c.id !== 'default')];
  for (const c of all) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === activeChat ? ' active' : '');
    item.innerHTML = `<span class="ci-title">${escapeText(c.title || c.id)}</span>` +
      (c.id !== 'default' ? '<span class="ci-del" title="Удалить">🗑</span>' : '');
    item.querySelector('.ci-title').onclick = () => switchChat(c.id);
    const del = item.querySelector('.ci-del');
    if (del) del.onclick = (e) => { e.stopPropagation(); deleteChat(c.id); };
    list.appendChild(item);
  }
}

function escapeText(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function switchChat(id) {
  activeChat = id;
  chat.innerHTML = '';
  renderChats();
  // Заголовок
  const c = chats.find((x) => x.id === id);
  $('chatTitle').textContent = c?.title || (id === 'default' ? 'Главный чат' : 'Чат');
}

$('newChat').onclick = async () => {
  const r = await fetch('/api/chats', { method: 'POST' }).then((r) => r.json());
  await refreshChats();
  switchChat(r.chat.id);
};

async function deleteChat(id) {
  await fetch('/api/chats/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (activeChat === id) switchChat('default');
  refreshChats();
}

async function refreshChats() {
  const r = await fetch('/api/chats').then((r) => r.json());
  chats = r.chats; renderChats();
}

function applySession(info) {
  if (!info) return;
  if (info.id === activeChat) {
    if (info.provider) current.provider = info.provider;
    if (info.model) current.model = info.model;
    if (info.thinking) current.thinking = info.thinking;
    $('chatTitle').textContent = info.title || $('chatTitle').textContent;
    updatePills();
  }
}

// ── Мини-пикер модели и мышления ───────────────────────
function updatePills() {
  const prov = providers.find((p) => p.id === current.provider);
  $('modelPillText').textContent = current.model || (prov ? prov.label : current.provider);
  $('thinkPillText').textContent = THINK_LABELS[current.thinking] || 'Средний';
}

function renderProviderPickers() {
  // Заполнить select в поповере и в настройках
  const sel = $('popProvider');
  sel.innerHTML = '';
  for (const p of providers) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.label + (p.ready ? '' : ' (нет ключа)');
    sel.appendChild(o);
  }
  sel.value = current.provider;
  updatePills();
  renderProviderList();
}

const modelPopover = $('modelPopover');
$('modelPill').onclick = () => openPopover(modelPopover, $('modelPill'), () => loadModelList());
$('popProvider').onchange = () => { current.provider = $('popProvider').value; loadModelList(); };
$('modelSearch').oninput = () => loadModelList($('modelSearch').value);

async function loadModelList(filter = '') {
  const list = $('modelList');
  const pid = $('popProvider').value;
  list.innerHTML = '<div class="pop-item">Загрузка…</div>';
  let models = modelsCache[pid];
  if (!models) {
    try {
      const r = await fetch('/api/models', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: pid }),
      }).then((r) => r.json());
      models = r.models || [];
      modelsCache[pid] = models;
    } catch { models = []; }
  }
  const f = filter.toLowerCase();
  const shown = models.filter((m) => m.toLowerCase().includes(f));
  list.innerHTML = '';
  if (!shown.length) { list.innerHTML = '<div class="pop-item">Моделей нет (проверьте токен)</div>'; return; }
  for (const m of shown) {
    const item = document.createElement('div');
    item.className = 'pop-item' + (m === current.model && pid === current.provider ? ' active' : '');
    item.innerHTML = `<span>${escapeText(m)}</span>`;
    item.onclick = () => {
      current.provider = pid; current.model = m;
      send('/model ' + pid);
      setTimeout(() => send('/setmodel ' + m), 60);
      updatePills();
      closePopovers();
    };
    list.appendChild(item);
  }
}

// Поповер мышления
const thinkPopover = $('thinkPopover');
$('thinkPill').onclick = () => {
  const list = $('thinkList');
  list.innerHTML = '';
  for (const [k, label] of Object.entries(THINK_LABELS)) {
    const item = document.createElement('div');
    item.className = 'pop-item' + (k === current.thinking ? ' active' : '');
    item.innerHTML = `<span>${label}</span>`;
    item.onclick = () => { current.thinking = k; send('/think ' + k); updatePills(); closePopovers(); };
    list.appendChild(item);
  }
  openPopover(thinkPopover, $('thinkPill'));
};

function openPopover(pop, anchor, after) {
  closePopovers();
  const r = anchor.getBoundingClientRect();
  pop.style.left = r.left + 'px';
  pop.style.bottom = (window.innerHeight - r.top + 8) + 'px';
  pop.classList.remove('hidden');
  if (after) after();
}
function closePopovers() {
  modelPopover.classList.add('hidden');
  thinkPopover.classList.add('hidden');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.popover') && !e.target.closest('.pill')) closePopovers();
});

// ── Настройки провайдеров ──────────────────────────────
$('openSettings').onclick = () => $('settingsOverlay').classList.remove('hidden');
$('closeSettings').onclick = () => $('settingsOverlay').classList.add('hidden');
$('settingsOverlay').onclick = (e) => { if (e.target === $('settingsOverlay')) $('settingsOverlay').classList.add('hidden'); };

function renderProviderList() {
  const list = $('providerList');
  if (!list) return;
  list.innerHTML = '';
  for (const p of providers) {
    const row = document.createElement('div');
    row.className = 'prov-row';
    row.innerHTML =
      `<div class="pr-info"><span class="pr-name">${escapeText(p.label)}</span>` +
      `<span class="pr-sub">${escapeText(p.id)} · ${escapeText(p.model || '—')}</span></div>` +
      `<span class="pr-badge ${p.hasKey ? 'ok' : 'no'}">${p.hasKey ? 'ключ есть' : 'нет ключа'}</span>`;
    row.onclick = () => fillProviderForm(p);
    list.appendChild(row);
  }
}

function fillProviderForm(p) {
  $('pf-id').value = p.id; $('pf-label').value = p.label || '';
  $('pf-kind').value = p.kind || 'openai'; $('pf-baseUrl').value = p.baseUrl || '';
  $('pf-model').value = p.model || ''; $('pf-apiKey').value = '';
}

$('pf-fetch').onclick = async () => {
  const hint = $('pf-hint'); hint.className = 'form-hint'; hint.textContent = 'Подгрузка моделей…';
  const body = {
    provider: $('pf-id').value.trim() || 'temp-' + $('pf-kind').value,
    id: $('pf-id').value.trim() || 'temp-' + $('pf-kind').value,
    label: $('pf-label').value.trim(),
    kind: $('pf-kind').value,
    baseUrl: $('pf-baseUrl').value.trim(),
    apiKey: $('pf-apiKey').value,
    model: $('pf-model').value.trim(),
  };
  try {
    // Сохраняем провайдера, затем тянем модели.
    await fetch('/api/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = await fetch('/api/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: body.id }) }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    const sel = $('pf-models');
    sel.innerHTML = '';
    (r.models || []).forEach((m) => { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); });
    sel.classList.remove('hidden');
    sel.onchange = () => ($('pf-model').value = sel.value);
    if (r.models?.length) $('pf-model').value = r.models[0];
    hint.className = 'form-hint ok';
    hint.textContent = `Найдено моделей: ${r.models?.length || 0}. Выберите рабочую из списка.`;
    modelsCache[body.id] = r.models;
  } catch (e) {
    hint.className = 'form-hint err';
    hint.textContent = 'Ошибка: ' + e.message + ' — проверьте URL и токен.';
  }
};

$('pf-save').onclick = async () => {
  const hint = $('pf-hint');
  const body = {
    id: $('pf-id').value.trim(), label: $('pf-label').value.trim(),
    kind: $('pf-kind').value, baseUrl: $('pf-baseUrl').value.trim(),
    apiKey: $('pf-apiKey').value, model: $('pf-model').value.trim(),
  };
  if (!body.id || !body.baseUrl) { hint.className = 'form-hint err'; hint.textContent = 'Заполните ID и Base URL.'; return; }
  const r = await fetch('/api/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  if (r.ok) { hint.className = 'form-hint ok'; hint.textContent = 'Провайдер сохранён.'; modelsCache[body.id] = null; }
  else { hint.className = 'form-hint err'; hint.textContent = 'Ошибка: ' + (r.error || '?'); }
};

// ── Установка плагина ──────────────────────────────────
async function installPlugin() {
  try {
    const r = await fetch('/api/install-plugin', { method: 'POST' }).then((r) => r.json());
    if (r.ok) addMsg('tool', '✓ ' + r.message + '\n' + r.installedTo);
    else addMsg('tool err', 'Ошибка установки: ' + (r.error || '?'));
  } catch (e) { addMsg('tool err', 'Ошибка: ' + e.message); }
}
$('installPlugin').onclick = installPlugin;

// ── Сайдбар (мобайл) ───────────────────────────────────
$('toggleSidebar').onclick = () => $('sidebar').classList.toggle('open');

// ── Отправка ───────────────────────────────────────────
function send(text) {
  if (!text.trim() || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'message', text, chatId: activeChat }));
}

function submit() {
  const text = input.value;
  if (!text.trim()) return;
  if (!text.startsWith('/') || true) addMsg('user', text);
  send(text);
  input.value = '';
  input.style.height = 'auto';
  hideSuggest();
}

sendBtn.onclick = submit;

input.addEventListener('keydown', (e) => {
  if (!suggest.classList.contains('hidden')) {
    const items = suggest.querySelectorAll('div');
    if (e.key === 'ArrowDown') { e.preventDefault(); suggestIndex = Math.min(suggestIndex + 1, items.length - 1); updateActive(items); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); suggestIndex = Math.max(suggestIndex - 1, 0); updateActive(items); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && suggestIndex >= 0)) { e.preventDefault(); applySuggest(items[suggestIndex] || items[0]); return; }
    if (e.key === 'Escape') return hideSuggest();
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  updateSuggest();
});

// ── Автоподстановка команд ─────────────────────────────
function updateSuggest() {
  const val = input.value;
  if (!val.startsWith('/') || val.includes(' ')) return hideSuggest();
  const matches = COMMANDS.filter(([c]) => c.startsWith(val.trim()));
  if (!matches.length) return hideSuggest();
  suggest.innerHTML = '';
  matches.forEach(([cmd, desc]) => {
    const div = document.createElement('div');
    div.innerHTML = `<b>${cmd}</b> — ${desc}`;
    div.dataset.cmd = cmd;
    div.onclick = () => applySuggest(div);
    suggest.appendChild(div);
  });
  suggestIndex = 0;
  updateActive(suggest.querySelectorAll('div'));
  suggest.classList.remove('hidden');
}
function updateActive(items) { items.forEach((it, i) => it.classList.toggle('active', i === suggestIndex)); }
function applySuggest(item) { if (!item) return; input.value = item.dataset.cmd; hideSuggest(); input.focus(); }
function hideSuggest() { suggest.classList.add('hidden'); suggestIndex = -1; }

connect();
updatePills();
