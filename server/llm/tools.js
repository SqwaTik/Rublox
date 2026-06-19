// Канонические описания инструментов (tools), которые LLM может вызывать.
// Каждый провайдер переводит их в свой формат.
export const TOOLS = [
  {
    name: 'run_code',
    description:
      'Выполнить произвольный Lua-код в Roblox Studio (edit-режим). ' +
      'Используй для создания объектов, настройки сцены, написания и вставки скриптов. ' +
      'Возвращает результат выполнения и вывод print().',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Lua-код для выполнения.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'insert_model',
    description:
      'Вставить модель/ассет из каталога Roblox по его asset id в Workspace.',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'number', description: 'Числовой ID ассета каталога.' },
        parent: {
          type: 'string',
          description: 'Куда вставить, напр. "Workspace". По умолчанию Workspace.',
        },
      },
      required: ['assetId'],
    },
  },
  {
    name: 'get_console_output',
    description: 'Получить последние строки вывода консоли Studio (логи print/warn/error).',
    parameters: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: 'Сколько последних строк вернуть (по умолчанию 50).' },
      },
    },
  },
  {
    name: 'get_studio_context',
    description:
      'Получить краткую структуру текущего place: сервисы, объекты и скрипты (оглавление проекта). ' +
      'Используй это вместо запроса всего кода, чтобы экономить токены.',
    parameters: {
      type: 'object',
      properties: {
        depth: { type: 'number', description: 'Глубина обхода дерева (по умолчанию 2).' },
      },
    },
  },
  {
    name: 'start_stop_play',
    description:
      'Запустить или остановить режим Play (тест игры) в Studio. ' +
      'action="start" — запустить плей-тест, action="stop" — остановить.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop'], description: 'start или stop.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'run_script_in_play_mode',
    description:
      'Выполнить Lua-код в запущенном режиме Play. По умолчанию на стороне сервера ' +
      '(context="server"), можно указать context="client" для локального игрока. ' +
      'Используй для проверки игровой логики во время теста.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Lua-код для выполнения в Play-режиме.' },
        context: {
          type: 'string',
          enum: ['server', 'client'],
          description: 'Где выполнять: server (по умолчанию) или client.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'use_template',
    description:
      'Подставить готовый Lua-шаблон из библиотеки вместо генерации кода с нуля — ' +
      'это экономит токены. Доступные id: platformer_character, npc_move_to, ' +
      'race_checkpoints, leaderboard_points, click_to_collect. ' +
      'Код шаблона будет выполнен в Studio (если подключён).',
    parameters: {
      type: 'object',
      properties: {
        templateId: { type: 'string', description: 'ID шаблона из библиотеки.' },
        params: {
          type: 'object',
          description: 'Параметры шаблона (зависят от шаблона), напр. { jumpPower: 60 }.',
        },
      },
      required: ['templateId'],
    },
  },
];

// Преобразование в формат Anthropic.
export function toolsForAnthropic() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

// Преобразование в формат OpenAI (function calling).
export function toolsForOpenAI() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
