// Реестр LLM-провайдеров с пользовательским CRUD и живой подгрузкой моделей.
//
// Провайдер: { id, label, kind:'anthropic'|'openai', baseUrl, apiKey, model,
//              apiKeyEnv?, headers? }
// kind определяет протокол, а не вендора — любой OpenAI-совместимый сервис
// (OpenRouter, Groq, Together, DeepSeek, Ollama, vLLM, LM Studio) описывается
// как kind:'openai' со своим baseUrl.
//
// Источники (по возрастанию приоритета):
//   1) встроенные из .env
//   2) providers.json в корне (только чтение)
//   3) data/providers.user.json — то, что пользователь задал/изменил через UI

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const userFile = join(config.rootDir, 'data', 'providers.user.json');

function builtins() {
  return [
    {
      id: 'anthropic',
      label: 'Claude',
      kind: 'anthropic',
      baseUrl: config.anthropic.baseUrl,
      apiKey: config.anthropic.apiKey,
      model: config.model,
    },
    {
      id: 'openai',
      label: 'ChatGPT',
      kind: 'openai',
      baseUrl: config.openai.baseUrl,
      apiKey: config.openai.apiKey,
      model: 'gpt-4o',
    },
    {
      id: 'local',
      label: 'Local',
      kind: 'openai',
      baseUrl: config.local.baseUrl,
      apiKey: config.local.apiKey,
      model: config.local.model,
    },
  ];
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

function saveUser() {
  try {
    const dir = join(config.rootDir, 'data');
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
  const layers = [...builtins(), ...loadCustom(), ...userProviders];
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
  if (!registry.size) loadProviders();
  return [...registry.values()].map((p) => ({
    id: p.id,
    label: p.label || p.id,
    model: p.model || '',
    kind: p.kind,
    baseUrl: p.baseUrl,
    hasKey: !!p.apiKey,
    ready: !!p.apiKey || p.kind === 'openai',
  }));
}

export function isKnownProvider(id) {
  if (!registry.size) loadProviders();
  return registry.has(id);
}

// ── CRUD пользовательских провайдеров (из UI) ──────────
// Создать или обновить провайдер. Возвращает публичный объект.
export function upsertProvider(input) {
  if (!input || !input.id) throw new Error('Нужен id провайдера');
  const id = String(input.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const existing = userProviders.find((p) => p.id === id) || {};
  const p = {
    id,
    label: input.label || existing.label || id,
    kind: input.kind || existing.kind || 'openai',
    baseUrl: normalizeBaseUrl(input.baseUrl || existing.baseUrl || ''),
    apiKey: input.apiKey != null ? input.apiKey : existing.apiKey || '',
    model: input.model || existing.model || '',
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
// Возвращает массив строковых id моделей, доступных у провайдера.
export async function fetchModels(id) {
  const p = getProvider(id);
  if (!p) throw new Error(`Провайдер "${id}" не найден`);

  if (p.kind === 'openai') {
    // Стандартный OpenAI-эндпоинт /models.
    const res = await fetch(`${p.baseUrl}/models`, {
      headers: {
        authorization: `Bearer ${p.apiKey || 'not-needed'}`,
        ...(p.headers || {}),
      },
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const list = (data.data || data.models || [])
      .map((m) => (typeof m === 'string' ? m : m.id || m.name))
      .filter(Boolean);
    return [...new Set(list)].sort();
  }

  // У Anthropic есть /v1/models (не на всех прокси). Пробуем, иначе — дефолтный набор.
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
