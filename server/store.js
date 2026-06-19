// Хранение сессий на диске: история, резюме, настройки.
// Файлы лежат в data/sessions/<id>.json. Без внешних зависимостей.

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

const dataDir = join(config.dataDir, 'data', 'sessions');

function ensureDir() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
}

function fileFor(id) {
  // Защита от выхода за пределы каталога: оставляем только безопасные символы.
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(dataDir, `${safe}.json`);
}

// Сериализуемый снимок сессии.
export function saveSession(session) {
  try {
    ensureDir();
    if (!session.createdAt) session.createdAt = new Date().toISOString();
    const snapshot = {
      id: session.id,
      title: session.title,
      titleManual: session.titleManual,
      provider: session.provider,
      model: session.model,
      thinking: session.thinking,
      messages: session.messages,
      summary: session.summary,
      contextNotes: session.contextNotes,
      systemPersona: session.systemPersona,
      createdAt: session.createdAt,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(fileFor(session.id), JSON.stringify(snapshot, null, 2));
    return true;
  } catch (err) {
    console.warn('saveSession:', err.message);
    return false;
  }
}

export function loadSessionData(id) {
  try {
    const raw = readFileSync(fileFor(id), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('loadSession:', err.message);
    return null;
  }
}

export function deleteSessionFile(id) {
  try {
    rmSync(fileFor(id));
    return true;
  } catch {
    return false;
  }
}

export function listSessionIds() {
  try {
    ensureDir();
    return readdirSync(dataDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}
