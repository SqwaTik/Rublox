// Управление сессиями (чатами): история, модель, уровень мышления, компрессия.

import { config } from './config.js';
import { estimateMessagesTokens, summarizeMessages } from './context.js';
import { getProvider } from './llm/registry.js';
import { complete } from './llm/providers.js';
import { saveSession, loadSessionData, deleteSessionFile, listSessionIds } from './store.js';
import { activeSkillPrompts } from './skills.js';
import { projectPromptBlock } from './projects.js';

// Ядро личности (стабильное — хорошо кэшируется prompt cache).
const CORE_PROMPT =
  'Ты — Rublox, AI-ассистент для разработки игр на Roblox. Язык интерфейса и ' +
  'общения — русский. Ты действуешь как агент: используешь инструменты, чтобы ' +
  'реально менять проект, а не просто советовать.';

// Правила оформления ответа (общие для всех режимов).
const FORMAT_RULES =
  'ОФОРМЛЕНИЕ ОТВЕТА:\n' +
  '- Пиши кратко и по делу. Структурируй заголовками, списками, таблицами и ' +
  '`инлайн-кодом`. **Жирный** — ТОЛЬКО для редких ключевых акцентов (1-2 на абзац), ' +
  'не выделяй им всё подряд. Лучше структура, чем жирный текст.\n' +
  '- Любой код — в блоках с языком: ```lua … ``` (или ```bash, ```powershell).\n' +
  '- Когда ПРАВИШЬ код, показывай изменения как diff в блоке ```diff: строки с ' +
  '"+ " — добавленное, "- " — удалённое. Не дублируй неизменные куски целиком.\n' +
  '- НИКОГДА не вставляй заглушки вроде "[Pasted text #1]", "...", "ваш код тут". ' +
  'Всегда показывай реальный код, который пишешь.\n' +
  '- Для многошаговой задачи (3+ шага) вызови update_plan со списком шагов. ПЕРЕД ' +
  'началом каждого шага помечай его in_progress, по завершении — done (ровно один шаг ' +
  'in_progress за раз). План — живой трекер прогресса для пользователя, держи его актуальным.';

// Когда спрашивать пользователя, а когда действовать самому.
const INTERACTION_RULES =
  'ВЗАИМОДЕЙСТВИЕ:\n' +
  '- Действуй автономно: не переспрашивай по мелочам и очевидным вещам — выполняй задачу.\n' +
  '- Инструмент ask_user (кнопки выбора) используй РЕДКО и только при настоящей развилке, ' +
  'где твой выбор сильно меняет результат и его не угадать. Примеры уместного выбора: ' +
  'стек/технология при запросе «напиши программу/сайт» (напр. C++ / Python, Tailwind / ' +
  'обычный CSS, Electron / web, React / Vue — плюс «свой вариант»); стиль и тематика ' +
  'постройки; серверная или клиентская логика; удалять ли существующие объекты; жанр игры. ' +
  'Дай 2–4 коротких варианта (allowOther оставь true). Не задавай больше одного вопроса ' +
  'подряд и не спрашивай то, что уже понятно из запроса — иначе просто делай.';

// Правило проверки фактов через браузер и справочник.
const KNOWLEDGE_RULES =
  'ЗНАНИЯ И ПРОВЕРКА:\n' +
  '- ПЕРЕД написанием или правкой Luau-кода ВСЕГДА вызывай luau_reference(topic) по ' +
  'нужной теме — даже если уверен. Это освежает актуальный API Roblox и снижает ошибки.\n' +
  '- Если не знаешь или не уверен в факте, актуальном API, asset id, ошибке — ' +
  'ОБЯЗАТЕЛЬНО используй web_search, затем web_fetch для деталей. Лучше проверить, ' +
  'чем выдумать. Не сочиняй несуществующие функции и id.\n' +
  '- При сомнении выбирай инструмент-проверку, а не догадку.';

// Экономия токенов — отдельное жёсткое правило. Главный пожиратель токенов это
// поиск по коду «вслепую» и чтение целых модулей. Направляем модель на дешёвые пути.
const ECONOMY_RULES =
  'ЭКОНОМИЯ ТОКЕНОВ (ВАЖНО):\n' +
  '- Ищешь ФИЧУ или поведение («где авторизация», «функция урона») — вызывай ' +
  'code_search (на ПК) или search_scripts (в Studio), НЕ grep_files и НЕ чтение всех ' +
  'файлов. Они сами расширяют запрос синонимами (auth↔login↔signin) и возвращают ' +
  'только нужные функции ЦЕЛИКОМ с путём и строками — править можно сразу там.\n' +
  '- grep_files/get_script_source применяй точечно, когда уже знаешь файл/символ. Не ' +
  'вычитывай весь модуль ради одной процедуры.\n' +
  '- Для структуры бери оглавление (get_studio_context, tree), а не полный дамп.\n' +
  '- Не повторяй один и тот же поиск/чтение — результат уже в истории.';

