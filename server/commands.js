// Обработчик слеш-команд чата. Возвращает { handled, reply } либо
// { handled:false } если это обычное сообщение для LLM.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { bridge } from './bridge.js';
import { listProviders, isKnownProvider } from './llm/registry.js';
import { listTemplates, renderTemplate } from './templates.js';

const execAsync = promisify(exec);

export const COMMAND_LIST = [
  'help', 'connect', 'disconnect', 'status', 'model', 'models', 'setmodel',
  'temp', 'persona', 'context', 'compact', 'reset', 'run', 'insert',
  'console', 'tree', 'play', 'stop', 'playrun', 'templates', 'template', 'local',
];

const HELP = [
  '/help — список команд',
  '/connect — статус подключения к Roblox Studio',
  '/disconnect — отключить плагин (включает локальный режим)',
  '/status — состояние сессии и соединения',
  '/models — список доступных провайдеров',
  '/model <id> — сменить провайдера (id из /models)',
  '/setmodel <имя> — задать имя модели у текущего провайдера',
  '/temp <0..2> — установить температуру',
  '/persona <текст> — задать роль (системный промпт)',
  '/context <текст> — добавить заметку в контекст проекта',
  '/compact — свернуть историю в резюме',
  '/reset — очистить историю сессии',
  '/run <lua> — выполнить Lua-код в Studio',
  '/insert <assetId> — вставить ассет из каталога',
  '/console — показать вывод консоли Studio',
  '/tree — оглавление текущего place',
  '/play — запустить Play-режим (по возможности)',
  '/stop — остановить Play-режим',
  '/playrun <lua> — выполнить код в Play-режиме',
  '/templates — список готовых шаблонов кода',
  '/template <id> [json-параметры] — вставить шаблон в Studio',
  '/local <команда> — выполнить команду на ПК (только при отключённом Roblox)',
].join('\n');

async function dispatchTool(tool, args) {
  try {
    const r = await bridge.dispatch(tool, args);
    return `Результат:\n${JSON.stringify(r, null, 2)}`;
  } catch (e) {
    return `Ошибка: ${e.message}`;
  }
}

