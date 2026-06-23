// Семантический поиск по коду — главный рычаг экономии токенов на этапе анализа.
//
// Проблема обычного grep: запрос «исправь авторизацию» не находит функцию login(),
// модель перебирает синонимы (auth|signin|register) и тонет в мусоре, а найдя —
// вынуждена вычитывать ВЕСЬ модуль ради одной процедуры. Это двойной расход.
//
// Решение здесь:
//  1) Расширяем запрос синонимами (auth↔login↔signin, save↔persist↔store, …) и
//     разбиваем на токены — ищем по смыслу, а не по точной строке.
//  2) Индексируем файлы по СИМВОЛАМ: для каждого файла извлекаем функции/методы/
//     классы с их ГРАНИЦАМИ (по скобкам/отступам) — для JS/TS/Lua/Python и др.
//  3) Ранжируем символы по совпадению с токенами запроса (имя символа весит
//     сильно, тело — слабее, точное вхождение фразы — бонус).
//  4) Возвращаем ТОЛЬКО топ-N релевантных функций ЦЕЛИКОМ (а не весь файл) с
//     путём и номерами строк. Модель сразу видит нужную процедуру и правит её.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, basename } from 'node:path';
import { homedir } from 'node:os';

// ── Тезаурус синонимов для расширения запроса ──────────────────────────────
// Группы взаимозаменяемых по смыслу слов. Если в запросе есть любое слово группы —
// в поиск добавляются все остальные. Покрывает и англ., и частые русские термины.
const SYNONYMS = [
  ['auth', 'authenticate', 'authentication', 'authorize', 'authorization', 'login', 'signin', 'logon', 'session', 'credential', 'token', 'оауth', 'авторизац', 'вход', 'логин'],
  ['register', 'signup', 'registration', 'enroll', 'create account', 'регистрац'],
  ['logout', 'signout', 'logoff', 'выход'],
  ['save', 'persist', 'store', 'write', 'commit', 'flush', 'сохран', 'запис'],
  ['load', 'fetch', 'read', 'retrieve', 'get', 'query', 'загруз', 'чтен', 'получ'],
  ['delete', 'remove', 'destroy', 'erase', 'drop', 'purge', 'удал'],
  ['update', 'edit', 'modify', 'patch', 'change', 'set', 'обнов', 'измен', 'правк'],
  ['user', 'account', 'profile', 'member', 'пользовател', 'аккаунт'],
  ['validate', 'check', 'verify', 'sanitize', 'guard', 'провер', 'валидац'],
  ['error', 'exception', 'fail', 'failure', 'throw', 'reject', 'ошибк', 'сбой'],
  ['handler', 'callback', 'listener', 'subscribe', 'on', 'emit', 'event', 'событ', 'обработчик'],
  ['render', 'draw', 'paint', 'display', 'show', 'view', 'отрисов', 'рендер'],
  ['request', 'http', 'api', 'endpoint', 'route', 'fetch', 'axios', 'запрос'],
  ['config', 'setting', 'option', 'preference', 'env', 'настройк', 'конфиг'],
  ['connect', 'connection', 'socket', 'websocket', 'bridge', 'подключ', 'соединен'],
  ['parse', 'decode', 'deserialize', 'tokenize', 'разбор', 'парс'],
  ['encode', 'serialize', 'stringify', 'кодиров'],
  ['init', 'initialize', 'setup', 'bootstrap', 'start', 'инициализац', 'запуск'],
  ['build', 'compile', 'bundle', 'сборк', 'постро'],
  ['spawn', 'create', 'instantiate', 'new', 'make', 'созда', 'спавн'],
  ['move', 'translate', 'position', 'walk', 'movement', 'перемещ', 'движен'],
  ['damage', 'hit', 'attack', 'hurt', 'health', 'урон', 'атак', 'здоров'],
  ['animation', 'animate', 'tween', 'cutscene', 'анимац', 'катсцен'],
  ['sound', 'audio', 'music', 'sfx', 'звук', 'аудио'],
];

// Стоп-слова запроса — не несут смысла для поиска символа.
const STOP = new Set([
  'fix', 'the', 'a', 'an', 'in', 'on', 'of', 'to', 'and', 'or', 'for', 'with',
  'function', 'func', 'method', 'code', 'file', 'исправь', 'почини', 'функци',
  'функцию', 'функция', 'метод', 'код', 'файл', 'где', 'найди', 'это', 'для',
  'все', 'этот', 'эта', 'про', 'как', 'что',
]);

