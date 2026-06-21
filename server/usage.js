// Учёт лимитов (rate limits) провайдеров. Anthropic и OpenAI присылают остаток
// лимитов в заголовках КАЖДОГО ответа — мы их перехватываем и храним последний
// снимок по провайдеру. Это реальные данные от API, а не выдумка: если заголовков
// нет (локальная модель, нестандартный шлюз) — снимок помечается available:false.

const lastByProvider = new Map();

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
