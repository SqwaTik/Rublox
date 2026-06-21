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
let myCid = null; // id этого клиента (для реалтайм-синхронизации между окнами)
let providers = [];
let templates = [];
let chats = [];
let modelsCache = {};
let workTimer = null;
let workStart = 0;
let sending = false;                 // идёт ли генерация в активном чате
const busyChats = new Set();         // чаты, где сейчас работает агент
const reloadOnDone = new Set();      // чаты, историю которых надо перезагрузить по 'done'

// Ограничения для производительности больших чатов.
const MAX_RENDER = 250;              // сколько последних сообщений рисуем при загрузке
const MAX_DOM = 400;                 // максимум узлов в DOM (старые отбрасываем)

const THINK_LEVELS = ['min', 'low', 'high', 'max'];
const THINK_LABELS = { min: 'Min', low: 'Low', high: 'High', max: 'Max' };
let current = { provider: null, model: null, thinking: 'high' };

// Фильтры моделей в минипикере: ключ → regex по имени модели.
const MODEL_FILTERS = [
  ['all', ''],
  ['code', 'code|coder|codestral|deepseek|qwen.*c|starcoder|devstral'],
  ['reasoning', 'o1|o3|o4|r1|reason|think|gpt-5|opus|sonnet|grok'],
  ['fast', 'mini|flash|haiku|lite|turbo|fast|nano|small|8b|7b|3b'],
  ['vision', 'vision|vl|4o|gemini|image|multimodal|pixtral'],
];
let modelFilterKey = 'all';
let modelFilterRe = null;

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
  // События агента тегированы chatId — рендерим только активный чат, иначе ответ
  // «утечёт» в другой открытый чат. Занятость отслеживаем для всех чатов.
  const forActive = !m.chatId || m.chatId === activeChat;
  switch (m.type) {
    case 'status_work':
      if (m.chatId) busyChats.add(m.chatId);
      if (forActive) updateWork(m.text, m.tokens);
      break;
    case 'assistant_start':
      if (m.chatId) busyChats.add(m.chatId);
      if (forActive) { startStream(); setSendStop(true); }
      break;
    case 'assistant_delta': if (forActive) appendStream(m.text); break;
    case 'assistant_end': if (forActive) endStream(m.text); break;
    case 'assistant': if (forActive) addMsg('assistant', m.text); break;
    case 'error':
      if (forActive) { endStream(); stopWork(); addMsg('tool err', 'Error: ' + m.text); setSendStop(false); }
      break;
    case 'tool': if (forActive) renderToolCall(m.name, m.args); break;
    case 'tool_result': if (forActive) renderToolResult(m.name, m.ok, m.result); break;
    case 'done':
      if (m.chatId) busyChats.delete(m.chatId);
      if (forActive) {
        endStream(); stopWork(); setSendStop(false);
        if (reloadOnDone.has(m.chatId)) { reloadOnDone.delete(m.chatId); reloadMessages(); }
      }
      break;
    case 'status': renderStatus(m.status); break;
    case 'providers': providers = m.providers; renderProviderPickers(); break;
    case 'chats': chats = m.chats; renderChats(); break;
    case 'session': applySession(m.info); break;
    case 'usage': lastUsage = m.usage || { available: false }; renderUsageRing(); break;
    case 'hello': myCid = m.cid; break;
    case 'user':
      // Сообщение из ДРУГОГО клиента (десктоп/браузер) — показываем в реалтайме.
      // Своё (origin === myCid) уже отрисовано оптимистично — пропускаем.
      if (m.origin && m.origin === myCid) break;
      if (m.chatId) busyChats.add(m.chatId);
      if (forActive) { addMsg('user' + (m.ultra ? ' ultra' : ''), m.text); startWork(); setSendStop(true); }
      break;
  }
}

function shortArgs(a) { const s = JSON.stringify(a || {}); return s.length > 70 ? s.slice(0, 70) + '…' : s; }
function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }

// ── Worklog (индикатор работы) ────────────────────────
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
function buildMsg(cls, text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + cls;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (cls.startsWith('assistant')) bubble.innerHTML = window.mdRender(text);
  else bubble.textContent = text;
  wrap.appendChild(bubble);
  return { wrap, bubble };
}
// Держим DOM лёгким: отбрасываем самые старые сообщения сверх лимита (фикс лагов).
function trimChat() {
  while (chat.children.length > MAX_DOM) chat.removeChild(chat.firstChild);
}
function addMsg(cls, text) {
  clearWelcome();
  const { wrap, bubble } = buildMsg(cls, text);
  chat.appendChild(wrap);
  bindCopy(bubble);
  trimChat();
  scrollDown();
}

// ── Проекты (проектная папка + общая память во всех чатах) ──
let projects = [];
let activeProject = null;
let prjEditId = null;

