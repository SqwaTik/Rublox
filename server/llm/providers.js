// Единый интерфейс к разным LLM-провайдерам с поддержкой стриминга.
//
// Канонический формат сообщения (наш внутренний):
//   { role: 'user'|'assistant'|'tool', content: string,
//     toolCalls?: [{ id, name, args }],         // для assistant
//     toolCallId?, name? }                       // для tool (результат)
//
// Провайдер выбирается по id из реестра (registry.js); протокол определяется
// полем kind ('anthropic' | 'openai'). Любой OpenAI-совместимый сервис работает
// как kind: 'openai' со своим baseUrl.
//
// complete() — обычный (нестриминговый) вызов: { text, toolCalls }.
// streamComplete() — стриминг: вызывает onDelta(textChunk) по мере прихода
//   токенов и возвращает финальный { text, toolCalls }.

import { config } from '../config.js';
import { getProvider, effectiveKind } from './registry.js';
import { toolsForAnthropic, toolsForOpenAI, TOOL_NAMES } from './tools.js';
import { captureLimits } from '../usage.js';

// Человекочитаемое объяснение типовых HTTP-ошибок провайдера. Сырой ответ часто
// приходит как HTML (403-страница Cloudflare/роутера) — показывать его в чате
// бессмысленно. Даём короткую подсказку, что делать.
function explainHttpError(status, rawMsg) {
  const raw = String(rawMsg || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const short = raw.length > 300 ? raw.slice(0, 300) + '…' : raw;
  const low = raw.toLowerCase();

  // Реальная причина важнее кода. Провайдеры часто шлют 401/402/403/429 при
  // ИСЧЕРПАННОМ БАЛАНСЕ — а текст «ключ не подходит» вводит в заблуждение. Сначала
  // смотрим в сам текст ошибки и определяем причину по ключевым словам.
  const has = (re) => re.test(low);
  // Реселлер пускает только НАСТОЯЩИЙ клиент Claude Code (проверка по отпечатку
  // клиента/TLS, не по заголовкам). Обойти из стороннего приложения нельзя.
  if (has(/official claude code client|restricted to the official|use claude code cli|please use claude code/)) {
    return `LLM HTTP ${status}: провайдер принимает только официальный клиент Claude Code и блокирует сторонние приложения — через Rublox он работать не будет. Используйте другого провайдера (например, agentrouter).`;
  }
  if (has(/insufficient.*(balance|credit|fund|quota)|no.*(balance|credit)|out of (credit|quota)|balance.*(low|exhaust|insufficient)|недостаточно средств|баланс|закончил|нет средств|пополните|top.?up|payment required|billing|recharge/)) {
    return `LLM HTTP ${status}: закончился баланс/кредиты у провайдера. Пополните счёт или смените провайдера.` +
      (short ? ` (${short})` : '');
  }
  if (has(/rate.?limit|too many request|quota.*(exceed|exhaust)|превышен лимит/)) {
    return `LLM HTTP ${status}: превышен лимит запросов. Подождите или смените провайдера.` + (short ? ` (${short})` : '');
  }
  if (has(/invalid.*api.?key|incorrect api key|unauthorized client|invalid token|неверный ключ|api key not valid/)) {
    return `LLM HTTP ${status}: ключ отклонён провайдером. Проверьте API-ключ в Настройках → Провайдеры.` + (short ? ` (${short})` : '');
  }
  if (has(/model.*(not found|not exist|unavailable|not support|decommission)|no such model|unknown model|нет модели|модель не/)) {
    return `LLM HTTP ${status}: модель недоступна у провайдера. Проверьте имя модели или смените её.` + (short ? ` (${short})` : '');
  }

  const hint = {
    400: 'неверный запрос к модели (возможно, модель не поддерживает инструменты или формат истории).',
    401: 'провайдер отклонил ключ (401). Проверьте API-ключ в Настройках → Провайдеры.',
    402: 'требуется оплата (402). Вероятно, закончился баланс у провайдера.',
    403: 'доступ запрещён (403). Возможные причины: исчерпан баланс, ключ не подходит для этой модели, либо модель/регион недоступны.',
    404: 'модель не найдена у провайдера (404). Проверьте имя модели.',
    413: 'слишком большой запрос (413). Сократите историю — /compact.',
    429: 'превышен лимит запросов (429). Подождите или смените провайдера.',
    500: 'внутренняя ошибка провайдера (500). Попробуйте ещё раз.',
    502: 'провайдер недоступен (502/шлюз). Попробуйте позже.',
    503: 'провайдер перегружен (503). Попробуйте позже.',
  }[status];
  let msg = `LLM HTTP ${status}`;
  if (hint) msg += `: ${hint}`;
  // Реальный текст провайдера всегда полезен — добавляем его, даже если есть hint.
  if (short) msg += hint ? ` (${short})` : `: ${short}`;
  return msg;
}

// Построчный парсер SSE: вызывает onEvent(dataString) для каждого "data: ...".
async function readSSE(res, onEvent) {
  if (!res.ok) {
    const errText = await res.text();
    let msg = errText;
    try { const j = JSON.parse(errText); msg = j?.error?.message || j?.raw || errText; } catch { /* не JSON */ }
    throw new Error(explainHttpError(res.status, msg || res.statusText));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      // Прерывание пользователем (AbortController) — выходим тихо, отдаём накопленное.
      if (err && (err.name === 'AbortError' || /abort/i.test(err.message || ''))) break;
      throw err;
    }
    const { value, done } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        onEvent(data);
      }
    }
  }
}

