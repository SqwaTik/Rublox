// Пайплайн «текст → 3D-меш → Roblox» (как у nilo):
//  1) Meshy text-to-3d (preview = low-poly геометрия, refine = текстура) → fbx;
//  2) скачиваем fbx;
//  3) грузим в Roblox через Open Cloud Assets API (assetType Model) → assetId.
// Ключи: env (MESHY_API_KEY / ROBLOX_OPEN_CLOUD_KEY / ROBLOX_CREATOR_USER_ID|GROUP_ID)
// или data/app.json (meshyApiKey / openCloudApiKey / openCloudUserId|GroupId).
//
// Зависимостей нет: используем глобальные fetch/FormData/Blob (Node 18+).

import { appConfigGet } from './app-config.js';

const MESHY_BASE = process.env.MESHY_BASE_URL || 'https://api.meshy.ai/openapi/v2';
const TRIPO_BASE = process.env.TRIPO_BASE_URL || 'https://api.tripo3d.ai/v2/openapi';
const TRIPO_MODEL = process.env.TRIPO_MODEL || ''; // пусто = версия по умолчанию Tripo (избегаем «invalid version»)
const OPEN_CLOUD_BASE = process.env.ROBLOX_OPEN_CLOUD_BASE || 'https://apis.roblox.com/assets/v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Пул ключей с авто-свапом ───────────────────────────
// У каждого сервиса можно держать несколько ключей (массив в data/app.json,
// либо ENV/одиночное поле — разделители: перевод строки, запятая, пробел).
// withKey() начинает с последнего рабочего ключа и при ошибке лимита/квоты/
// авторизации (swap-ошибка) автоматически переключается на следующий.
const KEY_SRC = {
  tripo:     { env: 'TRIPO_API_KEY',        single: 'tripoApiKey',      arr: 'tripoApiKeys' },
  meshy:     { env: 'MESHY_API_KEY',        single: 'meshyApiKey',      arr: 'meshyApiKeys' },
  opencloud: { env: 'ROBLOX_OPEN_CLOUD_KEY', single: 'openCloudApiKey', arr: 'openCloudApiKeys' },
};
const poolIdx = {}; // service -> индекс последнего рабочего ключа

function poolKeys(service) {
  const c = KEY_SRC[service];
  if (!c) return [];
  const parts = [];
  if (process.env[c.env]) parts.push(process.env[c.env]);
  const arr = appConfigGet(c.arr, null);
  if (Array.isArray(arr)) parts.push(...arr);
  const single = appConfigGet(c.single, '');
  if (single) parts.push(single);
  const keys = parts
    .flatMap((s) => String(s || '').split(/[\s,]+/))
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(keys)];
}

// Признак ошибки, при которой стоит сменить ключ (лимит/квота/баланс/авторизация).
function isSwapError(status, text) {
  if ([401, 402, 403, 429].includes(Number(status))) return true;
  return /quota|insufficient|credit|balance|rate.?limit|exceeded|too many|unauthor|forbidden|expired|invalid.*(key|token)|payment/i.test(String(text || ''));
}
function swapError(status, text, label) {
  const e = new Error(`${label} ${status}: ${String(text).slice(0, 300)}`);
  e._swap = isSwapError(status, text);
  e._status = Number(status);
  return e;
}

// Выполнить fn(key) с авто-свапом: стартуем с запомненного индекса, при swap-ошибке
// идём к следующему ключу; запоминаем рабочий. Бросаем последнюю ошибку, если все пали.
async function withKey(service, fn) {
  const keys = poolKeys(service);
  if (!keys.length) throw new Error(`Нет ключа (${service}).`);
  let start = poolIdx[service] || 0;
  if (start >= keys.length) start = 0;
  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    const idx = (start + i) % keys.length;
    try {
      const out = await fn(keys[idx]);
      poolIdx[service] = idx;
      return out;
    } catch (e) {
      lastErr = e;
      if (!e || !e._swap || keys.length === 1) throw e;
      // swap-ошибка и есть запасные ключи → пробуем следующий
    }
  }
  throw lastErr;
}

