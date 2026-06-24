// Точка входа сервера: статика веб-чата, WebSocket для чата,
// REST-эндпоинты для плагина Roblox (long-poll и приём результатов).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { bridge } from './bridge.js';
import {
  getSession, createSession, deleteSession, listSessions,
} from './session.js';
import { handleCommand } from './commands.js';
import { runAgent, validateTools } from './agent.js';
import {
  listProviders, upsertProvider, deleteProvider, fetchModels,
} from './llm/registry.js';
import { PROVIDER_TEMPLATES } from './llm/provider-templates.js';
import { installPlugin } from './plugin-installer.js';
import { getBridgeToken, setBridgeToken, regenerateBridgeToken, getPcAgent, setPcAgent } from './app-config.js';
import { listSkills, setSkillEnabled, addCustomSkill, removeCustomSkill } from './skills.js';
import {
  listProjects, getActiveProject, setActiveProject, createProject, updateProject, deleteProject,
} from './projects.js';
import { getUsage, addSpent, getSpentTotal } from './usage.js';
import { getUpdateInfo } from './update.js';
import { listKnowledge, addKnowledge, removeKnowledge, clearKnowledge } from './knowledge.js';
import { resolveAsk, hasPendingAsk } from './asks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// ── Утилиты HTTP ───────────────────────────────────────
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function checkAuth(req) {
  const header = req.headers['authorization'] || '';
  const token = header.replace(/^Bearer\s+/i, '');
  return token === getBridgeToken();
}

