// ПК-инструменты — активны, когда Studio не
// подключён. Выполнение команд (powershell/cmd/bash) и работа с файлами.
//
// ВНИМАНИЕ: даёт ИИ полный доступ к компьютеру пользователя. Включается тумблером
// в настройках (по умолчанию включён, т.к. это локальное приложение пользователя).

import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync,
  statSync, existsSync, rmSync, renameSync, copyFileSync, cpSync,
} from 'node:fs';
import { homedir, platform, arch, hostname, cpus, totalmem, freemem } from 'node:os';
import { resolve, join, relative, sep, basename, dirname, extname } from 'node:path';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const MAX_OUT = 12000;
function clip(s) {
  s = String(s ?? '');
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + '\n…(вывод обрезан)' : s;
}

export async function runCommand(args) {
  const command = String(args.command || '').trim();
  if (!command) return 'Пустая команда.';
  const opts = {
    cwd: args.cwd && existsSync(args.cwd) ? args.cwd : homedir(),
    timeout: Number(args.timeout) || 60000,
    maxBuffer: 1024 * 1024 * 16,
    windowsHide: true,
  };
  try {
    let res;
    if (process.platform === 'win32') {
      const sh = String(args.shell || 'powershell').toLowerCase();
      if (sh === 'cmd') {
        res = await execAsync(command, opts);
      } else if (sh === 'bash') {
        res = await execFileAsync('bash.exe', ['-lc', command], opts);
      } else {
        res = await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
          opts
        );
      }
    } else {
      res = await execFileAsync('/bin/bash', ['-lc', command], opts);
    }
    const out = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
    return clip(out || '(команда выполнена, пустой вывод)');
  } catch (e) {
    const out = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim();
    return clip(`Ошибка выполнения:\n${out}`);
  }
}

export function readFileTool(args) {
  const path = String(args.path || '');
  if (!path) return 'Не указан path.';
  try {
    return clip(readFileSync(path, 'utf8'));
  } catch (e) {
    return `Ошибка чтения: ${e.message}`;
  }
}

export function writeFileTool(args) {
  const path = String(args.path || '');
  if (!path) return 'Не указан path.';
  try {
    const dir = resolve(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, String(args.content ?? ''), 'utf8');
    return `Записано: ${path} (${String(args.content ?? '').length} символов)`;
  } catch (e) {
    return `Ошибка записи: ${e.message}`;
  }
}

export function editFileTool(args) {
  const path = String(args.path || '');
  if (!path) return 'Не указан path.';
  const oldStr = String(args.oldText ?? '');
  const newStr = String(args.newText ?? '');
  if (!oldStr) return 'Нужен oldText для замены.';
  try {
    const src = readFileSync(path, 'utf8');
    const count = src.split(oldStr).length - 1;
    if (count === 0) return 'Фрагмент oldText не найден в файле.';
    if (count > 1 && !args.replaceAll) {
      return `Фрагменту oldText соответствует ${count} мест. Уточните контекст или передайте replaceAll=true.`;
    }
    const next = args.replaceAll ? src.split(oldStr).join(newStr) : src.replace(oldStr, newStr);
    writeFileSync(path, next, 'utf8');
    return `Файл изменён: ${path} (замен: ${args.replaceAll ? count : 1})`;
  } catch (e) {
    return `Ошибка правки: ${e.message}`;
  }
}

export function listDirTool(args) {
  const path = String(args.path || homedir());
  try {
    const entries = readdirSync(path).slice(0, 300).map((name) => {
      try {
        const st = statSync(resolve(path, name));
        return (st.isDirectory() ? '[dir] ' : '      ') + name + (st.isDirectory() ? '' : ` (${st.size}b)`);
      } catch {
        return '      ' + name;
      }
    });
    return clip(`${path}\n` + entries.join('\n'));
  } catch (e) {
    return `Ошибка списка: ${e.message}`;
  }
}

export function makeDirTool(args) {
  const path = String(args.path || '');
  if (!path) return 'Не указан path.';
  try {
    mkdirSync(path, { recursive: true });
    return `Создан каталог: ${path}`;
  } catch (e) {
    return `Ошибка: ${e.message}`;
  }
}

// ── Расширенный набор ПК-инструментов ──────────────────────────────

// Удалить файл или каталог (рекурсивно). Необратимо — только по явной просьбе.
export function deletePathTool(args) {
  const path = String(args.path || '');
  if (!path) return 'Не указан path.';
  if (!existsSync(path)) return `Путь не существует: ${path}`;
  try {
    const st = statSync(path);
    rmSync(path, { recursive: true, force: true });
    return `Удалено: ${path}${st.isDirectory() ? ' (каталог)' : ''}`;
  } catch (e) {
    return `Ошибка удаления: ${e.message}`;
  }
}