// Санитизация истории перед отправкой провайдеру. Гарантируем, что КАЖДЫЙ
// tool_use (toolCall ассистента) имеет tool_result сразу после него. Иначе и
// Anthropic, и OpenAI кидают 400 ("tool_use ids were found without tool_result
// blocks"). Такое бывает при прерывании (Stop), падении стрима или повторе id —
// лечим вместо падения.
function sanitizeMessages(messages) {
  const src = Array.isArray(messages) ? messages : [];
  const resultIds = new Set();
  for (const m of src) {
    if (m.role === 'tool' && m.toolCallId) resultIds.add(m.toolCallId);
  }
  const out = [];
  const seenCallIds = new Set();
  for (let i = 0; i < src.length; i++) {
    const m = src[i];
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      const keptCalls = [];
      const synthResults = [];
      for (const tc of calls) {
        if (!tc || !tc.id || seenCallIds.has(tc.id)) continue;
        seenCallIds.add(tc.id);
        keptCalls.push(tc);
        if (!resultIds.has(tc.id)) {
          synthResults.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: 'Прервано: результат не получен.' });
        }
      }
      out.push({ ...m, toolCalls: keptCalls });
      for (const r of synthResults) out.push(r);
    } else if (m.role === 'tool') {
      if (m.toolCallId && seenCallIds.has(m.toolCallId)) out.push(m);
    } else {
      out.push(m);
    }
  }
  return out;
}