async function serveStatic(req, res) {
  let path = req.url.split('?')[0];
  if (path === '/') path = '/index.html';
  const filePath = normalize(join(webDir, path));
  if (!filePath.startsWith(webDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ── REST для плагина Roblox ────────────────────────────
async function handlePluginApi(req, res, url) {
  if (!checkAuth(req)) return sendJson(res, 401, { error: 'Неверный токен' });

  if (url === '/api/roblox/ping' && req.method === 'POST') {
    // Лёгкий тест связи при нажатии Connect в плагине (токен уже проверен выше).
    const body = await readBody(req);
    bridge.markConnected(body.studioInfo);
    broadcastStatus();
    return sendJson(res, 200, { ok: true, placeName: body.studioInfo?.placeName || null });
  }

  if (url === '/api/roblox/poll' && req.method === 'POST') {
    const body = await readBody(req);
    bridge.markConnected(body.studioInfo);
    const commands = await bridge.poll();
    return sendJson(res, 200, { commands });
  }

  if (url === '/api/roblox/result' && req.method === 'POST') {
    const body = await readBody(req);
    bridge.resolveResult(body.id, body.result, body.error);
    return sendJson(res, 200, { ok: true });
  }

  if (url === '/api/roblox/console' && req.method === 'POST') {
    const body = await readBody(req);
    bridge.pushConsole(body.lines || []);
    return sendJson(res, 200, { ok: true });
  }

  if (url === '/api/roblox/disconnect' && req.method === 'POST') {
    bridge.markDisconnected();
    broadcastStatus();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Неизвестный эндпоинт' });
}

// ── REST приложения (провайдеры, модели, чаты, плагин) ─
async function handleAppApi(req, res, url) {
  // Провайдеры
  if (url === '/api/providers' && req.method === 'GET')
    return sendJson(res, 200, { providers: listProviders() });

  if (url === '/api/provider-templates' && req.method === 'GET')
    return sendJson(res, 200, { templates: PROVIDER_TEMPLATES });

  if (url === '/api/providers' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const p = upsertProvider(body);
      broadcastProviders();
      return sendJson(res, 200, { ok: true, provider: { id: p.id, label: p.label, model: p.model } });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (url === '/api/providers/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const ok = deleteProvider(body.id);
    broadcastProviders();
    return sendJson(res, 200, { ok });
  }

  // Живой список моделей по токену
  if (url === '/api/models' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      // Сначала временно применим переданные данные провайдера (если есть).
      if (body.provider && (body.apiKey != null || body.baseUrl)) {
        upsertProvider({ id: body.provider, ...body });
      }
      const models = await fetchModels(body.provider);
      return sendJson(res, 200, { models });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // Чаты
  if (url === '/api/chats' && req.method === 'GET')
    return sendJson(res, 200, { chats: listSessions() });

  if (url === '/api/chats' && req.method === 'POST') {
    const s = createSession();
    return sendJson(res, 200, { chat: s.info() });
  }

  if (url === '/api/chats/messages' && req.method === 'POST') {
    const body = await readBody(req);
    const s = getSession(body.id || 'default');
    return sendJson(res, 200, { id: s.id, info: s.info(), messages: s.uiMessages() });
  }

  if (url === '/api/chats/rename' && req.method === 'POST') {
    const body = await readBody(req);
    const s = getSession(body.id || 'default');
    s.rename(body.title);
    return sendJson(res, 200, { ok: true, chats: listSessions() });
  }

  if (url === '/api/chats/delete' && req.method === 'POST') {
    const body = await readBody(req);
    deleteSession(body.id);
    return sendJson(res, 200, { ok: true, chats: listSessions() });
  }

  if (url === '/api/chats/delete-all' && req.method === 'POST') {
    for (const c of listSessions()) {
      if (c.id !== 'default') deleteSession(c.id);
    }
    getSession('default').reset();
    return sendJson(res, 200, { ok: true, chats: listSessions() });
  }

  // Bridge-токен для плагина Studio (показывается в настройках)
  if (url === '/api/bridge-token' && req.method === 'GET')
    return sendJson(res, 200, { token: getBridgeToken(), port: config.port });

  if (url === '/api/bridge-token' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { token: setBridgeToken(body.token), port: config.port });
  }

  if (url === '/api/bridge-token/regenerate' && req.method === 'POST')
    return sendJson(res, 200, { token: regenerateBridgeToken(), port: config.port });

  // Тумблер локального ПК-агента
  if (url === '/api/pc-agent' && req.method === 'GET')
    return sendJson(res, 200, { enabled: getPcAgent() });

  if (url === '/api/pc-agent' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { enabled: setPcAgent(body.enabled) });
  }

  // ── Обновления приложения ──
  if (url === '/api/update/info' && req.method === 'GET') {
    const force = /[?&]force=1/.test(req.url);
    return sendJson(res, 200, await getUpdateInfo({ force }));
  }
  // Запуск установки: доступен только в десктопе (Electron подкладывает хук).
  if (url === '/api/update/apply' && req.method === 'POST') {
    const u = globalThis.__rubloxUpdater;
    if (u && typeof u.applyUpdate === 'function') {
      u.applyUpdate().catch((e) => console.warn('applyUpdate:', e && e.message));
      return sendJson(res, 200, { started: true });
    }
    return sendJson(res, 200, { started: false, reason: 'not-desktop' });
  }

  // ── База знаний агента (самообучение) ──
  if (url === '/api/knowledge' && req.method === 'GET')
    return sendJson(res, 200, { items: listKnowledge() });
  if (url === '/api/knowledge/clear' && req.method === 'POST') { clearKnowledge(); return sendJson(res, 200, { ok: true }); }
  if (url === '/api/knowledge/remove' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { ok: removeKnowledge(body.id) });
  }
  // Импорт текстового Roblox-плейса (.rbxlx/.rbxmx — это XML): извлекаем дерево
  // класс/имя и записываем компактную сводку в память. Бинарные .rbxl/.rbxm так
  // не читаются — для них используйте capture_place при подключённом мосте.
  if (url === '/api/knowledge/import' && req.method === 'POST') {
    const body = await readBody(req);
    const text = String(body.content || '');
    const name = String(body.name || 'плейс');
    if (!text.trim()) return sendJson(res, 400, { error: 'Пустой файл' });
    // Грубый разбор XML: считаем классы и собираем верхнеуровневые имена.
    const classes = {};
    for (const m of text.matchAll(/<Item\s+class="([^"]+)"/g)) classes[m[1]] = (classes[m[1]] || 0) + 1;
    const names = [...text.matchAll(/<string name="Name">([^<]+)<\/string>/g)].slice(0, 40).map((m) => m[1]);
    const top = Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([c, n]) => `${c}×${n}`);
    if (!top.length) return sendJson(res, 400, { error: 'Не похоже на XML-плейс (.rbxlx/.rbxmx). Бинарные .rbxl читаются только через capture_place.' });
    const summary = `Плейс «${name}»: ${top.join(', ')}. Объекты: ${[...new Set(names)].slice(0, 30).join(', ')}.`;
    const item = addKnowledge(summary, { tags: ['map', name], source: 'import' });
    return sendJson(res, 200, { ok: true, item });
  }

  // ── Лимиты провайдера (rate limits) ──
  if (url === '/api/usage' && req.method === 'POST') {
    const body = await readBody(req);
    const id = body.provider || getSession(body.chatId || 'default').provider;
    return sendJson(res, 200, { usage: { ...getUsage(id), spentTotal: getSpentTotal() }, provider: id });
  }

  // ── Проекты ──
  if (url === '/api/projects' && req.method === 'GET')
    return sendJson(res, 200, { projects: listProjects(), active: getActiveProject() });

  if (url === '/api/projects/create' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.name) return sendJson(res, 400, { error: 'Нужно имя проекта' });
    createProject(body);
    return sendJson(res, 200, { projects: listProjects(), active: getActiveProject() });
  }

  if (url === '/api/projects/update' && req.method === 'POST') {
    const body = await readBody(req);
    updateProject(body.id, body);
    return sendJson(res, 200, { projects: listProjects(), active: getActiveProject() });
  }

  if (url === '/api/projects/active' && req.method === 'POST') {
    const body = await readBody(req);
    setActiveProject(body.id);
    return sendJson(res, 200, { projects: listProjects(), active: getActiveProject() });
  }

  if (url === '/api/projects/delete' && req.method === 'POST') {
    const body = await readBody(req);
    deleteProject(body.id);
    return sendJson(res, 200, { projects: listProjects(), active: getActiveProject() });
  }

  // ── ИИ-плагины (скиллы) ──
  if (url === '/api/skills' && req.method === 'GET')
    return sendJson(res, 200, { skills: listSkills() });

  if (url === '/api/skills/toggle' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { skills: setSkillEnabled(body.id, body.enabled) });
  }

  if (url === '/api/skills/add' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.name || !body.prompt)
      return sendJson(res, 400, { error: 'Нужны name и prompt' });
    return sendJson(res, 200, { skills: addCustomSkill(body) });
  }

  if (url === '/api/skills/remove' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { skills: removeCustomSkill(body.id) });
  }

  // Установка плагина в Roblox Studio
  if (url === '/api/install-plugin' && req.method === 'POST') {
    try {
      const result = installPlugin();
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  return sendJson(res, 404, { error: 'Неизвестный эндпоинт' });
}

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url.startsWith('/api/roblox/')) return await handlePluginApi(req, res, url);
    // Идентификация инстанса: позволяет десктопу отличить «свой» свежий сервер от
    // чужого/залипшего процесса, занявшего порт.
    if (url === '/api/ping') return sendJson(res, 200, { app: 'rublox', version: config.version, pid: process.pid });
    if (url === '/api/status') return sendJson(res, 200, bridge.status());
    if (url.startsWith('/api/')) return await handleAppApi(req, res, url);
    return await serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