// Правила построек: главное — РЕАЛЬНЫЙ масштаб. Частая ошибка — строить мелко.
const BUILD_RULES =
  'ПОСТРОЙКИ И МАСШТАБ (важно!):\n' +
  '- Единица измерения — stud. Ориентиры реального масштаба: рост персонажа ≈ 5 studs, ' +
  'высота этажа/стен — 12–18 studs, дверной проём — ширина 7, высота 10, толщина стен — ' +
  '1–2 studs, ширина коридора — минимум 12–16 studs, комната — обычно от 30×30 studs.\n' +
  '- НЕ строй мелко: игрок должен свободно ходить внутри. Если сомневаешься в размере — ' +
  'бери КРУПНЕЕ. Просторное помещение лучше тесного. (Типичная ошибка — постройка в ' +
  'несколько раз меньше нужного: backrooms, дома, арены должны быть большими.)\n' +
  '- ВОРКФЛОУ постройки: 1) при необходимости спроси стиль через ask_user; 2) спроектируй ' +
  'plan_build (генплан вида сверху — зоны/комнаты/стены в studs, реальные размеры); ' +
  '3) для КОМНАТ/зданий используй build_room (плагин сам точно ставит пол, потолок, 4 ' +
  'стены и проёмы — не будет кривизны и щелей); для сложных форм — build_parts ОДНИМ ' +
  'батчем; 4) детализируй: материалы/текстуры через apply_surface, мебель, свет.\n' +
  '- Стены делай отдельными Part-сегментами по периметру (не один огромный блок), ' +
  'пол и потолок — плоскими плитами. Якори всё (anchored=true). Для backrooms: жёлтые ' +
  'стены (#C8B560), ковёр, низкий гул, мерцающие лампы, лабиринт коридоров 14–16 studs.\n' +
  '- «РЕАЛИСТИЧНЕЕ»/«красивее» = меняй МАТЕРИАЛЫ и добавляй ТЕКСТУРЫ/детали через ' +
  'apply_surface (кирпич, дерево, бетон, штукатурка, обои-текстура на стенах), добавляй ' +
  'мебель, плинтусы, окна, мелкие части. НЕ сводись к одному изменению освещения и НЕ ' +
  'перекрашивай свет в случайный цвет — свет лишь дополняет. Если просят реалистичные ' +
  'стены/обои — это apply_surface с материалом (и при необходимости текстурой), а не ' +
  'смена ClockTime/Ambient.';

