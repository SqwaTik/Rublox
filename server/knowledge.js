// База знаний агента (самообучение). Агент записывает сюда выводы из опыта —
// рабочие приёмы, устройство конкретных карт/механик, частые грабли — а сервер
// подмешивает их в системный промпт во ВСЕ чаты. Так со временем ассистент
// делает типовые задачи быстрее и сразу правильно.
//
// Хранилище — data/knowledge.json: { items: [{ id, text, tags[], source, at }] }.
// Записи компактные (1–3 предложения). Дубликаты по тексту схлопываются.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const file = join(config.dataDir, 'data', 'knowledge.json');
const MAX_ITEMS = 300;          // верхний предел записей (старые вытесняются)
const MAX_PROMPT_CHARS = 2600;  // сколько максимум знаний влить в системный промпт

function read() {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(j.items) ? j.items : [];
  } catch { return []; }
}

function write(items) {
  try {
    const dir = join(config.dataDir, 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ items }, null, 2));
  } catch (err) { console.warn('knowledge write:', err.message); }
}

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');

// Добавить знание. Возвращает запись (или существующую при дубле).
export function addKnowledge(text, { tags = [], source = 'agent' } = {}) {
  const t = norm(text);
  if (!t) throw new Error('Пустой текст знания');
  const items = read();
  const dupe = items.find((it) => norm(it.text).toLowerCase() === t.toLowerCase());
  if (dupe) return dupe;
  const item = { id: randomUUID().slice(0, 8), text: t, tags: Array.isArray(tags) ? tags : [], source, at: Date.now() };
  items.push(item);
  // Вытесняем самые старые (но agent-знания приоритетнее импортов при равенстве).
  while (items.length > MAX_ITEMS) items.shift();
  write(items);
  return item;
}

export function listKnowledge() { return read(); }

export function removeKnowledge(id) {
  const items = read();
  const next = items.filter((it) => it.id !== id);
  if (next.length === items.length) return false;
  write(next);
  return true;
}

export function clearKnowledge() { write([]); }

// Блок знаний для системного промпта: свежие записи, сгруппированные по тегам,
// с ограничением по объёму (чтобы не раздувать каждый запрос).
export function knowledgePromptBlock() {
  const items = read();
  if (!items.length) return '';
  // Свежие — в конце; берём с конца, пока не упрёмся в лимит символов.
  const picked = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const line = `- ${items[i].text}` + (items[i].tags.length ? ` [${items[i].tags.join(', ')}]` : '');
    if (used + line.length > MAX_PROMPT_CHARS) break;
    picked.push(line);
    used += line.length + 1;
  }
  if (!picked.length) return '';
  picked.reverse();
  return 'ВЫУЧЕННОЕ (твой накопленный опыт — применяй сразу, не переоткрывай заново):\n' + picked.join('\n');
}
