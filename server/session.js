// Управление сессиями (чатами): история, модель, уровень мышления, компрессия.

import { config } from './config.js';
import { estimateMessagesTokens, summarizeMessages } from './context.js';
import { getProvider } from './llm/registry.js';
import { complete } from './llm/providers.js';
import { saveSession, loadSessionData, deleteSessionFile, listSessionIds } from './store.js';

const BASE_PROMPT =
  'Ты — Rublox, AI-ассистент, встроенный в Roblox Studio через плагин. ' +
  'Ты работаешь ВНУТРИ редактора Roblox Studio на компьютере пользователя: ' +
  'через мост (long-poll) ты выполняешь Lua прямо в его открытом игровом ' +
  'месте (place). Ты НЕ облачный бот и НЕ генератор файлов — ты редактируешь ' +
  'живую сцену. Твоя задача — помогать делать игры на платформе Roblox: ' +
  'геймплей, скрипты на Luau, объекты, UI.\n\n' +
  'ОКРУЖЕНИЕ: иерархия game → сервисы (Workspace, Players, ReplicatedStorage, ' +
  'ServerScriptService, StarterPlayer, StarterGui и т.д.). Язык — Luau (Roblox Lua). ' +
  'Инструменты, если плагин подключён: run_code (Lua в edit-режиме), insert_model ' +
  '(ассет каталога), get_console_output, get_studio_context (оглавление дерева), ' +
  'start_stop_play / run_script_in_play_mode (плей-тест), use_template (готовые блоки).\n\n' +
  'ГЛАВНОЕ ПРАВИЛО: ты редактируешь УЖЕ ОТКРЫТЫЙ плейс изнутри. Когда просят ' +
  'добавить механику (управление, спринт, способности, интерфейс), создавай ' +
  'ПОСТОЯННЫЕ объекты-скрипты в нужных сервисах через run_code, чтобы они ' +
  'сохранились в плейсе и работали при запуске Play:\n' +
  '- ввод/управление (клавиши, спринт, прыжки, камера) → "LocalScript" в ' +
  'game.StarterPlayer.StarterPlayerScripts;\n' +
  '- логика персонажа → StarterCharacterScripts;\n' +
  '- серверная логика (урон, спавны, очки) → "Script" в ServerScriptService;\n' +
  '- общие модули → "ModuleScript" в ReplicatedStorage.\n' +
  'Давай скрипту осмысленное .Name, проверяй FindFirstChild, при повторном ' +
  'запросе обновляй .Source существующего, а не плоди дубли. НЕ выполняй разовый ' +
  'код, который сработает один раз и исчезнет.\n\n' +
  'Если задача большая — сначала кратко составь план списком (маркеры "- "), ' +
  'затем выполняй по пунктам. Для частых задач проверь use_template — экономит токены. ' +
  'Экономь токены: запрашивай get_studio_context (оглавление), а не весь код. ' +
  'Оформляй ответ markdown: **жирный**, списки, `инлайн-код`, блоки ```lua ... ```.';

// Уровни «мышления». Названия типизированные (Min/Low/High/Max), не переводятся.
// budget — бюджет reasoning-токенов (для thinking-моделей),
// effort — поле для OpenAI reasoning_effort, temperature — запасной маппинг.
export const THINKING_LEVELS = {
  min: { label: 'Min', budget: 0, effort: 'minimal', temperature: 0.2 },
  low: { label: 'Low', budget: 2048, effort: 'low', temperature: 0.4 },
  high: { label: 'High', budget: 6144, effort: 'high', temperature: 0.8 },
  max: { label: 'Max', budget: 16384, effort: 'high', temperature: 1 },
};

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

  systemPrompt() {
    let p = BASE_PROMPT;
    if (this.systemPersona) p += `\n\nРоль: ${this.systemPersona}`;
    if (this.summary) p += `\n\nРезюме предыдущего диалога:\n${this.summary}`;
    if (this.contextNotes.length)
      p += `\n\nКонтекст проекта:\n- ${this.contextNotes.join('\n- ')}`;
    return p;
  }

  addUser(text) {
    this.messages.push({ role: 'user', content: text });
  }

  addAssistant(text, toolCalls) {
    this.messages.push({ role: 'assistant', content: text || '', toolCalls: toolCalls || [] });
  }

  addToolResult(toolCallId, name, content) {
    this.messages.push({ role: 'tool', toolCallId, name, content });
  }

  getCompiledMessages() {
    return this.messages;
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
        out.push({ role: 'user', text: m.content });
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
    if (this.messages.length < 2) return false;
    const firstUser = this.messages.find((m) => m.role === 'user');
    if (!firstUser) return false;
    try {
      const reply = await complete({
        provider: this.provider,
        system: 'Придумай короткий заголовок чата (3-5 слов, без кавычек и точки) ' +
          'по теме первого сообщения. Ответь только заголовком.',
        messages: [{ role: 'user', content: firstUser.content.slice(0, 500) }],
        model: this.model,
        temperature: 0.3,
        useTools: false,
      });
      const t = (reply.text || '').trim().replace(/^["'«»]+|["'«».]+$/g, '').slice(0, 60);
      if (t) {
        this.title = t;
        this.persist();
        return true;
      }
    } catch {
      // молча оставляем дефолтный заголовок
    }
    return false;
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