// ── WebSocket: чат ─────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
// WebSocketServer тоже эмитит 'error' при EADDRINUSE базового сервера — без
// обработчика это роняло процесс необработанным исключением.
wss.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') return; // уже обработано на http-сервере
  console.error('Ошибка WebSocket-сервера:', err && err.message);
});
const clients = new Set();

function broadcastStatus() {
  const msg = JSON.stringify({ type: 'status', status: bridge.status() });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function broadcastProviders() {
  const msg = JSON.stringify({ type: 'providers', providers: listProviders() });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// Мгновенный broadcast при смене состояния плагина (подключение/отключение/смена плейса).
bridge.onChange = broadcastStatus;
// Периодическая страховка (на случай пропущенного события).
setInterval(broadcastStatus, 4000);

// Активные запуски агента по чатам — для прерывания (кнопка Stop).
const runs = new Map(); // chatId -> AbortController

let cidSeq = 0;
wss.on('connection', (ws) => {
  ws._cid = 'c' + (++cidSeq) + '_' + Date.now().toString(36);
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', cid: ws._cid, version: config.version }));
  ws.send(JSON.stringify({ type: 'status', status: bridge.status() }));
  ws.send(JSON.stringify({ type: 'providers', providers: listProviders() }));
  ws.send(JSON.stringify({ type: 'chats', chats: listSessions() }));

  ws.on('message', async (data) => {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Прерывание текущего запуска в чате.
    if (payload.type === 'stop') {
      const ac = runs.get(payload.chatId || 'default');
      if (ac) ac.abort();
      return;
    }

    // Ответ на вопрос ask_user (клик по кнопке или свой вариант). Не идёт в LLM
    // как новое сообщение — разрешает ожидающий Promise агента.
    if (payload.type === 'ask_answer') {
      const cid = payload.chatId || 'default';
      const answer = String(payload.answer || '');
      const ok = resolveAsk(cid, answer);
      if (ok) {
        // Эхо выбора как сообщение пользователя — чтобы было видно в истории.
        const session = getSession(cid);
        const msg = JSON.stringify({ type: 'ask_answered', chatId: cid, answer, origin: ws._cid });
        for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
        session.persist();
      }
      return;
    }

    if (payload.type !== 'message') return;

    const text = String(payload.text || '').trim();
    const hasImages = Array.isArray(payload.images) && payload.images.length;
    if (!text && !hasImages) return; // пусто и без картинок — игнор

    // Активный чат передаётся клиентом; по умолчанию 'default'.
    const session = getSession(payload.chatId || 'default');
    const chatId = session.id;
    const origin = ws._cid;
    // БРОДКАСТ всем подключённым клиентам (десктоп + браузер видят один чат в
    // реалтайме). События тегируются chatId — клиент рендерит только активный
    // чат; origin — id отправителя, чтобы не дублировать своё сообщение.
    const send = (obj) => {
      const msg = JSON.stringify({ ...obj, chatId, origin });
      for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
    };

    // Слеш-команды обрабатываются локально, без обращения к LLM.
    const cmd = await handleCommand(session, text);
    if (cmd.handled) {
      // silent — служебные команды (смена модели/мышления через минипикер):
      // не пишем в чат и не шлём лишний done, только обновляем состояние сессии.
      if (cmd.silent) {
        session.persist();
        send({ type: 'session', info: session.info() });
        return;
      }
      send({ type: 'assistant', text: cmd.reply });
      session.persist();
      send({ type: 'session', info: session.info() });
      send({ type: 'chats', chats: listSessions() });
      send({ type: 'done' });
      return;
    }

    // Обычное сообщение → агентный цикл с LLM.
    // «ultrathink» в сообщении → максимальное мышление на ЭТОТ ход (как в Claude).
    const ultra = /\bultrathink\b/i.test(text);
    const prevThinking = session.thinking;
    if (ultra) session.thinking = 'max';
    const images = Array.isArray(payload.images) ? payload.images.slice(0, 6) : null;
    session.addUser(text, images);
    send({ type: 'user', text, ultra, images }); // эхо для других клиентов
    send({ type: 'typing' });
    const ac = new AbortController();
    runs.set(chatId, ac);
    let runTokens = 0; // токены этого прогона (последнее значение из status)
    try {
      await runAgent(session, (evType, d) => {
        if (evType === 'status') { if (typeof d.tokens === 'number') runTokens = d.tokens; send({ type: 'status_work', text: d.text, tokens: d.tokens }); }
        else if (evType === 'assistant_start') send({ type: 'assistant_start' });
        else if (evType === 'assistant_delta') send({ type: 'assistant_delta', text: d.text });
        else if (evType === 'assistant_text') send({ type: 'assistant_end', text: d.text });
        else if (evType === 'tool_call') send({ type: 'tool', name: d.name, args: d.args });
        else if (evType === 'tool_result')
          send({ type: 'tool_result', name: d.name, ok: d.ok, result: d.result });
      }, { signal: ac.signal });
      await session.maybeCompress();
    } catch (err) {
      send({ type: 'error', text: err.message });
    } finally {
      runs.delete(chatId);
      if (ultra) session.thinking = prevThinking; // вернуть прежний уровень мышления
    }
    if (runTokens > 0) addSpent(runTokens); // копим суммарный расход токенов
    await session.autoTitle(); // авто-заголовок по теме, если не переименован
    session.persist();
    send({ type: 'session', info: session.info() });
    // Лимиты провайдера + суммарно потраченные токены за всё время (для UI).
    send({ type: 'usage', usage: { ...getUsage(session.provider), spentTotal: getSpentTotal() } });
    send({ type: 'chats', chats: listSessions() });
    send({ type: 'done' });
  });

  ws.on('close', () => clients.delete(ws));
});

// Самопроверка инструментов ДО старта — гарантия, что LLM не словит
// «Неизвестный инструмент». При рассинхроне сервер не стартует.
try {
  const v = validateTools();
  console.log(`Инструменты OK: всего ${v.total} (studio ${v.studio}, pc ${v.pc}, web ${v.web})`);
} catch (err) {
  console.error('ОШИБКА конфигурации инструментов:\n' + err.message);
  process.exit(1);
}

// Порт занят — НЕ роняем процесс необработанным 'error' (раньше из-за этого в
// упакованном приложении окно молча подключалось к чужому серверу). Сообщаем
// наружу: глобальный флаг + хук, который десктоп выставляет до старта сервера.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Порт ${config.port} занят другим процессом — сервер не запущен.`);
    globalThis.__rubloxPortInUse = true;
    if (typeof globalThis.__rubloxOnPortInUse === 'function') {
      try { globalThis.__rubloxOnPortInUse(config.port); } catch { /* десктоп сам разрулит */ }
    }
    return;
  }
  console.error('Ошибка HTTP-сервера:', err && err.message);
});

server.listen(config.port, () => {
  console.log(`Rublox — сервер на http://localhost:${config.port}`);
});