// Какой генератор использовать: 'meshy' | 'tripo' | 'auto' (auto → tripo при наличии ключа, иначе meshy).
function resolveProvider(explicit) {
  let p = String(explicit || process.env.MESH3D_PROVIDER || appConfigGet('mesh3dProvider', '') || 'auto').trim().toLowerCase();
  if (p === 'auto') p = poolKeys('tripo').length ? 'tripo' : 'meshy';
  return p;
}
function openCloudCreator() {
  const uid = String(process.env.ROBLOX_CREATOR_USER_ID || appConfigGet('openCloudUserId', '') || '').trim();
  const gid = String(process.env.ROBLOX_CREATOR_GROUP_ID || appConfigGet('openCloudGroupId', '') || '').trim();
  return { uid, gid };
}

// Готовность интеграции (булевы флаги, для agent.js/диагностики).
export function meshConfigStatus() {
  const c = openCloudCreator();
  const tripo = poolKeys('tripo').length;
  const meshy = poolKeys('meshy').length;
  return {
    meshy: !!meshy,
    tripo: !!tripo,
    generator: !!(meshy || tripo),
    provider: resolveProvider(),
    openCloud: !!poolKeys('opencloud').length,
    creator: !!(c.uid || c.gid),
  };
}

// Подробности для UI настроек (списки ключей + счётчики + создатель).
export function meshConfigDetail() {
  const c = openCloudCreator();
  return {
    ...meshConfigStatus(),
    tripoKeys: poolKeys('tripo'),
    meshyKeys: poolKeys('meshy'),
    openCloudKeys: poolKeys('opencloud'),
    counts: { tripo: poolKeys('tripo').length, meshy: poolKeys('meshy').length, openCloud: poolKeys('opencloud').length },
    openCloudUserId: c.uid,
    openCloudGroupId: c.gid,
    mesh3dProvider: String(appConfigGet('mesh3dProvider', '') || 'auto'),
    mesh3dPolycount: meshPolycount(),
  };
}

// Дефолтное число полигонов (когда ИИ не задал своё в аргументах инструмента).
export function meshPolycount() {
  const n = Number(process.env.MESH3D_POLYCOUNT || appConfigGet('mesh3dPolycount', 0)) || 6000;
  return Math.min(50000, Math.max(500, Math.round(n)));
}

// ── Meshy ──────────────────────────────────────────────
async function meshyCreate(key, body) {
  const res = await fetch(`${MESHY_BASE}/text-to-3d`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let data = {};
  try { data = JSON.parse(txt); } catch { /* ignore */ }
  if (!res.ok) throw swapError(res.status, txt, 'Meshy');
  if (!data.result) throw new Error(`Meshy: нет task id в ответе (${txt.slice(0, 200)})`);
  return data.result;
}

async function meshyPoll(key, taskId, { timeoutMs = 300000, onProgress } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${MESHY_BASE}/text-to-3d/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (data.status === 'SUCCEEDED') return data;
    if (data.status === 'FAILED' || data.status === 'CANCELED') {
      const msg = (data.task_error && data.task_error.message) || data.status;
      throw new Error(`Meshy задача завершилась: ${msg}`);
    }
    if (onProgress) onProgress(Number(data.progress) || 0, data.status || 'PENDING');
    await sleep(5000);
  }
  throw new Error('Meshy: превышено время ожидания генерации.');
}

// Сгенерировать меш через Meshy (с авто-свапом ключей) и вернуть ссылки на форматы.
async function generateMeshMeshy({ prompt, polycount = 6000, refine = true, onProgress } = {}) {
  if (!poolKeys('meshy').length) throw new Error('Нет ключа Meshy (MESHY_API_KEY или meshyApiKey в настройках).');
  if (!prompt || !String(prompt).trim()) throw new Error('Пустой prompt для генерации.');
  return withKey('meshy', async (key) => {
    const previewId = await meshyCreate(key, {
      mode: 'preview',
      prompt: String(prompt),
      should_remesh: true,
      target_polycount: Math.max(1000, Number(polycount) || 6000),
      target_formats: ['fbx', 'glb'],
    });
    let task = await meshyPoll(key, previewId, { onProgress });
    if (refine) {
      const refineId = await meshyCreate(key, { mode: 'refine', preview_task_id: previewId });
      task = await meshyPoll(key, refineId, { onProgress });
    }
    const urls = task.model_urls || {};
    if (!urls.fbx) throw new Error('Meshy: в ответе нет ссылки на fbx.');
    return {
      fbxUrl: urls.fbx, glbUrl: urls.glb, objUrl: urls.obj,
      thumbnail: task.thumbnail_url, taskId: task.id || previewId,
    };
  });
}

