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

// ── Живая подгрузка списка моделей по токену ────────────
export async function fetchModels(id) {
  const p = getProvider(id);
  if (!p) throw new Error(`Провайдер "${id}" не найден`);
  const kind = effectiveKind(p.kind);

  if (kind === 'openai') {
    const res = await fetch(`${p.baseUrl}/models`, {
      headers: {
        authorization: `Bearer ${p.apiKey || 'not-needed'}`,
        'user-agent': 'Rublox/0.2 (+https://github.com/SqwaTik/roblox-ai-assistant)',
        accept: 'application/json',
        ...(p.headers || {}),
      },
    });
    const t = await res.text();
    if (!res.ok) {
      // 3xx (напр. 305 Use Proxy) — почти всегда неверный baseUrl или адрес
      // требует прокси/редирект, который мы не следуем. Поясняем по-человечески.
      const hint = res.status >= 300 && res.status < 400
        ? ` — адрес перенаправляет (${res.status}); проверьте baseUrl (нужен прямой путь до /v1).`
        : '';
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 160)}${hint}`);
    }
    // Если вернулся HTML (страница, редирект, неверный baseUrl) — JSON.parse даст
    // невнятное "Unexpected token '<'". Ловим и показываем понятную причину.
    let data;
    try {
      data = JSON.parse(t);
    } catch {
      const looksHtml = /^\s*</.test(t);
      throw new Error(
        looksHtml
          ? `Адрес ${p.baseUrl}/models вернул HTML, а не JSON — проверьте baseUrl (нужен путь до /v1).`
          : `Ответ /models не является JSON: ${t.slice(0, 160)}`
      );
    }
    const list = (data.data || data.models || [])
      .map((m) => (typeof m === 'string' ? m : m.id || m.name))
      .filter(Boolean);
    return [...new Set(list)].sort();
  }

  // Anthropic: пробуем /v1/models, иначе дефолтный набор.
  try {
    const res = await fetch(`${p.baseUrl}/v1/models`, {
      headers: {
        'x-api-key': p.apiKey,
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-cli/1.0.0 (external, cli)',
        ...(p.headers || {}),
      },
    });
    if (res.ok) {
      const data = await res.json();
      const list = (data.data || data.models || [])
        .map((m) => (typeof m === 'string' ? m : m.id))
        .filter(Boolean);
      if (list.length) return [...new Set(list)].sort();
    }
  } catch {
    /* падаем в дефолт ниже */
  }
  return [
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet-20241022',
  ];
}

loadProviders();
