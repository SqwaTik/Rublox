// Локализация RU/EN. Уровни мышления (Min/Low/High/Max) НЕ переводятся —
// они типизированные, всегда на английском.
window.I18N = {
  en: {
    newChat: 'New chat',
    settings: 'Settings',
    installPlugin: 'Install plugin',
    deleteAll: 'Delete all chats',
    studioOff: 'Studio: disconnected',
    studioOn: 'Studio: connected',
    placeholder: 'Describe a task or type a /command…',
    rename: 'Rename',
    delete: 'Delete',
    mainChat: 'Main chat',
    confirmDeleteAll: 'Delete all chats? This cannot be undone.',
    confirmInstall: 'Studio is not connected. Install the plugin into Roblox automatically?',
    // settings
    providers: 'Providers',
    appearance: 'Appearance',
    about: 'About',
    language: 'Language',
    theme: 'Theme',
    addProvider: 'Add / edit provider',
    quickTemplates: 'Quick templates (paste your key)',
    noProviders: 'No providers yet. Add one below or use a template.',
    id: 'ID', name: 'Name', protocol: 'Protocol', baseUrl: 'Base URL',
    apiKey: 'API key', model: 'Model',
    previewModels: 'Preview models', save: 'Save', remove: 'Remove',
    thinkingTitle: 'Reasoning level',
    fetchOk: 'Models found',
    fetchFail: 'Error — check URL and key',
    aboutText: 'Rublox — AI assistant for Roblox Studio. Chat with any LLM provider, ' +
      'connect a Studio plugin and edit your place from inside.',
  },
  ru: {
    newChat: 'Новый чат',
    settings: 'Настройки',
    installPlugin: 'Установить плагин',
    deleteAll: 'Удалить все чаты',
    studioOff: 'Studio: отключён',
    studioOn: 'Studio: подключён',
    placeholder: 'Опишите задачу или введите /команду…',
    rename: 'Переименовать',
    delete: 'Удалить',
    mainChat: 'Главный чат',
    confirmDeleteAll: 'Удалить все чаты? Это необратимо.',
    confirmInstall: 'Studio не подключён. Установить плагин в Roblox автоматически?',
    providers: 'Провайдеры',
    appearance: 'Внешний вид',
    about: 'О программе',
    language: 'Язык',
    theme: 'Тема',
    addProvider: 'Добавить / изменить провайдера',
    quickTemplates: 'Быстрые шаблоны (вставьте свой ключ)',
    noProviders: 'Провайдеров нет. Добавьте ниже или выберите шаблон.',
    id: 'ID', name: 'Название', protocol: 'Протокол', baseUrl: 'Base URL',
    apiKey: 'API-ключ', model: 'Модель',
    previewModels: 'Превью моделей', save: 'Сохранить', remove: 'Удалить',
    thinkingTitle: 'Уровень мышления',
    fetchOk: 'Моделей найдено',
    fetchFail: 'Ошибка — проверьте URL и ключ',
    aboutText: 'Rublox — AI-ассистент для Roblox Studio. Чат с любым LLM-провайдером, ' +
      'подключение плагина Studio и редактирование плейса изнутри.',
  },
};

window.getLang = () => localStorage.getItem('lang') || 'en';
window.setLang = (l) => localStorage.setItem('lang', l);
window.t = (key) => {
  const lang = window.getLang();
  return (window.I18N[lang] && window.I18N[lang][key]) || window.I18N.en[key] || key;
};
