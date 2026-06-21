// Агентный цикл: вызываем LLM, исполняем затребованные инструменты, возвращаем
// результаты модели и повторяем, пока есть tool-calls. Поддерживает прерывание
// (AbortSignal), три режима инструментов (Studio / ПК / только веб) и экономию
// токенов (обрезка длинных результатов).

import { streamComplete } from './llm/providers.js';
import { bridge } from './bridge.js';
import { renderTemplate } from './templates.js';
import { getPcAgent } from './app-config.js';
import { getLuauReference } from './luau-reference.js';
import { webSearch, webFetch, searchAssets } from './web.js';
import {
  runCommand, readFileTool, writeFileTool, editFileTool, listDirTool, makeDirTool,
  deletePathTool, moveTool, copyTool, appendFileTool, readLinesTool, statTool,
  existsTool, globTool, grepTool, treeTool, sysInfoTool, cwdTool,
} from './local-tools.js';
import { TOOL_NAMES, WEB_TOOLS, PC_TOOLS, SPECIAL_TOOLS, STUDIO_TOOLS } from './llm/tools.js';

const MAX_STEPS = 8; // защита от бесконечного цикла tool-use

// Server-side значения по умолчанию для нескольких Studio-инструментов.
// Остальные проксируются в плагин как есть.
const STUDIO_DEFAULTS = {
  insert_model: (a) => ({ parent: 'Workspace', ...a }),
  get_console_output: (a) => ({ lines: 50, ...a }),
  get_studio_context: (a) => ({ depth: 2, ...a }),
  duplicate_instance: (a) => ({ count: 1, ...a }),
  run_script_in_play_mode: (a) => ({ context: 'server', ...a }),
};
function applyStudioDefaults(name, args) {
  const fn = STUDIO_DEFAULTS[name];
  return fn ? fn(args || {}) : (args || {});
}

// Явный набор имён, которые runTool обрабатывает НЕ через обобщённый Studio-проброс
// (веб + ПК + спец). Используется самопроверкой ниже.
const NON_STUDIO_HANDLED = new Set([
  'web_search', 'web_fetch', 'search_assets', 'luau_reference',
  'run_command', 'read_file', 'write_file', 'edit_file', 'list_dir', 'make_dir',
  'read_lines', 'append_file', 'delete_path', 'move_path', 'copy_path',
  'glob_files', 'grep_files', 'tree', 'stat_path', 'path_exists', 'sys_info', 'get_cwd',
  'use_template', 'update_plan', 'plan_build',
]);

// САМОПРОВЕРКА при старте: каждая объявленная схема должна иметь обработчик, иначе
// LLM словит «Неизвестный инструмент». Studio-инструменты покрыты обобщённым
// пробросом автоматически; для веб/ПК/спец сверяемся со списком выше. Любой
// рассинхрон → сервер падает на старте с понятным сообщением, а НЕ в рантайме.
export function validateTools() {
  const problems = [];
  for (const name of TOOL_NAMES) {
    const handled = STUDIO_TOOLS.has(name) || NON_STUDIO_HANDLED.has(name);
    if (!handled) problems.push(`схема "${name}" без обработчика`);
  }
  // Обратная сверка: web/pc сеты не должны содержать несуществующих схем.
  for (const n of [...WEB_TOOLS, ...PC_TOOLS]) {
    if (!TOOL_NAMES.includes(n)) problems.push(`в наборе есть "${n}", но схемы нет`);
  }
  if (problems.length) {
    throw new Error('Рассинхрон инструментов:\n  - ' + problems.join('\n  - '));
  }
  return { ok: true, total: TOOL_NAMES.length, studio: STUDIO_TOOLS.size,
    web: WEB_TOOLS.size, pc: PC_TOOLS.size };
}

// Обрезка результата инструмента, который попадёт в историю (экономия токенов).
const MAX_TOOL_RESULT = 4000;
function trimResult(s) {
  s = resultToString(s);
  return s.length > MAX_TOOL_RESULT ? s.slice(0, MAX_TOOL_RESULT) + '\n…(результат обрезан для экономии токенов)' : s;
}