async function loadProjects() {
  const r = await fetch('/api/projects').then((r) => r.json()).catch(() => null);
  if (r) { projects = r.projects || []; activeProject = r.active || null; renderProjectBar(); }
}
function renderProjectBar() {
  const el = $('projectName');
  if (el) el.textContent = activeProject ? activeProject.name : (window.t('noProject') || 'Без проекта');
}
function renderProjectList() {
  const list = $('projectList');
  if (!list) return;
  list.innerHTML = '';
  if (!projects.length) { list.innerHTML = `<div class="form-hint">${window.t('noProject') || ''}</div>`; }
  for (const p of projects) {
    const row = document.createElement('div');
    row.className = 'prj-row' + (activeProject && p.id === activeProject.id ? ' active' : '');
    row.innerHTML = `<div class="prj-main"><div class="prj-name">${escUsage(p.name)}</div>` +
      `<div class="prj-sub">${escUsage(p.folder || '—')}</div></div>` +
      `<button class="pr-del" title="${window.t('delete') || 'Удалить'}">${window.ICON.trash}</button>`;
    row.querySelector('.prj-main').onclick = async () => {
      const r = await fetch('/api/projects/active', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.id }) }).then((r) => r.json());
      projects = r.projects; activeProject = r.active; renderProjectBar(); renderProjectList(); openProjectEdit(p);
    };
    row.querySelector('.pr-del').onclick = async (e) => {
      e.stopPropagation();
      const r = await fetch('/api/projects/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.id }) }).then((r) => r.json());
      projects = r.projects; activeProject = r.active; renderProjectBar(); renderProjectList();
      if (prjEditId === p.id) $('prj-edit').classList.add('hidden');
    };
    list.appendChild(row);
  }
}
function openProjectEdit(p) {
  prjEditId = p.id;
  $('prj-edit').classList.remove('hidden');
  $('prj-edit-folder').value = p.folder || '';
  $('prj-notes').value = p.notes || '';
}
if ($('projectBar')) $('projectBar').onclick = () => {
  $('projectsOverlay').classList.remove('hidden'); loadProjects().then(renderProjectList);
  if (activeProject) openProjectEdit(activeProject); else $('prj-edit').classList.add('hidden');
};
if ($('closeProjects')) $('closeProjects').onclick = () => $('projectsOverlay').classList.add('hidden');
if ($('projectsOverlay')) $('projectsOverlay').onclick = (e) => { if (e.target === $('projectsOverlay')) $('projectsOverlay').classList.add('hidden'); };
if ($('prj-create')) $('prj-create').onclick = async () => {
  const name = $('prj-name').value.trim();
  if (!name) return;
  const r = await fetch('/api/projects/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, folder: $('prj-folder').value.trim() }) }).then((r) => r.json());
  projects = r.projects; activeProject = r.active;
  $('prj-name').value = ''; $('prj-folder').value = '';
  renderProjectBar(); renderProjectList();
  if (activeProject) openProjectEdit(activeProject);
  showToast(window.t('saved') || 'Сохранено', 'ok');
};
if ($('prj-save')) $('prj-save').onclick = async () => {
  if (!prjEditId) return;
  const r = await fetch('/api/projects/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: prjEditId, folder: $('prj-edit-folder').value.trim(), notes: $('prj-notes').value }) }).then((r) => r.json());
  projects = r.projects; activeProject = r.active;
  renderProjectBar(); renderProjectList();
  showToast(window.t('saved') || 'Сохранено', 'ok');
};

// ── Обновления (changelog по страницам) ───────────────
const CHANGELOG = [
  { v: 'v0.2.3', date: '', items: [
    'Чат: исправлена ошибка 400 при смене модели в середине диалога',
    'Авто-заголовок чата — один раз и по смыслу, без мусора',
    'Плавный стрим текста, кнопка «вниз», приветствие в пустом чате',
    'Markdown-таблицы и нумерованные списки, мягкий жирный',
    'ultrathink в сообщении → максимальное мышление + радужная подсветка',
    'Кастомные дропдауны, тосты, удаление провайдера из списка',
    'Раздел Plugins → Скиллы, красивые свотчи тем и переключатели',
  ] },
  { v: 'v0.2.2', date: '', items: [
    'Автодетект реальных моделей провайдера (Bearer + x-api-key)',
    'Показ только совместимых моделей по протоколу',
    'Шаблон OpenModel — DeepSeek / Qwen / MiMo / Claude',
  ] },
  { v: 'v0.2.1', date: '', items: [
    'Починен multi/openai (reasoning_effort только reasoning-моделям)',
    'Реалтайм-синхронизация между окнами, индикатор лимитов',
    'Бейджи возможностей моделей, фиксы поповеров',
  ] },
  { v: 'v0.2.0', date: '', items: [
    '67 инструментов: постройки по генплану, UI, физика, свет, звук',
    'ИИ-плагины (скиллы), документация по Luau (29 тем)',
    '9 тем со свотчами, todo-план, источники веб-поиска',
  ] },
];
let updatesPage = 0;
function renderUpdates() {
  const list = $('updatesList'), pager = $('updatesPager');
  if (!list) return;
  const rel = CHANGELOG[updatesPage];
  if (!rel) return;
  list.innerHTML = `<div class="upd-card"><div class="upd-ver">${rel.v}</div><ul>` +
    rel.items.map((x) => `<li>${x.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</li>`).join('') +
    '</ul></div>';
  pager.innerHTML = CHANGELOG.map((r, i) =>
    `<span class="upd-dot${i === updatesPage ? ' active' : ''}" data-i="${i}" title="${r.v}"></span>`).join('');
  pager.querySelectorAll('.upd-dot').forEach((d) => {
    d.onclick = () => { updatesPage = Number(d.dataset.i); renderUpdates(); };
  });
}

// Превращает нативный <select> в кастомный красивый дропдаун (нативный
// прячем, но он остаётся источником значения и событий change).
function enhanceSelect(sel) {
  if (!sel || sel.dataset.enhanced) return;
  sel.dataset.enhanced = '1';
  const wrap = document.createElement('div');
  wrap.className = 'cselect';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.style.display = 'none';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'cselect-btn';
  const menu = document.createElement('div');
  menu.className = 'cselect-menu hidden';
  wrap.appendChild(btn); wrap.appendChild(menu);
  const sync = () => {
    const opt = sel.options[sel.selectedIndex];
    btn.innerHTML = `<span>${opt ? opt.textContent : ''}</span>${window.ICON.chevron || ''}`;
    menu.innerHTML = '';
    Array.from(sel.options).forEach((o, idx) => {
      const it = document.createElement('div');
      it.className = 'cselect-item' + (idx === sel.selectedIndex ? ' active' : '');
      it.textContent = o.textContent;
      it.onclick = () => {
        sel.selectedIndex = idx; menu.classList.add('hidden'); sync();
        sel.dispatchEvent(new Event('change'));
      };
      menu.appendChild(it);
    });
  };
  sel._csync = sync;
  btn.onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll('.cselect-menu').forEach((m) => m !== menu && m.classList.add('hidden'));
    menu.classList.toggle('hidden');
  };
  document.addEventListener('click', () => menu.classList.add('hidden'));
  sync();
}

// Тост-уведомление сверху по центру с анимацией (вместо текста справа-снизу).
function showToast(text, kind) {
  const host = $('toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast';
  const ic = kind === 'ok' ? (window.ICON?.check || '') : '';
  el.innerHTML = (ic ? ic : '') + `<span>${String(text).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</span>`;
  host.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, 2200);
}

// Инлайн-заметка по центру, без пузыря (напр. «Остановлено»).
function addInlineNotice(text) {
  const el = document.createElement('div');
  el.className = 'chat-notice';
  el.textContent = text;
  chat.appendChild(el);
  trimChat();
  scrollDown();
}

// Приветствие в пустом чате (по центру, без блока).
function renderWelcomeIfEmpty() {
  if (chat.querySelector('.msg, .chat-notice')) return;
  if (chat.querySelector('.chat-welcome')) return;
  const el = document.createElement('div');
  el.className = 'chat-welcome';
  el.innerHTML = `<div class="cw-title">${window.t('welcomeEmpty') || 'В этом чате пока пусто'}</div>` +
    `<div class="cw-hint">${window.t('welcomeHint') || ''}</div>`;
  chat.appendChild(el);
}
function clearWelcome() { const w = chat.querySelector('.chat-welcome'); if (w) w.remove(); }

// Иконка для разных инструментов (в карточке tool-call).
function toolIcon(name) {
  if (name === 'web_search' || name === 'web_fetch') return window.ICON.globe;
  if (name === 'run_command') return window.ICON.terminal;
  if (name === 'luau_reference') return window.ICON.brain;
  if (name === 'search_assets' || name === 'insert_model') return window.ICON.download;
  if (name === 'update_plan') return window.ICON.list;
  if (name === 'plan_build') return window.ICON.layout;
  if (name === 'build_parts' || name === 'group_instances') return window.ICON.box;
  if (name === 'create_screen_gui' || name === 'create_ui_element') return window.ICON.layout;
  if (name === 'weld' || name === 'create_constraint' || name === 'add_attachment') return window.ICON.link;
  if (name === 'add_light') return window.ICON.bulb;
  if (name === 'set_lighting') return window.ICON.sun;
  if (name === 'add_sound') return window.ICON.volume;
  if (name === 'add_proximity_prompt' || name === 'add_click_detector') return window.ICON.pointer;
  if (name === 'add_particle') return window.ICON.sparkles;
  if (name === 'add_decal') return window.ICON.image;
  if (name === 'create_script' || name === 'set_script_source' || name === 'get_script_source') return window.ICON.edit;
  if (/^(read_file|write_file|edit_file|append_file|read_lines|list_dir|make_dir|move_path|copy_path|delete_path|stat_path|path_exists|glob_files|grep_files|tree)$/.test(name)) return window.ICON.edit;
  return window.ICON.cpu;
}

// План задач (todo) — отдельная карточка с чекбоксами, обновляется на месте.
let planEl = null;
function renderPlan(steps) {
  steps = Array.isArray(steps) ? steps : [];
  const rows = steps.map((s) => {
    const st = s.status || 'pending';
    const box = st === 'done' ? '✓' : st === 'in_progress' ? '◼' : '◻';
    const cls = st === 'done' ? 'pl-done' : st === 'in_progress' ? 'pl-active' : 'pl-todo';
    const txt = String(s.text || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    return `<div class="plan-row ${cls}"><span class="plan-box">${box}</span><span>${txt}</span></div>`;
  }).join('');
  const html = `<div class="toolcall-head">${window.ICON.list || ''}<b>${window.t('planTitle') || 'План'}</b></div>${rows}`;
  if (planEl && planEl.isConnected) {
    planEl.innerHTML = html;
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'msg tool';
    const bubble = document.createElement('div');
    bubble.className = 'bubble rich plan-card';
    bubble.innerHTML = html;
    wrap.appendChild(bubble);
    chat.appendChild(wrap);
    planEl = bubble;
    trimChat();
  }
  scrollDown();
}

// Генплан постройки — схема вида сверху (SVG), как чертёж.
function renderBlueprint(args) {
  const items = Array.isArray(args.items) ? args.items : [];
  if (!items.length) return;
  // Габариты участка: из args или по охвату зон.
  let W = Number(args.width) || 0, D = Number(args.depth) || 0;
  for (const it of items) {
    W = Math.max(W, (Number(it.x) || 0) + (Number(it.w) || 0));
    D = Math.max(D, (Number(it.z) || 0) + (Number(it.d) || 0));
  }
  W = W || 64; D = D || 64;
  const VB = 320, pad = 8; const sc = (VB - pad * 2) / Math.max(W, D);
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const rects = items.map((it) => {
    const x = pad + (Number(it.x) || 0) * sc, y = pad + (Number(it.z) || 0) * sc;
    const w = (Number(it.w) || 1) * sc, h = (Number(it.d) || 1) * sc;
    const col = /^#?[0-9a-fA-F]{6}$/.test(it.color || '') ? (it.color[0] === '#' ? it.color : '#' + it.color) : 'var(--accent)';
    const tx = x + w / 2, ty = y + h / 2;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${col}" fill-opacity="0.28" stroke="${col}" stroke-width="1.5"/>` +
      (it.label ? `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" fill="var(--text)" font-size="9" text-anchor="middle" dominant-baseline="middle">${esc(it.label)}</text>` : '');
  }).join('');
  const svg = `<svg viewBox="0 0 ${VB} ${VB}" class="blueprint-svg"><rect x="0" y="0" width="${VB}" height="${VB}" fill="rgba(255,255,255,0.02)"/>${rects}</svg>`;
  const wrap = document.createElement('div');
  wrap.className = 'msg tool';
  const bubble = document.createElement('div');
  bubble.className = 'bubble rich';
  bubble.innerHTML = `<div class="toolcall-head">${window.ICON.list || ''}<b>${window.t('blueprint') || 'Генплan'}: ${esc(args.name || '')}</b></div>` +
    `<div class="blueprint-meta">${W}×${D} studs · ${items.length} зон</div>${svg}`;
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  trimChat();
  scrollDown();
}

// Красивая карточка вызова инструмента: показываем РЕАЛЬНЫЙ код/действие.
function renderToolCall(name, args) {
  args = args || {};
  clearWelcome();
  if (name === 'update_plan') { renderPlan(args.steps); return; }
  if (name === 'plan_build') { renderBlueprint(args); return; }
  let md = '';
  if ((name === 'run_code' || name === 'run_script_in_play_mode') && args.code) md = '```lua\n' + args.code + '\n```';
  else if (name === 'set_script_source' && args.source) md = '```lua\n' + args.source + '\n```';
  else if (name === 'create_script' && args.source) md = '`' + (args.scriptType || 'Script') + '` → ' + (args.parent || '') + '\n```lua\n' + args.source + '\n```';
  else if (name === 'move_instance') md = '`' + (args.path || '') + '` → ' + (args.parent || '');
  else if (name === 'call_method') md = '`' + (args.path || '') + ':' + (args.method || '') + '()`';
  else if (name === 'add_tag' || name === 'remove_tag') md = '`' + (args.tag || '') + '` ← ' + (args.path || '');
  else if (name === 'group_instances') md = (args.container || 'Model') + ' `' + (args.name || 'Group') + '`';
  else if (name === 'build_parts') md = '`' + (args.name || 'Build') + '` — частей: ' + ((args.parts || []).length);
  else if (name === 'create_ui_element') md = '`' + (args.className || 'Frame') + '` → ' + (args.parent || '') + (args.text ? ' · «' + args.text + '»' : '');
  else if (name === 'create_screen_gui') md = 'ScreenGui `' + (args.name || '') + '`';
  else if (name === 'weld') md = '`' + (args.part0 || '') + '` ↔ `' + (args.part1 || '') + '`';
  else if (name === 'create_constraint') md = (args.constraintType || '') + ': `' + (args.attachment0 || '') + '` ↔ `' + (args.attachment1 || '') + '`';
  else if (name === 'add_light') md = '`' + (args.lightType || 'PointLight') + '` → ' + (args.path || '');
  else if (name === 'add_sound') md = '`' + (args.soundId || '') + '`';
  else if (name === 'add_proximity_prompt') md = 'ProximityPrompt → ' + (args.path || '') + (args.actionText ? ' · «' + args.actionText + '»' : '');
  else if (name === 'add_click_detector') md = 'ClickDetector → ' + (args.path || '');
  else if (name === 'set_lighting') md = 'Lighting' + (args.clockTime != null ? ' · ' + args.clockTime + ':00' : '');
  else if (name === 'add_decal') md = (args.kind || 'Decal') + ' `' + (args.texture || '') + '` → ' + (args.path || '');
  else if (name === 'add_particle') md = 'ParticleEmitter → ' + (args.path || '');
  else if (name === 'use_template') md = '`' + (args.templateId || '') + '`';
  else if (name === 'create_instance') md = '`' + (args.className || '?') + '` → ' + (args.parent || 'Workspace');
  else if (name === 'set_properties') md = '`' + (args.path || '') + '` ' + '```json\n' + JSON.stringify(args.properties || {}, null, 2) + '\n```';
  else if (name === 'insert_model') md = 'assetId `' + (args.assetId || '') + '`';
  else if (name === 'search_assets') md = '`' + (args.keyword || '') + '`';
  else if (name === 'web_search') md = '`' + (args.query || '') + '`';
  else if (name === 'web_fetch') md = args.url || '';
  else if (name === 'run_command') md = '```bash\n' + (args.command || '') + '\n```';
  else if (name === 'write_file' || name === 'read_file' || name === 'list_dir' || name === 'make_dir') md = '`' + (args.path || '') + '`';
  else if (name === 'edit_file') md = '`' + (args.path || '') + '`\n```diff\n- ' + String(args.oldText || '').split('\n').join('\n- ') + '\n+ ' + String(args.newText || '').split('\n').join('\n+ ') + '\n```';
  else { const s = JSON.stringify(args); md = s && s !== '{}' ? '`' + (s.length > 120 ? s.slice(0, 120) + '…' : s) + '`' : ''; }

  const wrap = document.createElement('div');
  wrap.className = 'msg tool';
  const bubble = document.createElement('div');
  bubble.className = 'bubble rich';
  bubble.innerHTML = `<div class="toolcall-head">${toolIcon(name)}<b>${name}</b></div>` + (md ? window.mdRender(md) : '');
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  bindCopy(bubble);
  trimChat();
  scrollDown();
}

function renderToolResult(name, ok, result) {
  // Веб-поиск: показываем источники карточками-чипами (как у крупных ИИ).
  if (ok && name === 'web_search') { renderSources(String(result || '')); return; }
  const s = String(result == null ? '' : result);
  // Тривиальный успех не засоряет ленту — детали уже видны в ответе ассистента.
  if (ok && (result == null || /^(ok|Изменено|Создан|Выделен|Записано|Построено|Перемещено|Сварено)/.test(s) || s.length < 4)) {
    return;
  }
  clearWelcome();
  // Карточка результата: заголовок (имя инструмента) + тело с markdown.
  const wrap = document.createElement('div');
  wrap.className = 'msg tool' + (ok ? '' : ' err');
  const bubble = document.createElement('div');
  bubble.className = 'bubble rich';
  const head = ok ? (window.ICON.check || '←') : (window.ICON.close || '⚠');
  bubble.innerHTML = `<div class="toolcall-head">${head}<b>${escUsage(name)}</b></div>` +
    `<div class="tool-res">${window.mdRender(truncate(s, 1400))}</div>`;
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  bindCopy(bubble);
  trimChat();
  scrollDown();
}

// Источники веб-поиска → чипы с доменом и заголовком.
function renderSources(text) {
  const urls = text.match(/https?:\/\/[^\s]+/g) || [];
  if (!urls.length) return;
  const titles = text.split('\n').filter((l) => /^\s*\d+\./.test(l)).map((l) => l.replace(/^\s*\d+\.\s*/, '').trim());
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const chips = urls.slice(0, 8).map((u, i) => {
    let host = u; try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { /* keep */ }
    const title = titles[i] || host;
    return `<a class="src-chip" href="${esc(u)}" target="_blank" rel="noreferrer" title="${esc(title)}">` +
      `<img src="https://www.google.com/s2/favicons?domain=${esc(host)}&sz=32" onerror="this.style.display='none'"/>` +
      `<span>${esc(host)}</span></a>`;
  }).join('');
  const wrap = document.createElement('div');
  wrap.className = 'msg tool';
  const bubble = document.createElement('div');
  bubble.className = 'bubble rich';
  bubble.innerHTML = `<div class="toolcall-head">${window.ICON.globe || ''}<b>${window.t('sources') || 'Источники'}</b></div>` +
    `<div class="src-chips">${chips}</div>`;
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  trimChat();
  scrollDown();
}

// Полная перерисовка истории (с ограничением для скорости).
function renderHistory(messages) {
  chat.classList.add('bulk');
  chat.innerHTML = '';
  streamEl = null;
  const frag = document.createDocumentFragment();
  for (const m of (messages || []).slice(-MAX_RENDER)) {
    const cls = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'tool';
    const { wrap, bubble } = buildMsg(cls, m.text);
    if (cls === 'assistant') bindCopy(bubble);
    frag.appendChild(wrap);
  }
  chat.appendChild(frag);
  chat.classList.remove('bulk');
  scrollDown(true);
}

async function reloadMessages() {
  const id = activeChat;
  const r = await fetch('/api/chats/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }).then((r) => r.json()).catch(() => null);
  if (r && id === activeChat) { renderHistory(r.messages); applySession(r.info); }
}
function startStream() {
  clearWelcome();
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble streaming'; bubble.dataset.raw = '';
  // Пока текста нет — показываем 3 анимированные точки вместо пустого пузыря.
  bubble.innerHTML = '<span class="typing-dots"><i></i><i></i><i></i></span>';
  wrap.appendChild(bubble); chat.appendChild(wrap);
  streamEl = bubble; scrollDown(true);
}
function appendStream(chunk) {
  if (!streamEl) startStream();
  streamEl.dataset.raw += chunk;
  scheduleRender(streamEl);
  scrollDown();
}
// Плавный стрим: во время печати показываем ПЛОСКИЙ текст (pre-wrap) — он
// прирастает по символам без рывков. Тяжёлый markdown-рендер (с реflow кода,
// списков и т.п.) делаем ОДИН раз в конце. Это убирает «дёрганье».
let renderQueued = false;
function scheduleRender(el) {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (el) el.textContent = el.dataset.raw;
    scrollDown();
  });
}
function endStream(finalText) {
  if (!streamEl) return;
  const raw = typeof finalText === 'string' && finalText.length ? finalText : streamEl.dataset.raw;
  if (!raw) { streamEl.parentElement.remove(); streamEl = null; return; }
  streamEl.classList.remove('streaming');
  streamEl.innerHTML = window.mdRender(raw);
  bindCopy(streamEl); streamEl = null;
}
function bindCopy(scope) {
  const copyIcon = window.ICON?.copy || 'copy';
  const checkIcon = window.ICON?.check || '✓';
  scope.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.onclick = () => {
      navigator.clipboard.writeText(btn.parentElement.querySelector('code').textContent);
      btn.innerHTML = checkIcon; btn.classList.add('copied');
      setTimeout(() => { btn.innerHTML = copyIcon; btn.classList.remove('copied'); }, 1200);
    };
  });
}
// Умный автоскролл: тянем вниз только если пользователь уже у низа.
// force=true — принудительно (старт нового сообщения, отправка).
let stickBottom = true;
function atBottom() { return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80; }
function scrollDown(force) {
  if (force) stickBottom = true;
  if (stickBottom) chat.scrollTop = chat.scrollHeight;
  updateScrollBtn();
}
function updateScrollBtn() {
  const btn = $('scrollBtn');
  if (!btn) return;
  btn.classList.toggle('hidden', atBottom());
}
chat.addEventListener('scroll', () => {
  stickBottom = atBottom();
  updateScrollBtn();
});

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
  // Первый запуск: чатов нет — показываем пустое состояние, без «главного чата».
  if (!chats.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = window.t('noChats');
    list.appendChild(empty);
    return;
  }
  const seen = new Set();
  for (const c of chats) {
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
    ren.onclick = (e) => { e.stopPropagation(); startRenameItem(c.id, title, c.title); };
    act.appendChild(ren);
    const del = document.createElement('span');
    del.className = 'ci-del'; del.innerHTML = window.ICON.trash; del.title = window.t('delete');
    del.onclick = (e) => { e.stopPropagation(); deleteChat(c.id); };
    act.appendChild(del);
    item.appendChild(title); item.appendChild(act);
    list.appendChild(item);
  }
}