// ── Tripo 3D ───────────────────────────────────────────
async function tripoCreate(key, body) {
  const res = await fetch(`${TRIPO_BASE}/task`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let data = {};
  try { data = JSON.parse(txt); } catch { /* ignore */ }
  if (!res.ok) throw swapError(res.status, txt, 'Tripo');
  // code != 0 при нехватке кредитов/неверном ключе — тоже повод сменить ключ.
  if (data.code !== 0) throw swapError(res.status, `code ${data.code}: ${data.message || txt.slice(0, 200)}`, 'Tripo');
  if (!data.data || !data.data.task_id) throw new Error(`Tripo: нет task id в ответе (${txt.slice(0, 200)})`);
  return data.data.task_id;
}

async function tripoPoll(key, taskId, { timeoutMs = 300000, onProgress } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${TRIPO_BASE}/task/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    const d = data.data || {};
    const status = String(d.status || '').toLowerCase();
    if (status === 'success') return d;
    if (['failed', 'cancelled', 'canceled', 'banned', 'expired', 'error', 'unknown'].includes(status))
      throw new Error(`Tripo задача завершилась: ${status}`);
    if (onProgress) onProgress(Number(d.progress) || 0, status || 'queued');
    await sleep(5000);
  }
  throw new Error('Tripo: превышено время ожидания генерации.');
}

// Выбрать из output URL с нужным расширением (output — словарь строковых ссылок).
function pickUrl(output, ext) {
  if (!output || typeof output !== 'object') return '';
  const urls = Object.values(output).filter((v) => typeof v === 'string' && /^https?:/i.test(v));
  return urls.find((u) => u.split('?')[0].toLowerCase().endsWith('.' + ext)) || '';
}

// Сгенерировать меш через Tripo. Open Cloud принимает Model только в FBX —
// поэтому после text_to_model запускаем convert_model в FBX.
async function generateMeshTripo({ prompt, polycount = 6000, refine = true, onProgress } = {}) {
  if (!poolKeys('tripo').length) throw new Error('Нет ключа Tripo (TRIPO_API_KEY или tripoApiKey в настройках).');
  if (!prompt || !String(prompt).trim()) throw new Error('Пустой prompt для генерации.');
  const faceLimit = Math.max(500, Number(polycount) || 6000);
  return withKey('tripo', async (key) => {
    const body = {
      type: 'text_to_model',
      prompt: String(prompt),
      face_limit: faceLimit,
      texture: refine !== false,
      pbr: refine !== false,
    };
    // model_version шлём ТОЛЬКО если задан явно (TRIPO_MODEL): неверное значение
    // даёт «400 code 2017 The version value is invalid». Без поля Tripo берёт свою
    // актуальную версию по умолчанию.
    if (TRIPO_MODEL) body.model_version = TRIPO_MODEL;
    const baseId = await tripoCreate(key, body);
    const baseTask = await tripoPoll(key, baseId, { onProgress });
    const out = baseTask.output || {};
    const glbUrl = pickUrl(out, 'glb') || out.pbr_model || out.model || '';
    const thumbnail = pickUrl(out, 'webp') || pickUrl(out, 'png') || out.rendered_image || '';

    const convId = await tripoCreate(key, { type: 'convert_model', format: 'FBX', original_model_task_id: baseId, quad: false });
    const convTask = await tripoPoll(key, convId, { onProgress });
    const fbxUrl = pickUrl(convTask.output || {}, 'fbx') || (convTask.output && convTask.output.model) || '';
    if (!fbxUrl) throw new Error('Tripo: не удалось получить FBX после конвертации.');
    return { fbxUrl, glbUrl, objUrl: '', thumbnail, taskId: baseId };
  });
}

// ── Проверка ключей (баланс/валидность) для UI ─────────
const MESHY_ROOT = MESHY_BASE.replace(/\/v\d+$/, ''); // .../openapi

async function tripoBalance(key) {
  // Путь баланса лежит в разделе Wallet; пробуем известные варианты.
  let lastErr = '';
  for (const path of ['/user/balance', '/wallet/balance', '/balance']) {
    try {
      const res = await fetch(`${TRIPO_BASE}${path}`, { headers: { Authorization: `Bearer ${key}` } });
      const txt = await res.text();
      let d = {}; try { d = JSON.parse(txt); } catch { /* ignore */ }
      if (res.ok && d.code === 0 && d.data) return { ok: true, balance: Number(d.data.balance) };
      lastErr = `${res.status}: ${(d.message || txt).slice(0, 80)}`;
      if (res.status === 401 || res.status === 403) return { ok: false, error: lastErr };
    } catch (e) { lastErr = e.message; }
  }
  return { ok: false, error: lastErr || 'нет ответа' };
}

