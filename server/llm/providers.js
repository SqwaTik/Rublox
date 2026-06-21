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
import { toolsForAnthropic, toolsForOpenAI } from './tools.js';
import { captureLimits } from '../usage.js';

// ── Низкоуровневый HTTP ────────────────────────────────
async function httpJson(url, options, providerId) {
  const res = await fetch(url, options);
  // Перехватываем лимиты из заголовков ответа (даже при ошибке — полезно).
  if (providerId) captureLimits(providerId, res.headers);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.raw || res.statusText;
    throw new Error(`LLM HTTP ${res.status}: ${msg}`);
  }
  return data;
}

// Построчный парсер SSE: вызывает onEvent(dataString) для каждого "data: ...".
async function readSSE(res, onEvent) {
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM HTTP ${res.status}: ${errText || res.statusText}`);
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

// ── Anthropic: преобразование канона ───────────────────
function canonToAnthropic(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls || []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      });
    }
  }
  return out;
}

function anthropicBody(p, { system, messages, model, temperature, maxTokens, useTools, studioConnected, pcAllowed, thinking }, stream) {
  const body = {
    model: model || p.model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: canonToAnthropic(messages),
  };
  // Extended thinking: включаем на «глубоком» уровне. Требует temperature=1.
  if (thinking && thinking.budget >= 4096) {
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

function anthropicHeaders(p) {
  const h = {
    'content-type': 'application/json',
    'x-api-key': p.apiKey,
    'anthropic-version': '2023-06-01',
    // Многие прокси (напр. agentrouter.org) пускают только клиентов,
    // похожих на настоящий Claude Code. Без User-Agent — 401.
    'user-agent': 'claude-cli/1.0.0 (external, cli)',
  };
  return { ...h, ...(p.headers || {}) };
}

async function callAnthropic(p, opts) {
  if (!p.apiKey) throw new Error(`API-ключ для провайдера "${p.id}" не задан`);
  const data = await httpJson(`${p.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: anthropicHeaders(p),
    body: JSON.stringify(anthropicBody(p, opts, false)),
  }, p.id);
  let text = '';
  const toolCalls = [];
  for (const block of data.content || []) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use')
      toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
  }
  return { text, toolCalls };
}

async function streamAnthropic(p, opts, onDelta) {
  if (!p.apiKey) throw new Error(`API-ключ для провайдера "${p.id}" не задан`);
  const res = await fetch(`${p.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: anthropicHeaders(p),
    body: JSON.stringify(anthropicBody(p, opts, true)),
    signal: opts.signal,
  });
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
      blocks[ev.index] = { type: b.type, id: b.id, name: b.name, jsonBuf: '' };
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta') {
        text += d.text;
        onDelta(d.text);
      } else if (d.type === 'input_json_delta') {
        const blk = blocks[ev.index];
        if (blk) blk.jsonBuf += d.partial_json || '';
      }
    }
  });

  const toolCalls = [];
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
    }
  }
  return { text, toolCalls };
}

// ── OpenAI-совместимые: преобразование канона ──────────
function canonToOpenAI(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
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
  // reasoning_effort для reasoning-моделей (o-серия, gpt-5 и совместимые).
  if (thinking && thinking.effort) body.reasoning_effort = thinking.effort;
  if (useTools) body.tools = toolsForOpenAI({ studioConnected, pcAllowed });
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: false };
  }
  return body;
}

function openaiHeaders(p) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${p.apiKey || 'not-needed'}`,
    ...(p.headers || {}),
  };
}

async function callOpenAI(p, opts) {
  const data = await httpJson(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: openaiHeaders(p),
    body: JSON.stringify(openaiBody(p, opts, false)),
  }, p.id);
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
  const res = await fetch(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: openaiHeaders(p),
    body: JSON.stringify(openaiBody(p, opts, true)),
    signal: opts.signal,
  });
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

// ── Публичные точки входа ──────────────────────────────
function resolve(provider) {
  const p = getProvider(provider);
  if (!p) throw new Error(`Неизвестный провайдер: ${provider}`);
  return p;
}

export async function complete({ provider, system, messages, model, temperature, maxTokens, useTools, studioConnected, pcAllowed, thinking, signal }) {
  const p = resolve(provider);
  const opts = { system, messages, model, temperature, maxTokens: maxTokens || config.maxTokens, useTools, studioConnected, pcAllowed, thinking, signal };
  return effectiveKind(p.kind) === 'anthropic' ? callAnthropic(p, opts) : callOpenAI(p, opts);
}

export async function streamComplete(
  { provider, system, messages, model, temperature, maxTokens, useTools, studioConnected, pcAllowed, thinking, signal },
  onDelta = () => {}
) {
  const p = resolve(provider);
  const opts = { system, messages, model, temperature, maxTokens: maxTokens || config.maxTokens, useTools, studioConnected, pcAllowed, thinking, signal };
  return effectiveKind(p.kind) === 'anthropic'
    ? streamAnthropic(p, opts, onDelta)
    : streamOpenAI(p, opts, onDelta);
}
