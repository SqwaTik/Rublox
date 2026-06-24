// Реестр LLM-провайдеров с пользовательским CRUD и живой подгрузкой моделей.
//
// Провайдер: { id, label, kind:'anthropic'|'openai'|'multi', baseUrl, apiKey,
//              model, apiKeyEnv?, headers? }
// kind определяет протокол запроса/ответа:
//   - 'openai'    — OpenAI-совместимый (/chat/completions, /models)
//   - 'anthropic' — Anthropic Messages API (/v1/messages)
//   - 'multi'     — мультипротокол: вход в OpenAI-формате, но провайдер сам
//                   маршрутизирует к моделям OpenAI/Anthropic/DeepSeek/Zhipu/
//                   MiniMax/Kimi и т.д. (OmniRoute, OpenRouter). Технически
//                   обрабатывается как openai.
//
// По умолчанию провайдеров НЕТ (пустой список). Пользователь добавляет их через
// UI (шаблоны + свой ключ) или через providers.json. Всё пишется в
// data/providers.user.json.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const userFile = join(config.dataDir, 'data', 'providers.user.json');

// Нормализация протокола: 'multi' исполняется как openai.
export function effectiveKind(kind) {
  return kind === 'anthropic' ? 'anthropic' : 'openai';
}

function resolveKey(p) {
  if (p.apiKeyEnv && process.env[p.apiKeyEnv]) return process.env[p.apiKeyEnv];
  return p.apiKey || '';
}

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`${path}:`, err.message);
    return fallback;
  }
}

function loadCustom() {
  const parsed = readJsonFile(join(config.rootDir, 'providers.json'), []);
  const list = Array.isArray(parsed) ? parsed : parsed.providers || [];
  return list.filter((p) => p && p.id && p.kind && p.baseUrl);
}

function loadUser() {
  const parsed = readJsonFile(userFile, []);
  const list = Array.isArray(parsed) ? parsed : parsed.providers || [];
  return list.filter((p) => p && p.id && p.kind && p.baseUrl);
}