async function switchChat(id) {
  activeChat = id;
  chat.innerHTML = '';
  streamEl = null;
  planEl = null;
  // Загружаем историю с сервера — она хранится на диске.
  const r = await fetch('/api/chats/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }).then((r) => r.json()).catch(() => null);
  if (r) {
    renderHistory(r.messages);
    applySession(r.info);
  }
  // Если в этом чате прямо сейчас работает агент — показываем индикатор и
  // помечаем для перезагрузки истории по завершении (живой стрим мы пропустили).
  if (busyChats.has(id)) { startWork(); setSendStop(true); reloadOnDone.add(id); }
  else { stopWork(); setSendStop(false); }
  renderWelcomeIfEmpty();
  renderChats();
}

// Сохранить новое имя чата на сервере.
function commitRename(id, title) {
  const t = String(title || '').trim();
  if (!t) { renderChats(); return; }
  fetch('/api/chats/rename', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, title: t }),
  }).then((r) => r.json()).then((r) => {
    chats = r.chats; renderChats();
    if (id === activeChat) $('chatTitle').textContent = t;
  });
}

// Инлайн-редактирование названия в сайдбаре (window.prompt не работает в Electron).
function startRenameItem(id, titleSpan, current) {
  const inp = document.createElement('input');
  inp.className = 'ci-edit'; inp.value = current || '';
  titleSpan.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    if (save) commitRename(id, inp.value); else renderChats();
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  inp.onblur = () => finish(true);
  inp.onclick = (e) => e.stopPropagation();
}