const STUDIO_PROMPT =
  'РЕЖИМ: Roblox Studio подключён. Ты работаешь ВНУТРИ открытого плейса и меняешь ' +
  'живую сцену через мост. Иерархия: game → сервисы (Workspace, Players, ' +
  'ReplicatedStorage, ServerScriptService, StarterPlayer, StarterGui и т.д.).\n' +
  'Инструменты Studio: get_studio_context (оглавление дерева с path), ' +
  'get_instance_properties/set_properties, create_instance/delete_instance/' +
  'rename_instance/duplicate_instance, get_script_source/set_script_source, ' +
  'find_instances, select_instance, get_selection (выделенное пользователем), ' +
  'run_code (Lua в edit), insert_model (ассет по id), search_assets (поиск в тулбоксе), ' +
  'get_console_output, start_stop_play/run_script_in_play_mode, use_template.\n' +
  'СКРИПТИНГ (лучше спец-инструменты, а не run_code): write_script — создать ' +
  'новый скрипт с кодом в правильном сервисе; edit_script — точечно править ' +
  'существующий (oldText→newText) после get_script_source.\n' +
  'ПОСТРОЙКИ: plan_build (генплан) → build_room (точные комнаты) / build_parts (батч) ' +
  'по правилам масштаба ниже; apply_surface для материалов/текстур (реалистичность).\n' +
  'АНИМАЦИИ И КИНО: tween_instance (плавная анимация свойств — двери, платформы, ' +
  'эффекты), create_cutscene (кинематографичный облёт камеры по кадрам), play_animation ' +
  '(анимации Humanoid). Делай катсцены красивыми: 3–6 плавных кадров камеры.\n' +
  'ЛАНДШАФТ/ПЕРСОНАЖИ: fill_terrain (воксельный Terrain — горы, вода, песок; operation ' +
  '"cut" вырезает), clear_terrain; create_npc (готовый риг R6/R15 с Humanoid); ' +
  'apply_character_skin (одежда/цвета/аксессуары/лицо на персонажа); focus_camera (навести ' +
  'камеру на объект перед take_screenshot). ИСТОРИЯ: undo/redo — твои правки откатываются ' +
  '(каждое действие = одна точка отмены, можно безопасно экспериментировать).\n' +
  'СКИН ПО СКРИНШОТУ/ОПИСАНИЮ: если пользователь дал картинку персонажа или описал образ — ' +
  'разгляди цвета тела и одежду, подбери каталожные asset id через search_assets ' +
  '(assetType "image"/"decal" — одежда, "model" — аксессуары/шляпы), затем примени всё одним ' +
  'apply_character_skin. Нет рига — сперва create_npc. Цвета задавай hex "#RRGGBB".\n' +
  'ГЛУБОКОЕ ПОНИМАНИЕ ROBLOX (соблюдай как эксперт):\n' +
  '- Клиент-сервер: серверный Script видит всё и авторитетен; LocalScript работает только ' +
  'у игрока (ввод, камера, UI, локальные эффекты). Связь между ними — ТОЛЬКО через ' +
  'RemoteEvent/RemoteFunction в ReplicatedStorage. НИКОГДА не доверяй клиенту в вопросах ' +
  'урона/валюты/очков — проверяй и считай на сервере (анти-чит культура).\n' +
  '- Персонаж: Humanoid + HumanoidRootPart; ходьбу/прыжок меняй через WalkSpeed/JumpPower/' +
  'JumpHeight; части тела R6 ("Torso","Left Arm"…) и R15 (MeshPart "UpperTorso"…) различай.\n' +
  '- Сохранение данных — DataStoreService (только сервер; pcall вокруг GetAsync/SetAsync, ' +
  'ретраи, кэш в памяти; учитывай лимиты запросов). Атрибуты (SetAttribute) и ' +
  'CollectionService-теги — для лёгких данных и систем «на тегах».\n' +
  '- Производительность: не плоди соединения событий без :Disconnect(); тяжёлое — пакетно; ' +
  'физические объекты якори (Anchored), если не нужна симуляция; не дёргай свойства в цикле.\n' +
  '- Частые ошибки, которых избегай: WaitForChild для ещё не реплицированного; правка ' +
  'StarterGui/StarterPlayer не меняет уже заспавненного игрока; забытый task.wait в циклах ' +
  '(зависание); деление логики не по тому сервису.\n' +
  'Ты умеешь работать со ВСЕМ Studio: скрипты, модели, части, UI, физика, свойства, ' +
  'вставка готовых моделей из тулбокса (search_assets → insert_model), дублирование.\n' +
  'АССЕТЫ: подбирай их САМ через search_assets (модели/декали/звуки) и предлагай ' +
  'пользователю — он увидит карточки с превью (модели) или плеером (звуки) и сможет ' +
  'выбрать/заменить. Для атмосферы реально ищи и вставляй звук (search_assets ' +
  'assetType=audio → add_sound). ЗВУК: ставь умеренную громкость (add_sound volume ' +
  '0.2–0.5, НЕ выше без причины — сырые ассеты очень громкие); регулируй уже ' +
  'добавленные через set_sound_volume (можно «тише всё» без path).\n' +
  'ГЛАВНОЕ: создавай ПОСТОЯННЫЕ объекты, сохраняющиеся в плейсе:\n' +
  '- управление/ввод/камера → "LocalScript" в StarterPlayer.StarterPlayerScripts;\n' +
  '- логика персонажа → StarterCharacterScripts;\n' +
  '- серверная логика (урон, спавны, очки, DataStore) → "Script" в ServerScriptService;\n' +
  '- общие модули → "ModuleScript" в ReplicatedStorage; RemoteEvent — в ReplicatedStorage.\n' +
  'Давай осмысленные .Name, проверяй FindFirstChild, обновляй .Source существующего, ' +
  'а не плоди дубли. Для точечных правок предпочитай set_properties/set_script_source ' +
  'вместо run_code. Экономь токены: бери get_studio_context (оглавление), а не весь код.';

