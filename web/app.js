// Rublox — фронтенд. WebSocket-чат, мультичаты с историей на диске,
// переименование, минипикеры справа, настройки с вкладками, шаблоны
// провайдеров, превью моделей, worklog-индикатор, i18n, SVG-иконки.

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const input = $('input');
const sendBtn = $('send');
const worklog = $('worklog');
const suggest = $('suggest');

let ws;
let suggestIndex = -1;
let streamEl = null;
let activeChat = 'default';
let providers = [];
let templates = [];
let chats = [];
let modelsCache = {};
let workTimer = null;
let workStart = 0;

const THINK_LEVELS = ['min', 'low', 'high', 'max'];
const THINK_LABELS = { min: 'Min', low: 'Low', high: 'High', max: 'Max' };
let current = { provider: null, model: null, thinking: 'high' };

const COMMANDS = [
  ['/help', 'commands'], ['/connect', 'studio status'], ['/disconnect', 'disconnect plugin'],
  ['/models', 'providers'], ['/model ', 'switch provider'], ['/setmodel ', 'model name'],
  ['/think ', 'reasoning level'], ['/persona ', 'role'], ['/context ', 'context note'],
  ['/compact', 'compress history'], ['/reset', 'clear'], ['/run ', 'Lua in Studio'],
  ['/insert ', 'asset by id'], ['/console', 'Studio console'], ['/tree', 'place outline'],
  ['/play', 'start Play'], ['/stop', 'stop Play'], ['/playrun ', 'code in Play'],
  ['/templates', 'templates'], ['/template ', 'apply template'], ['/local ', 'PC command'],
];

// ── Иконки и i18n ──────────────────────────────────────
function paintIcons(scope = document) {
  scope.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.painted) return;
    const svg = window.ICON[el.dataset.icon];
    if (svg) { el.innerHTML = svg; el.dataset.painted = '1'; }
  });
}
function applyI18n() {
  document.querySelectorAll('[data-t]').forEach((el) => {
    const txt = window.t(el.dataset.t);
    // сохраняем вложенную иконку, меняем только текстовый узел
    const iconHost = el.previousElementSibling;
    el.textContent = txt;
  });
  document.querySelectorAll('[data-t-ph]').forEach((el) => { el.placeholder = window.t(el.dataset.tPh); });
}

// ── WebSocket ──────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => { stopWork(); setTimeout(connect, 1500); };
}

function onMessage(m) {
  switch (m.type) {
    case 'status_work': updateWork(m.text, m.tokens); break;
    case 'assistant_start': startStream(); break;
    case 'assistant_delta': appendStream(m.text); break;
    case 'assistant_end': endStream(m.text); break;
    case 'assistant': addMsg('assistant', m.text); break;
    case 'error': endStream(); stopWork(); addMsg('tool err', 'Error: ' + m.text); break;
    case 'tool': addMsg('tool', `${m.name}(${shortArgs(m.args)})`); break;
    case 'tool_result': addMsg('tool' + (m.ok ? '' : ' err'), `${m.name}: ${truncate(m.result, 280)}`); break;
    case 'done': endStream(); stopWork(); break;
    case 'status': renderStatus(m.status); break;
    case 'providers': providers = m.providers; renderProviderPickers(); break;
    case 'chats': chats = m.chats; renderChats(); break;
    case 'session': applySession(m.info); break;
  }
}

function shortArgs(a) { const s = JSON.stringify(a || {}); return s.length > 70 ? s.slice(0, 70) + '…' : s; }
function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }

// ── Worklog (как в Claude Code) ────────────────────────
function startWork() {
  workStart = Date.now();
  worklog.classList.remove('hidden');
  if (workTimer) clearInterval(workTimer);
  workTimer = setInterval(() => updateWork(), 1000);
}
function updateWork(text, tokens) {
  if (worklog.classList.contains('hidden')) startWork();
  if (text) worklog.dataset.text = text;
  if (typeof tokens === 'number') worklog.dataset.tokens = tokens;
  const secs = Math.floor((Date.now() - workStart) / 1000);
  const mm = Math.floor(secs / 60), ss = secs % 60;
  const time = mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
  const tk = Number(worklog.dataset.tokens || 0);
  const tkStr = tk >= 1000 ? (tk / 1000).toFixed(1) + 'k' : tk;
  $('worklogText').textContent = (worklog.dataset.text || 'Thinking') + '…';
  $('worklogMeta').textContent = `(${time} · ↓ ${tkStr} tokens)`;
}
function stopWork() {
  worklog.classList.add('hidden');
  if (workTimer) { clearInterval(workTimer); workTimer = null; }
  worklog.dataset.text = ''; worklog.dataset.tokens = 0;
}

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
  bindCopy(bubble);
  scrollDown();
}
function startStream() {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble'; bubble.dataset.raw = '';
  wrap.appendChild(bubble); chat.appendChild(wrap);
  streamEl = bubble; scrollDown();
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
  bindCopy(streamEl); streamEl = null;
}
function bindCopy(scope) {
  scope.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.onclick = () => {
      navigator.clipboard.writeText(btn.parentElement.querySelector('code').textContent);
      btn.textContent = '✓'; setTimeout(() => (btn.textContent = 'copy'), 1200);
    };
  });
}
function scrollDown() { chat.scrollTop = chat.scrollHeight; }

// ── Статус Studio ──────────────────────────────────────
function renderStatus(s) {
  const connected = s && s.connected;
  const chip = $('studioStatus');
  chip.classList.toggle('connected', connected);
  chip.classList.toggle('disconnected', !connected);
  const place = s?.studioInfo?.placeName ? ` (${s.studioInfo.placeName})` : '';
  $('studioText').textContent = connected ? window.t('studioOn') + place : window.t('studioOff');
}
$('studioStatus').onclick = async () => {
  const s = await fetch('/api/status').then((r) => r.json()).catch(() => null);
  if (s && s.connected) send('/disconnect');
  else if (confirm(window.t('confirmInstall'))) installPlugin();
};

// ── Чаты ───────────────────────────────────────────────
function renderChats() {
  const list = $('chatList');
  list.innerHTML = '';
  const seen = new Set();
  const all = [{ id: 'default', title: window.t('mainChat') }, ...chats.filter((c) => c.id !== 'default')];
  for (const c of all) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === activeChat ? ' active' : '');
    const title = document.createElement('span');
    title.className = 'ci-title'; title.textContent = c.title || c.id;
    title.onclick = () => switchChat(c.id);
    const act = document.createElement('span');
    act.className = 'ci-act';
    const ren = document.createElement('span');
    ren.innerHTML = window.ICON.edit; ren.title = window.t('rename');
    ren.onclick = (e) => { e.stopPropagation(); renameChat(c.id, c.title); };
    act.appendChild(ren);
    if (c.id !== 'default') {
      const del = document.createElement('span');
      del.className = 'ci-del'; del.innerHTML = window.ICON.trash; del.title = window.t('delete');
      del.onclick = (e) => { e.stopPropagation(); deleteChat(c.id); };
      act.appendChild(del);
    }
    item.appendChild(title); item.appendChild(act);
    list.appendChild(item);
  }
}

async function switchChat(id) {
  activeChat = id;
  chat.innerHTML = '';
  // Загружаем историю с сервера — она хранится на диске.
  const r = await fetch('/api/chats/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }).then((r) => r.json()).catch(() => null);
  if (r) {
    for (const m of r.messages || []) {
      if (m.role === 'user') addMsg('user', m.text);
      else if (m.role === 'assistant') addMsg('assistant', m.text);
      else addMsg('tool', m.text);
    }
    applySession(r.info);
  }
  renderChats();
}

function renameChat(id, oldTitle) {
  const title = prompt(window.t('rename'), oldTitle || '');
  if (title == null) return;
  fetch('/api/chats/rename', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, title }),
  }).then((r) => r.json()).then((r) => { chats = r.chats; renderChats(); if (id === activeChat) $('chatTitle').textContent = title; });
}

