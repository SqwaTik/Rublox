// Точка входа сервера: статика веб-чата, WebSocket для чата,
// REST-эндпоинты для плагина Roblox (long-poll и приём результатов).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { bridge } from './bridge.js';
import { getSession } from './session.js';
import { handleCommand } from './commands.js';
import { runAgent } from './agent.js';
import { listProviders } from './llm/registry.js';

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

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url.startsWith('/api/roblox/')) return await handlePluginApi(req, res, url);
    if (url === '/api/status') return sendJson(res, 200, bridge.status());
    if (url === '/api/providers') return sendJson(res, 200, { providers: listProviders() });
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

// Периодически рассылаем статус соединения с Roblox.
setInterval(broadcastStatus, 5000);

wss.on('connection', (ws) => {
  clients.add(ws);
  const session = getSession('default');
  ws.send(JSON.stringify({ type: 'status', status: bridge.status() }));
  ws.send(JSON.stringify({ type: 'providers', providers: listProviders() }));
  ws.send(JSON.stringify({ type: 'session', info: session.info() }));

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

    const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

    // Слеш-команды обрабатываются локально, без обращения к LLM.
    const cmd = await handleCommand(session, text);
    if (cmd.handled) {
      send({ type: 'assistant', text: cmd.reply });
      session.persist();
      send({ type: 'session', info: session.info() });
      send({ type: 'done' });
      return;
    }

    // Обычное сообщение → агентный цикл с LLM.
    session.addUser(text);
    send({ type: 'typing' });
    try {
      await runAgent(session, (evType, data) => {
        if (evType === 'assistant_start') send({ type: 'assistant_start' });
        else if (evType === 'assistant_delta') send({ type: 'assistant_delta', text: data.text });
        else if (evType === 'assistant_text') send({ type: 'assistant_end', text: data.text });
        else if (evType === 'tool_call') send({ type: 'tool', name: data.name, args: data.args });
        else if (evType === 'tool_result')
          send({ type: 'tool_result', name: data.name, ok: data.ok, result: data.result });
      });
      await session.maybeCompress();
    } catch (err) {
      send({ type: 'error', text: err.message });
    }
    session.persist();
    send({ type: 'session', info: session.info() });
    send({ type: 'done' });
  });

  ws.on('close', () => clients.delete(ws));
});

server.listen(config.port, () => {
  console.log(`Roblox AI Assistant — сервер на http://localhost:${config.port}`);
  console.log(`Провайдер по умолчанию: ${config.provider} (${config.model})`);
});