// ── Anthropic: преобразование канона ───────────────────
// includeThinking — добавлять ли обратно thinking-блоки ассистента. При включённом
// extended thinking Anthropic ТРЕБУЕТ возвращать `thinking` (с подписью) в том же
// ассистент-сообщении перед text/tool_use, иначе 400. Когда мышление выключено —
// блоки НЕ шлём (иначе тоже ошибка).
function canonToAnthropic(messages, includeThinking) {
  const out = [];
  // Серия идущих подряд tool-результатов должна склеиваться в ОДНО user-сообщение
  // с несколькими tool_result-блоками. Иначе при ПАРАЛЛЕЛЬНЫХ вызовах (assistant с
  // двумя tool_use) каждый результат попадал в отдельное сообщение, и Anthropic
  // ругался: «tool_use ids were found without tool_result blocks immediately after».
  let toolMsg = null;
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content && m.content.length ? m.content : '(пусто)' };
      if (toolMsg) { toolMsg.content.push(block); }
      else { toolMsg = { role: 'user', content: [block] }; out.push(toolMsg); }
      continue;
    }
    toolMsg = null; // любой не-tool обрывает серию результатов
    if (m.role === 'user') {
      if (m.images && m.images.length) {
        const parts = [];
        for (const img of m.images) {
          parts.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.data } });
        }
        if (m.content && m.content.length) parts.push({ type: 'text', text: m.content });
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content: m.content && m.content.length ? m.content : '…' });
      }
    } else if (m.role === 'assistant') {
      const blocks = [];
      // Thinking-блоки идут ПЕРВЫМИ (требование API) и только при включённом мышлении.
      if (includeThinking && Array.isArray(m.thinking)) {
        for (const tb of m.thinking) blocks.push(tb);
      }
      if (m.content && m.content.length) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls || []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
      }
      // Пустой ассистент без блоков — пропускаем (Anthropic требует непустой content).
      if (!blocks.length) continue;
      out.push({ role: 'assistant', content: blocks });
    }
  }
  return out;
}

function anthropicBody(p, { system, messages, model, temperature, maxTokens, useTools, studioConnected, pcAllowed, thinking }, stream) {
  const thinkingOn = !!(thinking && thinking.budget >= 4096);
  const body = {
    model: model || p.model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: canonToAnthropic(messages, thinkingOn),
  };
  // Extended thinking: включаем на «глубоком» уровне. Требует temperature=1.
  if (thinkingOn) {
    body.thinking = { type: 'enabled', budget_tokens: thinking.budget };
    body.temperature = 1;
  }
  if (useTools) body.tools = toolsForAnthropic({ studioConnected, pcAllowed });
  if (stream) body.stream = true;
  if (config.promptCache !== false && p.cache !== false) applyAnthropicCaching(body);
  return body;
}

// Prompt caching: помечаем стабильный префикс (system, схемы tools и последнее
// сообщение истории) cache_control. Anthropic кэширует совпадающий префикс между
// запросами → до ~90% экономии входных токенов на повторных шагах диалога.
function applyAnthropicCaching(body) {
  const mark = { type: 'ephemeral' };
  if (typeof body.system === 'string' && body.system) {
    body.system = [{ type: 'text', text: body.system, cache_control: mark }];
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    const i = body.tools.length - 1;
    body.tools[i] = { ...body.tools[i], cache_control: mark };
  }
  const last = body.messages[body.messages.length - 1];
  if (last) {
    if (typeof last.content === 'string') {
      last.content = [{ type: 'text', text: last.content, cache_control: mark }];
    } else if (Array.isArray(last.content) && last.content.length) {
      const j = last.content.length - 1;
      last.content[j] = { ...last.content[j], cache_control: mark };
    }
  }
}