$('chatTitle').ondblclick = () => renameChat(activeChat, $('chatTitle').textContent);

$('newChat').onclick = async () => {
  const r = await fetch('/api/chats', { method: 'POST' }).then((r) => r.json());
  await refreshChats(); switchChat(r.chat.id);
};
async function deleteChat(id) {
  await fetch('/api/chats/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  if (activeChat === id) switchChat('default');
  refreshChats();
}
$('deleteAll').onclick = async () => {
  if (!confirm(window.t('confirmDeleteAll'))) return;
  const r = await fetch('/api/chats/delete-all', { method: 'POST' }).then((r) => r.json());
  chats = r.chats; activeChat = 'default'; chat.innerHTML = ''; renderChats();
};
async function refreshChats() { const r = await fetch('/api/chats').then((r) => r.json()); chats = r.chats; renderChats(); }

function applySession(info) {
  if (!info || info.id !== activeChat) return;
  current.provider = info.provider; current.model = info.model; current.thinking = info.thinking || 'high';
  $('chatTitle').textContent = info.title || $('chatTitle').textContent;
  updatePills();
}

// ── Минипикеры ─────────────────────────────────────────
function updatePills() {
  $('modelPillText').textContent = current.model || 'No model';
  $('thinkPillText').textContent = THINK_LABELS[current.thinking] || 'High';
}
function renderProviderPickers() {
  const sel = $('popProvider');
  sel.innerHTML = '';
  if (!providers.length) {
    const o = document.createElement('option'); o.textContent = '— add a provider in Settings —'; o.value = '';
    sel.appendChild(o);
  }
  for (const p of providers) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.label; sel.appendChild(o);
  }
  if (current.provider) sel.value = current.provider;
  updatePills(); renderProviderList();
}

const modelPopover = $('modelPopover');
$('modelPill').onclick = (e) => { e.stopPropagation(); togglePopover(modelPopover, $('modelPill'), () => loadModelList()); };
$('popProvider').onchange = () => { current.provider = $('popProvider').value; loadModelList(); };
$('modelSearch').oninput = () => loadModelList($('modelSearch').value);

async function loadModelList(filter = '') {
  const list = $('modelList');
  const pid = $('popProvider').value;
  if (!pid) { list.innerHTML = '<div class="pop-item">No provider selected</div>'; return; }
  list.innerHTML = '<div class="pop-item">Loading…</div>';
  let models = modelsCache[pid];
  if (!models) {
    try {
      const r = await fetch('/api/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: pid }) }).then((r) => r.json());
      models = r.models || []; modelsCache[pid] = models;
    } catch { models = []; }
  }
  const f = filter.toLowerCase();
  const shown = models.filter((m) => m.toLowerCase().includes(f));
  list.innerHTML = '';
  if (!shown.length) { list.innerHTML = '<div class="pop-item">No models (check key)</div>'; return; }
  for (const m of shown) {
    const item = document.createElement('div');
    item.className = 'pop-item' + (m === current.model && pid === current.provider ? ' active' : '');
    item.textContent = m;
    item.onclick = () => {
      current.provider = pid; current.model = m;
      send('/model ' + pid); setTimeout(() => send('/setmodel ' + m), 60);
      updatePills(); closePopovers();
    };
    list.appendChild(item);
  }
}

$('thinkPill').onclick = (e) => {
  e.stopPropagation();
  const list = $('thinkList');
  list.innerHTML = '';
  for (const k of THINK_LEVELS) {
    const item = document.createElement('div');
    item.className = 'pop-item' + (k === current.thinking ? ' active' : '');
    item.textContent = THINK_LABELS[k];
    item.onclick = () => { current.thinking = k; send('/think ' + k); updatePills(); closePopovers(); };
    list.appendChild(item);
  }
  togglePopover($('thinkPopover'), $('thinkPill'));
};

function togglePopover(pop, anchor, after) {
  const wasOpen = !pop.classList.contains('hidden');
  closePopovers();
  if (wasOpen) return; // повторный клик закрывает
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.left, window.innerWidth - 340) + 'px';
  pop.style.bottom = (window.innerHeight - r.top + 8) + 'px';
  pop.classList.remove('hidden');
  if (after) after();
}
function closePopovers() { modelPopover.classList.add('hidden'); $('thinkPopover').classList.add('hidden'); }
document.addEventListener('click', (e) => {
  if (!e.target.closest('.popover') && !e.target.closest('.pill')) closePopovers();
});

