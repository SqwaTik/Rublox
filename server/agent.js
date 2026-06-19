// Агентный цикл: вызываем LLM, исполняем затребованные инструменты через мост
// Roblox, возвращаем результаты модели и повторяем, пока есть tool-calls.

import { streamComplete } from './llm/providers.js';
import { bridge } from './bridge.js';
import { renderTemplate } from './templates.js';

const MAX_STEPS = 6; // защита от бесконечного цикла tool-use

// Исполняет один tool-call и возвращает результат для модели.
async function runTool(name, args) {
  switch (name) {
    case 'run_code':
      return bridge.dispatch('run_code', { code: args.code });
    case 'insert_model':
      return bridge.dispatch('insert_model', {
        assetId: args.assetId,
        parent: args.parent || 'Workspace',
      });
    case 'get_console_output':
      return bridge.dispatch('get_console_output', { lines: args.lines || 50 });
    case 'get_studio_context':
      return bridge.dispatch('get_studio_context', { depth: args.depth || 2 });
    case 'start_stop_play':
      return bridge.dispatch('start_stop_play', { action: args.action });
    case 'run_script_in_play_mode':
      return bridge.dispatch('run_script_in_play_mode', {
        code: args.code,
        context: args.context || 'server',
      });
    case 'use_template': {
      const code = renderTemplate(args.templateId, args.params);
      if (!bridge.isConnected()) {
        return `Шаблон "${args.templateId}" (Studio не подключён, код не выполнен):\n${code}`;
      }
      const r = await bridge.dispatch('run_code', { code });
      return `Шаблон "${args.templateId}" выполнен. ${resultToString(r)}`;
    }
    default:
      throw new Error(`Неизвестный инструмент: ${name}`);
  }
}

// Человекочитаемые описания того, ЧТО делает инструмент — для индикатора статуса
// (как в Claude Code: «Реализую мост Roblox…»). Возвращает строку по tool-call.
function statusFor(name, args) {
  switch (name) {
    case 'run_code': return 'Выполняю Lua-код в Studio';
    case 'insert_model': return `Вставляю ассет ${args.assetId || ''}`.trim();
    case 'get_console_output': return 'Читаю консоль Studio';
    case 'get_studio_context': return 'Изучаю структуру плейса';
    case 'start_stop_play': return args.action === 'stop' ? 'Останавливаю Play' : 'Запускаю Play';
    case 'run_script_in_play_mode': return 'Выполняю код в Play-режиме';
    case 'use_template': return `Применяю шаблон ${args.templateId || ''}`.trim();
    default: return `Вызываю ${name}`;
  }
}

function resultToString(result) {
  if (result == null) return 'ok';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// Грубая оценка токенов по символам (≈4 симв/токен).
const tok = (s) => Math.ceil((s || '').length / 4);

// session — экземпляр Session; onEvent(type, payload) для стриминга в UI.
// События: status (что делаю + токены), assistant_start/delta/end,
// tool_call, tool_result.
export async function runAgent(session, onEvent = () => {}) {
  const useTools = bridge.isConnected();
  let outTokens = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    onEvent('status', { text: 'Думаю', tokens: outTokens });
    onEvent('assistant_start', {});
    const think = session.thinkingConfig();
    const reply = await streamComplete(
      {
        provider: session.provider,
        system: session.systemPrompt(),
        messages: session.getCompiledMessages(),
        model: session.model,
        temperature: think.temperature,
        thinking: think,
        useTools,
      },
      (chunk) => {
        outTokens += tok(chunk);
        onEvent('assistant_delta', { text: chunk });
        onEvent('status', { text: 'Печатаю ответ', tokens: outTokens });
      }
    );

    session.addAssistant(reply.text, reply.toolCalls);
    onEvent('assistant_text', { text: reply.text });

    if (!reply.toolCalls || reply.toolCalls.length === 0) {
      return reply.text; // финальный ответ без действий
    }

    for (const tc of reply.toolCalls) {
      onEvent('status', { text: statusFor(tc.name, tc.args), tokens: outTokens });
      onEvent('tool_call', { name: tc.name, args: tc.args });
      let resultStr;
      try {
        const result = await runTool(tc.name, tc.args);
        resultStr = resultToString(result);
        onEvent('tool_result', { name: tc.name, ok: true, result: resultStr });
      } catch (err) {
        resultStr = `Ошибка: ${err.message}`;
        onEvent('tool_result', { name: tc.name, ok: false, result: resultStr });
      }
      outTokens += tok(resultStr);
      session.addToolResult(tc.id, tc.name, resultStr);
    }
  }

  return 'Достигнут лимит шагов выполнения инструментов.';
}