// Переместить/переименовать файл или каталог.
export function moveTool(args) {
  const from = String(args.from || '');
  const to = String(args.to || '');
  if (!from || !to) return 'Нужны from и to.';
  try {
    const dir = resolve(to, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    renameSync(from, to);
    return `Перемещено: ${from} → ${to}`;
  } catch (e) {
    return `Ошибка перемещения: ${e.message}`;
  }
}

// Скопировать файл или каталог (рекурсивно).
export function copyTool(args) {
  const from = String(args.from || '');
  const to = String(args.to || '');
  if (!from || !to) return 'Нужны from и to.';
  try {
    const st = statSync(from);
    if (st.isDirectory()) {
      cpSync(from, to, { recursive: true });
    } else {
      const dir = resolve(to, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      copyFileSync(from, to);
    }
    return `Скопировано: ${from} → ${to}`;
  } catch (e) {
    return `Ошибка копирования: ${e.message}`;
  }
}

// Дописать текст в конец файла (создаёт файл при отсутствии).
export function appendFileTool(args) {
  const path = String(args.path || '');
  if (!path) return 'Не указан path.';
  try {
    const dir = resolve(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, String(args.content ?? ''), 'utf8');
    return `Дописано в ${path} (${String(args.content ?? '').length} символов)`;
  } catch (e) {
    return `Ошибка: ${e.message}`;
  }
}

// Прочитать файл с номерами строк и/или диапазоном (offset/limit).
export function readLinesTool(args) {
  const path = String(args.path || '');
  if (!path) return 'Не указан path.';
  try {
    const lines = readFileSync(path, 'utf8').split('\n');
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Number(args.limit) > 0 ? Number(args.limit) : lines.length;
    const slice = lines.slice(offset, offset + limit);
    const numbered = slice.map((ln, i) => `${String(offset + i + 1).padStart(5)}\t${ln}`);
    return clip(numbered.join('\n') || '(пусто)');
  } catch (e) {
    return `Ошибка чтения: ${e.message}`;
  }
}

// Метаданные пути: размер, тип, даты.
export function statTool(args) {
  const path = String(args.path || '');
  if (!path) return 'Не указан path.';
  try {
    const st = statSync(path);
    return [
      `path: ${path}`,
      `тип: ${st.isDirectory() ? 'каталог' : 'файл'}`,
      `размер: ${st.size} b`,
      `изменён: ${st.mtime.toISOString()}`,
      `создан: ${st.birthtime.toISOString()}`,
    ].join('\n');
  } catch (e) {
    return `Ошибка: ${e.message}`;
  }
}

// Проверка существования.
export function existsTool(args) {
  const path = String(args.path || '');
  if (!path) return 'Не указан path.';
  return existsSync(path) ? `Существует: ${path}` : `Не существует: ${path}`;
}

// Рекурсивный поиск файлов по glob-подобному шаблону имени (*, ?).
export function globTool(args) {
  const root = String(args.path || homedir());
  const pattern = String(args.pattern || '*');
  const re = globToRegExp(pattern);
  const max = Number(args.limit) > 0 ? Number(args.limit) : 500;
  const found = [];
  walk(root, 0, 12, (full, name) => {
    if (re.test(name)) found.push(full);
    return found.length < max;
  });
  if (!found.length) return `Ничего не найдено по "${pattern}" в ${root}.`;
  return clip(found.join('\n'));
}

// Поиск текста по содержимому файлов (как grep -rn).
export function grepTool(args) {
  const root = String(args.path || homedir());
  const needle = String(args.pattern || '');
  if (!needle) return 'Нужен pattern.';
  let re;
  try {
    re = new RegExp(needle, args.ignoreCase ? 'i' : '');
  } catch (e) {
    return `Неверное регулярное выражение: ${e.message}`;
  }
  const glob = args.glob ? globToRegExp(String(args.glob)) : null;
  const max = Number(args.limit) > 0 ? Number(args.limit) : 200;
  const hits = [];
  walk(root, 0, 12, (full, name) => {
    if (glob && !glob.test(name)) return true;
    try {
      if (statSync(full).size > 2 * 1024 * 1024) return true; // пропускаем большие
      const lines = readFileSync(full, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= max) return false;
        }
      }
    } catch { /* бинарь/нет доступа — пропускаем */ }
    return hits.length < max;
  });
  if (!hits.length) return `Совпадений "${needle}" не найдено.`;
  return clip(hits.join('\n'));
}

// Дерево каталога (как tree, с ограничением глубины).
export function treeTool(args) {
  const root = String(args.path || homedir());
  const maxDepth = Math.min(Number(args.depth) || 3, 8);
  const out = [root];
  const max = 600;
  function rec(dir, depth, prefix) {
    if (depth > maxDepth || out.length >= max) return;
    let entries;
    try {
      entries = readdirSync(dir).sort();
    } catch { return; }
    for (const name of entries) {
      if (out.length >= max) return;
      if (name === 'node_modules' || name === '.git') continue;
      const full = join(dir, name);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { /* skip */ }
      out.push(`${prefix}${isDir ? '📁 ' : '   '}${name}`);
      if (isDir) rec(full, depth + 1, prefix + '  ');
    }
  }
  rec(root, 1, '  ');
  return clip(out.join('\n'));
}

// Информация о системе.
export function sysInfoTool() {
  const gb = (b) => (b / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  return [
    `ОС: ${platform()} ${arch()}`,
    `Хост: ${hostname()}`,
    `CPU: ${cpus()[0]?.model || '?'} ×${cpus().length}`,
    `Память: ${gb(freemem())} свободно из ${gb(totalmem())}`,
    `Домашний каталог: ${homedir()}`,
    `Node: ${process.version}`,
    `CWD сервера: ${process.cwd()}`,
  ].join('\n');
}

// Текущий рабочий каталог процесса сервера.
export function cwdTool() {
  return process.cwd();
}

// ── Вспомогательное ──

function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + esc + '$', 'i');
}

// Обход дерева с колбэком; cb возвращает false → останавливаем обход.
function walk(root, depth, maxDepth, cb) {
  if (depth > maxDepth) return true;
  let entries;
  try {
    entries = readdirSync(root);
  } catch { return true; }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(root, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (!walk(full, depth + 1, maxDepth, cb)) return false;
    } else {
      if (!cb(full, name)) return false;
    }
  }
  return true;
}