// ── Настройки ──────────────────────────────────────────
$('openSettings').onclick = () => { $('settingsOverlay').classList.remove('hidden'); renderTemplates(); };
$('closeSettings').onclick = () => $('settingsOverlay').classList.add('hidden');
$('settingsOverlay').onclick = (e) => { if (e.target === $('settingsOverlay')) $('settingsOverlay').classList.add('hidden'); };
document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`.tab-pane[data-pane="${tab.dataset.tab}"]`).classList.add('active');
  };
});

function renderProviderList() {
  const list = $('providerList');
  if (!list) return;
  list.innerHTML = '';
  if (!providers.length) {
    list.innerHTML = `<div class="form-hint">${window.t('noProviders')}</div>`;
    return;
  }
  for (const p of providers) {
    const row = document.createElement('div');
    row.className = 'prov-row';
    const badge = p.hasKey ? `<span class="pr-badge ok">key</span>` : '';
    row.innerHTML = `<div><div class="pr-name">${p.label}</div><div class="pr-sub">${p.id} · ${p.model || '—'}</div></div>${badge}`;
    row.onclick = () => fillForm(p);
    list.appendChild(row);
  }
}
function renderTemplates() {
  const grid = $('templateGrid');
  if (!grid || !templates.length) return;
  grid.innerHTML = '';
  for (const t of templates) {
    const el = document.createElement('div');
    el.className = 'tpl';
    el.innerHTML = `<div class="tpl-name">${t.label}</div><div class="tpl-note">${t.note || ''}</div>`;
    el.onclick = () => fillForm({ id: t.id, label: t.label, kind: t.kind, baseUrl: t.baseUrl, model: t.model });
    grid.appendChild(el);
  }
}
function fillForm(p) {
  $('pf-id').value = p.id || ''; $('pf-label').value = p.label || '';
  $('pf-kind').value = p.kind || 'multi'; $('pf-baseUrl').value = p.baseUrl || '';
  $('pf-model').value = p.model || ''; $('pf-apiKey').value = '';
  $('pf-models').classList.add('hidden'); $('pf-hint').textContent = '';
}
function formBody() {
  return {
    id: $('pf-id').value.trim(), label: $('pf-label').value.trim(), kind: $('pf-kind').value,
    baseUrl: $('pf-baseUrl').value.trim(), apiKey: $('pf-apiKey').value, model: $('pf-model').value.trim(),
  };
}
$('pf-fetch').onclick = async () => {
  const hint = $('pf-hint'); hint.className = 'form-hint'; hint.textContent = '…';
  const body = formBody();
  if (!body.id || !body.baseUrl) { hint.className = 'form-hint err'; hint.textContent = 'Need ID and Base URL'; return; }
  try {
    await fetch('/api/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = await fetch('/api/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: body.id }) }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    const sel = $('pf-models'); sel.innerHTML = '';
    (r.models || []).forEach((m) => { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); });
    sel.classList.remove('hidden');
    sel.onchange = () => ($('pf-model').value = sel.value);
    if (r.models?.length) $('pf-model').value = r.models[0];
    modelsCache[body.id] = r.models;
    hint.className = 'form-hint ok'; hint.textContent = `${window.t('fetchOk')}: ${r.models?.length || 0}`;
  } catch (e) { hint.className = 'form-hint err'; hint.textContent = `${window.t('fetchFail')}: ${e.message}`; }
};
$('pf-save').onclick = async () => {
  const hint = $('pf-hint'); const body = formBody();
  if (!body.id || !body.baseUrl) { hint.className = 'form-hint err'; hint.textContent = 'Need ID and Base URL'; return; }
  const r = await fetch('/api/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  if (r.ok) { hint.className = 'form-hint ok'; hint.textContent = window.t('save') + ' ✓'; modelsCache[body.id] = null; refreshProviders(); }
  else { hint.className = 'form-hint err'; hint.textContent = r.error || '?'; }
};
$('pf-delete').onclick = async () => {
  const id = $('pf-id').value.trim();
  if (!id) return;
  await fetch('/api/providers/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  fillForm({}); refreshProviders();
};
async function refreshProviders() {
  const r = await fetch('/api/providers').then((r) => r.json());
  providers = r.providers; renderProviderPickers();
}

// ── Установка плагина ──────────────────────────────────
async function installPlugin() {
  try {
    const r = await fetch('/api/install-plugin', { method: 'POST' }).then((r) => r.json());
    if (r.ok) addMsg('tool', r.message + '\n' + r.installedTo);
    else addMsg('tool err', 'Install error: ' + (r.error || '?'));
  } catch (e) { addMsg('tool err', 'Error: ' + e.message); }
}
$('installPlugin').onclick = installPlugin;
$('toggleSidebar').onclick = () => $('sidebar').classList.toggle('open');

// ── Настройки внешнего вида ────────────────────────────
$('set-lang').onchange = () => { window.setLang($('set-lang').value); applyI18n(); renderChats(); };
$('set-theme').onchange = () => {
  const v = $('set-theme').value;
  if (v === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('theme', v);
};

// ── Управление окном (Electron) ────────────────────────
function winCtl(action) {
  if (window.rublox && window.rublox.win) window.rublox.win(action);
}
$('winMin').onclick = () => winCtl('min');
$('winMax').onclick = () => winCtl('max');
$('winClose').onclick = () => winCtl('close');

// ── Отправка ───────────────────────────────────────────
function send(text) {
  if (!text.trim() || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'message', text, chatId: activeChat }));
}
function submit() {
  const text = input.value;
  if (!text.trim()) return;
  addMsg('user', text);
  send(text);
  input.value = ''; input.style.height = 'auto'; hideSuggest();
  startWork();
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
function updateSuggest() {
  const val = input.value;
  if (!val.startsWith('/') || val.includes(' ')) return hideSuggest();
  const matches = COMMANDS.filter(([c]) => c.startsWith(val.trim()));
  if (!matches.length) return hideSuggest();
  suggest.innerHTML = '';
  matches.forEach(([cmd, desc]) => {
    const div = document.createElement('div');
    div.innerHTML = `<b>${cmd}</b> — ${desc}`; div.dataset.cmd = cmd;
    div.onclick = () => applySuggest(div); suggest.appendChild(div);
  });
  suggestIndex = 0; updateActive(suggest.querySelectorAll('div')); suggest.classList.remove('hidden');
}
function updateActive(items) { items.forEach((it, i) => it.classList.toggle('active', i === suggestIndex)); }
function applySuggest(item) { if (!item) return; input.value = item.dataset.cmd; hideSuggest(); input.focus(); }
function hideSuggest() { suggest.classList.add('hidden'); suggestIndex = -1; }

// ── Инициализация ──────────────────────────────────────
async function init() {
  // тема и язык
  const savedTheme = localStorage.getItem('theme') || 'red';
  if (savedTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  $('set-theme').value = savedTheme;
  $('set-lang').value = window.getLang();
  paintIcons(); applyI18n();
  // шаблоны провайдеров
  try { templates = (await fetch('/api/provider-templates').then((r) => r.json())).templates || []; } catch { templates = []; }
  // about
  document.querySelector('[data-t="aboutText"]').textContent = window.t('aboutText');
  connect();
  updatePills();
}
init();
