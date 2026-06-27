// Агентный цикл: вызываем LLM, исполняем затребованные инструменты, возвращаем
// результаты модели и повторяем, пока есть tool-calls. Поддерживает прерывание
// (AbortSignal), три режима инструментов (Studio / ПК / только веб) и экономию
// токенов (обрезка длинных результатов).

import { streamComplete } from './llm/providers.js';
import { bridge } from './bridge.js';
import { renderTemplate } from './templates.js';
import { getPcAgent, getPcAlways } from './app-config.js';
import { getLuauReference } from './luau-reference.js';
import { webSearch, webFetch, searchAssets, searchAssetsTyped } from './web.js';
import { waitForAnswer } from './asks.js';
import { renderBlueprintPNG } from './png.js';
import { codeSearch } from './code-search.js';
import { getActiveProject } from './projects.js';
import { addKnowledge } from './knowledge.js';
import { generateAndUpload, meshConfigStatus, meshPolycount } from './mesh3d.js';
import {
  runCommand, readFileTool, writeFileTool, editFileTool, multiEditTool, listDirTool, makeDirTool,
  deletePathTool, moveTool, copyTool, appendFileTool, readLinesTool, statTool,
  existsTool, globTool, grepTool, treeTool, sysInfoTool, cwdTool,
  clipboardReadTool, clipboardWriteTool, notifyTool, screenshotTool, downloadFileTool,
  regQueryTool, regSetTool, runBackgroundTool, processOutputTool, processInputTool,
  processStopTool, processListTool, gitTool, launchAppTool, focusWindowTool, sendKeysTool,
  runCodeSandboxTool, installRuntimeTool,
} from './local-tools.js';
import { TOOL_NAMES, WEB_TOOLS, PC_TOOLS, SPECIAL_TOOLS, STUDIO_TOOLS } from './llm/tools.js';

// Жёсткого лимита шагов нет — агент работает, пока у задачи есть tool-calls,
// и останавливается сам, когда выдаёт финальный ответ без инструментов. Цикл
// прерывается только пользователем (Stop) или ошибкой. SAFETY_CAP — лишь
// аварийный предел против реально бесконечного цикла (не виден пользователю,
// сообщения о нём нет).
const SAFETY_CAP = 1000;

// Последний генплан по чату — для аудита и vision-ревью (review_blueprint).
const lastBlueprint = new Map(); // chatId -> { name, width, depth, items }

// Детерминированный аудит генплана: ловим типичные ошибки (мелкий масштаб, узкие
// коридоры, пересечения комнат, выход за участок) — точнее, чем «на глаз». Слова
// в label определяют тип зоны. Возвращает массив строк-замечаний.
function auditBlueprint(items, W, D) {
  const warns = [];
  const isWall = (l) => /(стен|wall|забор|fence|перегород)/i.test(l);
  const isDoor = (l) => /(двер|door|проём|проем|вход|арка|gate)/i.test(l);
  const isCorridor = (l) => /(коридор|corridor|hall|проход|туннель|tunnel)/i.test(l);
  const isRoom = (l) => /(комнат|room|зал|hall|спальн|кухн|офис|лобби|lobby|арен|холл)/i.test(l);
  const list = items.map((it) => ({
    label: String(it.label || ''),
    x: Number(it.x) || 0, z: Number(it.z) || 0,
    w: Math.abs(Number(it.w) || 0), d: Math.abs(Number(it.d) || 0),
  }));
  for (const it of list) {
    const tag = `«${it.label || 'зона'}»`;
    if (it.x < 0 || it.z < 0 || it.x + it.w > W + 0.5 || it.z + it.d > D + 0.5) {
      warns.push(`${tag} выходит за границы участка ${W}×${D}.`);
    }
    if (isWall(it.label) || isDoor(it.label)) continue; // стены/проёмы тонкие — это норма
    const mn = Math.min(it.w, it.d);
    if (isCorridor(it.label)) {
      if (mn < 12) warns.push(`${tag} коридор слишком узкий (${mn} studs) — игроку тесно, делай ≥12–16.`);
    } else if (isRoom(it.label)) {
      if (mn < 24) warns.push(`${tag} комната мелковата (${it.w}×${it.d}) — обычно от 30×30 studs.`);
    } else if (mn > 0 && mn < 8) {
      warns.push(`${tag} очень узкая зона (${it.w}×${it.d}) — проверь масштаб.`);
    }
  }
  // Пересечения НЕ-стен зон (комнаты не должны накладываться друг на друга).
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (isWall(a.label) || isWall(b.label) || isDoor(a.label) || isDoor(b.label)) continue;
      const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const oz = Math.max(0, Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z));
      if (ox > 1 && oz > 1) {
        warns.push(`«${a.label || 'зона'}» и «${b.label || 'зона'}» пересекаются (${ox.toFixed(0)}×${oz.toFixed(0)}).`);
      }
    }
  }
  return warns;
}

