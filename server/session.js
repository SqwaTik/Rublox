// Управление сессиями (чатами): история, модель, уровень мышления, компрессия.

import { config } from './config.js';
import { estimateMessagesTokens, summarizeMessages } from './context.js';
import { getProvider } from './llm/registry.js';
import { saveSession, loadSessionData, deleteSessionFile, listSessionIds } from './store.js';

const BASE_PROMPT =
  'Ты — AI-ассистент для разработки игр в Roblox Studio. ' +
  'Помогаешь проектировать геймплей и пишешь Lua-код. ' +
  'Когда подключён плагин Studio, используй инструменты (run_code, insert_model, ' +
  'get_console_output, get_studio_context, start_stop_play, run_script_in_play_mode) ' +
  'для реальных изменений в открытом плейсе. ' +
  '\n\nГЛАВНОЕ ПРАВИЛО: ты редактируешь УЖЕ ОТКРЫТЫЙ плейс изнутри, а не генерируешь ' +
  'внешние файлы. Когда тебя просят добавить игровую механику (управление, спринт, ' +
  'способности, интерфейс), создавай ПОСТОЯННЫЕ объекты-скрипты в нужных сервисах ' +
  'через run_code, чтобы они сохранились в плейсе и работали при запуске:\n' +
  '- ввод/управление игроком (клавиши, спринт, прыжки, камера) → создай Instance ' +
  '"LocalScript" в game.StarterPlayer.StarterPlayerScripts;\n' +
  '- логика персонажа в StarterCharacterScripts при необходимости;\n' +
  '- серверная логика (урон, спавны, очки, события) → "Script" в ServerScriptService;\n' +
  '- общие модули → "ModuleScript" в ReplicatedStorage.\n' +
  'Задавай скрипту осмысленное .Name, проверяй, нет ли уже такого (FindFirstChild), ' +
  'и при повторном запросе обновляй .Source существующего, а не плоди дубли. ' +
  'НЕ выполняй разовый код, который сработает один раз и исчезнет — пользователь ' +
  'хочет, чтобы механика осталась в игре после нажатия Play.\n\n' +
  'Пример: «спринт на Left Shift» → создать LocalScript в StarterPlayerScripts, ' +
  'который через UserInputService меняет Humanoid.WalkSpeed на Shift.\n\n' +
  'Для частых задач (платформер, NPC, гонка, лидерборд, сбор предметов) сначала ' +
  'проверь инструмент use_template — это экономит токены. ' +
  'Экономь токены: сначала запрашивай get_studio_context (оглавление), ' +
  'а не весь код. Используй markdown: **жирный**, списки, `инлайн-код` и блоки ' +
  '```lua ... ``` для кода. Отвечай по-русски, по делу, без воды.';

// Уровни «мышления». budget — бюджет reasoning-токенов (для thinking-моделей),
// effort — поле для OpenAI reasoning_effort, temperature — запасной маппинг.
export const THINKING_LEVELS = {
  minimal: { label: 'Минимум', budget: 0, effort: 'low', temperature: 0.2 },
  low: { label: 'Низкий', budget: 2048, effort: 'low', temperature: 0.4 },
  medium: { label: 'Средний', budget: 6144, effort: 'medium', temperature: 0.7 },
  high: { label: 'Глубокий', budget: 12288, effort: 'high', temperature: 1 },
};

export class Session {
  constructor(id) {
    this.id = id;
    this.title = 'Новый чат';
    this.provider = config.provider;
    this.model = config.model;
    this.thinking = 'medium';
    this.messages = [];
    this.summary = '';
    this.contextNotes = [];
    this.systemPersona = '';
    this.createdAt = null; // проставится при первом сохранении
    this._restore();
  }

  _restore() {
    const data = loadSessionData(this.id);
    if (!data) return;
    this.title = data.title || this.title;
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
    return THINKING_LEVELS[this.thinking] || THINKING_LEVELS.medium;
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
    // Автозаголовок по первому сообщению пользователя.
    if (this.title === 'Новый чат' && text.trim()) {
      this.title = text.trim().slice(0, 40);
    }
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
    thinking: d.thinking || 'medium',
    messages: Array.isArray(d.messages) ? d.messages.length : 0,
  };
}
