// ИИ-плагины (скиллы): включаемые модули поведения. Каждый включённый скилл
// добавляет фрагмент в системный промпт — это РЕАЛЬНО меняет работу модели, а не
// просто украшает настройки. Состояние хранится в app.json:
//   skills = { disabled: [id, ...], custom: [{ id, name, desc, prompt, enabled }] }
// Встроенные по умолчанию включены; пользователь может выключать и добавлять свои.

import { appConfigGet, appConfigSet } from './app-config.js';
import { randomBytes } from 'node:crypto';

// Встроенные плагины. icon — имя SVG-иконки из web/icons.js.
export const BUILTIN_SKILLS = [
  {
    id: 'builder',
    name: 'Архитектор построек',
    desc: 'Сначала генплан (вид сверху), потом аккуратная постройка из частей. Красивые, продуманные строения.',
    icon: 'box',
    prompt:
      'НАВЫК «Архитектор»: для построек сперва спроектируй генплан через plan_build ' +
      '(зоны, footprint-ы сверху), покажи его пользователю, затем строй через ' +
      'build_parts по плану. Думай о пропорциях, симметрии, материалах и цветах. ' +
      'Группируй результат в одну Model с осмысленным именем.',
  },
  {
    id: 'scripter',
    name: 'Мастер скриптинга',
    desc: 'Эксперт Luau: перед кодом сверяется с документацией, пишет чистый и безопасный код.',
    icon: 'brain',
    prompt:
      'НАВЫК «Скриптинг»: перед написанием Luau вызывай luau_reference по теме. Пиши ' +
      'идиоматичный код: сервис через game:GetService, серверная логика в Script, ' +
      'клиентская в LocalScript, сетевые вызовы в pcall, паузы через task.wait. ' +
      'Размещай скрипты в правильных контейнерах.',
  },
  {
    id: 'ui-designer',
    name: 'UI-дизайнер',
    desc: 'Строит интерфейсы: ScreenGui, Frame, кнопки, раскладки UIListLayout, скругления UICorner.',
    icon: 'layout',
    prompt:
      'НАВЫК «UI»: для интерфейсов используй create_screen_gui и create_ui_element. ' +
      'Применяй UDim2 (scale для адаптивности), UIListLayout/UIGridLayout для раскладки, ' +
      'UICorner для скруглений, UIPadding для отступов. Думай об иерархии ZIndex и якорях.',
  },
  {
    id: 'debugger',
    name: 'Отладчик',
    desc: 'Читает консоль Studio, находит и чинит ошибки сам, проверяет результат.',
    icon: 'terminal',
    prompt:
      'НАВЫК «Отладка»: после выполнения кода проверяй get_console_output на ошибки. ' +
      'Если есть ошибка — анализируй стек, исправляй причину и проверяй снова, пока чисто. ' +
      'Не оставляй красных ошибок в Output.',
  },
  {
    id: 'optimizer',
    name: 'Оптимизатор',
    desc: 'Следит за производительностью: меньше частей, разумные циклы, очистка мусора.',
    icon: 'cpu',
    prompt:
      'НАВЫК «Оптимизация»: избегай тяжёлых конструкций — лишних частей, while без ' +
      'task.wait, утечек соединений. Используй Debris для временных объектов, ' +
      'отключай ненужные Connection через :Disconnect(). Предлагай оптимальные решения.',
  },
  {
    id: 'canvas',
    name: 'Canvas (длинные документы)',
    desc: 'Для больших текстов/кода держит цельный документ и редактирует его точечными правками.',
    icon: 'edit',
    prompt:
      'НАВЫК «Canvas»: для объёмного кода или текста выдавай цельный документ в одном ' +
      'блоке, а при доработках показывай точечные правки в формате diff (строки с "+" ' +
      'зелёным для добавлений и "-" красным для удалений), не переписывая всё заново.',
  },
  {
    id: 'researcher',
    name: 'Веб-исследователь',
    desc: 'При любой неуверенности ищет в интернете и опирается на источники.',
    icon: 'globe',
    prompt:
      'НАВЫК «Исследователь»: при малейшей неуверенности в факте, API, asset id или ' +
      'актуальности — используй web_search, затем web_fetch для деталей. Опирайся на ' +
      'найденные источники, а не на догадки.',
  },
];

const BUILTIN_IDS = new Set(BUILTIN_SKILLS.map((s) => s.id));

function loadState() {
  const raw = appConfigGet('skills', {}) || {};
  return {
    disabled: Array.isArray(raw.disabled) ? raw.disabled : [],
    custom: Array.isArray(raw.custom) ? raw.custom : [],
  };
}

function saveState(state) {
  appConfigSet('skills', {
    disabled: state.disabled || [],
    custom: state.custom || [],
  });
}

// Полный список скиллов с актуальным enabled-флагом — для UI.
export function listSkills() {
  const state = loadState();
  const disabled = new Set(state.disabled);
  const builtin = BUILTIN_SKILLS.map((s) => ({
    ...s, builtin: true, enabled: !disabled.has(s.id),
  }));
  const custom = state.custom.map((s) => ({
    id: s.id, name: s.name, desc: s.desc || '', prompt: s.prompt || '',
    icon: 'puzzle', builtin: false, enabled: s.enabled !== false,
  }));
  return [...builtin, ...custom];
}

// Включить/выключить скилл по id (встроенный или пользовательский).
export function setSkillEnabled(id, enabled) {
  const state = loadState();
  if (BUILTIN_IDS.has(id)) {
    const set = new Set(state.disabled);
    if (enabled) set.delete(id); else set.add(id);
    state.disabled = [...set];
  } else {
    const item = state.custom.find((s) => s.id === id);
    if (item) item.enabled = !!enabled;
  }
  saveState(state);
  return listSkills();
}

// Добавить пользовательский скилл (имя + инструкция-промпт).
export function addCustomSkill({ name, desc, prompt }) {
  const state = loadState();
  const id = 'custom_' + randomBytes(5).toString('hex');
  state.custom.push({
    id,
    name: String(name || 'Свой навык').slice(0, 80),
    desc: String(desc || '').slice(0, 200),
    prompt: String(prompt || '').slice(0, 4000),
    enabled: true,
  });
  saveState(state);
  return listSkills();
}

// Удалить пользовательский скилл (встроенные удалять нельзя — только выключать).
export function removeCustomSkill(id) {
  const state = loadState();
  state.custom = state.custom.filter((s) => s.id !== id);
  saveState(state);
  return listSkills();
}

// Фрагменты промпта всех включённых скиллов — подмешиваются в системный промпт.
export function activeSkillPrompts() {
  return listSkills().filter((s) => s.enabled && s.prompt).map((s) => s.prompt);
}