// Исполняет один tool-call и возвращает результат для модели.
async function runTool(name, args) {
  switch (name) {
    // ── Веб (доступно всегда) ──
    case 'web_search':
      return webSearch(args.query, args.count || 5);
    case 'web_fetch':
      return webFetch(args.url, args.maxChars || 4000);
    case 'search_assets':
      return searchAssets(args.keyword, args.assetType || 'model', args.limit || 12);
    case 'luau_reference':
      return getLuauReference(args.topic);

    // ── ПК-инструменты (когда Studio не подключён) ──
    case 'run_command':
      return runCommand(args);
    case 'read_file':
      return readFileTool(args);
    case 'write_file':
      return writeFileTool(args);
    case 'edit_file':
      return editFileTool(args);
    case 'list_dir':
      return listDirTool(args);
    case 'make_dir':
      return makeDirTool(args);
    case 'read_lines':
      return readLinesTool(args);
    case 'append_file':
      return appendFileTool(args);
    case 'delete_path':
      return deletePathTool(args);
    case 'move_path':
      return moveTool(args);
    case 'copy_path':
      return copyTool(args);
    case 'glob_files':
      return globTool(args);
    case 'grep_files':
      return grepTool(args);
    case 'tree':
      return treeTool(args);
    case 'stat_path':
      return statTool(args);
    case 'path_exists':
      return existsTool(args);
    case 'sys_info':
      return sysInfoTool();
    case 'get_cwd':
      return cwdTool();

    // ── Спец-инструменты (особая логика) ──
    case 'update_plan': {
      // Визуал плана рисует фронтенд из события tool_call; модели возвращаем сводку.
      const steps = Array.isArray(args.steps) ? args.steps : [];
      const mark = (s) => (s === 'done' ? '[x]' : s === 'in_progress' ? '[~]' : '[ ]');
      return 'План обновлён:\n' + steps.map((s) => `${mark(s.status)} ${s.text}`).join('\n');
    }
    case 'plan_build': {
      // Генплан рисует фронтенд (вид сверху); модели возвращаем сводку зон.
      const items = Array.isArray(args.items) ? args.items : [];
      const lines = items.map((it) =>
        `• ${it.label || 'зона'}: x${it.x} z${it.z} ${it.w}×${it.d}`);
      return `Генплан «${args.name || 'постройка'}» (${items.length} зон) показан пользователю:\n` +
        lines.join('\n') + '\nДалее строй через build_parts по этому плану.';
    }
    case 'use_template': {
      const code = renderTemplate(args.templateId, args.params);
      if (!bridge.isConnected()) {
        return `Шаблон "${args.templateId}" (Studio не подключён, код не выполнен):\n${code}`;
      }
      const r = await bridge.dispatch('run_code', { code });
      return `Шаблон "${args.templateId}" выполнен. ${resultToString(r)}`;
    }

    // ── Roblox Studio: обобщённый проброс в плагин по имени ──
    // Любой инструмент из STUDIO_TOOLS уходит в плагин КАК ЕСТЬ. Поэтому добавить
    // новый Studio-инструмент = добавить только схему (+ обработчик в плагине):
    // «забыть подключить» в agent.js структурно невозможно.
    default:
      if (!STUDIO_TOOLS.has(name)) {
        throw new Error(`Неизвестный инструмент: ${name}`);
      }
      return bridge.dispatch(name, applyStudioDefaults(name, args));
  }
}

