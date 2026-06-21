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
      'Получить структуру текущего place: сервисы, объекты и скрипты (оглавление проекта). ' +
      'Для каждого узла возвращает name, className и path (полный путь вида ' +
      '"game.Workspace.Part") — путь используй в get_instance_properties / set_properties / ' +
      'delete_instance. Используй это вместо запроса всего кода, чтобы экономить токены.',
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
    name: 'get_instance_properties',
    description:
      'Прочитать свойства объекта в Explorer по его пути. Возвращает основные ' +
      'свойства (Name, ClassName, Parent) и читаемые значения (числа, строки, ' +
      'булевы, Vector3, Color3, UDim2, CFrame.Position и т.п.). Используй, чтобы ' +
      'узнать текущее состояние объекта перед изменением.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Путь к объекту, напр. "game.Workspace.Part" или "Workspace.Model.Humanoid".',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'set_properties',
    description:
      'Изменить одно или несколько свойств объекта в Explorer по пути. ' +
      'Значения передаются как есть: числа, строки, true/false; для типов Roblox ' +
      'используй строки-конструкторы, напр. "Vector3.new(0,5,0)", "Color3.fromRGB(255,0,0)", ' +
      '"UDim2.new(0,100,0,40)", "CFrame.new(0,10,0)", "Enum.Material.Neon".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту.' },
        properties: {
          type: 'object',
          description: 'Карта свойство→значение, напр. { "Anchored": true, "Size": "Vector3.new(4,1,2)" }.',
        },
      },
      required: ['path', 'properties'],
    },
  },
  {
    name: 'create_instance',
    description:
      'Создать новый объект (Instance) заданного класса и поместить его по пути-родителю. ' +
      'Можно сразу задать свойства. Возвращает путь созданного объекта.',
    parameters: {
      type: 'object',
      properties: {
        className: { type: 'string', description: 'Класс объекта, напр. "Part", "Folder", "PointLight", "Script".' },
        parent: { type: 'string', description: 'Путь к родителю, напр. "game.Workspace". По умолчанию Workspace.' },
        properties: {
          type: 'object',
          description: 'Необязательные начальные свойства (как в set_properties).',
        },
      },
      required: ['className'],
    },
  },
  {
    name: 'delete_instance',
    description:
      'Удалить объект из Explorer по его пути (вызывает :Destroy()). ' +
      'Используй осторожно — действие необратимо в рамках сессии.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту для удаления.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'rename_instance',
    description: 'Переименовать объект в Explorer по его пути.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту.' },
        newName: { type: 'string', description: 'Новое имя.' },
      },
      required: ['path', 'newName'],
    },
  },
  {
    name: 'get_script_source',
    description:
      'Прочитать исходный код скрипта (Script / LocalScript / ModuleScript) по пути. ' +
      'Используй перед правкой, чтобы увидеть текущий код.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к скрипту, напр. "game.ServerScriptService.Main".' },
      },
      required: ['path'],
    },
  },
  {
    name: 'set_script_source',
    description:
      'Полностью заменить исходный код скрипта по пути. Передавай весь новый код целиком. ' +
      'Так редактируй существующие скрипты вместо run_code.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к скрипту.' },
        source: { type: 'string', description: 'Новый исходный код Lua целиком.' },
      },
      required: ['path', 'source'],
    },
  },
  {
    name: 'find_instances',
    description:
      'Найти объекты по имени и/или классу во всём дереве place. Возвращает список ' +
      'с path для дальнейшей адресации. Удобно, когда точный путь неизвестен.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Подстрока имени (необязательно).' },
        className: { type: 'string', description: 'Класс или базовый класс, напр. "Part", "Script" (необязательно).' },
        limit: { type: 'number', description: 'Максимум результатов (по умолчанию 50).' },
      },
    },
  },
  {
    name: 'select_instance',
    description: 'Выделить объект в Explorer Studio (Selection) по пути — для визуального контроля.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'use_template',
    description:
      'Подставить готовый Lua-шаблон из библиотеки вместо генерации кода с нуля — ' +
      'это экономит токены. Доступные id: platformer_character, npc_move_to, ' +
      'race_checkpoints, leaderboard_points, sprint_on_shift, click_to_collect. ' +
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
  {
    name: 'get_selection',
    description:
      'Получить объекты, выделенные пользователем в Explorer Studio прямо сейчас ' +
      '(с их path, className, свойствами). Используй, когда пользователь говорит ' +
      '«этот объект», «выделенное», «то что я выбрал».',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'duplicate_instance',
    description:
      'Клонировать объект по пути (со всеми детьми) в того же или другого родителя. ' +
      'Удобно для размножения подготовленных моделей/частей.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к исходному объекту.' },
        parent: { type: 'string', description: 'Путь к родителю для копии (по умолчанию тот же).' },
        count: { type: 'number', description: 'Сколько копий сделать (по умолчанию 1).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'move_instance',
    description: 'Переместить объект к другому родителю (reparent) по пути.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту.' },
        parent: { type: 'string', description: 'Путь к новому родителю.' },
      },
      required: ['path', 'parent'],
    },
  },
  {
    name: 'get_children',
    description:
      'Список прямых детей объекта (имя, класс, число детей). Дешевле, чем всё ' +
      'дерево — используй для навигации по конкретной ветке.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Путь к объекту.' } },
      required: ['path'],
    },
  },
  {
    name: 'get_attributes',
    description: 'Прочитать пользовательские атрибуты объекта (Instance:GetAttributes).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Путь к объекту.' } },
      required: ['path'],
    },
  },
  {
    name: 'set_attributes',
    description:
      'Установить атрибуты объекта (Instance:SetAttribute). Значения можно задавать ' +
      'конструкторами как у свойств: "Vector3.new(...)", "Color3.fromRGB(...)" и т.д.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту.' },
        attributes: { type: 'object', description: 'Карта имя→значение.' },
      },
      required: ['path', 'attributes'],
    },
  },
  {
    name: 'add_tag',
    description: 'Добавить объекту тег CollectionService (для систем на тегах).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту.' },
        tag: { type: 'string', description: 'Имя тега.' },
      },
      required: ['path', 'tag'],
    },
  },
  {
    name: 'remove_tag',
    description: 'Снять тег CollectionService с объекта.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту.' },
        tag: { type: 'string', description: 'Имя тега.' },
      },
      required: ['path', 'tag'],
    },
  },
  {
    name: 'get_tags',
    description: 'Получить теги CollectionService у объекта.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Путь к объекту.' } },
      required: ['path'],
    },
  },
  {
    name: 'create_script',
    description:
      'Создать скрипт (Script | LocalScript | ModuleScript) с готовым исходником сразу. ' +
      'Удобнее, чем create_instance + set_script_source. Размещай в правильном сервисе.',
    parameters: {
      type: 'object',
      properties: {
        scriptType: { type: 'string', description: 'Script | LocalScript | ModuleScript.' },
        parent: { type: 'string', description: 'Путь к родителю (сервису/папке).' },
        name: { type: 'string', description: 'Имя скрипта.' },
        source: { type: 'string', description: 'Исходный код Luau.' },
      },
      required: ['scriptType', 'parent', 'source'],
    },
  },
  {
    name: 'call_method',
    description:
      'Вызвать метод объекта (напр. PivotTo, MakeJoints, BreakJoints, MoveTo). Аргументы ' +
      'парсятся как значения свойств (Vector3.new(...), CFrame.new(...) и т.д.).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту.' },
        method: { type: 'string', description: 'Имя метода.' },
        args: { type: 'array', description: 'Аргументы метода (массив значений/строк-конструкторов).' },
      },
      required: ['path', 'method'],
    },
  },
  {
    name: 'clear_children',
    description: 'Удалить всех детей объекта (очистить контейнер). Необратимо.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Путь к контейнеру.' } },
      required: ['path'],
    },
  },
  {
    name: 'count_instances',
    description:
      'Посчитать объекты по классу во всём дереве (или в поддереве по path). Полезно ' +
      'для аудита плейса перед действиями.',
    parameters: {
      type: 'object',
      properties: {
        className: { type: 'string', description: 'Класс для подсчёта (необязательно — иначе все).' },
        path: { type: 'string', description: 'Корень поддерева (по умолчанию game).' },
      },
    },
  },
  {
    name: 'group_instances',
    description: 'Сгруппировать объекты в новый Model или Folder.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', description: 'Массив путей к объектам.' },
        container: { type: 'string', description: 'Model (по умолчанию) или Folder.' },
        name: { type: 'string', description: 'Имя группы.' },
        parent: { type: 'string', description: 'Куда поместить группу (по умолчанию рядом с первым объектом).' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'build_parts',
    description:
      'Батч-постройка: создать Model из множества частей за один вызов — основа быстрых ' +
      'и красивых построек по генплану. Сначала спроектируй план через plan_build, затем ' +
      'строй здесь. Каждая часть: shape (Block/Ball/Cylinder/Wedge), position{x,y,z}, ' +
      'size{x,y,z}, color "#RRGGBB", material (Plastic/Wood/Concrete/Neon/Metal/Glass/Brick/' +
      'Grass/Slate), orientation{x,y,z} в градусах, anchored.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Имя модели постройки.' },
        parent: { type: 'string', description: 'Путь к родителю (по умолчанию Workspace).' },
        parts: {
          type: 'array',
          description: 'Список частей постройки.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              shape: { type: 'string', description: 'Block | Ball | Cylinder | Wedge.' },
              position: { type: 'object', description: '{x,y,z} центр части (studs).' },
              size: { type: 'object', description: '{x,y,z} размер части (studs).' },
              color: { type: 'string', description: 'Цвет "#RRGGBB".' },
              material: { type: 'string', description: 'Материал, напр. Wood, Concrete, Neon.' },
              orientation: { type: 'object', description: '{x,y,z} поворот в градусах.' },
              anchored: { type: 'boolean', description: 'Закрепить (по умолчанию true).' },
            },
            required: ['position', 'size'],
          },
        },
      },
      required: ['parts'],
    },
  },
  {
    name: 'add_proximity_prompt',
    description:
      'Добавить ProximityPrompt на объект — всплывающая подсказка «нажмите E» для ' +
      'взаимодействия (двери, кнопки, предметы). Логику навешивай скриптом отдельно.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту.' },
        actionText: { type: 'string', description: 'Текст действия (напр. "Открыть").' },
        objectText: { type: 'string', description: 'Название объекта.' },
        keyCode: { type: 'string', description: 'Клавиша, напр. "E" (по умолчанию E).' },
        holdDuration: { type: 'number', description: 'Сколько держать (сек).' },
        maxDistance: { type: 'number', description: 'Дистанция активации (studs).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'add_click_detector',
    description: 'Добавить ClickDetector на объект — реакция на клик мышью.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту.' },
        maxDistance: { type: 'number', description: 'Дистанция активации (studs).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'create_screen_gui',
    description:
      'Создать ScreenGui (контейнер интерфейса) в StarterGui. Затем наполняй его ' +
      'через create_ui_element. Это основа любого 2D-интерфейса игрока.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Имя ScreenGui.' },
        parent: { type: 'string', description: 'Путь к родителю (по умолчанию StarterGui).' },
        resetOnSpawn: { type: 'boolean', description: 'Сбрасывать при респавне (по умолчанию true).' },
      },
    },
  },
  {
    name: 'create_ui_element',
    description:
      'Создать UI-элемент внутри родителя (ScreenGui/Frame): Frame, TextLabel, ' +
      'TextButton, TextBox, ImageLabel, ImageButton, ScrollingFrame, UIListLayout, ' +
      'UICorner, UIPadding и др. Размер/позиция в UDim2 (scale+offset).',
    parameters: {
      type: 'object',
      properties: {
        parent: { type: 'string', description: 'Путь к родителю (ScreenGui/Frame).' },
        className: { type: 'string', description: 'Класс GUI-объекта, напр. TextButton.' },
        name: { type: 'string', description: 'Имя элемента.' },
        size: { type: 'object', description: '{xScale,xOffset,yScale,yOffset}.' },
        position: { type: 'object', description: '{xScale,xOffset,yScale,yOffset}.' },
        bgColor: { type: 'string', description: 'Цвет фона "#RRGGBB".' },
        bgTransparency: { type: 'number', description: 'Прозрачность фона 0..1.' },
        text: { type: 'string', description: 'Текст (для Text*-элементов).' },
        textColor: { type: 'string', description: 'Цвет текста "#RRGGBB".' },
        textSize: { type: 'number', description: 'Размер текста.' },
      },
      required: ['parent', 'className'],
    },
  },
  {
    name: 'weld',
    description:
      'Жёстко сварить два объекта через WeldConstraint (двигаются как одно целое). ' +
      'Перед сваркой обычно ставят Anchored=false у обеих частей.',
    parameters: {
      type: 'object',
      properties: {
        part0: { type: 'string', description: 'Путь к первой части.' },
        part1: { type: 'string', description: 'Путь ко второй части.' },
      },
      required: ['part0', 'part1'],
    },
  },
  {
    name: 'add_attachment',
    description: 'Добавить Attachment (точку крепления) на объект — нужен для констрейнтов и эффектов.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту.' },
        name: { type: 'string', description: 'Имя Attachment.' },
        position: { type: 'object', description: '{x,y,z} локальная позиция.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'create_constraint',
    description:
      'Создать физический констрейнт между двумя Attachment: HingeConstraint (петля), ' +
      'SpringConstraint (пружина), RopeConstraint (верёвка), RodConstraint, ' +
      'BallSocketConstraint, PrismaticConstraint. Свойства через properties.',
    parameters: {
      type: 'object',
      properties: {
        constraintType: { type: 'string', description: 'Тип, напр. HingeConstraint.' },
        attachment0: { type: 'string', description: 'Путь к первому Attachment.' },
        attachment1: { type: 'string', description: 'Путь ко второму Attachment.' },
        properties: { type: 'object', description: 'Доп. свойства констрейнта.' },
      },
      required: ['constraintType', 'attachment0', 'attachment1'],
    },
  },
  {
    name: 'add_decal',
    description: 'Добавить Decal или Texture (картинку) на грань объекта по assetId.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту.' },
        texture: { type: 'string', description: 'Asset id картинки (rbxassetid://...).' },
        kind: { type: 'string', description: 'Decal (по умолчанию) или Texture.' },
        face: { type: 'string', description: 'Грань: Front/Back/Top/Bottom/Left/Right.' },
      },
      required: ['path', 'texture'],
    },
  },
  {
    name: 'add_light',
    description: 'Добавить источник света на объект: PointLight, SpotLight или SurfaceLight.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту.' },
        lightType: { type: 'string', description: 'PointLight | SpotLight | SurfaceLight.' },
        color: { type: 'string', description: 'Цвет света "#RRGGBB".' },
        brightness: { type: 'number', description: 'Яркость.' },
        range: { type: 'number', description: 'Радиус (studs).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'add_particle',
    description: 'Добавить ParticleEmitter (частицы: огонь, дым, искры) на объект или Attachment.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к объекту/Attachment.' },
        texture: { type: 'string', description: 'Asset id текстуры частицы.' },
        rate: { type: 'number', description: 'Частиц в секунду.' },
        color: { type: 'string', description: 'Цвет "#RRGGBB".' },
        lifetime: { type: 'number', description: 'Время жизни частицы (сек).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'add_sound',
    description:
      'Добавить Sound на объект (3D-звук) или в SoundService (глобальный). Можно ' +
      'зациклить и запустить сразу.',
    parameters: {
      type: 'object',
      properties: {
        parent: { type: 'string', description: 'Путь к родителю (по умолчанию SoundService).' },
        name: { type: 'string', description: 'Имя звука.' },
        soundId: { type: 'string', description: 'Asset id (rbxassetid://...).' },
        volume: { type: 'number', description: 'Громкость.' },
        looped: { type: 'boolean', description: 'Зациклить.' },
        playOnCreate: { type: 'boolean', description: 'Запустить сразу.' },
      },
      required: ['soundId'],
    },
  },
  {
    name: 'set_lighting',
    description:
      'Настроить глобальное освещение сцены (сервис Lighting): время суток (ClockTime ' +
      '0..24), яркость, ambient-цвета, туман. Задаёт атмосферу всей игры.',
    parameters: {
      type: 'object',
      properties: {
        clockTime: { type: 'number', description: 'Время суток 0..24 (14 = день).' },
        brightness: { type: 'number', description: 'Глобальная яркость.' },
        ambient: { type: 'string', description: 'Ambient-цвет "#RRGGBB".' },
        outdoorAmbient: { type: 'string', description: 'Outdoor ambient "#RRGGBB".' },
        fogEnd: { type: 'number', description: 'Дальность тумана (studs).' },
        fogColor: { type: 'string', description: 'Цвет тумана "#RRGGBB".' },
      },
    },
  },
  {
    name: 'search_assets',
    description:
      'Найти ассеты в каталоге/тулбоксе Roblox по ключевому слову. Возвращает список ' +
      'assetId с названиями. Затем вставляй нужный через insert_model(assetId). ' +
      'Используй, когда нужна готовая модель/декаль/звук из тулбокса.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Что искать, напр. "tree", "sword", "car".' },
        assetType: {
          type: 'string',
          description: 'Тип ассета: model (по умолчанию), decal, audio, mesh, image, plugin.',
        },
        limit: { type: 'number', description: 'Сколько результатов (по умолчанию 12).' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'luau_reference',
    description:
      'Открыть раздел справочника по Luau и Roblox API (язык, сервисы, Instance, ' +
      'события, физика/CFrame, Humanoid, RemoteEvent, UI, TweenService, DataStore, ' +
      'билдинг, и т.д.). Вызывай, если не уверен в синтаксисе или API, ПЕРЕД написанием ' +
      'кода. Без аргумента — список тем.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Тема или ключевое слово, напр. "CFrame", "RemoteEvent", "DataStore".' },
      },
    },
  },
  {
    name: 'web_search',
    description:
      'Поиск в интернете (возвращает заголовки и ссылки). Используй ВСЕГДА, когда не ' +
      'уверен в факте, актуальном API, asset id или решении — лучше проверить, чем ' +
      'выдумать. Для деталей затем открой ссылку через web_fetch.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос.' },
        count: { type: 'number', description: 'Сколько результатов (по умолчанию 5).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Загрузить страницу по URL и вернуть её текст (очищенный от разметки). ' +
      'Используй после web_search, чтобы прочитать документацию/devforum/гайд.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Полный http(s) URL.' },
        maxChars: { type: 'number', description: 'Ограничение длины текста (по умолчанию 4000).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'update_plan',
    description:
      'Показать/обновить план задач (todo-лист) в чате. Используй для многошаговых ' +
      'задач: составь шаги, по ходу работы помечай статусы. Доступно всегда. Каждый ' +
      'вызов ЗАМЕНЯЕТ предыдущий план целиком.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Шаги плана по порядку.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Описание шага.' },
              status: { type: 'string', description: 'pending | in_progress | done' },
            },
            required: ['text'],
          },
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'plan_build',
    description:
      'Спроектировать ГЕНПЛАН постройки (вид сверху) — он сразу показывается пользователю ' +
      'как схема. Используй ПЕРЕД build_parts для красивых, продуманных построек: сначала ' +
      'разметь зоны/footprint-ы сверху (комнаты, стены, дорожки), покажи план, затем строй. ' +
      'Координаты в studs: x — вправо, z — вглубь (вид сверху).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Название постройки.' },
        width: { type: 'number', description: 'Ширина участка по X (studs).' },
        depth: { type: 'number', description: 'Глубина участка по Z (studs).' },
        items: {
          type: 'array',
          description: 'Footprint-ы (прямоугольники вида сверху).',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Подпись зоны (комната, стена…).' },
              x: { type: 'number', description: 'X левого края (studs).' },
              z: { type: 'number', description: 'Z верхнего края (studs).' },
              w: { type: 'number', description: 'Ширина по X.' },
              d: { type: 'number', description: 'Глубина по Z.' },
              color: { type: 'string', description: 'Цвет зоны "#RRGGBB".' },
            },
            required: ['x', 'z', 'w', 'd'],
          },
        },
      },
      required: ['items'],
    },
  },

  // ── ПК-инструменты (когда Studio не подключён) ──
  {
    name: 'run_command',
    description:
      'Выполнить команду в терминале на ПК пользователя. На Windows по умолчанию ' +
      'PowerShell (shell="powershell"), также можно shell="cmd" или "bash". ' +
      'Возвращает stdout/stderr. Используй для любых задач на компьютере.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Команда для выполнения.' },
        cwd: { type: 'string', description: 'Рабочая директория (необязательно).' },
        shell: { type: 'string', enum: ['powershell', 'cmd', 'bash'], description: 'Оболочка (Windows).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Прочитать текстовый файл на ПК по абсолютному пути.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Путь к файлу.' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Создать или перезаписать файл на ПК (каталоги создаются автоматически).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу.' },
        content: { type: 'string', description: 'Полное содержимое файла.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Точечно заменить фрагмент в файле на ПК: oldText → newText. По умолчанию ' +
      'заменяет одно вхождение (нужна уникальность); replaceAll=true — все.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу.' },
        oldText: { type: 'string', description: 'Существующий фрагмент.' },
        newText: { type: 'string', description: 'Чем заменить.' },
        replaceAll: { type: 'boolean', description: 'Заменить все вхождения.' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'list_dir',
    description: 'Список файлов и папок в каталоге на ПК.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Путь к каталогу.' } },
    },
  },
  {
    name: 'make_dir',
    description: 'Создать каталог (рекурсивно) на ПК.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Путь к каталогу.' } },
      required: ['path'],
    },
  },
  {
    name: 'read_lines',
    description: 'Прочитать файл на ПК с номерами строк, можно диапазоном (offset/limit).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу.' },
        offset: { type: 'number', description: 'С какой строки (0 = начало).' },
        limit: { type: 'number', description: 'Сколько строк.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'append_file',
    description: 'Дописать текст в конец файла на ПК (создаётся при отсутствии).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу.' },
        content: { type: 'string', description: 'Что дописать.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_path',
    description: 'Удалить файл или каталог (рекурсивно) на ПК. НЕОБРАТИМО — только по явной просьбе.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Путь.' } },
      required: ['path'],
    },
  },
  {
    name: 'move_path',
    description: 'Переместить или переименовать файл/каталог на ПК.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Откуда.' },
        to: { type: 'string', description: 'Куда.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'copy_path',
    description: 'Скопировать файл или каталог (рекурсивно) на ПК.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Источник.' },
        to: { type: 'string', description: 'Назначение.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'stat_path',
    description: 'Метаданные файла/каталога на ПК: тип, размер, даты.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Путь.' } },
      required: ['path'],
    },
  },
  {
    name: 'glob_files',
    description: 'Рекурсивно найти файлы на ПК по шаблону имени (* и ?). Аналог Glob.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Шаблон имени, напр. "*.lua".' },
        path: { type: 'string', description: 'Корень поиска (по умолчанию домашний каталог).' },
        limit: { type: 'number', description: 'Максимум результатов.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep_files',
    description: 'Поиск по содержимому файлов на ПК (регэксп), рекурсивно — как grep -rn.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Регулярное выражение.' },
        path: { type: 'string', description: 'Корень поиска (по умолчанию домашний каталог).' },
        glob: { type: 'string', description: 'Фильтр файлов по имени, напр. "*.ts".' },
        ignoreCase: { type: 'boolean', description: 'Игнорировать регистр.' },
        limit: { type: 'number', description: 'Максимум совпадений.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'tree',
    description: 'Дерево каталога на ПК (node_modules/.git пропускаются).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Каталог (по умолчанию домашний).' },
        depth: { type: 'number', description: 'Глубина (по умолчанию 3, максимум 8).' },
      },
    },
  },
  {
    name: 'path_exists',
    description: 'Проверить, существует ли файл/каталог на ПК.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Путь.' } },
      required: ['path'],
    },
  },
  {
    name: 'sys_info',
    description: 'Информация о системе: ОС, CPU, память, домашний каталог, версия Node.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_cwd',
    description: 'Текущий рабочий каталог процесса сервера Rublox.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'clipboard_read',
    description: 'Прочитать текст из буфера обмена Windows.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'clipboard_write',
    description: 'Записать текст в буфер обмена Windows.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Что положить в буфер.' } },
      required: ['text'],
    },
  },
  {
    name: 'notify',
    description: 'Показать системное уведомление Windows (всплывающее из трея).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Заголовок.' },
        message: { type: 'string', description: 'Текст уведомления.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'take_screenshot',
    description: 'Сделать скриншот всего экрана и сохранить в PNG-файл. Возвращает путь.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Куда сохранить (по умолчанию в домашний каталог).' } },
    },
  },
  {
    name: 'download_file',
    description: 'Скачать файл по URL (в т.ч. бинарный — картинки, архивы, exe) и сохранить на диск.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s)-ссылка.' },
        path: { type: 'string', description: 'Куда сохранить (по умолчанию домашний каталог + имя из URL).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'reg_query',
    description: 'Прочитать ключ/значение реестра Windows (reg query).',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Путь ключа, напр. HKCU\\Software\\Microsoft\\Windows\\CurrentVersion.' },
        value: { type: 'string', description: 'Имя значения (необязательно).' },
      },
      required: ['key'],
    },
  },
  {
    name: 'reg_set',
    description: 'Записать значение в реестр Windows (reg add). ОСТОРОЖНО — только по явной просьбе.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Путь ключа.' },
        value: { type: 'string', description: 'Имя значения.' },
        data: { type: 'string', description: 'Данные.' },
        type: { type: 'string', description: 'Тип: REG_SZ (по умолч.), REG_DWORD и т.д.' },
      },
      required: ['key', 'value', 'data'],
    },
  },
  {
    name: 'run_background',
    description:
      'Запустить долгоживущий/фоновый процесс (сервер npm start, dev-сервер, watcher) и ' +
      'СРАЗУ продолжить работу, не блокируясь. Возвращает id. Вывод читай через ' +
      'process_output, ввод шли через process_input, останавливай process_stop.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Команда для запуска.' },
        cwd: { type: 'string', description: 'Рабочий каталог.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'process_output',
    description: 'Прочитать накопленный вывод фонового процесса по id (и его статус).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id из run_background.' } },
      required: ['id'],
    },
  },
  {
    name: 'process_input',
    description:
      'Отправить ввод в stdin фонового/интерактивного процесса (ответ на запросы программы: ' +
      'y/n, имя пакета в npm init, и т.п.).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id процесса.' },
        input: { type: 'string', description: 'Что ввести.' },
        noNewline: { type: 'boolean', description: 'Не добавлять перевод строки.' },
      },
      required: ['id', 'input'],
    },
  },
  {
    name: 'process_stop',
    description: 'Остановить (убить) фоновый процесс по id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id процесса.' } },
      required: ['id'],
    },
  },
  {
    name: 'process_list',
    description: 'Список запущенных фоновых процессов и их статусы.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git',
    description:
      'Безопасный обзор git: action = status | diff | log | branch. Показывает состояние, ' +
      'не делает опасных операций. Для коммитов/пушей используй run_command по явной просьбе.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'status | diff | log | branch.' },
        cwd: { type: 'string', description: 'Каталог репозитория.' },
        staged: { type: 'boolean', description: 'Для diff — показать застейдженное.' },
        limit: { type: 'number', description: 'Для log — сколько коммитов.' },
      },
    },
  },
  {
    name: 'launch_app',
    description: 'Запустить GUI-приложение (notepad, calc, путь к exe и т.п.) — не блокируясь.',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Имя или путь программы.' },
        args: { type: 'array', description: 'Аргументы командной строки.' },
      },
      required: ['app'],
    },
  },
  {
    name: 'focus_window',
    description: 'Вывести окно на передний план по части его заголовка (Windows).',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Часть заголовка окна.' } },
      required: ['title'],
    },
  },
  {
    name: 'send_keys',
    description:
      'Отправить нажатия клавиш активному окну (SendKeys): ввод текста, спецклавиши ' +
      '{ENTER}{TAB}{ESC}, сочетания ^c (Ctrl+C), %{F4} (Alt+F4). Сначала сфокусируй окно.',
    parameters: {
      type: 'object',
      properties: { keys: { type: 'string', description: 'Строка клавиш в формате SendKeys.' } },
      required: ['keys'],
    },
  },
];