// Нормализация шагов плана. Модели часто ломают формат: присылают строку с
// XML-мусором («\n<parameter name="text">…»), один объект вместо массива, JSON-строку
// или массив строк. Приводим ВСЁ к [{text, status}] — иначе план в UI пуст.
function normalizePlanSteps(raw) {
  let steps = raw;
  // JSON-строка → пытаемся распарсить.
  if (typeof steps === 'string') {
    const s = steps.trim();
    try {
      const parsed = JSON.parse(s);
      steps = parsed;
    } catch {
      // Не JSON. Вытаскиваем текст из XML-подобного мусора или режем по строкам.
      const cleaned = s
        .replace(/<\/?parameter[^>]*>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/^\s*["'\[\]{}]+|["'\[\]{}]+\s*$/g, '');
      steps = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);
    }
  }
  // Один объект-шаг вместо массива.
  if (steps && !Array.isArray(steps) && typeof steps === 'object') {
    if (Array.isArray(steps.steps)) steps = steps.steps;
    else steps = [steps];
  }
  if (!Array.isArray(steps)) return [];
  const okStatus = (s) => (s === 'done' || s === 'in_progress' || s === 'pending') ? s : 'pending';
  return steps.map((it) => {
    if (typeof it === 'string') {
      // Возможны пометки прямо в тексте: «— готово», «[x]», «(done)».
      let text = it.trim();
      let status = 'pending';
      if (/(\bdone\b|\[x\]|✔|✓|— ?готово|- ?готово|выполнено)/i.test(text)) status = 'done';
      else if (/(in[_ ]?progress|\[~\]|◐|в процессе|делаю)/i.test(text)) status = 'in_progress';
      text = text.replace(/\s*[—-]\s*(готово|done|выполнено)\s*$/i, '')
        .replace(/^\[[ x~]?\]\s*/i, '').trim();
      return { text, status };
    }
    if (it && typeof it === 'object') {
      return { text: String(it.text || it.label || it.title || it.name || '').trim(), status: okStatus(it.status) };
    }
    return { text: String(it || '').trim(), status: 'pending' };
  }).filter((s) => s.text);
}

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
  'run_command', 'read_file', 'write_file', 'edit_file', 'multi_edit', 'list_dir', 'make_dir',
  'read_lines', 'append_file', 'delete_path', 'move_path', 'copy_path',
  'glob_files', 'grep_files', 'tree', 'stat_path', 'path_exists', 'sys_info', 'get_cwd',
  'clipboard_read', 'clipboard_write', 'notify', 'take_screenshot', 'download_file',
  'reg_query', 'reg_set', 'run_background', 'process_output', 'process_input',
  'process_stop', 'process_list', 'git', 'launch_app', 'focus_window', 'send_keys',
  'run_code_sandbox', 'install_runtime', 'code_search',
  'use_template', 'update_plan', 'plan_build', 'ask_user', 'write_script', 'review_blueprint',
  'remember', 'capture_place', 'generate_3d_model',
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
// Лимит зависит от инструмента: «болтливые» (дерево плейса, чтение файлов, веб,
// консоль) обрезаем агрессивнее — модели редко нужен весь объём, а в истории он
// висит на каждом последующем шаге и жжёт токены кратно.
const MAX_TOOL_RESULT = 2500;
const TOOL_RESULT_LIMITS = {
  get_studio_context: 1800,
  get_file_data: 1800,
  tree: 1500,
  read_file: 2000,
  read_lines: 2000,
  web_fetch: 2000,
  web_search: 1500,
  get_console_output: 1200,
  find_instances: 1500,
  grep_files: 1500,
  glob_files: 1200,
  search_assets: 1800,
  process_output: 1200,
  run_command: 2000,
  run_code_sandbox: 2000,
};
function trimResult(s, name) {
  s = resultToString(s);
  const cap = TOOL_RESULT_LIMITS[name] || MAX_TOOL_RESULT;
  if (s.length <= cap) return s;
  // Для длинного вывода оставляем начало И конец (часто важна концовка — ошибки,
  // итоги), середину выкидываем — так контекст полезнее при той же экономии.
  const head = Math.floor(cap * 0.7);
  const tail = cap - head;
  return s.slice(0, head) + '\n…(обрезано ' + (s.length - cap) + ' симв. для экономии токенов)…\n' + s.slice(s.length - tail);
}

// Исполняет один tool-call и возвращает результат для модели.
// ctx = { chatId, signal, onEvent } — для интерактивных инструментов (ask_user).
// Валидация обязательных аргументов: модель часто шлёт пустой write/поиск/edit.
// Вместо мусорного вызова возвращаем понятную корректирующую ошибку — модель
// видит её в результате инструмента и повторяет с правильными аргументами.
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const ARG_RULES = {
  web_search: (a) => isStr(a.query) || 'нужен непустой query (что искать).',
  web_fetch: (a) => isStr(a.url) || 'нужен url.',
  search_assets: (a) => isStr(a.keyword) || 'нужен непустой keyword (что искать в тулбоксе).',
  code_search: (a) => isStr(a.query) || 'нужен непустой query.',
  grep_files: (a) => isStr(a.pattern) || 'нужен непустой pattern (regex/строка поиска).',
  glob_files: (a) => isStr(a.pattern) || 'нужен непустой pattern (маска, напр. **/*.lua).',
  read_file: (a) => isStr(a.path) || 'нужен path к файлу.',
  read_lines: (a) => isStr(a.path) || 'нужен path к файлу.',
  stat_path: (a) => isStr(a.path) || 'нужен path.',
  path_exists: (a) => isStr(a.path) || 'нужен path.',
  delete_path: (a) => isStr(a.path) || 'нужен path.',
  make_dir: (a) => isStr(a.path) || 'нужен path каталога.',
  write_file: (a) => !isStr(a.path) ? 'нужен path файла.'
    : (typeof a.content !== 'string' ? 'нужен content (строка; для пустого файла передай "").' : true),
  append_file: (a) => !isStr(a.path) ? 'нужен path.'
    : (typeof a.content !== 'string' ? 'нужен content (что дописать).' : true),
  edit_file: (a) => !isStr(a.path) ? 'нужен path.'
    : !isStr(a.oldText) ? 'нужен непустой oldText (что заменить).'
    : (typeof a.newText !== 'string' ? 'нужен newText (чем заменить).' : true),
  multi_edit: (a) => !isStr(a.path) ? 'нужен path.'
    : ((!Array.isArray(a.edits) || a.edits.length === 0) ? 'нужен непустой массив edits [{oldText,newText}].'
    : (a.edits.some((e) => !e || !isStr(e.oldText)) ? 'в каждом элементе edits нужен непустой oldText.' : true)),
  move_path: (a) => !isStr(a.from) ? 'нужен from (откуда).' : (!isStr(a.to) ? 'нужен to (куда).' : true),
  copy_path: (a) => !isStr(a.from) ? 'нужен from (источник).' : (!isStr(a.to) ? 'нужен to (назначение).' : true),
  write_script: (a) => !isStr(a.source) ? 'нужен непустой source (полный код скрипта — не пустой).'
    : (!isStr(a.scriptType) ? 'нужен scriptType (Script | LocalScript | ModuleScript).' : true),
  edit_script: (a) => !isStr(a.path) ? 'нужен path к скрипту.'
    : !isStr(a.oldText) ? 'нужен непустой oldText (что заменить в скрипте).'
    : (typeof a.newText !== 'string' ? 'нужен newText (чем заменить).' : true),
  run_command: (a) => isStr(a.command) || 'нужна непустая command.',
  run_code_sandbox: (a) => !isStr(a.code) ? 'нужен непустой code для запуска.'
    : (!isStr(a.language) ? 'нужен language (lua|luau|javascript|python|bash|powershell).' : true),
};
function validateArgs(name, args) {
  const rule = ARG_RULES[name];
  if (!rule) return null;
  const r = rule(args || {});
  if (r === true) return null;
  return `Инструмент ${name}: ${r} Аргументы пустые/неполные — исправь и вызови инструмент ещё раз (не оставляй поля пустыми).`;
}

async function runTool(name, args, ctx = {}) {
  const argErr = validateArgs(name, args);
  if (argErr) return argErr;
  switch (name) {
    // ── Веб (доступно всегда) ──
    case 'web_search':
      return webSearch(args.query, args.count || 5);
    case 'web_fetch':
      return webFetch(args.url, args.maxChars || 4000);
    case 'search_assets':
      return searchAssetsTyped(args.keyword, args.assetType || 'model', args.limit || 12);
    case 'luau_reference':
      return getLuauReference(args.topic);
    case 'code_search': {
      // Семантический поиск по коду. Корень: явный path → папка проекта → дом.
      const proj = getActiveProject();
      const root = args.path || (proj && proj.folder) || undefined;
      return codeSearch({ query: args.query, root, limit: args.limit || 5 });
    }

    // ── ПК-инструменты (когда Studio не подключён) ──
    case 'run_command':
      return runCommand(args);
    case 'read_file':
      return readFileTool(args);
    case 'write_file':
      return writeFileTool(args);
    case 'edit_file':
      return editFileTool(args);
    case 'multi_edit':
      return multiEditTool(args);
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
    case 'clipboard_read': return clipboardReadTool();
    case 'clipboard_write': return clipboardWriteTool(args);
    case 'notify': return notifyTool(args);
    case 'take_screenshot': return screenshotTool(args);
    case 'download_file': return downloadFileTool(args);
    case 'reg_query': return regQueryTool(args);
    case 'reg_set': return regSetTool(args);
    case 'run_background': return runBackgroundTool(args);
    case 'process_output': return processOutputTool(args);
    case 'process_input': return processInputTool(args);
    case 'process_stop': return processStopTool(args);
    case 'process_list': return processListTool();
    case 'git': return gitTool(args);
    case 'launch_app': return launchAppTool(args);
    case 'focus_window': return focusWindowTool(args);
    case 'send_keys': return sendKeysTool(args);
    case 'run_code_sandbox': return runCodeSandboxTool(args);
    case 'install_runtime': return installRuntimeTool(args);

    // ── Спец-инструменты (особая логика) ──
    case 'update_plan': {
      // Визуал плана рисует фронтенд из события tool_call; модели возвращаем сводку.
      const steps = normalizePlanSteps(args.steps);
      if (!steps.length) return 'План пуст — передай steps как массив шагов вида {text, status}.';
      const mark = (s) => (s === 'done' ? '[x]' : s === 'in_progress' ? '[~]' : '[ ]');
      return 'План обновлён:\n' + steps.map((s) => `${mark(s.status)} ${s.text}`).join('\n');
    }
    case 'ask_user': {
      // Вопрос с кнопками уже отрисован фронтом из события tool_call. Ждём ответ
      // пользователя (клик по кнопке или свой текст) и возвращаем его модели.
      const q = String(args.question || 'Как продолжить?');
      const answer = await waitForAnswer(ctx.chatId || 'default', q, { signal: ctx.signal });
      return `Пользователь выбрал: ${answer}`;
    }
    case 'review_blueprint': {
      // Рендерим последний генплан в PNG и отдаём картинку модели (vision).
      const bp = lastBlueprint.get(ctx.chatId || 'default');
      if (!bp) return 'Нет генплана для проверки — сначала вызови plan_build.';
      let img;
      try { img = renderBlueprintPNG(bp); } catch (e) { return `Не удалось отрендерить генплан: ${e.message}`; }
      // __image будет извлечён в runAgent и добавлен как изображение в историю.
      return {
        __image: { mediaType: img.mediaType, data: img.data },
        text: `Генплан «${bp.name || ''}» (${img.W}×${img.D}, ${img.legend.length} зон) отрендерен в ` +
          `изображение и отправлен тебе на проверку. Легенда (номер → зона):\n${img.legend.join('\n')}\n` +
          'Посмотри на схему: оцени компоновку, пропорции и масштаб. При проблемах переделай plan_build.',
      };
    }
    case 'remember': {
      // Самообучение: агент записывает вывод в долговременную память.
      try {
        const item = addKnowledge(args.text, { tags: args.tags || [], source: 'agent' });
        return `Запомнил: «${item.text}»`;
      } catch (e) { return `Не удалось запомнить: ${e.message}`; }
    }
    case 'capture_place': {
      // Снимок открытого плейса → в память (структура дерева). Только при Studio.
      if (!bridge.isConnected()) return 'Studio не подключён — нечего снимать. Подключите мост в плагине.';
      let tree;
      try { tree = await bridge.dispatch('get_studio_context', { depth: Number(args.depth) || 3 }); }
      catch (e) { return `Не удалось получить структуру плейса: ${e.message}`; }
      const place = (bridge.studioInfo && bridge.studioInfo.placeName) || 'плейс';
      const summary = `Карта «${place}»` + (args.note ? ` (${args.note})` : '') + ':\n' + trimResult(resultToString(tree), 'capture_place').slice(0, 2000);
      try {
        addKnowledge(summary, { tags: ['map', place], source: 'capture' });
      } catch (e) { return `Снимок получен, но не сохранён: ${e.message}`; }
      return `Снял слепок плейса «${place}» и записал в память. В дальнейшем смогу опираться на его устройство.`;
    }
    case 'generate_3d_model': {
      // Текст → 3D-меш (Meshy) → загрузка в Roblox (Open Cloud) → assetId.
      // Если Studio подключён — сразу вставляем как MeshPart.
      const st = meshConfigStatus();
      if (!st.generator || !st.openCloud || !st.creator) {
        const miss = [];
        if (!st.generator) miss.push('ключ генератора 3D — Tripo (TRIPO_API_KEY/tripoApiKey) или Meshy (MESHY_API_KEY/meshyApiKey)');
        if (!st.openCloud) miss.push('ключ Open Cloud (ROBLOX_OPEN_CLOUD_KEY или openCloudApiKey)');
        if (!st.creator) miss.push('ID создателя (ROBLOX_CREATOR_USER_ID или ROBLOX_CREATOR_GROUP_ID)');
        return 'Генерация 3D недоступна — не настроены: ' + miss.join('; ') +
          '. Задай их через ENV или POST /api/mesh-config, затем повтори.';
      }
      // Видимое сообщение «начал генерацию» — процесс долгий (1–3 мин), без него
      // кажется, что чат завис.
      const provider = (st.provider || 'генератор');
      if (ctx.onEvent) {
        ctx.onEvent('assistant_start', {});
        ctx.onEvent('assistant_text', { text: `Начинаю генерацию 3D-модели «${args.prompt}» через ${provider}… это займёт 1–3 минуты.` });
      }
      let lastPct = -1;
      const onProgress = (pct, stage) => {
        const p = Math.round(Number(pct) || 0);
        if (!ctx.onEvent || p === lastPct) return;
        lastPct = p;
        ctx.onEvent('status', { text: `Генерация 3D (${stage || 'идёт'}): ${p}%` });
      };
      let gen;
      try {
        gen = await generateAndUpload({
          prompt: args.prompt,
          name: args.name,
          polycount: Number(args.polycount) || meshPolycount(),
          refine: args.refine !== false,
          onProgress,
        });
      } catch (e) {
        // Частый случай: на Tripo нет API-кредитов (веб-кредиты ≠ API-кредиты).
        if (/credit|insufficient|balance|2008|quota|payment/i.test(e.message)) {
          return `Не удалось сгенерировать 3D-модель: на ключе нет API-кредитов. ` +
            `Важно: бесплатные кредиты на сайте Tripo (Studio) ≠ API-кредиты — они считаются отдельно. ` +
            `Получи бесплатные API-кредиты по программе для разработчиков (Tripo Game Hub Developer API Credits, ` +
            `разовый грант ~5000) или пополни на platform.tripo3d.ai → Billing. Проверить баланс ключей можно ` +
            `во вкладке «3D» → «Проверить ключи». (Ошибка: ${e.message})`;
        }
        return `Не удалось сгенерировать 3D-модель: ${e.message}`;
      }
      if (bridge.isConnected()) {
        try {
          const r = await bridge.dispatch('insert_mesh_asset', {
            assetId: gen.assetId, name: args.name || args.prompt,
            parent: args.parent, position: args.position,
          });
          return `Сгенерирована и вставлена 3D-модель (assetId ${gen.assetId}). ${resultToString(r)}`;
        } catch (e) {
          return `Модель сгенерирована и загружена (assetId ${gen.assetId}), но вставить в Studio не вышло: ${e.message}. ` +
            `Вставь вручную через insert_mesh_asset assetId=${gen.assetId}.`;
        }
      }
      return `Сгенерирована и загружена 3D-модель. assetId: ${gen.assetId}. ` +
        `Studio не подключён — подключи мост и вставь через insert_mesh_asset assetId=${gen.assetId}.`;
    }
    case 'write_script': {
      // Создать/заменить скрипт в Studio. Удобная обёртка: при подключённом
      // Studio проксируем в плагин как create_script; иначе показываем код.
      const scriptType = args.scriptType || 'Script';
      if (!bridge.isConnected()) {
        return `Studio не подключён — скрипт «${args.name || scriptType}» не создан. Код:\n${args.source || ''}`;
      }
      const r = await bridge.dispatch('create_script', {
        scriptType, parent: args.parent, name: args.name, source: args.source,
      });
      return resultToString(r);
    }
    case 'plan_build': {
      // Генплан рисует фронтенд (вид сверху); модели возвращаем сводку + аудит.
      // Авто-коррекция: привязываем координаты к сетке 2 studs — убирает «кривость»
      // (зоны перестают быть на доли стада смещены друг относительно друга).
      const snap = (v) => Math.round((Number(v) || 0) / 2) * 2;
      const items = (Array.isArray(args.items) ? args.items : []).map((it) => ({
        ...it,
        x: snap(it.x), z: snap(it.z),
        w: Math.max(2, snap(it.w)), d: Math.max(2, snap(it.d)),
      }));
      let W = Number(args.width) || 0, D = Number(args.depth) || 0;
      for (const it of items) {
        W = Math.max(W, (Number(it.x) || 0) + (Number(it.w) || 0));
        D = Math.max(D, (Number(it.z) || 0) + (Number(it.d) || 0));
      }
      // Запоминаем для review_blueprint (vision-проверка).
      lastBlueprint.set(ctx.chatId || 'default', { name: args.name, width: W, depth: D, items });
      const lines = items.map((it, i) =>
        `${i + 1}. ${it.label || 'зона'}: x${it.x} z${it.z} ${it.w}×${it.d}`);
      const warns = auditBlueprint(items, W, D);
      const audit = warns.length
        ? `\n\nПРОВЕРКА ГЕНПЛАНА — найдены проблемы, ИСПРАВЬ их новым plan_build перед постройкой:\n- ${warns.join('\n- ')}`
        : '\n\nПРОВЕРКА ГЕНПЛАНА: критичных проблем масштаба/геометрии не найдено — можно строить.';
      return `Генплан «${args.name || 'постройка'}» (${items.length} зон, участок ${W}×${D}) показан пользователю:\n` +
        lines.join('\n') + audit + '\n\nДалее: при необходимости вызови review_blueprint для визуальной ' +
        'проверки, затем строй build_parts по этому плану.';
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
    case 'ask_user': return 'Жду ответ пользователя';
    case 'review_blueprint': return 'Проверяю генплан визуально';
    case 'write_script': return `Пишу скрипт ${args.name || args.scriptType || ''}`.trim();
    case 'edit_script': return `Правлю скрипт ${args.path || ''}`.trim();
    case 'plan_build': return `Проектирую генплан: ${args.name || ''}`.trim();
    case 'build_parts': return `Строю (${(args.parts || []).length} частей)`.trim();
    case 'build_room': return `Строю комнату ${args.name || ''} (${args.width || '?'}×${args.depth || '?'})`.trim();
    case 'apply_surface': return `Применяю материал/текстуру на ${args.path || ''}`.trim();
    case 'web_search': return `Ищу в интернете: ${args.query || ''}`.trim();
    case 'web_fetch': return 'Читаю страницу';
    case 'search_assets': return `Ищу ассеты: ${args.keyword || ''}`.trim();
    case 'luau_reference': return `Сверяюсь со справочником${args.topic ? ': ' + args.topic : ''}`;
    case 'run_command': return `Выполняю команду: ${(args.command || '').slice(0, 50)}`.trim();
    case 'read_file': return `Читаю файл ${args.path || ''}`.trim();
    case 'write_file': return `Пишу файл ${args.path || ''}`.trim();
    case 'edit_file': return `Правлю файл ${args.path || ''}`.trim();
    case 'multi_edit': return `Правлю файл ${args.path || ''} (${(args.edits || []).length})`.trim();
    case 'list_dir': return `Смотрю каталог ${args.path || ''}`.trim();
    case 'make_dir': return `Создаю каталог ${args.path || ''}`.trim();
    case 'read_lines': return `Читаю файл ${args.path || ''}`.trim();
    case 'append_file': return `Дописываю в ${args.path || ''}`.trim();
    case 'delete_path': return `Удаляю ${args.path || ''}`.trim();
    case 'move_path': return `Перемещаю ${args.from || ''}`.trim();
    case 'copy_path': return `Копирую ${args.from || ''}`.trim();
    case 'glob_files': return `Ищу файлы: ${args.pattern || ''}`.trim();
    case 'grep_files': return `Ищу по содержимому: ${args.pattern || ''}`.trim();
    case 'code_search': return `Семантический поиск: ${args.query || ''}`.trim();
    case 'search_scripts': return `Ищу в скриптах: ${args.query || ''}`.trim();
    case 'tree': return `Строю дерево ${args.path || ''}`.trim();
    case 'stat_path': return `Смотрю ${args.path || ''}`.trim();
    case 'path_exists': return `Проверяю ${args.path || ''}`.trim();
    case 'sys_info': return 'Читаю информацию о системе';
    case 'get_cwd': return 'Узнаю рабочий каталог';
    case 'clipboard_read': return 'Читаю буфер обмена';
    case 'clipboard_write': return 'Пишу в буфер обмена';
    case 'notify': return 'Показываю уведомление';
    case 'take_screenshot': return 'Делаю скриншот экрана';
    case 'download_file': return `Скачиваю ${args.url || ''}`.trim();
    case 'reg_query': return `Читаю реестр ${args.key || ''}`.trim();
    case 'reg_set': return `Пишу в реестр ${args.key || ''}`.trim();
    case 'run_background': return `Запускаю в фоне: ${(args.command || '').slice(0, 40)}`.trim();
    case 'process_output': return `Читаю вывод ${args.id || ''}`.trim();
    case 'process_input': return `Ввожу в процесс ${args.id || ''}`.trim();
    case 'process_stop': return `Останавливаю процесс ${args.id || ''}`.trim();
    case 'process_list': return 'Смотрю фоновые процессы';
    case 'git': return `git ${args.action || 'status'}`.trim();
    case 'launch_app': return `Запускаю ${args.app || ''}`.trim();
    case 'focus_window': return `Фокус на окно ${args.title || ''}`.trim();
    case 'send_keys': return 'Отправляю клавиши';
    case 'run_code_sandbox': return `Выполняю код (${args.language || '?'}) в песочнице`.trim();
    case 'install_runtime': return `Устанавливаю рантайм ${args.language || 'luau'}`.trim();
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
    case 'set_sound_volume': return 'Настраиваю громкость звука';
    case 'set_lighting': return 'Настраиваю освещение сцены';
    case 'tween_instance': return `Анимирую ${args.path || ''}`.trim();
    case 'create_cutscene': return `Создаю катсцену ${args.name || ''} (${(args.frames || []).length} кадров)`.trim();
    case 'play_animation': return `Проигрываю анимацию на ${args.path || ''}`.trim();
    case 'start_stop_play': return args.action === 'stop' ? 'Останавливаю Play' : 'Запускаю Play';
    case 'run_script_in_play_mode': return 'Выполняю код в Play-режиме';
    case 'use_template': return `Применяю шаблон ${args.templateId || ''}`.trim();
    default: return `Вызываю ${name}`;
  }
}

function resultToString(result) {
  if (result == null) return 'ok';
  if (typeof result === 'string') return result;
  // Массив простых значений (строки/числа) — отдаём построчно, а не сырым JSON.
  // Так вывод консоли Studio (get_console_output) и подобные списки читаются
  // по-человечески: «Remotes готовы: 10\n…\ncleared: World_Base», а не
  // ["...","...","..."]. Пустой массив — явная пометка вместо «[]».
  if (Array.isArray(result)) {
    if (!result.length) return '(пусто)';
    if (result.every((x) => typeof x === 'string' || typeof x === 'number')) {
      return result.map((x) => String(x)).join('\n');
    }
  }
  try {
    return JSON.stringify(result, null, 2);
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
  // ПК-инструменты: при выключенном Studio — по тумблеру pcAgent; при подключённом
  // Studio — если включён pcAlways (по умолчанию да), чтобы можно было «сделать на ПК»
  // не отключая Studio.
  const pcAllowed = getPcAgent() && (!studioConnected || getPcAlways());
  let outTokens = 0;

  // Гарантируем рабочий провайдер: если выбранный (или дефолтный 'anthropic') не
  // настроен — переключаемся на первого доступного, иначе понятная ошибка вместо
  // «Неизвестный провайдер: anthropic».
  if (!session.ensureProvider()) {
    onEvent('error', {
      text: 'Не добавлено ни одного провайдера. Откройте настройки (значок ключа), ' +
        'добавьте провайдера и API-ключ, затем выберите модель.',
    });
    return 'Нет настроенных провайдеров.';
  }

  // Гарантированно показываемая заметка: после инструментов активного «пузыря» во
  // фронте уже нет (endStream без streamEl — no-op), поэтому создаём новый пузырь
  // (assistant_start) и сразу наполняем его (assistant_text). Без этого финальные
  // пометки «Готово»/ошибки терялись, и чат «закрывался молча».
  const emitNote = (text) => {
    onEvent('assistant_start', {});
    onEvent('assistant_text', { text });
    session.addAssistant(text, null);
    return text;
  };

  let didTools = false;     // была ли реальная работа (вызовы инструментов)
  let summaryNudged = false; // один раз просили подытожить при пустом финале
  let continues = 0;        // сколько раз авто-продолжали обрезанный по длине ответ

  for (let step = 0; step < SAFETY_CAP; step++) {
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

    session.addAssistant(reply.text, reply.toolCalls, reply.thinking);
    onEvent('assistant_text', { text: reply.text });

    // Прервали во время стрима — сохраняем то, что есть, и выходим.
    if (signal?.aborted) return reply.text;

    if (!reply.toolCalls || reply.toolCalls.length === 0) {
      // Ответ обрезан по лимиту длины (модель не дописала) — просим продолжить
      // ровно с места обрыва. Текст уже сохранён в историю и показан выше.
      const truncated = reply.stop === 'max_tokens' || reply.stop === 'length';
      if (truncated && reply.text && reply.text.trim() && continues < 4) {
        continues++;
        session.addUser('Твой ответ обрезался по лимиту длины. Продолжи РОВНО с места обрыва — ' +
          'не повторяй уже написанное и не начинай заново. Если это код — продолжи с той же строки.');
        continue;
      }
      // Нормальный финал: есть текст — он уже показан выше, возвращаем его.
      if (reply.text && reply.text.trim()) return reply.text;
      // Пустой финал. Либо модель «оборвалась» (прокси вернул только сырой
      // tool_use-текст, который мы извлекли), либо она молча сделала работу и не
      // подытожила. Чат НЕ должен закрыться без сообщения.
      if (!summaryNudged) {
        // Один раз мягко просим довести задачу/подытожить — чтобы пользователь
        // получил внятный ответ, а не пустоту.
        summaryNudged = true;
        session.addUser(didTools
          ? 'Кратко подытожь для пользователя, что сделано (1–3 предложения). Инструменты больше не вызывай.'
          : 'Продолжай выполнение задачи.');
        continue;
      }
      // Уже просили — не зацикливаемся. Даём гарантированно видимый финал.
      return emitNote(didTools
        ? 'Готово — задача выполнена.'
        : 'Не удалось сформировать ответ. Уточните запрос или попробуйте ещё раз.');
    }

    const pendingImages = []; // картинки от инструментов (review_blueprint) — для vision
    didTools = true;
    for (const tc of reply.toolCalls) {
      if (signal?.aborted) {
        session.addToolResult(tc.id, tc.name, 'Остановлено пользователем.');
        continue;
      }
      onEvent('status', { text: statusFor(tc.name, tc.args), tokens: outTokens });
      // Для update_plan нормализуем шаги ПЕРЕД отправкой в UI — иначе план пуст,
      // если модель прислала шаги строкой/одним объектом/с XML-мусором.
      let uiArgs = tc.args;
      if (tc.name === 'update_plan') {
        uiArgs = { ...tc.args, steps: normalizePlanSteps(tc.args.steps) };
      } else if (tc.name === 'plan_build' && Array.isArray(tc.args.items)) {
        // Та же привязка к сетке, что и в обработчике — чтобы схема в UI была ровной.
        const snap = (v) => Math.round((Number(v) || 0) / 2) * 2;
        uiArgs = { ...tc.args, items: tc.args.items.map((it) => ({
          ...it, x: snap(it.x), z: snap(it.z),
          w: Math.max(2, snap(it.w)), d: Math.max(2, snap(it.d)),
        })) };
      }
      onEvent('tool_call', { name: tc.name, args: uiArgs });
      let resultStr;
      try {
        const result = await runTool(tc.name, tc.args, { chatId: session.id, signal, onEvent });
        // Инструмент мог вернуть изображение (review_blueprint) — копим для модели.
        if (result && typeof result === 'object' && result.__image) {
          pendingImages.push(result.__image);
          resultStr = resultToString(result.text || 'Изображение готово.');
        } else {
          resultStr = resultToString(result);
        }
        onEvent('tool_result', { name: tc.name, ok: true, result: resultStr });
      } catch (err) {
        resultStr = `Ошибка: ${err.message}`;
        onEvent('tool_result', { name: tc.name, ok: false, result: resultStr });
      }
      outTokens += tok(resultStr);
      session.addToolResult(tc.id, tc.name, trimResult(resultStr, tc.name));
    }
    // После всех результатов добавляем картинки как user-сообщение (vision видит их
    // на следующем шаге). Делаем это ПОСЛЕ цикла, чтобы не разорвать пары
    // tool_use↔tool_result (иначе провайдер вернёт 400).
    if (pendingImages.length && !signal?.aborted) {
      session.addUser('Вот отрендеренная схема генплана. Оцени компоновку, пропорции и ' +
        'масштаб; если что-то не так — переделай plan_build, иначе переходи к build_parts.', pendingImages);
    }
  }

  // Достигнут аварийный предел шагов. НЕ закрываемся молча — даём видимый финал.
  return emitNote(didTools
    ? 'Достигнут предел шагов. Основное сделано; если задача не завершена — напишите, продолжу.'
    : 'Достигнут предел шагов без результата. Уточните задачу или попробуйте ещё раз.');
}
