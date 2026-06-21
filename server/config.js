// Лёгкий загрузчик .env без внешних зависимостей.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

function loadEnvFile() {
  try {
    const raw = readFileSync(join(rootDir, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Снимаем кавычки, если есть.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // .env отсутствует — используем переменные окружения и значения по умолчанию.
  }
}

loadEnvFile();

const bool = (v, def) => (v == null ? def : /^(1|true|yes|on)$/i.test(v));
const num = (v, def) => (v == null || v === '' ? def : Number(v));

export const config = {
  rootDir,
  // Каталог для записи (сессии, пользовательские провайдеры, сборка плагина).
  // В упакованном Electron переопределяется на userData через env.
  dataDir: process.env.ROBLOX_AI_DATA_DIR || rootDir,
  port: num(process.env.PORT, 8787),
  bridgeToken: process.env.BRIDGE_TOKEN || 'change-me',

  provider: process.env.LLM_PROVIDER || 'anthropic',
  model: process.env.LLM_MODEL || 'claude-opus-4-8',
  temperature: num(process.env.LLM_TEMPERATURE, 0.7),
  maxTokens: num(process.env.LLM_MAX_TOKENS, 4096),

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  },
  local: {
    apiKey: process.env.LOCAL_API_KEY || 'not-needed',
    baseUrl: process.env.LOCAL_BASE_URL || 'http://localhost:11434/v1',
    model: process.env.LOCAL_MODEL || 'llama3.1',
  },

  compressThreshold: num(process.env.CONTEXT_COMPRESS_THRESHOLD, 6000),
  allowLocalExec: bool(process.env.ALLOW_LOCAL_EXEC, false),

  // Prompt caching (Anthropic): кэш системного промпта и схем инструментов между
  // запросами — главный рычаг экономии токенов. Отключить: PROMPT_CACHE=false.
  promptCache: bool(process.env.PROMPT_CACHE, true),
  // Локальный ПК-агент: ПК-инструменты, когда Studio не подключён.
  // По умолчанию включён — это локальное приложение пользователя.
  pcAgent: bool(process.env.PC_AGENT, true),
};
