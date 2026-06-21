// Постоянные настройки приложения (отдельно от .env): bridge-токен для плагина.
// Хранится в data/app.json. Токен генерируется автоматически при первом запуске,
// чтобы пользователю не приходилось придумывать его вручную и чтобы дефолтный
// 'change-me' не оставался в проде.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';

const file = join(config.dataDir, 'data', 'app.json');

function read() {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function write(obj) {
  try {
    const dir = join(config.dataDir, 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2));
    return true;
  } catch (err) {
    console.warn('app-config write:', err.message);
    return false;
  }
}

function generateToken() {
  return 'rbx_' + randomBytes(18).toString('hex');
}

// Возвращает актуальный bridge-токен. Приоритет: сохранённый → из .env (если он
// не дефолтный) → свежесгенерированный (с сохранением на диск).
export function getBridgeToken() {
  const stored = read();
  if (stored.bridgeToken) return stored.bridgeToken;
  const envToken = process.env.BRIDGE_TOKEN;
  const token = envToken && envToken !== 'change-me' ? envToken : generateToken();
  write({ ...stored, bridgeToken: token });
  return token;
}

export function setBridgeToken(token) {
  const t = String(token || '').trim();
  const stored = read();
  const next = t || generateToken();
  write({ ...stored, bridgeToken: next });
  return next;
}

export function regenerateBridgeToken() {
  return setBridgeToken(generateToken());
}

// Тумблер локального ПК-агента (ПК-инструменты), когда Studio выключен.
export function getPcAgent() {
  const stored = read();
  if (typeof stored.pcAgent === 'boolean') return stored.pcAgent;
  return config.pcAgent; // дефолт из .env (по умолчанию true)
}

export function setPcAgent(value) {
  const stored = read();
  const v = !!value;
  write({ ...stored, pcAgent: v });
  return v;
}

// Универсальный доступ к app.json для прочих настроек (скиллы/плагины и т.п.).
export function appConfigGet(key, fallback) {
  const stored = read();
  return Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : fallback;
}

export function appConfigSet(key, value) {
  const stored = read();
  write({ ...stored, [key]: value });
  return value;
}
