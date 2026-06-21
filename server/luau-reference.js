// Доступ к справочнику Luau/Roblox (docs/luau-roblox.md) для инструмента
// luau_reference. Единый источник правды — markdown-файл; здесь он режется на
// темы по заголовкам "## ".

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

function docPath() {
  const candidates = [
    join(config.rootDir, 'docs', 'luau-roblox.md'),
    process.resourcesPath ? join(process.resourcesPath, 'docs', 'luau-roblox.md') : null,
    join(config.dataDir, 'docs', 'luau-roblox.md'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

let cache = null;
function load() {
  if (cache) return cache;
  let raw = '';
  try {
    raw = readFileSync(docPath(), 'utf8');
  } catch {
    raw = '';
  }
  const sections = [];
  const re = /^##\s+(.+)$/gm;
  let m;
  const indices = [];
  while ((m = re.exec(raw)) !== null) indices.push({ title: m[1].trim(), start: m.index });
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i].start;
    const end = i + 1 < indices.length ? indices[i + 1].start : raw.length;
    sections.push({ title: indices[i].title, body: raw.slice(start, end).trim() });
  }
  cache = { raw, sections };
  return cache;
}

export function listLuauTopics() {
  return load().sections.map((s) => s.title);
}

// Возвращает раздел(ы) по теме. Без темы — список доступных тем.
// Тема ищется по подстроке без учёта регистра; совпадения объединяются.
export function getLuauReference(topic) {
  const { sections } = load();
  if (!sections.length) return 'Справочник Luau недоступен (файл docs/luau-roblox.md не найден).';
  if (!topic || !String(topic).trim()) {
    return 'Доступные темы luau_reference:\n- ' + sections.map((s) => s.title).join('\n- ');
  }
  const q = String(topic).toLowerCase();
  const hits = sections.filter((s) => s.title.toLowerCase().includes(q));
  if (!hits.length) {
    // Поиск по телу как запасной вариант.
    const inBody = sections.filter((s) => s.body.toLowerCase().includes(q));
    if (!inBody.length) {
      return `Тема "${topic}" не найдена. Доступно:\n- ` + sections.map((s) => s.title).join('\n- ');
    }
    return inBody.slice(0, 3).map((s) => s.body).join('\n\n');
  }
  return hits.slice(0, 4).map((s) => s.body).join('\n\n');
}