// Инлайн-редактирование названия в заголовке (двойной клик).
$('chatTitle').ondblclick = () => {
  if (!activeChat) return;
  const host = $('chatTitle');
  const cur = host.textContent;
  const inp = document.createElement('input');
  inp.className = 'title-edit'; inp.value = cur;
  host.style.display = 'none'; host.after(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    inp.remove(); host.style.display = '';
    if (save && inp.value.trim()) { host.textContent = inp.value.trim(); commitRename(activeChat, inp.value); }
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  inp.onblur = () => finish(true);
};

$('newChat').onclick = async () => {
  const r = await fetch('/api/chats', { method: 'POST' }).then((r) => r.json());
  await refreshChats(); switchChat(r.chat.id);
};
async function deleteChat(id) {
  await fetch('/api/chats/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  if (activeChat === id) {
    // Переключаемся на первый оставшийся чат, либо в пустое состояние.
    const rest = chats.filter((c) => c.id !== id);
    if (rest.length) switchChat(rest[0].id);
    else { activeChat = null; chat.innerHTML = ''; $('chatTitle').textContent = ''; }
  }
  refreshChats();
}
async function refreshChats() { const r = await fetch('/api/chats').then((r) => r.json()); chats = r.chats; renderChats(); }

function applySession(info) {
  if (!info || info.id !== activeChat) return;
  current.provider = info.provider; current.model = info.model; current.thinking = info.thinking || 'high';
  $('chatTitle').textContent = info.title || $('chatTitle').textContent;
  updatePills();
  loadUsage();
}

// ── Минипикеры ─────────────────────────────────────────
function updatePills() {
  $('modelPillText').textContent = current.model || 'No model';
  $('thinkPillText').textContent = THINK_LABELS[current.thinking] || 'High';
}

// ── Индикатор лимитов (кольцо) ─────────────────────────
let lastUsage = { available: false };
const RING_C = 2 * Math.PI * 9; // длина окружности r=9

// Перерисовать кольцо: заполнение = доля ОСТАВШЕГОСЯ лимита (узкое горло).
function renderUsageRing() {
  const fill = document.querySelector('#usagePill .ur-fill');
  if (!fill) return;
  fill.style.strokeDasharray = RING_C.toFixed(2);
  if (!lastUsage.available || lastUsage.ratio == null) {
    // Нет данных о лимитах — серое пустое кольцо.
    fill.style.strokeDashoffset = RING_C.toFixed(2);
    $('usagePill').classList.add('ring-empty');
    $('usagePill').classList.remove('ring-low');
    return;
  }
  const r = Math.max(0, Math.min(1, lastUsage.ratio));
  fill.style.strokeDashoffset = (RING_C * (1 - r)).toFixed(2);
  $('usagePill').classList.remove('ring-empty');
  $('usagePill').classList.toggle('ring-low', r <= 0.15); // мало осталось — красным
}

async function loadUsage() {
  const r = await fetch('/api/usage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: current.provider, chatId: activeChat }),
  }).then((r) => r.json()).catch(() => null);
  if (r) { lastUsage = r.usage || { available: false }; renderUsageRing(); }
}