const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.lua', '.luau', '.py',
  '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
  '.vue', '.svelte',
]);
const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', 'build', 'release', '.next', 'out',
  'vendor', '__pycache__', '.cache', 'coverage', 'target',
]);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-zа-я0-9_]+/i)
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

// Расширяет токены запроса синонимами. Возвращает Map<token, weight>: исходные
// токены весят 1.0, синонимы — 0.6 (слабее, чтобы точное слово было приоритетнее).
function expandQuery(query) {
  const base = tokenize(query);
  const weights = new Map();
  for (const t of base) weights.set(t, 1.0);
  const lc = String(query || '').toLowerCase();
  for (const group of SYNONYMS) {
    const hit = group.some((w) => lc.includes(w) || base.some((t) => t.startsWith(w) || w.startsWith(t)));
    if (hit) {
      for (const w of group) {
        const wt = tokenize(w);
        for (const part of wt) if (!weights.has(part)) weights.set(part, 0.6);
      }
    }
  }
  return weights;
}

// ── Извлечение символов (функций/классов/методов) с границами ───────────────
// Универсальный подход: ищем строки-«заголовки» функций по языковым паттернам,
// затем определяем конец блока по балансу фигурных скобок (C-подобные) или по
// возврату отступа (Python / Lua с end). Возвращаем [{name, startLine, endLine}].

const HEADER_PATTERNS = [
  // JS/TS: function foo(, const foo = (, foo(...) {, async foo(, class Foo, method(
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z0-9_$]*\s*=>)/,
  /^\s*(?:export\s+)?class\s+([A-Za-z0-9_$]+)/,
  /^\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/,                       // method() {
  /^\s*([A-Za-z0-9_$]+)\s*:\s*(?:async\s*)?function/,            // foo: function
  // Lua: function Name(, local function Name(, Name.Method = function
  /^\s*(?:local\s+)?function\s+([A-Za-z0-9_.:]+)/,
  /^\s*([A-Za-z0-9_.:]+)\s*=\s*function/,
  // Python: def foo(, class Foo:
  /^\s*def\s+([A-Za-z0-9_]+)/,
  /^\s*class\s+([A-Za-z0-9_]+)/,
  // Go / Rust / Java / C#: func, fn, public ... name(
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/,
  /^\s*(?:pub\s+)?fn\s+([A-Za-z0-9_]+)/,
  /^\s*(?:public|private|protected|static|\s)+[A-Za-z0-9_<>\[\]]+\s+([A-Za-z0-9_]+)\s*\(/,
];

function extractSymbols(lines, ext) {
  const symbols = [];
  const braceLang = !['.py'].includes(ext);
  const luaLang = ext === '.lua' || ext === '.luau';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let name = null;
    for (const re of HEADER_PATTERNS) {
      const m = line.match(re);
      if (m) { name = m[1]; break; }
    }
    if (!name) continue;
    let end = i;
    if (luaLang) {
      // Lua: ищем парный end по балансу function/if/for/while/do … end.
      let depth = 0; let started = false;
      for (let j = i; j < lines.length && j < i + 400; j++) {
        const lj = lines[j];
        depth += (lj.match(/\b(function|if|for|while|do|repeat)\b/g) || []).length;
        depth -= (lj.match(/\b(end|until)\b/g) || []).length;
        started = started || depth > 0;
        if (started && depth <= 0) { end = j; break; }
        end = j;
      }
    } else if (braceLang) {
      // C-подобные: баланс фигурных скобок от первой открывающей.
      let depth = 0; let started = false;
      for (let j = i; j < lines.length && j < i + 400; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') depth--;
        }
        if (started && depth <= 0) { end = j; break; }
        end = j;
      }
    } else {
      // Python: блок до возврата к отступу <= отступа заголовка.
      const indent = line.match(/^\s*/)[0].length;
      end = i;
      for (let j = i + 1; j < lines.length && j < i + 400; j++) {
        if (lines[j].trim() === '') { end = j; continue; }
        const ind = lines[j].match(/^\s*/)[0].length;
        if (ind <= indent) break;
        end = j;
      }
    }
    symbols.push({ name, startLine: i, endLine: end });
    // Перепрыгиваем в конец блока, чтобы не плодить вложенные дубликаты верхнего уровня.
    // (вложенные функции всё равно найдём при следующем проходе, если не прыгнули далеко)
  }
  return symbols;
}