// ── Единый устойчивый слой запросов ────────────────────
// Версионно-aware URL эндпоинта: если baseUrl уже содержит /vN — не дублируем
// версию (иначе /v1/v1/...), а если версии нет — добавляем нужную. Чинит частые
// 404/401 на кастомных baseUrl.
function endpointUrl(p, kind) {
  const b = String(p.baseUrl || '').replace(/\/+$/, '');
  const hasVer = /\/v\d+$/.test(b);
  if (kind === 'anthropic') return hasVer ? `${b}/messages` : `${b}/v1/messages`;
  return hasVer ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

// Базовые заголовки без авторизации. anthropic-version нужен для Anthropic-формата
// (безвреден для остальных).
//
// КЛИЕНТСКАЯ ЛИЧНОСТЬ. Реселлеры Claude Code (agentrouter.org, aerolink/freemodel
// и др.) пускают запрос ТОЛЬКО если клиент выглядит как Claude Code CLI: проверяют
// user-agent (`claude-cli/...`) и заголовок `x-app: cli`. Иначе — 401 «unauthorized
// client detected», даже если ключ верный (раньше это ломало agentrouter, при том
// что в самом Claude Code тот же ключ работал). Поэтому представляемся как CLI.
// Официальному Anthropic/OpenAI и обычным OpenAI-шлюзам это не мешает.
const CLAUDE_CLI_UA = 'claude-cli/1.0.119 (external, cli)';
function protoHeaders(kind) {
  const h = {
    'content-type': 'application/json',
    'user-agent': CLAUDE_CLI_UA,
    'x-app': 'cli',
    accept: 'application/json',
  };
  if (kind === 'anthropic') h['anthropic-version'] = '2023-06-01';
  return h;
}

// Схемы авторизации по порядку предпочтения протокола. Если пользователь сам
// задал auth в headers — используем только его (один пустой вариант).
function authVariants(p, kind) {
  const userAuth = Object.keys(p.headers || {}).some((k) => /^(authorization|x-api-key)$/i.test(k));
  if (userAuth) return [{}];
  const bearer = { authorization: `Bearer ${p.apiKey || 'not-needed'}` };
  const xkey = { 'x-api-key': p.apiKey || '' };
  return kind === 'anthropic' ? [xkey, bearer] : [bearer, xkey];
}

// Запрос к LLM с автоперебором схемы авторизации при 401/403 (разные шлюзы хотят
// Bearer ЛИБО x-api-key). Прочие коды не перебираем — это не проблема ключа.
// Возвращает Response; разбор успеха/ошибки — на стороне вызывающего.
async function llmFetch(p, kind, payload, signal) {
  const url = endpointUrl(p, kind);
  const base = protoHeaders(kind);
  const variants = authVariants(p, kind);
  const body = JSON.stringify(payload);
  let res;
  for (let i = 0; i < variants.length; i++) {
    const headers = { ...base, ...variants[i], ...(p.headers || {}) };
    res = await fetch(url, { method: 'POST', headers, body, signal });
    if (res.ok || (res.status !== 401 && res.status !== 403)) return res;
    if (i < variants.length - 1) { try { await res.arrayBuffer(); } catch { /* сброс тела перед повтором */ } }
  }
  return res;
}

// Некоторые модели/шлюзы запрещают отдельные необязательные параметры и отвечают
// 400 вроде «`temperature` is deprecated for this model» (так делает agentrouter
// для новых claude-моделей). Заранее знать нельзя — поэтому при таком 400 убираем
// именно названный параметр и повторяем запрос один раз. Безопасные к удалению:
const DROPPABLE_PARAMS = ['temperature', 'top_p', 'reasoning_effort', 'stream_options'];
function stripUnsupportedParams(payload, errText) {
  const t = String(errText || '').toLowerCase();
  if (!/deprecat|unsupported|not support|not allow|unexpected|unknown|invalid|remove/.test(t)) return null;
  let changed = false;
  const next = { ...payload };
  for (const key of DROPPABLE_PARAMS) {
    if (key in next && t.includes(key.toLowerCase())) { delete next[key]; changed = true; }
  }
  return changed ? next : null;
}

// llmFetch + адаптивный ретрай по 400 о неподдержанном параметре. Тело читаем через
// clone(), чтобы оригинальный res остался пригоден для parseJsonRes/readSSE, если
// ретрай не нужен.
async function llmFetchAdaptive(p, kind, payload, signal) {
  let res = await llmFetch(p, kind, payload, signal);
  if (res.status === 400) {
    let text = '';
    try { text = await res.clone().text(); } catch { /* тело не читается — пропускаем ретрай */ }
    const stripped = stripUnsupportedParams(payload, text);
    if (stripped) {
      try { await res.arrayBuffer(); } catch { /* сброс старого тела */ }
      res = await llmFetch(p, kind, stripped, signal);
    }
  }
  return res;
}

// Разбор JSON-ответа (нестриминг): перехват лимитов + человекочитаемая ошибка.
async function parseJsonRes(res, providerId) {
  if (providerId) captureLimits(providerId, res.headers);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.raw || res.statusText;
    throw new Error(explainHttpError(res.status, msg));
  }
  return data;
}