function renderUsagePopover() {
  const box = $('usageBody');
  const u = lastUsage;
  const t = (k, d) => window.t(k) || d;
  if (!u || !u.available) {
    box.innerHTML = `<div class="usage-title">${t('limitsTitle', 'Лимиты')}</div>` +
      `<div class="usage-none">${t('limitsNone', 'Данных о лимитах нет — провайдер их не присылает.')}</div>`;
    return;
  }
  const pct = u.ratio != null ? Math.round(u.ratio * 100) : null;
  const bar = (part, label) => {
    if (!part || part.limit == null) return '';
    const rem = part.remaining != null ? part.remaining : '—';
    const ratio = (part.limit > 0 && part.remaining != null) ? part.remaining / part.limit : 0;
    const w = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    const low = ratio <= 0.15 ? ' low' : '';
    return `<div class="usage-row"><div class="usage-row-head"><span>${label}</span>` +
      `<span class="usage-num">${rem} / ${part.limit}</span></div>` +
      `<div class="usage-track"><div class="usage-fill${low}" style="width:${w}%"></div></div></div>`;
  };
  const reset = (u.tokens && u.tokens.reset) || (u.requests && u.requests.reset);
  box.innerHTML =
    `<div class="usage-title">${t('limitsTitle', 'Лимиты')} · ${u.kind}` +
    (pct != null ? ` · ${pct}%` : '') + `</div>` +
    bar(u.requests, t('limitsRequests', 'Запросы')) +
    bar(u.tokens, t('limitsTokens', 'Токены')) +
    (reset ? `<div class="usage-reset">${t('limitsReset', 'Сброс')}: ${esc(String(reset))}</div>` : '');
}