// Веб-инструменты доступны ВСЕГДА (и в режиме Studio, и в режиме ПК).
export const WEB_TOOLS = new Set([
  'web_search', 'web_fetch', 'search_assets', 'luau_reference',
]);
// ПК-инструменты (Studio не подключён).
export const PC_TOOLS = new Set([
  'run_command', 'read_file', 'write_file', 'edit_file', 'list_dir', 'make_dir',
  'read_lines', 'append_file', 'delete_path', 'move_path', 'copy_path',
  'glob_files', 'grep_files', 'tree', 'stat_path', 'path_exists',
  'sys_info', 'get_cwd',
  // Расширенные возможности ПК:
  'clipboard_read', 'clipboard_write', 'notify', 'take_screenshot', 'download_file',
  'reg_query', 'reg_set', 'run_background', 'process_output', 'process_input',
  'process_stop', 'process_list', 'git', 'launch_app', 'focus_window', 'send_keys',
]);

// Инструменты со спец-логикой в agent.js (не чистый проброс).
export const SPECIAL_TOOLS = new Set(['use_template', 'update_plan', 'plan_build']);

// Инструменты, доступные ВСЕГДА (в любом режиме): планирование и генплан.
export const ALWAYS_TOOLS = new Set(['update_plan', 'plan_build']);