async function callAnthropic(p, opts) {
  if (!p.apiKey) throw new Error(`API-ключ для провайдера "${p.id}" не задан`);
  const res = await llmFetchAdaptive(p, 'anthropic', anthropicBody(p, opts, false), opts.signal);
  const data = await parseJsonRes(res, p.id);
  let text = '';
  const toolCalls = [];
  const thinking = [];
  for (const block of data.content || []) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use')
      toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
    else if (block.type === 'thinking')
      thinking.push({ type: 'thinking', thinking: block.thinking || '', signature: block.signature || '' });
    else if (block.type === 'redacted_thinking')
      thinking.push({ type: 'redacted_thinking', data: block.data || '' });
  }
  return { text, toolCalls, thinking };
}

async function streamAnthropic(p, opts, onDelta) {
  if (!p.apiKey) throw new Error(`API-ключ для провайдера "${p.id}" не задан`);
  const res = await llmFetchAdaptive(p, 'anthropic', anthropicBody(p, opts, true), opts.signal);
  captureLimits(p.id, res.headers);

  let text = '';
  const blocks = {}; // index -> { type, id, name, jsonBuf }

  await readSSE(res, (raw) => {
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    if (ev.type === 'content_block_start') {
      const b = ev.content_block || {};
      blocks[ev.index] = { type: b.type, id: b.id, name: b.name, jsonBuf: '', thinking: b.thinking || '', signature: b.signature || '', data: b.data || '' };
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      const blk = blocks[ev.index];
      if (d.type === 'text_delta') {
        text += d.text;
        onDelta(d.text);
      } else if (d.type === 'input_json_delta') {
        if (blk) blk.jsonBuf += d.partial_json || '';
      } else if (d.type === 'thinking_delta') {
        if (blk) blk.thinking += d.thinking || '';
      } else if (d.type === 'signature_delta') {
        if (blk) blk.signature += d.signature || '';
      }
    }
  });

  const toolCalls = [];
  const thinking = [];
  for (const idx of Object.keys(blocks)) {
    const b = blocks[idx];
    if (b.type === 'tool_use') {
      let args = {};
      try {
        args = b.jsonBuf ? JSON.parse(b.jsonBuf) : {};
      } catch {
        args = {};
      }
      toolCalls.push({ id: b.id, name: b.name, args });
    } else if (b.type === 'thinking') {
      thinking.push({ type: 'thinking', thinking: b.thinking || '', signature: b.signature || '' });
    } else if (b.type === 'redacted_thinking') {
      thinking.push({ type: 'redacted_thinking', data: b.data || '' });
    }
  }
  return { text, toolCalls, thinking };
}