function escUsage(s) { return String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }
const esc = escUsage;

$('usagePill').onclick = (e) => {
  e.stopPropagation();
  loadUsage().then(() => { renderUsagePopover(); });
  togglePopover($('usagePopover'), $('usagePill'), () => renderUsagePopover());
};
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
  if (sel._csync) sel._csync();
  updatePills(); renderProviderList();
}

const modelPopover = $('modelPopover');
$('modelPill').onclick = (e) => { e.stopPropagation(); togglePopover(modelPopover, $('modelPill'), () => { renderModelFilters(); loadModelList($('modelSearch').value); }); };
$('popProvider').onchange = () => { current.provider = $('popProvider').value; loadModelList(); loadUsage(); };
$('modelSearch').oninput = () => loadModelList($('modelSearch').value);

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function renderModelFilters() {
  const box = $('modelFilters');
  if (!box) return;
  box.innerHTML = '';
  for (const [key, rx] of MODEL_FILTERS) {
    const chip = document.createElement('span');
    chip.className = 'mf-chip' + (modelFilterKey === key ? ' active' : '');
    chip.textContent = window.t('filter' + cap(key));
    chip.onclick = (ev) => {
      // Без этого пересборка чипов отрывает e.target от DOM, и общий
      // document-handler принимает клик за «вне поповера» и закрывает меню.
      ev.stopPropagation();
      modelFilterKey = key;
      modelFilterRe = rx ? new RegExp(rx, 'i') : null;
      renderModelFilters();
      loadModelList($('modelSearch').value);
    };
    box.appendChild(chip);
  }
}

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
  const shown = models.filter((m) => m.toLowerCase().includes(f) && (!modelFilterRe || modelFilterRe.test(m)));
  list.innerHTML = '';
  if (!shown.length) { list.innerHTML = '<div class="pop-item">No models match</div>'; return; }
  for (const m of shown) {
    const item = document.createElement('div');
    item.className = 'pop-item pop-model' + (m === current.model && pid === current.provider ? ' active' : '');
    const caps = modelCaps(m);
    const badges = caps.map((c) => `<span class="cap cap-${c.key}">${c.label}</span>`).join('');
    item.innerHTML = `<span class="pm-name">${escUsage(m)}</span>` +
      (badges ? `<span class="pm-caps">${badges}</span>` : '');
    item.onclick = () => {
      current.provider = pid; current.model = m;
      send('/model ' + pid); setTimeout(() => send('/setmodel ' + m), 60);
      updatePills(); closePopovers();
    };
    list.appendChild(item);
  }
}

