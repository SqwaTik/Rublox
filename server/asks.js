// Реестр ожидающих вопросов к пользователю (инструмент ask_user).
//
// Агент вызывает ask_user → создаётся «ожидание» по chatId, во фронт уходит
// событие с кнопками, агент висит на Promise. Пользователь жмёт кнопку (или
// пишет свой вариант) → WS-обработчик в index.js вызывает resolveAsk(), Promise
// разрешается, агент продолжает с выбранным ответом.

const pending = new Map(); // chatId -> { resolve, reject, timer, question }

// Поставить вопрос и дождаться ответа. Возвращает строку-ответ.
// signal — AbortSignal (кнопка Stop): прерывает ожидание.
export function waitForAnswer(chatId, question, { timeoutMs = 600000, signal } = {}) {
  // Если в этом чате уже висит вопрос — снимаем старый (берём последний).
  cancelAsk(chatId, 'Заменён новым вопросом.');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(chatId);
      resolve('(пользователь не ответил вовремя — действуй на своё усмотрение)');
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      pending.delete(chatId);
      resolve('(вопрос прерван пользователем)');
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    pending.set(chatId, { resolve, reject, timer, question, signal, onAbort });
  });
}

// Пользователь ответил (кнопкой или текстом).
export function resolveAsk(chatId, answer) {
  const p = pending.get(chatId);
  if (!p) return false;
  clearTimeout(p.timer);
  if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
  pending.delete(chatId);
  p.resolve(String(answer == null ? '' : answer));
  return true;
}

// Есть ли открытый вопрос в чате.
export function hasPendingAsk(chatId) {
  return pending.has(chatId);
}

// Снять вопрос (без ответа).
export function cancelAsk(chatId, reason = 'Отменено.') {
  const p = pending.get(chatId);
  if (!p) return false;
  clearTimeout(p.timer);
  if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
  pending.delete(chatId);
  p.resolve(reason);
  return true;
}
