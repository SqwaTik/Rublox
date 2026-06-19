// Утилиты компрессии контекста: оценка токенов, резюмирование старой истории,
// построение оглавления проекта.

import { complete } from './llm/providers.js';

// Грубая оценка токенов (≈4 символа на токен для смешанного текста).
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content || '');
    for (const tc of m.toolCalls || []) {
      total += estimateTokens(JSON.stringify(tc.args || {}));
    }
  }
  return total;
}

// Сворачивает массив старых сообщений в краткое резюме через LLM.
export async function summarizeMessages(session, messages) {
  const transcript = messages
    .map((m) => {
      if (m.role === 'tool') return `[инструмент ${m.name}] -> ${m.content}`;
      const tools = (m.toolCalls || [])
        .map((tc) => `вызов ${tc.name}(${JSON.stringify(tc.args)})`)
        .join('; ');
      return `${m.role}: ${m.content || ''}${tools ? ' | ' + tools : ''}`;
    })
    .join('\n');

  const reply = await complete({
    provider: session.provider,
    system:
      'Ты сжимаешь историю диалога между разработчиком и AI-ассистентом Roblox. ' +
      'Сохрани: принятые решения, созданные объекты/скрипты, важные параметры, ' +
      'нерешённые задачи. Отбрось вежливость и дубли. Ответь тезисами на русском.',
    messages: [{ role: 'user', content: `Сожми эту историю:\n\n${transcript}` }],
    model: session.model,
    temperature: 0.3,
    useTools: false,
  });
  return reply.text || '(резюме недоступно)';
}

// Строит краткое "оглавление" из сырого дерева Studio (для get_studio_context).
export function buildProjectIndex(tree) {
  const lines = [];
  const walk = (node, prefix) => {
    if (!node) return;
    const tag = node.className ? `[${node.className}]` : '';
    lines.push(`${prefix}${node.name} ${tag}`.trimEnd());
    for (const child of node.children || []) walk(child, prefix + '  ');
  };
  walk(tree, '');
  return lines.join('\n');
}
