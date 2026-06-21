// Готовые шаблоны провайдеров для UI: базовый URL уже настроен, нужен лишь ключ.
// Это AI-роутеры/агрегаторы — принимают OpenAI-совместимый формат и сами
// маршрутизируют запрос к моделям OpenAI, Anthropic, DeepSeek, Zhipu, MiniMax,
// Kimi (Moonshot), Xiaomi MiMo и др.
export const PROVIDER_TEMPLATES = [
  {
    id: '', label: 'Custom (любой)', kind: 'multi',
    baseUrl: '', model: '',
    note: 'Свой провайдер: задай ID, Base URL, протокол и ключ — подойдёт любой OpenAI/Anthropic-совместимый сервис.',
  },
  {
    id: 'omniroute', label: 'OmniRoute', kind: 'multi',
    baseUrl: 'https://api.omniroute.io/v1', model: '',
    note: 'Агрегатор: OpenAI, Anthropic, DeepSeek, Zhipu, MiniMax, Kimi и др.',
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'multi',
    baseUrl: 'https://openrouter.ai/api/v1', model: '',
    note: 'Крупнейший роутер: сотни моделей всех вендоров.',
  },
  {
    id: 'local', label: 'Local (свои модели)', kind: 'openai',
    baseUrl: 'http://localhost:11434/v1', model: '',
    note: 'Скачанные модели: Ollama (11434) / LM Studio (1234) / vLLM. Ключ не нужен.',
  },
  {
    id: 'agentrouter', label: 'AgentRouter', kind: 'anthropic',
    baseUrl: 'https://agentrouter.org', model: 'claude-opus-4-8',
    note: 'Anthropic-совместимый прокси (Claude Code / Codex / Gemini).',
  },
  {
    id: 'deepseek', label: 'DeepSeek', kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    note: 'Официальный API DeepSeek (deepseek-chat, deepseek-reasoner).',
  },
  {
    id: 'zhipu', label: 'Zhipu AI (GLM)', kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus',
    note: 'GLM-4 от Zhipu AI.',
  },
  {
    id: 'moonshot', label: 'Kimi (Moonshot)', kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k',
    note: 'Kimi от Moonshot AI.',
  },
  {
    id: 'minimax', label: 'MiniMax', kind: 'openai',
    baseUrl: 'https://api.minimax.chat/v1', model: 'abab6.5s-chat',
    note: 'MiniMax abab.',
  },
  {
    id: 'groq', label: 'Groq', kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile',
    note: 'Сверхбыстрый инференс Llama/Mixtral.',
  },
  {
    id: 'together', label: 'Together', kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    note: 'Открытые модели.',
  },
  {
    id: 'openai', label: 'OpenAI (ChatGPT)', kind: 'openai',
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o',
    note: 'Официальный OpenAI.',
  },
  {
    id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4-8',
    note: 'Официальный Anthropic.',
  },
];
