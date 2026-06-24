// Учёт лимитов (rate limits) провайдеров. Anthropic и OpenAI присылают остаток
// лимитов в заголовках КАЖДОГО ответа — мы их перехватываем и храним последний
// снимок по провайдеру. Это реальные данные от API, а не выдумка: если заголовков
// нет (локальная модель, нестандартный шлюз) — снимок помечается available:false.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

const lastByProvider = new Map();

// ── Суммарно потраченные токены за всё время ────────────
// Грубая (но честная по порядку величины) сумма output-токенов всех прогонов.
// Храним в data/app.json рядом с прочими настройками, чтобы счётчик переживал
// перезапуск. Запись throttle'им — не чаще раза в 3 с (диск не насилуем).
const appFile = join(config.dataDir, 'data', 'app.json');
function readApp() { try { return JSON.parse(readFileSync(appFile, 'utf8')); } catch { return {}; } }
function writeApp(obj) {
  try {
    const dir = join(config.dataDir, 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(appFile, JSON.stringify(obj, null, 2));
  } catch (err) { console.warn('usage write:', err.message); }
}

let spentTotal = Number(readApp().spentTokens) || 0;
let lastFlush = 0;
let flushTimer = null;
function flushSpent() {
  lastFlush = Date.now();
  writeApp({ ...readApp(), spentTokens: spentTotal });
}
export function addSpent(tokens) {
  const n = Number(tokens) || 0;
  if (n <= 0) return;
  spentTotal += n;
  // Throttle записи; гарантированный флеш по таймеру, если давно не писали.
  if (Date.now() - lastFlush > 3000) flushSpent();
  else if (!flushTimer) { flushTimer = setTimeout(() => { flushTimer = null; flushSpent(); }, 3000); }
}
export function getSpentTotal() { return spentTotal; }

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Перехват заголовков ответа. headers — объект Headers (есть .get) или словарь.
export function captureLimits(providerId, headers) {
  if (!providerId || !headers) return;
  const get = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]);

  const aReqLim = get('anthropic-ratelimit-requests-limit');
  const aTokLim = get('anthropic-ratelimit-tokens-limit');
  const oReqLim = get('x-ratelimit-limit-requests');
  const oTokLim = get('x-ratelimit-limit-tokens');

  let snap = null;
  if (aReqLim != null || aTokLim != null) {
    snap = {
      available: true, kind: 'anthropic', at: Date.now(),
      requests: {
        limit: num(aReqLim),
        remaining: num(get('anthropic-ratelimit-requests-remaining')),
        reset: get('anthropic-ratelimit-requests-reset') || null,
      },
      tokens: {
        limit: num(aTokLim),
        remaining: num(get('anthropic-ratelimit-tokens-remaining')),
        reset: get('anthropic-ratelimit-tokens-reset') || null,
      },
    };
  } else if (oReqLim != null || oTokLim != null) {
    snap = {
      available: true, kind: 'openai', at: Date.now(),
      requests: {
        limit: num(oReqLim),
        remaining: num(get('x-ratelimit-remaining-requests')),
        reset: get('x-ratelimit-reset-requests') || null,
      },
      tokens: {
        limit: num(oTokLim),
        remaining: num(get('x-ratelimit-remaining-tokens')),
        reset: get('x-ratelimit-reset-tokens') || null,
      },
    };
  }
  if (snap) lastByProvider.set(providerId, snap);
}

// Снимок лимитов провайдера для UI. Считает ratio = min(остаток/лимит) по
// запросам и токенам — это «узкое горло», его и рисует кольцо.
export function getUsage(providerId) {
  const snap = lastByProvider.get(providerId);
  if (!snap || !snap.available) return { available: false };
  const ratios = [];
  for (const part of [snap.requests, snap.tokens]) {
    if (part && part.limit > 0 && part.remaining != null) {
      ratios.push(Math.max(0, Math.min(1, part.remaining / part.limit)));
    }
  }
  const ratio = ratios.length ? Math.min(...ratios) : null;
  return { ...snap, ratio };
}
