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
import { runAgent } from './agent.js';
import {
  listProviders, upsertProvider, deleteProvider, fetchModels,
} from './llm/registry.js';
import { PROVIDER_TEMPLATES } from './llm/provider-templates.js';
import { installPlugin } from './plugin-installer.js';

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
  return token === config.bridgeToken;
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
    if (url === '/api/status') return sendJson(res, 200, bridge.status());
    if (url.startsWith('/api/')) return await handleAppApi(req, res, url);
    return await serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

// ── WebSocket: чат ─────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
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

// Периодически рассылаем статус соединения с Roblox.
setInterval(broadcastStatus, 5000);

wss.on('connection', (ws) => {
  clients.add(ws);
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
    if (payload.type !== 'message') return;

    const text = String(payload.text || '').trim();
    if (!text) return;

    // Активный чат передаётся клиентом; по умолчанию 'default'.
    const session = getSession(payload.chatId || 'default');
    const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

    // Слеш-команды обрабатываются локально, без обращения к LLM.
    const cmd = await handleCommand(session, text);
    if (cmd.handled) {
      send({ type: 'assistant', text: cmd.reply });
      session.persist();
      send({ type: 'session', info: session.info() });
      send({ type: 'chats', chats: listSessions() });
      send({ type: 'done' });
      return;
    }

    // Обычное сообщение → агентный цикл с LLM.
    session.addUser(text);
    send({ type: 'typing' });
    try {
      await runAgent(session, (evType, d) => {
        if (evType === 'status') send({ type: 'status_work', text: d.text, tokens: d.tokens });
        else if (evType === 'assistant_start') send({ type: 'assistant_start' });
        else if (evType === 'assistant_delta') send({ type: 'assistant_delta', text: d.text });
        else if (evType === 'assistant_text') send({ type: 'assistant_end', text: d.text });
        else if (evType === 'tool_call') send({ type: 'tool', name: d.name, args: d.args });
        else if (evType === 'tool_result')
          send({ type: 'tool_result', name: d.name, ok: d.ok, result: d.result });
      });
      await session.maybeCompress();
    } catch (err) {
      send({ type: 'error', text: err.message });
    }
    await session.autoTitle(); // авто-заголовок по теме, если не переименован
    session.persist();
    send({ type: 'session', info: session.info() });
    send({ type: 'chats', chats: listSessions() });
    send({ type: 'done' });
  });

  ws.on('close', () => clients.delete(ws));
});

server.listen(config.port, () => {
  console.log(`Rublox — сервер на http://localhost:${config.port}`);
});