// ── OpenAI-совместимые: преобразование канона ──────────
function canonToOpenAI(system, messages) {
  const out = [];
  if (system && String(system).trim()) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.images && m.images.length) {
        // Мультимодальное сообщение: текст + картинки (vision).
        const parts = [];
        if (m.content && m.content.length) parts.push({ type: 'text', text: m.content });
        for (const img of m.images) {
          parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType || 'image/png'};base64,${img.data}` } });
        }
        out.push({ role: 'user', content: parts });
      } else {
        // Пустой content → 400 "non-empty content". Подстраховываемся.
        out.push({ role: 'user', content: m.content && m.content.length ? m.content : '…' });
      }
    } else if (m.role === 'assistant') {
      const hasTools = !!(m.toolCalls && m.toolCalls.length);
      const hasText = !!(m.content && m.content.length);
      // Ассистент без текста И без тулзов — вырожденное сообщение, пропускаем
      // (иначе провайдер ругается на пустой content).
      if (!hasTools && !hasText) continue;
      const msg = { role: 'assistant' };
      // С tool_calls пустой текст допустим как null (спека OpenAI); без них — текст.
      msg.content = hasText ? m.content : (hasTools ? null : '…');
      if (hasTools) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content && m.content.length ? m.content : '(пусто)' });
    }
  }
  return out;
}

function openaiBody(p, { system, messages, model, temperature, maxTokens, useTools, studioConnected, pcAllowed, thinking }, stream) {
  const body = {
    model: model || p.model,
    temperature,
    max_tokens: maxTokens,
    messages: canonToOpenAI(system, messages),
  };
  // reasoning_effort ТОЛЬКО для reasoning-моделей (o1/o3/o4, gpt-5, *-reasoner и
  // т.п.). Обычные модели (gpt-4o, llama, deepseek-chat, Claude через роутер) на
  // этот параметр отвечают ошибкой — раньше из-за этого multi/openai «не работали
  // ни на одном провайдере». Определяем по имени модели.
  const mname = String(model || p.model || '');
  const isReasoning = /(^|[^a-z])o[1345]([^a-z]|$)|gpt-5|reasoner|reasoning|think|deepseek-r|grok-4|qwq/i.test(mname);
  if (thinking && thinking.effort && isReasoning) body.reasoning_effort = thinking.effort;
  if (useTools) body.tools = toolsForOpenAI({ studioConnected, pcAllowed });
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: false };
  }
  return body;
}

async function callOpenAI(p, opts) {
  const res = await llmFetchAdaptive(p, 'openai', openaiBody(p, opts, false), opts.signal);
  const data = await parseJsonRes(res, p.id);
  const choice = data.choices?.[0]?.message || {};
  const toolCalls = (choice.tool_calls || []).map((tc) => {
    let args = {};
    try {
      args = JSON.parse(tc.function.arguments || '{}');
    } catch {
      args = {};
    }
    return { id: tc.id, name: tc.function.name, args };
  });
  return { text: choice.content || '', toolCalls };
}

async function streamOpenAI(p, opts, onDelta) {
  const res = await llmFetchAdaptive(p, 'openai', openaiBody(p, opts, true), opts.signal);
  captureLimits(p.id, res.headers);

  let text = '';
  const toolAcc = []; // индекс -> { id, name, argsBuf }

  await readSSE(res, (raw) => {
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    const delta = ev.choices?.[0]?.delta || {};
    if (delta.content) {
      text += delta.content;
      onDelta(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? 0;
      if (!toolAcc[i]) toolAcc[i] = { id: tc.id, name: '', argsBuf: '' };
      if (tc.id) toolAcc[i].id = tc.id;
      if (tc.function?.name) toolAcc[i].name = tc.function.name;
      if (tc.function?.arguments) toolAcc[i].argsBuf += tc.function.arguments;
    }
  });

  const toolCalls = toolAcc.filter(Boolean).map((t) => {
    let args = {};
    try {
      args = t.argsBuf ? JSON.parse(t.argsBuf) : {};
    } catch {
      args = {};
    }
    return { id: t.id, name: t.name, args };
  });
  return { text, toolCalls };
}

// Некоторые модели/прокси НЕ умеют структурный tool-use и «выплёвывают» вызов
// прямо в текст: «(tool_use) name=update_plan id=… input={…}», или XML-блоками
// <function_calls>…<invoke name="x"><parameter…>, или ```json {tool,args}```.
// Если структурных toolCalls нет, пробуем вытащить вызовы из текста — иначе
// чат «обрывается» сырой строкой (баг). Возвращает { text, toolCalls }.
let __rawCallSeq = 0;
const KNOWN_TOOL_NAMES = new Set(TOOL_NAMES);
function extractInlineToolCalls(text, known) {
  if (!text) return { text, toolCalls: [] };
  const calls = [];
  let cleaned = text;
  const isTool = (n) => !known || known.has(n);
  const mkId = (n) => `inline_${n}_${++__rawCallSeq}`;

  // 1) Формат «(tool_use) name=NAME id=ID input={JSON}» (как в баг-репорте).
  const reParen = /\(tool_use\)\s*name=([A-Za-z0-9_]+)(?:\s+id=\S+)?\s*input=(\{[\s\S]*?\})(?=\s*(?:\(tool_use\)|$))/g;
  let m;
  while ((m = reParen.exec(text))) {
    const name = m[1];
    if (!isTool(name)) continue;
    let args = {};
    try { args = JSON.parse(m[2]); } catch { /* частичный JSON — оставим пустым */ }
    calls.push({ id: mkId(name), name, args });
    cleaned = cleaned.replace(m[0], '');
  }

  // 2) Anthropic-подобные XML-блоки <invoke name="NAME"><parameter name="k">v</parameter>…
  const reInvoke = /<invoke\s+name=["']([A-Za-z0-9_]+)["']\s*>([\s\S]*?)<\/invoke>/g;
  while ((m = reInvoke.exec(text))) {
    const name = m[1];
    if (!isTool(name)) continue;
    const args = {};
    const reParam = /<parameter\s+name=["']([A-Za-z0-9_]+)["']\s*>([\s\S]*?)<\/parameter>/g;
    let pm;
    while ((pm = reParam.exec(m[2]))) {
      let v = pm[2].trim();
      try { v = JSON.parse(v); } catch { /* строка как есть */ }
      args[pm[1]] = v;
    }
    calls.push({ id: mkId(name), name, args });
    cleaned = cleaned.replace(m[0], '');
  }

  // Чистим обёртки функций-вызовов и лишние пустые строки.
  cleaned = cleaned
    .replace(/<\/?function_calls>/g, '')
    .replace(/<\/?antml:[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, toolCalls: calls };
}

// Достраивает результат провайдера: если структурных toolCalls нет — пробует
// вытащить их из текста (см. extractInlineToolCalls).
function reconcileToolCalls(result, useTools, known) {
  if (!useTools) return result;
  if (result.toolCalls && result.toolCalls.length) return result;
  const ex = extractInlineToolCalls(result.text || '', known);
  if (ex.toolCalls.length) return { ...result, text: ex.text, toolCalls: ex.toolCalls };
  return result;
}

// ── Публичные точки входа ──────────────────────────────
function resolve(provider) {
  const p = getProvider(provider);
  if (!p) throw new Error(`Неизвестный провайдер: ${provider}`);
  return p;
}

export async function complete({ provider, system, messages, model, temperature, maxTokens, useTools, studioConnected, pcAllowed, thinking, signal }) {
  const p = resolve(provider);
  const opts = { system, messages: sanitizeMessages(messages), model, temperature, maxTokens: maxTokens || config.maxTokens, useTools, studioConnected, pcAllowed, thinking, signal };
  const res = effectiveKind(p.kind) === 'anthropic' ? await callAnthropic(p, opts) : await callOpenAI(p, opts);
  return reconcileToolCalls(res, useTools, KNOWN_TOOL_NAMES);
}

export async function streamComplete(
  { provider, system, messages, model, temperature, maxTokens, useTools, studioConnected, pcAllowed, thinking, signal },
  onDelta = () => {}
) {
  const p = resolve(provider);
  const opts = { system, messages: sanitizeMessages(messages), model, temperature, maxTokens: maxTokens || config.maxTokens, useTools, studioConnected, pcAllowed, thinking, signal };
  const res = effectiveKind(p.kind) === 'anthropic'
    ? await streamAnthropic(p, opts, onDelta)
    : await streamOpenAI(p, opts, onDelta);
  return reconcileToolCalls(res, useTools, KNOWN_TOOL_NAMES);
}