const PC_PROMPT =
  'РЕЖИМ: Roblox Studio не подключён — ты работаешь как агент на ПК пользователя ' +
  'Доступны ПК-инструменты: run_command (powershell/cmd/bash), ' +
  'read_file, write_file, edit_file, list_dir, make_dir, glob_files, grep_files, tree.\n' +
  'Расширенные возможности ПК:\n' +
  '- Фоновые/долгие процессы: run_background (сервер, dev, watcher) — не блокирует; ' +
  'читай вывод process_output, отвечай на запросы программ через process_input ' +
  '(y/n, npm init), останавливай process_stop, список — process_list.\n' +
  '- take_screenshot (увидеть экран), clipboard_read/clipboard_write (буфер), ' +
  'notify (уведомление), download_file (скачать бинарь), reg_query/reg_set (реестр).\n' +
  '- git (status/diff/log/branch) — безопасный обзор; launch_app, focus_window, ' +
  'send_keys — запуск GUI и ввод в окна.\n' +
  '- run_code_sandbox — РЕАЛЬНО исполни код (js/python/lua/bash/powershell) и проверь ' +
  'вывод вместо проверки «в уме». Для Lua/Luau рантайм ставится АВТОМАТИЧЕСКИ при первом ' +
  'запуске (или вызови install_runtime); для Roblox-API нужен подключённый Studio (run_code).\n' +
  'Решай любые задачи на компьютере автономно: разбивай на шаги и проверяй результат. ' +
  'Перед правкой файла читай его. Опасные/необратимые действия (удаление, reg_set, ' +
  'форматирование) — только по явной просьбе.';

const NOTOOLS_PROMPT =
  'РЕЖИМ: ни Studio, ни ПК-инструменты недоступны. Доступен только браузер ' +
  '(web_search/web_fetch) и справочник. Помоги советом и кодом; чтобы вносить ' +
  'изменения в игру — попроси пользователя подключить плагин Rublox в Studio.';

// Уровни «мышления». Названия типизированные (Min/Low/High/Max), не переводятся.
// budget — бюджет reasoning-токенов (для thinking-моделей),
// effort — поле для OpenAI reasoning_effort, temperature — запасной маппинг.
export const THINKING_LEVELS = {
  min: { label: 'Min', budget: 0, effort: 'minimal', temperature: 0.2 },
  low: { label: 'Low', budget: 2048, effort: 'low', temperature: 0.4 },
  high: { label: 'High', budget: 6144, effort: 'high', temperature: 0.8 },
  max: { label: 'Max', budget: 16384, effort: 'high', temperature: 1 },
};

// Экономия токенов: давние «болтливые» tool-результаты (навигация по дереву,
// чтение файлов, веб, консоль, поиск) модели уже не нужны дословно — она их
// прочитала и пошла дальше. В истории они висят на КАЖДОМ следующем шаге и жгут
// токены кратно. Схлопываем такие результаты СТАРШЕ последних N сообщений в
// короткую заглушку. Свежие (хвост) оставляем как есть — они ещё в работе.
const VERBOSE_TOOLS = new Set([
  'get_studio_context', 'get_file_data', 'tree', 'read_file', 'read_lines',
  'web_fetch', 'web_search', 'get_console_output', 'find_instances',
  'grep_files', 'glob_files', 'search_assets', 'process_output', 'get_children',
  'get_script_source', 'code_search', 'search_scripts',
]);
const PRUNE_KEEP_TAIL = 8;     // последние сообщения не трогаем
const PRUNE_MIN_LEN = 400;     // короткие результаты схлопывать нет смысла

function pruneOldToolResults(messages) {
  if (!Array.isArray(messages) || messages.length <= PRUNE_KEEP_TAIL) return messages;
  const cutoff = messages.length - PRUNE_KEEP_TAIL;
  return messages.map((m, i) => {
    if (i >= cutoff) return m;
    if (m.role === 'tool' && VERBOSE_TOOLS.has(m.name) &&
        typeof m.content === 'string' && m.content.length > PRUNE_MIN_LEN) {
      return { ...m, content: `(результат ${m.name} свёрнут для экономии токенов — ` +
        `${m.content.length} симв. Повтори вызов, если снова нужны детали.)` };
    }
    return m;
  });
}