export async function handleCommand(session, raw) {
  const text = raw.trim();
  if (!text.startsWith('/')) return { handled: false };

  const space = text.indexOf(' ');
  const cmd = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const arg = space === -1 ? '' : text.slice(space + 1).trim();

  switch (cmd) {
    case '/help':
      return { handled: true, reply: HELP };

    case '/connect': {
      const s = bridge.status();
      return {
        handled: true,
        reply: s.connected
          ? `Roblox Studio подключён.${s.studioInfo?.placeName ? ' Place: ' + s.studioInfo.placeName : ''}`
          : 'Плагин не подключён. Откройте плагин в Studio и нажмите Connect.',
      };
    }

    case '/disconnect':
      bridge.markDisconnected();
      return { handled: true, reply: 'Соединение с Roblox сброшено. Активен локальный режим.' };

    case '/status':
      return {
        handled: true,
        reply:
          `Сессия: ${JSON.stringify(session.info())}\n` +
          `Roblox: ${JSON.stringify(bridge.status())}`,
      };

    case '/models': {
      const list = listProviders()
        .map((p) => `${p.id === session.provider ? '▸' : ' '} ${p.id} — ${p.label} (${p.model || '—'})${p.ready ? '' : ' [нет ключа]'}`)
        .join('\n');
      return { handled: true, reply: `Провайдеры:\n${list}` };
    }

    case '/model': {
      const p = arg.toLowerCase();
      if (!p) return { handled: true, reply: 'Укажите id провайдера. /models — список.' };
      if (!isKnownProvider(p))
        return { handled: true, reply: `Провайдер "${p}" не найден. /models — список.` };
      session.setProvider(p);
      return { handled: true, reply: `Провайдер: ${p}, модель: ${session.model}` };
    }

    case '/setmodel': {
      if (!arg) return { handled: true, reply: 'Укажите имя модели.' };
      session.setModel(arg);
      return { handled: true, reply: `Модель: ${session.model} (провайдер ${session.provider})` };
    }

    case '/temp': {
      const t = Number(arg);
      if (Number.isNaN(t) || t < 0 || t > 2)
        return { handled: true, reply: 'Температура должна быть числом 0..2' };
      session.temperature = t;
      return { handled: true, reply: `Температура: ${t}` };
    }

    case '/persona':
      session.systemPersona = arg;
      return { handled: true, reply: arg ? `Роль установлена: ${arg}` : 'Роль сброшена.' };

    case '/context':
      if (!arg) return { handled: true, reply: 'Укажите текст заметки.' };
      session.contextNotes.push(arg);
      return { handled: true, reply: 'Заметка добавлена в контекст.' };

    case '/compact': {
      const did = await session.maybeCompress();
      return { handled: true, reply: did ? 'История свёрнута в резюме.' : 'Сворачивать пока нечего.' };
    }

    case '/reset':
      session.reset();
      return { handled: true, reply: 'История сессии очищена.' };

    case '/run':
      if (!arg) return { handled: true, reply: 'Укажите Lua-код.' };
      return { handled: true, reply: await dispatchTool('run_code', { code: arg }) };

    case '/insert': {
      const id = Number(arg);
      if (!id) return { handled: true, reply: 'Укажите числовой assetId.' };
      return { handled: true, reply: await dispatchTool('insert_model', { assetId: id, parent: 'Workspace' }) };
    }

    case '/console':
      return { handled: true, reply: await dispatchTool('get_console_output', { lines: 50 }) };

    case '/tree':
      return { handled: true, reply: await dispatchTool('get_studio_context', { depth: 2 }) };

    case '/play':
      return { handled: true, reply: await dispatchTool('start_stop_play', { action: 'start' }) };

    case '/stop':
      return { handled: true, reply: await dispatchTool('start_stop_play', { action: 'stop' }) };

    case '/playrun':
      if (!arg) return { handled: true, reply: 'Укажите Lua-код для Play-режима.' };
      return { handled: true, reply: await dispatchTool('run_script_in_play_mode', { code: arg, context: 'server' }) };

    case '/templates': {
      const list = listTemplates()
        .map((t) => {
          const ps = Object.keys(t.params).length ? ` [${Object.keys(t.params).join(', ')}]` : '';
          return `• ${t.id} — ${t.title}${ps}`;
        })
        .join('\n');
      return { handled: true, reply: `Шаблоны кода:\n${list}\n\nПрименить: /template <id> {"параметр":значение}` };
    }

    case '/template': {
      if (!arg) return { handled: true, reply: 'Укажите id шаблона. /templates — список.' };
      const sp = arg.indexOf(' ');
      const id = sp === -1 ? arg : arg.slice(0, sp);
      let params = {};
      if (sp !== -1) {
        try {
          params = JSON.parse(arg.slice(sp + 1));
        } catch {
          return { handled: true, reply: 'Параметры должны быть JSON, напр.: /template platformer_character {"jumpPower":60}' };
        }
      }
      let code;
      try {
        code = renderTemplate(id, params);
      } catch (e) {
        return { handled: true, reply: e.message };
      }
      if (!bridge.isConnected()) {
        return { handled: true, reply: `Studio не подключён. Код шаблона:\n${code}` };
      }
      return { handled: true, reply: await dispatchTool('run_code', { code }) };
    }

    case '/local': {
      if (bridge.isConnected())
        return { handled: true, reply: 'Сначала /disconnect — локальный режим конфликтует с Roblox.' };
      if (!config.allowLocalExec)
        return { handled: true, reply: 'Локальное выполнение отключено (ALLOW_LOCAL_EXEC=false в .env).' };
      if (!arg) return { handled: true, reply: 'Укажите команду.' };
      try {
        const { stdout, stderr } = await execAsync(arg, { timeout: 15000 });
        return { handled: true, reply: `stdout:\n${stdout}\nstderr:\n${stderr}` };
      } catch (e) {
        return { handled: true, reply: `Ошибка: ${e.message}` };
      }
    }

    default:
      return { handled: true, reply: `Неизвестная команда ${cmd}. /help — список.` };
  }
}