// Реальные возможности модели по эвристике имени (теми же паттернами, что фильтры).
// Если имя не матчит — бейджа НЕ будет (не выдумываем способности, которых нет).
const CAP_DEFS = [
  { key: 'vision', label: 'Vision', rx: /vision|vl|gpt-4o|4o|gemini|claude-3|claude-opus|claude-sonnet|pixtral|multimodal|image/i },
  { key: 'reasoning', label: 'Reasoning', rx: /o1|o3|o4|r1|reason|think|gpt-5|opus|sonnet|grok|deepseek-r/i },
  { key: 'code', label: 'Code', rx: /code|coder|codestral|deepseek|qwen.*c|starcoder|devstral/i },
  { key: 'fast', label: 'Fast', rx: /mini|flash|haiku|lite|turbo|fast|nano|small|8b|7b|3b/i },
];
function modelCaps(name) {
  return CAP_DEFS.filter((c) => c.rx.test(name));
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
function closePopovers() { modelPopover.classList.add('hidden'); $('thinkPopover').classList.add('hidden'); $('usagePopover').classList.add('hidden'); }
document.addEventListener('click', (e) => {
  if (!e.target.closest('.popover') && !e.target.closest('.pill')) closePopovers();
});

// ── Настройки ──────────────────────────────────────────
$('openSettings').onclick = () => { $('settingsOverlay').classList.remove('hidden'); renderTemplates(); loadConnection(); renderThemeGrid(); loadSkills(); };
$('closeSettings').onclick = () => $('settingsOverlay').classList.add('hidden');
$('settingsOverlay').onclick = (e) => { if (e.target === $('settingsOverlay')) $('settingsOverlay').classList.add('hidden'); };
document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`.tab-pane[data-pane="${tab.dataset.tab}"]`).classList.add('active');
    if (tab.dataset.tab === 'updates') renderUpdates();
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
    row.innerHTML = `<div class="pr-main"><div class="pr-name">${p.label}</div><div class="pr-sub">${p.id} · ${p.model || '—'}</div></div>` +
      `<div class="pr-act">${badge}<button class="pr-del" title="${window.t('deleteProvider') || 'Удалить'}">${window.ICON.trash}</button></div>`;
    row.querySelector('.pr-main').onclick = () => fillForm(p);
    row.querySelector('.pr-del').onclick = async (e) => {
      e.stopPropagation();
      await fetch('/api/providers/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.id }) });
      refreshProviders();
      showToast((window.t('deleteProvider') || 'Удалено'), 'ok');
    };
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
  if ($('pf-kind')._csync) $('pf-kind')._csync();
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
  if (r.ok) { hint.className = 'form-hint'; hint.textContent = ''; modelsCache[body.id] = null; refreshProviders(); showToast(window.t('saved') || 'Сохранено', 'ok'); }
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

// ── Вкладка Connection (bridge token) ──────────────────
function flashCopied(btn) {
  const old = btn.innerHTML;
  btn.innerHTML = (window.ICON.check || '✓') + ' ' + window.t('copied');
  setTimeout(() => { btn.innerHTML = old; }, 1200);
}
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => flashCopied(btn)).catch(() => {});
}
async function loadConnection() {
  try {
    const r = await fetch('/api/bridge-token').then((r) => r.json());
    if (r) {
      $('conn-token').value = r.token || '';
      $('conn-url').value = 'http://localhost:' + (r.port || location.port || 8787);
    }
  } catch { /* пусто */ }
  try {
    const pa = await fetch('/api/pc-agent').then((r) => r.json());
    if (pa) $('set-pcagent').checked = !!pa.enabled;
  } catch { /* пусто */ }
}
if ($('conn-copy-token')) $('conn-copy-token').onclick = () => copyText($('conn-token').value, $('conn-copy-token'));
if ($('conn-copy-url')) $('conn-copy-url').onclick = () => copyText($('conn-url').value, $('conn-copy-url'));
if ($('conn-regen')) $('conn-regen').onclick = async () => {
  const r = await fetch('/api/bridge-token/regenerate', { method: 'POST' }).then((r) => r.json());
  if (r) $('conn-token').value = r.token;
};
if ($('set-pcagent')) $('set-pcagent').onchange = () => {
  fetch('/api/pc-agent', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: $('set-pcagent').checked }),
  });
};

// ── ИИ-плагины (скиллы) ────────────────────────────────
let skills = [];

async function loadSkills() {
  const r = await fetch('/api/skills').then((r) => r.json()).catch(() => null);
  if (r) { skills = r.skills || []; renderSkills(); }
}

function renderSkills() {
  const box = $('skillList');
  if (!box) return;
  const q = ($('skill-search').value || '').toLowerCase().trim();
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  box.innerHTML = '';
  const shown = skills.filter((s) =>
    !q || s.name.toLowerCase().includes(q) || (s.desc || '').toLowerCase().includes(q));
  if (!shown.length) { box.innerHTML = `<div class="form-hint">${window.t('pluginsEmpty') || 'Ничего не найдено'}</div>`; return; }
  for (const s of shown) {
    const card = document.createElement('div');
    card.className = 'skill-card' + (s.enabled ? ' on' : '');
    const icon = (window.ICON && window.ICON[s.icon]) || (window.ICON && window.ICON.puzzle) || '';
    const del = s.builtin ? '' :
      `<button class="skill-del" data-id="${esc(s.id)}" title="${window.t('remove') || 'Удалить'}">${window.ICON.trash || '×'}</button>`;
    card.innerHTML =
      `<div class="skill-ic">${icon}</div>` +
      `<div class="skill-main"><div class="skill-name">${esc(s.name)}` +
      `${s.builtin ? '' : ' <span class="skill-badge">' + (window.t('custom') || 'свой') + '</span>'}</div>` +
      `<div class="skill-desc">${esc(s.desc)}</div></div>` +
      `<label class="switch"><input type="checkbox" data-id="${esc(s.id)}" ${s.enabled ? 'checked' : ''}/><span class="slider"></span></label>` +
      del;
    box.appendChild(card);
  }
  box.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.onchange = () => toggleSkill(cb.dataset.id, cb.checked);
  });
  box.querySelectorAll('.skill-del').forEach((b) => {
    b.onclick = () => removeSkill(b.dataset.id);
  });
}