export class Session {
  constructor(id) {
    this.id = id;
    this.title = 'Новый чат';
    this.titleManual = false; // переименован ли пользователем вручную
    this.provider = config.provider;
    this.model = config.model;
    this.thinking = 'high';
    this.messages = [];
    this.summary = '';
    this.contextNotes = [];
    this.systemPersona = '';
    this.createdAt = null;
    this._restore();
  }

  _restore() {
    const data = loadSessionData(this.id);
    if (!data) return;
    this.title = data.title || this.title;
    this.titleManual = !!data.titleManual;
    this.provider = data.provider || this.provider;
    this.model = data.model || this.model;
    this.thinking = data.thinking || this.thinking;
    this.messages = Array.isArray(data.messages) ? data.messages : [];
    this.summary = data.summary || '';
    this.contextNotes = Array.isArray(data.contextNotes) ? data.contextNotes : [];
    this.systemPersona = data.systemPersona || '';
    this.createdAt = data.createdAt || null;
  }

  persist() {
    saveSession(this);
  }

  thinkingConfig() {
    return THINKING_LEVELS[this.thinking] || THINKING_LEVELS.high;
  }

  systemPrompt({ studioConnected = false, pcAllowed = false } = {}) {
    const mode = studioConnected ? STUDIO_PROMPT : pcAllowed ? PC_PROMPT : NOTOOLS_PROMPT;
    const parts = [CORE_PROMPT, mode];
    // Правила построек и масштаба нужны только когда можем строить (Studio).
    if (studioConnected) parts.push(BUILD_RULES);
    parts.push(FORMAT_RULES, INTERACTION_RULES, KNOWLEDGE_RULES, ECONOMY_RULES);
    let p = parts.join('\n\n');
    // Самоосознание: ИИ точно знает, какая он модель и где работает.
    p += `\n\nТЫ СЕЙЧАС: модель «${this.model || 'не выбрана'}» через провайдера ` +
      `«${this.provider || 'не выбран'}». Ты — оболочка Rublox поверх этой модели. ` +
      'Если спросят, какая ты модель — отвечай именно так, не выдумывай другое имя.';
    // Контекст активного проекта — общая память во всех чатах.
    const proj = projectPromptBlock();
    if (proj) p += `\n\n${proj}`;
    // Активные ИИ-плагины (скиллы) подмешивают свои инструкции в поведение.
    const skills = activeSkillPrompts();
    if (skills.length) p += `\n\nАКТИВНЫЕ НАВЫКИ:\n${skills.join('\n')}`;
    if (this.systemPersona) p += `\n\nРоль: ${this.systemPersona}`;
    if (this.summary) p += `\n\nРезюме предыдущего диалога:\n${this.summary}`;
    if (this.contextNotes.length)
      p += `\n\nКонтекст проекта:\n- ${this.contextNotes.join('\n- ')}`;
    return p;
  }

  addUser(text, images) {
    const m = { role: 'user', content: text };
    // images: [{ mediaType, data(base64) }] — для vision-моделей.
    if (Array.isArray(images) && images.length) m.images = images;
    this.messages.push(m);
  }

  addAssistant(text, toolCalls) {
    this.messages.push({ role: 'assistant', content: text || '', toolCalls: toolCalls || [] });
  }

  addToolResult(toolCallId, name, content) {
    this.messages.push({ role: 'tool', toolCallId, name, content });
  }

  getCompiledMessages() {
    return pruneOldToolResults(this.messages);
  }

  setProvider(provider) {
    const p = getProvider(provider);
    if (!p) return false;
    this.provider = provider;
    if (p.model) this.model = p.model;
    return true;
  }

  setModel(model) {
    this.model = model;
  }

  setThinking(level) {
    if (!THINKING_LEVELS[level]) return false;
    this.thinking = level;
    return true;
  }

  // Агрессивная компрессия ради экономии токенов: при превышении порога
  // оставляем только хвост и наращиваем тезисное резюме.
  async maybeCompress() {
    const tokens = estimateMessagesTokens(this.messages);
    if (tokens < config.compressThreshold) return false;
    const keep = 4;
    if (this.messages.length <= keep) return false;
    const old = this.messages.slice(0, this.messages.length - keep);
    const recent = this.messages.slice(this.messages.length - keep);
    const newSummary = await summarizeMessages(this, old);
    this.summary = this.summary ? `${this.summary}\n${newSummary}` : newSummary;
    this.messages = recent;
    return true;
  }

