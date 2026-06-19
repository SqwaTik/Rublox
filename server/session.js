// Управление сессией чата: история, настройки модели, компрессия контекста.

import { config } from './config.js';
import { estimateMessagesTokens, summarizeMessages } from './context.js';
import { getProvider } from './llm/registry.js';
import { saveSession, loadSessionData } from './store.js';

const BASE_PROMPT =
  'Ты — AI-ассистент для разработки игр в Roblox Studio. ' +
  'Помогаешь проектировать геймплей и пишешь Lua-код. ' +
  'Когда подключён плагин Studio, используй инструменты (run_code, insert_model, ' +
  'get_console_output, get_studio_context, start_stop_play, run_script_in_play_mode) ' +
  'для реальных изменений в сцене. ' +
  'Для частых задач (платформер, NPC, гонка, лидерборд, сбор предметов) сначала ' +
  'проверь инструмент use_template — это экономит токены. ' +
  'Экономь токены: сначала запрашивай get_studio_context (оглавление), ' +
  'а не весь код. Отвечай кратко, на русском, разбивай ответ на короткие абзацы.';

export class Session {
  constructor(id) {
    this.id = id;
    this.provider = config.provider;
    this.model = config.model;
    this.temperature = config.temperature;
    this.messages = []; // канонические сообщения
    this.summary = ''; // свёрнутая старая история
    this.contextNotes = []; // заметки из /context
    this.systemPersona = ''; // доп. системный промпт (роль)
    this._restore();
  }

  // Восстановление из файла, если есть сохранённое состояние.
  _restore() {
    const data = loadSessionData(this.id);
    if (!data) return;
    this.provider = data.provider || this.provider;
    this.model = data.model || this.model;
    this.temperature = typeof data.temperature === 'number' ? data.temperature : this.temperature;
    this.messages = Array.isArray(data.messages) ? data.messages : [];
    this.summary = data.summary || '';
    this.contextNotes = Array.isArray(data.contextNotes) ? data.contextNotes : [];
    this.systemPersona = data.systemPersona || '';
  }

  // Сохранить состояние на диск.
  persist() {
    saveSession(this);
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
    this.messages.push({
      role: 'assistant',
      content: text || '',
      toolCalls: toolCalls || [],
    });
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

  // Явно сменить модель (имя), не трогая провайдера.
  setModel(model) {
    this.model = model;
  }

  // Сворачивает старую историю, если превышен порог токенов.
  async maybeCompress() {
    const tokens = estimateMessagesTokens(this.messages);
    if (tokens < config.compressThreshold) return false;
    const keep = 6;
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
      provider: this.provider,
      model: this.model,
      temperature: this.temperature,
      messages: this.messages.length,
      tokens: estimateMessagesTokens(this.messages),
      hasSummary: !!this.summary,
    };
  }
}

const sessions = new Map();

export function getSession(id = 'default') {
  if (!sessions.has(id)) sessions.set(id, new Session(id));
  return sessions.get(id);
}