function walkFiles(dir, out, budget) {
  if (out.length >= budget) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= budget) return;
    if (e.name.startsWith('.') && e.name !== '.env') { /* allow .env-like skip */ }
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
      walkFiles(full, out, budget);
    } else if (e.isFile() && CODE_EXT.has(extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
}

// Оценка релевантности символа к взвешенным токенам запроса.
function scoreSymbol(sym, bodyLower, nameLower, weights, phraseLower) {
  let score = 0;
  for (const [tok, w] of weights) {
    if (nameLower.includes(tok)) score += w * 8;       // совпадение в ИМЕНИ — сильный сигнал
    const occ = bodyLower.split(tok).length - 1;
    if (occ > 0) score += w * Math.min(occ, 5) * 0.8;  // вхождения в теле — слабее, с насыщением
  }
  // Точная фраза запроса целиком в теле — бонус.
  if (phraseLower && phraseLower.length >= 4 && bodyLower.includes(phraseLower)) score += 6;
  return score;
}

// Публичная точка: семантический поиск.
//   query  — что ищем (естественный язык/имя)
//   root   — корень поиска (по умолчанию домашний каталог)
//   limit  — сколько сниппетов вернуть (по умолчанию 5)
//   maxFileBytes — не читать гигантские файлы
export function codeSearch({ query, root, limit = 5, maxFiles = 1500 } = {}) {
  const q = String(query || '').trim();
  if (!q) return 'Пустой запрос. Укажи, что искать (имя функции, фича, поведение).';
  let base = root ? String(root) : homedir();
  if (base.startsWith('~')) base = join(homedir(), base.slice(1));
  if (!existsSync(base)) return `Путь не найден: ${base}`;
  const st = statSync(base);
  const files = [];
  if (st.isFile()) files.push(base);
  else walkFiles(base, files, maxFiles);
  if (!files.length) return 'Не найдено файлов с кодом в указанном пути.';

  const weights = expandQuery(q);
  const phraseLower = q.toLowerCase();
  const candidates = [];
  let scanned = 0;
  for (const file of files) {
    let content;
    try {
      const fst = statSync(file);
      if (fst.size > 400 * 1024) continue;   // пропускаем очень большие файлы
      content = readFileSync(file, 'utf8');
    } catch { continue; }
    scanned++;
    const lines = content.split('\n');
    const ext = extname(file).toLowerCase();
    const symbols = extractSymbols(lines, ext);
    // Если символов нет (конфиг/markdown-подобное) — оценим файл как один блок по верхушке.
    const units = symbols.length ? symbols : [{ name: basename(file), startLine: 0, endLine: Math.min(lines.length - 1, 40) }];
    for (const sym of units) {
      const body = lines.slice(sym.startLine, sym.endLine + 1).join('\n');
      const score = scoreSymbol(sym, body.toLowerCase(), sym.name.toLowerCase(), weights, phraseLower);
      if (score > 0) {
        candidates.push({ file, name: sym.name, startLine: sym.startLine, endLine: sym.endLine, body, score });
      }
    }
  }
  if (!candidates.length) {
    return `По запросу «${q}» ничего релевантного не найдено среди ${scanned} файлов. ` +
      'Попробуй другие слова или обычный grep_files.';
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, Math.max(1, Math.min(limit, 12)));

  // Формируем компактный, но ПОЛНЫЙ по функциям результат: путь, строки, тело.
  const expanded = [...new Set([...weights.keys()])].slice(0, 12).join(', ');
  const out = [`Семантический поиск «${q}» (синонимы: ${expanded}). ` +
    `Просканировано файлов: ${scanned}, найдено фрагментов: ${candidates.length}. ` +
    `Топ-${top.length} релевантных функций целиком:`];
  for (const c of top) {
    const rel = (() => { try { return relative(base, c.file) || basename(c.file); } catch { return c.file; } })();
    let snippet = c.body;
    // Защита от гигантской функции — обрезаем тело, но помечаем.
    if (snippet.length > 2600) snippet = snippet.slice(0, 2600) + '\n…(тело функции длинное — обрезано)';
    out.push(
      `\n### ${rel}:${c.startLine + 1}-${c.endLine + 1} — ${c.name}() · score ${c.score.toFixed(1)}\n` +
      '```\n' + snippet + '\n```'
    );
  }
  out.push('\nЭто релевантные функции ЦЕЛИКОМ — обычно править нужно прямо здесь, ' +
    'без чтения всего модуля. Если не та — уточни запрос или открой файл по пути выше.');
  return out.join('\n');
}