async function meshyBalance(key) {
  try {
    const res = await fetch(`${MESHY_ROOT}/v1/balance`, { headers: { Authorization: `Bearer ${key}` } });
    const txt = await res.text();
    let d = {}; try { d = JSON.parse(txt); } catch { /* ignore */ }
    if (res.ok) return { ok: true, balance: Number(d.balance ?? d.result ?? d.credits) };
    return { ok: false, error: `${res.status}: ${(d.message || txt).slice(0, 80)}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

function maskKey(k) {
  const s = String(k || '');
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : `${s.slice(0, 3)}…`;
}

// Проверить все сохранённые ключи: для tripo/meshy — баланс; для opencloud — только наличие.
export async function testMeshKeys() {
  const out = { tripo: [], meshy: [], openCloud: [] };
  for (const k of poolKeys('tripo')) out.tripo.push({ key: maskKey(k), ...(await tripoBalance(k)) });
  for (const k of poolKeys('meshy')) out.meshy.push({ key: maskKey(k), ...(await meshyBalance(k)) });
  out.openCloud = poolKeys('opencloud').map((k) => ({ key: maskKey(k), ok: null }));
  return out;
}

// Диспетчер генератора (Meshy / Tripo) по выбранному провайдеру.
export async function generateMesh(opts = {}) {
  const provider = resolveProvider(opts.provider);
  if (provider === 'tripo') return generateMeshTripo(opts);
  return generateMeshMeshy(opts);
}

async function downloadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Скачивание меша: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new Error('Файл меша больше 20 МБ — Open Cloud не примет.');
  return buf;
}

// ── Roblox Open Cloud ──────────────────────────────────
export async function uploadToRoblox(fbxBuffer, { name = 'AIModel', description = 'Generated by Rublox' } = {}) {
  if (!poolKeys('opencloud').length) throw new Error('Нет ключа Open Cloud (ROBLOX_OPEN_CLOUD_KEY или openCloudApiKey).');
  const { uid, gid } = openCloudCreator();
  if (!uid && !gid) throw new Error('Не задан создатель (ROBLOX_CREATOR_USER_ID или ROBLOX_CREATOR_GROUP_ID).');
  const displayName = (String(name).replace(/[^\w \-]/g, '').trim() || 'AIModel').slice(0, 50);
  const request = {
    assetType: 'Model',
    displayName,
    description: String(description).slice(0, 1000),
    creationContext: { creator: gid ? { groupId: gid } : { userId: uid } },
  };

  return withKey('opencloud', async (key) => {
    const form = new FormData();
    form.append('request', JSON.stringify(request));
    form.append('fileContent', new Blob([fbxBuffer], { type: 'model/fbx' }), `${displayName}.fbx`);

    const res = await fetch(`${OPEN_CLOUD_BASE}/assets`, {
      method: 'POST', headers: { 'x-api-key': key }, body: form,
    });
    const txt = await res.text();
    if (!res.ok) throw swapError(res.status, txt, 'Open Cloud');
    let data = {};
    try { data = JSON.parse(txt); } catch { /* ignore */ }
    const opId = String(data.path || '').replace(/^operations\//, '') || data.operationId || '';
    if (!opId) throw new Error(`Open Cloud: нет operationId (${txt.slice(0, 200)})`);

    const start = Date.now();
    while (Date.now() - start < 150000) {
      await sleep(3000);
      const r = await fetch(`${OPEN_CLOUD_BASE}/operations/${opId}`, { headers: { 'x-api-key': key } });
      let d = {};
      try { d = await r.json(); } catch { /* ignore */ }
      if (d.done) {
        const assetId = d.response && (d.response.assetId || d.response.assetID);
        if (!assetId) throw new Error(`Open Cloud: завершено без assetId (${JSON.stringify(d).slice(0, 200)})`);
        return String(assetId);
      }
    }
    throw new Error('Open Cloud: превышено ожидание обработки (модерация ассета может занять время).');
  });
}

// Полный путь: текст → меш → Roblox assetId.
export async function generateAndUpload({ prompt, polycount, refine, name, onProgress } = {}) {
  const gen = await generateMesh({ prompt, polycount, refine, onProgress });
  const buf = await downloadBuffer(gen.fbxUrl);
  const assetId = await uploadToRoblox(buf, { name: name || prompt });
  return { assetId, ...gen };
}