  reset() {
    this.messages = [];
    this.summary = '';
    this.contextNotes = [];
    this.persist();
  }

  info() {
    return {
      id: this.id,
      title: this.title,
      provider: this.provider,
      model: this.model,
      thinking: this.thinking,
      messages: this.messages.length,
      tokens: estimateMessagesTokens(this.messages),
      hasSummary: !!this.summary,
    };
  }

  // История в виде сообщений для UI: user / assistant / tool.
  uiMessages() {
    const out = [];
    for (const m of this.messages) {
      if (m.role === 'user') {
        out.push({ role: 'user', text: m.content, images: m.images || undefined });
      } else if (m.role === 'assistant') {
        if (m.content) out.push({ role: 'assistant', text: m.content });
        for (const tc of m.toolCalls || []) {
          out.push({ role: 'tool', text: `→ ${tc.name}(${JSON.stringify(tc.args || {})})` });
        }
      } else if (m.role === 'tool') {
        out.push({ role: 'tool', text: `← ${m.name}: ${m.content}` });
      }
    }
    return out;
  }

  rename(title) {
    this.title = String(title || '').trim().slice(0, 60) || this.title;
    this.titleManual = true;
    this.persist();
  }

  // Авто-заголовок по теме (через LLM), если не переименован вручную.
  async autoTitle() {
    if (this.titleManual) return false;
    // Только ОДИН раз: пока заголовок дефолтный. После переименования не трогаем.
    if (this.title && this.title !== 'Новый чат') return false;
    if (this.messages.length < 2) return false;
    const firstUser = this.messages.find((m) => m.role === 'user');
    if (!firstUser) return false;
    // Фолбэк-заголовок из первых слов сообщения (на случай мусора от модели).
    const fallback = String(firstUser.content || '')
      .replace(/\s+/g, ' ').trim().slice(0, 40) || 'Чат';
    try {
      const reply = await complete({
        provider: this.provider,
        system: 'Придумай короткий заголовок чата (3-5 слов, без кавычек и точки) ' +
          'по теме первого сообщения. Ответь ТОЛЬКО заголовком, без пояснений, ' +
          'без кода и без тегов.',
        messages: [{ role: 'user', content: firstUser.content.slice(0, 500) }],
        model: this.model,
        temperature: 0.3,
        useTools: false,
      });
      let t = String(reply.text || '')
        .replace(/<[^>]*>/g, ' ')              // любые теги/XML (function_calls и пр.)
        .replace(/[`*_#>{}\[\]]/g, ' ')        // markdown-мусор
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^["'«»\-:]+|["'«».:\-]+$/g, '')
        .slice(0, 50)
        .trim();
      // Если модель выдала мусор (осталась разметка, пусто, слишком коротко) — фолбэк.
      if (!t || t.length < 2 || /[<>]/.test(t)) t = fallback;
      this.title = t;
      this.persist();
      return true;
    } catch {
      this.title = fallback;
      this.persist();
      return true;
    }
  }
}

// ── Менеджер мультичатов ───────────────────────────────
const sessions = new Map();

export function getSession(id = 'default') {
  if (!sessions.has(id)) sessions.set(id, new Session(id));
  return sessions.get(id);
}

export function createSession() {
  // id на основе счётчика существующих, без Date.now (детерминированно).
  const ids = new Set([...sessions.keys(), ...listSessionIds()]);
  let n = 1;
  let id = `chat-${n}`;
  while (ids.has(id)) id = `chat-${++n}`;
  const s = new Session(id);
  s.persist();
  sessions.set(id, s);
  return s;
}

export function deleteSession(id) {
  sessions.delete(id);
  return deleteSessionFile(id);
}

// Список всех чатов (с диска + активные в памяти) для сайдбара.
export function listSessions() {
  const ids = new Set([...sessions.keys(), ...listSessionIds()]);
  const out = [];
  for (const id of ids) {
    const data = sessions.has(id) ? sessions.get(id).info() : summaryFromDisk(id);
    if (data) out.push(data);
  }
  // Сначала по createdAt (если есть), иначе по id.
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

function summaryFromDisk(id) {
  const d = loadSessionData(id);
  if (!d) return null;
  return {
    id,
    title: d.title || id,
    provider: d.provider,
    model: d.model,
    thinking: d.thinking || 'high',
    messages: Array.isArray(d.messages) ? d.messages.length : 0,
  };
}