async function toggleSkill(id, enabled) {
  const r = await fetch('/api/skills/toggle', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, enabled }),
  }).then((r) => r.json()).catch(() => null);
  if (r) { skills = r.skills || []; renderSkills(); }
}

async function removeSkill(id) {
  const r = await fetch('/api/skills/remove', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }).then((r) => r.json()).catch(() => null);
  if (r) { skills = r.skills || []; renderSkills(); }
}

if ($('skill-search')) $('skill-search').oninput = () => renderSkills();
if ($('sk-add')) $('sk-add').onclick = async () => {
  const name = $('sk-name').value.trim();
  const prompt = $('sk-prompt').value.trim();
  if (!name || !prompt) return;
  const r = await fetch('/api/skills/add', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, desc: $('sk-desc').value.trim(), prompt }),
  }).then((r) => r.json()).catch(() => null);
  if (r) {
    skills = r.skills || [];
    $('sk-name').value = ''; $('sk-desc').value = ''; $('sk-prompt').value = '';
    renderSkills();
  }
};

// ── Настройки внешнего вида ────────────────────────────
$('set-lang').onchange = () => { window.setLang($('set-lang').value); applyI18n(); renderChats(); };

// Темы: имя, значение data-theme и два цвета для свотча (фон + акцент).
const THEMES = [
  { id: 'red', name: 'Rublox Red', bg: '#140a0c', accent: '#e01030' },
  { id: 'dark', name: 'Neutral Dark', bg: '#111319', accent: '#4f8cff' },
  { id: 'midnight', name: 'Midnight', bg: '#0c1122', accent: '#6366f1' },
  { id: 'violet', name: 'Violet', bg: '#140d22', accent: '#a855f7' },
  { id: 'ocean', name: 'Ocean', bg: '#07182a', accent: '#0ea5e9' },
  { id: 'emerald', name: 'Emerald', bg: '#0a1813', accent: '#10b981' },
  { id: 'sunset', name: 'Sunset', bg: '#1c0f08', accent: '#f97316' },
  { id: 'rose', name: 'Rose', bg: '#1d0c18', accent: '#ec4899' },
  { id: 'graphite', name: 'Graphite', bg: '#141619', accent: '#8b95a3' },
];

function applyTheme(id) {
  if (id === 'red') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
  localStorage.setItem('theme', id);
}

function renderThemeGrid() {
  const grid = $('theme-grid');
  if (!grid) return;
  const cur = localStorage.getItem('theme') || 'red';
  grid.innerHTML = '';
  for (const t of THEMES) {
    const card = document.createElement('div');
    card.className = 'theme-card' + (t.id === cur ? ' active' : '');
    // Круглый свотч: фон темы + диагональная половина акцента (CSS clip-path).
    card.innerHTML =
      `<span class="theme-swatch" style="background:${t.bg}"><span style="background:${t.accent}"></span></span>` +
      `<span class="theme-name">${t.name}</span>`;
    card.onclick = () => {
      applyTheme(t.id);
      grid.querySelectorAll('.theme-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
    };
    grid.appendChild(card);
  }
}

// ── Управление окном (Electron) ────────────────────────
function winCtl(action) {
  if (window.rublox && window.rublox.win) window.rublox.win(action);
}
$('winMin').onclick = () => winCtl('min');
$('winMax').onclick = () => winCtl('max');
$('winClose').onclick = () => winCtl('close');

// Кнопка «вернуться вниз»
if ($('scrollBtn')) $('scrollBtn').onclick = () => scrollDown(true);

// ── Отправка ───────────────────────────────────────────
function send(text) {
  if (!text.trim() || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'message', text, chatId: activeChat }));
}

// Переключение кнопки между «отправить» и «стоп».
function setSendStop(isStop) {
  sending = isStop;
  sendBtn.innerHTML = window.ICON[isStop ? 'stop' : 'send'];
  sendBtn.classList.toggle('is-stop', isStop);
  sendBtn.title = isStop ? window.t('stop') : '';
}

function submitText() {
  const text = input.value;
  if (!text.trim()) return;
  // «ultrathink» — радужная подсветка сообщения (как в Claude — «думай дольше»).
  addMsg('user' + (/\bultrathink\b/i.test(text) ? ' ultra' : ''), text);
  send(text);
  input.value = ''; input.style.height = 'auto'; hideSuggest();
  busyChats.add(activeChat);
  startWork();
  setSendStop(true);
}

// Прервать генерацию в активном чате.
function stopActive() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop', chatId: activeChat }));
  }
  busyChats.delete(activeChat);
  endStream();
  addInlineNotice(window.t('stopped') || 'Остановлено');
  stopWork();
  setSendStop(false);
}

sendBtn.onclick = () => (sending ? stopActive() : submitText());
input.addEventListener('keydown', (e) => {
  if (!suggest.classList.contains('hidden')) {
    const items = suggest.querySelectorAll('div');
    if (e.key === 'ArrowDown') { e.preventDefault(); suggestIndex = Math.min(suggestIndex + 1, items.length - 1); updateActive(items); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); suggestIndex = Math.max(suggestIndex - 1, 0); updateActive(items); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && suggestIndex >= 0)) { e.preventDefault(); applySuggest(items[suggestIndex] || items[0]); return; }
    if (e.key === 'Escape') return hideSuggest();
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sending) submitText(); }
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
  applyTheme(savedTheme);
  renderThemeGrid();
  $('set-lang').value = window.getLang();
  paintIcons(); applyI18n();
  // Кастомные дропдауны вместо нативных select (язык, протокол провайдера).
  enhanceSelect($('set-lang'));
  enhanceSelect($('pf-kind'));
  enhanceSelect($('popProvider'));
  // шаблоны провайдеров
  try { templates = (await fetch('/api/provider-templates').then((r) => r.json())).templates || []; } catch { templates = []; }
  // about
  document.querySelector('[data-t="aboutText"]').textContent = window.t('aboutText');
  connect();
  updatePills();
  renderUsageRing(); // нарисовать пустое кольцо сразу
  loadUsage();
  loadProjects();
  // Кнопки окна (свернуть/развернуть/закрыть) нужны только в десктоп-приложении
  // (Electron). В обычном браузере их прячем — там окном управляет сам браузер.
  if (!window.rublox) document.body.classList.add('in-browser');
}
init();