// Человекочитаемые описания того, ЧТО делает инструмент — для индикатора статуса.
function statusFor(name, args) {
  switch (name) {
    case 'update_plan': return 'Обновляю план';
    case 'plan_build': return `Проектирую генплан: ${args.name || ''}`.trim();
    case 'build_parts': return `Строю (${(args.parts || []).length} частей)`.trim();
    case 'web_search': return `Ищу в интернете: ${args.query || ''}`.trim();
    case 'web_fetch': return 'Читаю страницу';
    case 'search_assets': return `Ищу ассеты: ${args.keyword || ''}`.trim();
    case 'luau_reference': return `Сверяюсь со справочником${args.topic ? ': ' + args.topic : ''}`;
    case 'run_command': return `Выполняю команду: ${(args.command || '').slice(0, 50)}`.trim();
    case 'read_file': return `Читаю файл ${args.path || ''}`.trim();
    case 'write_file': return `Пишу файл ${args.path || ''}`.trim();
    case 'edit_file': return `Правлю файл ${args.path || ''}`.trim();
    case 'list_dir': return `Смотрю каталог ${args.path || ''}`.trim();
    case 'make_dir': return `Создаю каталог ${args.path || ''}`.trim();
    case 'read_lines': return `Читаю файл ${args.path || ''}`.trim();
    case 'append_file': return `Дописываю в ${args.path || ''}`.trim();
    case 'delete_path': return `Удаляю ${args.path || ''}`.trim();
    case 'move_path': return `Перемещаю ${args.from || ''}`.trim();
    case 'copy_path': return `Копирую ${args.from || ''}`.trim();
    case 'glob_files': return `Ищу файлы: ${args.pattern || ''}`.trim();
    case 'grep_files': return `Ищу по содержимому: ${args.pattern || ''}`.trim();
    case 'tree': return `Строю дерево ${args.path || ''}`.trim();
    case 'stat_path': return `Смотрю ${args.path || ''}`.trim();
    case 'path_exists': return `Проверяю ${args.path || ''}`.trim();
    case 'sys_info': return 'Читаю информацию о системе';
    case 'get_cwd': return 'Узнаю рабочий каталог';
    case 'run_code': return 'Выполняю Lua-код в Studio';
    case 'insert_model': return `Вставляю ассет ${args.assetId || ''}`.trim();
    case 'get_console_output': return 'Читаю консоль Studio';
    case 'get_studio_context': return 'Изучаю структуру плейса';
    case 'get_instance_properties': return `Читаю свойства ${args.path || ''}`.trim();
    case 'set_properties': return `Меняю свойства ${args.path || ''}`.trim();
    case 'create_instance': return `Создаю ${args.className || 'объект'}`.trim();
    case 'delete_instance': return `Удаляю ${args.path || ''}`.trim();
    case 'rename_instance': return `Переименовываю ${args.path || ''}`.trim();
    case 'get_script_source': return `Читаю скрипт ${args.path || ''}`.trim();
    case 'set_script_source': return `Редактирую скрипт ${args.path || ''}`.trim();
    case 'find_instances': return 'Ищу объекты в плейсе';
    case 'select_instance': return `Выделяю ${args.path || ''}`.trim();
    case 'get_selection': return 'Смотрю выделенное в Studio';
    case 'duplicate_instance': return `Дублирую ${args.path || ''}`.trim();
    case 'move_instance': return `Перемещаю ${args.path || ''}`.trim();
    case 'get_children': return `Смотрю детей ${args.path || ''}`.trim();
    case 'get_attributes': return `Читаю атрибуты ${args.path || ''}`.trim();
    case 'set_attributes': return `Ставлю атрибуты ${args.path || ''}`.trim();
    case 'add_tag': return `Добавляю тег ${args.tag || ''}`.trim();
    case 'remove_tag': return `Снимаю тег ${args.tag || ''}`.trim();
    case 'get_tags': return `Читаю теги ${args.path || ''}`.trim();
    case 'create_script': return `Создаю ${args.scriptType || 'Script'} ${args.name || ''}`.trim();
    case 'call_method': return `Вызываю ${args.method || ''} на ${args.path || ''}`.trim();
    case 'clear_children': return `Очищаю ${args.path || ''}`.trim();
    case 'count_instances': return 'Считаю объекты';
    case 'group_instances': return `Группирую в ${args.container || 'Model'}`.trim();
    case 'add_proximity_prompt': return `Добавляю ProximityPrompt на ${args.path || ''}`.trim();
    case 'add_click_detector': return `Добавляю ClickDetector на ${args.path || ''}`.trim();
    case 'create_screen_gui': return `Создаю ScreenGui ${args.name || ''}`.trim();
    case 'create_ui_element': return `Создаю UI ${args.className || ''}`.trim();
    case 'weld': return 'Свариваю объекты';
    case 'add_attachment': return `Добавляю Attachment на ${args.path || ''}`.trim();
    case 'create_constraint': return `Создаю ${args.constraintType || 'констрейнт'}`.trim();
    case 'add_decal': return `Добавляю ${args.kind || 'Decal'} на ${args.path || ''}`.trim();
    case 'add_light': return `Добавляю ${args.lightType || 'свет'} на ${args.path || ''}`.trim();
    case 'add_particle': return `Добавляю частицы на ${args.path || ''}`.trim();
    case 'add_sound': return 'Добавляю звук';
    case 'set_lighting': return 'Настраиваю освещение сцены';
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

function isAbort(err) {
  return err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
}

// session — экземпляр Session; onEvent(type, payload) для стриминга в UI.
// opts.signal — AbortSignal для прерывания (кнопка Stop).
export async function runAgent(session, onEvent = () => {}, opts = {}) {
  const signal = opts.signal;
  const studioConnected = bridge.isConnected();
  const pcAllowed = !studioConnected && getPcAgent();
  let outTokens = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) return 'Остановлено пользователем.';
    onEvent('status', { text: 'Думаю', tokens: outTokens });
    onEvent('assistant_start', {});
    const think = session.thinkingConfig();

    let reply;
    try {
      reply = await streamComplete(
        {
          provider: session.provider,
          system: session.systemPrompt({ studioConnected, pcAllowed }),
          messages: session.getCompiledMessages(),
          model: session.model,
          temperature: think.temperature,
          thinking: think,
          useTools: true,
          studioConnected,
          pcAllowed,
          signal,
        },
        (chunk) => {
          outTokens += tok(chunk);
          onEvent('assistant_delta', { text: chunk });
          onEvent('status', { text: 'Печатаю ответ', tokens: outTokens });
        }
      );
    } catch (err) {
      if (isAbort(err)) {
        onEvent('assistant_text', { text: '' });
        return 'Остановлено пользователем.';
      }
      throw err;
    }

    session.addAssistant(reply.text, reply.toolCalls);
    onEvent('assistant_text', { text: reply.text });

    // Прервали во время стрима — сохраняем то, что есть, и выходим.
    if (signal?.aborted) return reply.text;

    if (!reply.toolCalls || reply.toolCalls.length === 0) {
      return reply.text; // финальный ответ без действий
    }

    for (const tc of reply.toolCalls) {
      if (signal?.aborted) {
        session.addToolResult(tc.id, tc.name, 'Остановлено пользователем.');
        continue;
      }
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
      session.addToolResult(tc.id, tc.name, trimResult(resultStr));
    }
  }

  // Лимит шагов исчерпан — всегда показываем финальное сообщение, чтобы было
  // видно, что агент остановился (а не «завис»).
  const limitMsg = 'Достиг лимита шагов за один ход. Если задача не завершена — напишите «продолжи».';
  session.addAssistant(limitMsg, []);
  onEvent('assistant_start', {});
  onEvent('assistant_text', { text: limitMsg });
  return limitMsg;
}
