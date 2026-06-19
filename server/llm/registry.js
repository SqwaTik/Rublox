// Реестр LLM-провайдеров.
//
// Провайдер описывается объектом:
//   { id, label, kind: 'anthropic'|'openai', baseUrl, apiKey, model, apiKeyEnv? }
// kind определяет протокол (формат запроса/ответа), а не конкретного вендора —
// поэтому любой OpenAI-совместимый сервис (OpenRouter, Groq, Together, Mistral,
// DeepSeek, Ollama, vLLM, LM Studio) описывается как kind: 'openai' со своим baseUrl.
//
// Кастомные провайдеры читаются из providers.json в корне проекта (если есть)
// и дополняют/переопределяют встроенные по полю id.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

// Встроенные провайдеры из .env.
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

// Разрешает apiKey: если задан apiKeyEnv — берём из переменной окружения.
function resolveKey(p) {
  if (p.apiKeyEnv && process.env[p.apiKeyEnv]) return process.env[p.apiKeyEnv];
  return p.apiKey || '';
}

function loadCustom() {
  try {
    const raw = readFileSync(join(config.rootDir, 'providers.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.providers || [];
    return list.filter((p) => p && p.id && p.kind && p.baseUrl);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('providers.json:', err.message);
    return [];
  }
}

// Убираем завершающие слэши, иначе baseUrl + '/v1/messages' даст '//v1/...'
function normalizeBaseUrl(url) {
  return typeof url === 'string' ? url.replace(/\/+$/, '') : url;
}

const registry = new Map();

export function loadProviders() {
  registry.clear();
  for (const p of builtins()) registry.set(p.id, p);
  for (const p of loadCustom()) {
    const merged = { ...(registry.get(p.id) || {}), ...p };
    merged.apiKey = resolveKey(merged);
    registry.set(p.id, merged);
  }
  // Финальная обработка: ключи и нормализация baseUrl для всех.
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
  // Публичный список для UI — без секретов.
  return [...registry.values()].map((p) => ({
    id: p.id,
    label: p.label || p.id,
    model: p.model || '',
    kind: p.kind,
    ready: !!p.apiKey || p.kind === 'openai', // local/openai-совместимые часто без ключа
  }));
}

export function isKnownProvider(id) {
  if (!registry.size) loadProviders();
  return registry.has(id);
}

loadProviders();