// Имена всех объявленных инструментов.
export const TOOL_NAMES = TOOLS.map((t) => t.name);

// Studio-инструменты выводятся автоматически: всё, что НЕ веб, НЕ ПК и НЕ спец.
// Благодаря этому добавить Studio-инструмент = добавить только схему: agent.js
// проксирует его в плагин по имени, «забыть подключить» физически нельзя.
export const STUDIO_TOOLS = new Set(
  TOOL_NAMES.filter((n) => !WEB_TOOLS.has(n) && !PC_TOOLS.has(n) && !SPECIAL_TOOLS.has(n))
);

// Отбор инструментов по режиму:
//  - Studio подключён → инструменты Studio + веб;
//  - Studio выключен и разрешён ПК → инструменты ПК + веб;
//  - иначе → только веб.
function pickTools({ studioConnected = false, pcAllowed = false } = {}) {
  return TOOLS.filter((t) => {
    if (ALWAYS_TOOLS.has(t.name)) return true;
    if (WEB_TOOLS.has(t.name)) return true;
    if (PC_TOOLS.has(t.name)) return !studioConnected && pcAllowed;
    return studioConnected; // Studio-инструменты
  });
}

// Преобразование в формат Anthropic. ctx = { studioConnected, pcAllowed }.
export function toolsForAnthropic(ctx) {
  return pickTools(ctx).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

// Преобразование в формат OpenAI (function calling).
export function toolsForOpenAI(ctx) {
  return pickTools(ctx).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