// Авто-подхват ключей из .env для популярных провайдеров (если задан env, но
// сам провайдер ещё не добавлен — он НЕ появляется; ключ применяется лишь когда
// пользователь добавит провайдера с таким id или apiKeyEnv).
function saveUser() {
  try {
    const dir = join(config.dataDir, 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(userFile, JSON.stringify(userProviders, null, 2));
  } catch (err) {
    console.warn('saveUser providers:', err.message);
  }
}

// Убираем завершающие слэши, иначе baseUrl + '/v1/messages' даст '//v1/...'
function normalizeBaseUrl(url) {
  return typeof url === 'string' ? url.replace(/\/+$/, '') : url;
}

const registry = new Map();
let userProviders = []; // изменяемый слой (UI)

export function loadProviders() {
  registry.clear();
  userProviders = loadUser();
  // Нет builtins — стартуем с 0 провайдеров. Только то, что добавил пользователь.
  const layers = [...loadCustom(), ...userProviders];
  for (const p of layers) {
    const merged = { ...(registry.get(p.id) || {}), ...p };
    registry.set(p.id, merged);
  }
  for (const [id, p] of registry) {
    registry.set(id, {
      ...p,
      apiKey: resolveKey(p),
      baseUrl: normalizeBaseUrl(p.baseUrl),
    });
  }
  return registry;
}

export function getProvider(id) {
  if (!registry.size) loadProviders();
  return registry.get(id);
}

export function listProviders() {
  loadProviders(); // всегда свежий список (мог измениться файл)
  return [...registry.values()].map((p) => ({
    id: p.id,
    label: p.label || p.id,
    model: p.model || '',
    kind: p.kind,
    baseUrl: p.baseUrl,
    hasKey: !!p.apiKey,
    ready: !!p.apiKey,
  }));
}

export function isKnownProvider(id) {
  return !!getProvider(id);
}

// ── CRUD пользовательских провайдеров (из UI) ──────────
export function upsertProvider(input) {
  if (!input || !input.id) throw new Error('Нужен id провайдера');
  const id = String(input.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const existing = userProviders.find((p) => p.id === id) || {};
  const p = {
    id,
    label: input.label || existing.label || id,
    kind: input.kind || existing.kind || 'multi',
    baseUrl: normalizeBaseUrl(input.baseUrl || existing.baseUrl || ''),
    apiKey: input.apiKey != null && input.apiKey !== '' ? input.apiKey : existing.apiKey || '',
    model: input.model != null ? input.model : existing.model || '',
    headers: input.headers || existing.headers || undefined,
  };
  if (!p.baseUrl) throw new Error('Нужен baseUrl');
  userProviders = userProviders.filter((x) => x.id !== id);
  userProviders.push(p);
  saveUser();
  loadProviders();
  return getProvider(id);
}

export function deleteProvider(id) {
  const before = userProviders.length;
  userProviders = userProviders.filter((p) => p.id !== id);
  if (userProviders.length === before) return false;
  saveUser();
  loadProviders();
  return true;
}

// Какие протоколы из supported_protocols совместимы с нашим режимом запроса.
// anthropic шлёт в /v1/messages → нужен 'messages'. openai шлёт в /chat/completions
// → 'chat'/'completions'/'openai' (новый 'responses' мы пока не вызываем, поэтому
// responses-only модели для openai-режима не показываем как рабочие).
function protoMatches(kind, protos) {
  if (!Array.isArray(protos) || !protos.length) return true; // нет инфы — показываем
  const has = (x) => protos.includes(x);
  if (kind === 'anthropic') return has('messages') || has('anthropic');
  return has('chat') || has('completions') || has('openai') || has('responses');
}

// ── Живая подгрузка списка моделей по токену ────────────
// Универсально: пробуем оба пути (/v1/models и /models) и оба заголовка
// авторизации (Bearer и x-api-key) — разные шлюзы хотят разное (напр. OpenModel
// /v1/models принимает только Bearer, официальный Anthropic — только x-api-key).
// Если шлюз сообщает supported_protocols у моделей — показываем только те, что
// реально работают в выбранном протоколе. Так список = реально доступные модели.
export async function fetchModels(id) {
  const p = getProvider(id);
  if (!p) throw new Error(`Провайдер "${id}" не найден`);
  const kind = effectiveKind(p.kind);

  const base = String(p.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('Не задан baseUrl провайдера');
  const hasVer = /\/v\d+$/.test(base);
  const urls = hasVer ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];

  // Та же «личность Claude Code», что и в боевых запросах (см. providers.js):
  // реселлеры (agentrouter, aerolink) отдают /models только клиенту-CLI, иначе
  // 401 → список не грузился и подставлялся хардкод-фолбэк из claude-моделей.
  const common = {
    'user-agent': 'claude-cli/1.0.119 (external, cli)',
    'x-app': 'cli',
    accept: 'application/json',
    ...(p.headers || {}),
  };
  const authSets = [
    { authorization: `Bearer ${p.apiKey || 'not-needed'}` },
    { 'x-api-key': p.apiKey || '', 'anthropic-version': '2023-06-01' },
  ];

  let lastErr = '';
  for (const url of urls) {
    for (const auth of authSets) {
      try {
        const res = await fetch(url, { headers: { ...common, ...auth } });
        const t = await res.text();
        if (!res.ok) { lastErr = `HTTP ${res.status}: ${t.slice(0, 120)}`; continue; }
        let data;
        try { data = JSON.parse(t); } catch { lastErr = /^\s*</.test(t) ? 'вернулся HTML (проверьте baseUrl)' : 'ответ не JSON'; continue; }
        const raw = data.data || data.models || data || [];
        const entries = (Array.isArray(raw) ? raw : []).map((m) => (
          typeof m === 'string'
            ? { id: m, protos: null }
            : { id: m.id || m.name, protos: m.supported_protocols || m.supported_endpoint_types || null }
        )).filter((e) => e.id);
        if (!entries.length) { lastErr = 'пустой список моделей'; continue; }
        // Показываем ВСЕ модели, что отдаёт шлюз. Реселлеры-роутеры (agentrouter и
        // т.п.) кросс-маршрутизируют: openai-модель (gpt-5.5, GLM …) вызывается и
        // через /v1/messages у anthropic-провайдера — проверено вживую. Поэтому не
        // прячем по протоколу (иначе у anthropic-шлюза находились только claude).
        // Совместимые с текущим протоколом ставим первыми для удобства выбора.
        const compatible = entries.filter((e) => protoMatches(kind, e.protos)).map((e) => e.id);
        const compatibleSet = new Set(compatible);
        const rest = entries.map((e) => e.id).filter((id) => !compatibleSet.has(id));
        const list = [...new Set([...compatible.sort(), ...rest.sort()])];
        return list;
      } catch (e) { lastErr = e.message; }
    }
  }

  // Ничего не сработало. Для anthropic не оставляем UI пустым — даём известные
  // claude-модели как резерв; для openai честно сообщаем ошибку.
  if (kind === 'anthropic') {
    return ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
  }
  throw new Error(`Не удалось получить модели: ${lastErr || 'нет ответа от провайдера'}`);
}

loadProviders();
