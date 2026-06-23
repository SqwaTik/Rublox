// Автоустановка рантаймов для песочницы (run_code_sandbox). Главный — Luau (один
// небольшой exe, нужен для проверки Roblox-логики). Скачиваем официальный релиз
// с GitHub, распаковываем в локальную папку приложения и САМИ добавляем её в PATH
// — и в текущий процесс (чтобы песочница сразу его видела), и в пользовательский
// PATH Windows (чтобы видели и другие программы). Без внешних зависимостей.

import { config } from './config.js';
import { join, delimiter } from 'node:path';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir, platform } from 'node:os';

// Локальная папка рантаймов (в userData у упакованного приложения — она записываемая).
export const runtimesDir = join(config.dataDir, 'data', 'runtimes');

// Добавить папку рантаймов в PATH ТЕКУЩЕГО процесса (дочерние процессы наследуют).
export function ensureRuntimesOnPath() {
  try { mkdirSync(runtimesDir, { recursive: true }); } catch { /* */ }
  const parts = (process.env.PATH || '').split(delimiter);
  if (!parts.some((p) => p && p.toLowerCase() === runtimesDir.toLowerCase())) {
    process.env.PATH = runtimesDir + delimiter + (process.env.PATH || '');
  }
}
// Выполняется при импорте — песочница сразу видит уже скачанные ранее рантаймы.
ensureRuntimesOnPath();

// Запуск процесса с захватом вывода (промис).
function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch (e) { resolve({ code: null, out: '', err: e.message }); return; }
    const t = setTimeout(() => { try { child.kill(); } catch { /* */ } if (!done) { done = true; resolve({ code: null, out, err: err + '\n(таймаут)' }); } }, timeout);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(t); resolve({ code: null, out, err: err + '\n' + e.message }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }); } });
  });
}

// Есть ли уже рабочий рантайм (по имени команды)? ENOENT → нет.
function hasRuntime(cmd) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, ['--version'], { windowsHide: true }); }
    catch { resolve(false); return; }
    let settled = false;
    const fin = (v) => { if (!settled) { settled = true; resolve(v); } };
    p.on('error', (e) => fin(e && e.code !== 'ENOENT'));
    p.on('close', () => fin(true));
    setTimeout(() => { try { p.kill(); } catch { /* */ } fin(true); }, 4000);
  });
}

// Имя ассета релиза Luau под текущую ОС.
function luauAssetName() {
  const p = platform();
  if (p === 'win32') return 'luau-windows.zip';
  if (p === 'darwin') return 'luau-macos.zip';
  return 'luau-ubuntu.zip';
}

const GH_HEADERS = { 'user-agent': 'Rublox-runtime-installer', accept: 'application/vnd.github+json' };

// Скачать и распаковать Luau в runtimesDir. Возвращает строку-статус.
async function installLuau() {
  ensureRuntimesOnPath();
  const exe = platform() === 'win32' ? 'luau.exe' : 'luau';
  const target = join(runtimesDir, exe);
  if (existsSync(target)) return `Luau уже установлен: ${target}`;

  // 1) Узнаём последний релиз и ссылку на нужный ассет.
  let assetUrl = null, ver = '';
  try {
    const rel = await fetch('https://api.github.com/repos/luau-lang/luau/releases/latest', { headers: GH_HEADERS });
    if (!rel.ok) throw new Error(`GitHub API HTTP ${rel.status}`);
    const data = await rel.json();
    ver = data.tag_name || '';
    const want = luauAssetName();
    const asset = (data.assets || []).find((a) => a.name === want);
    if (!asset) throw new Error(`в релизе нет ассета ${want}`);
    assetUrl = asset.browser_download_url;
  } catch (e) {
    return `Не удалось узнать релиз Luau: ${e.message}. Установи вручную: github.com/luau-lang/luau/releases`;
  }

  // 2) Скачиваем zip во временный файл.
  const zip = join(tmpdir(), `rublox-luau-${Date.now()}.zip`);
  try {
    const res = await fetch(assetUrl, { headers: { 'user-agent': 'Rublox-runtime-installer' } });
    if (!res.ok) throw new Error(`скачивание HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(zip, buf);
  } catch (e) {
    return `Не удалось скачать Luau: ${e.message}`;
  }

  // 3) Распаковываем (Windows — Expand-Archive; иначе unzip).
  try {
    if (platform() === 'win32') {
      const r = await run('powershell.exe', ['-NoProfile', '-Command',
        `Expand-Archive -Path '${zip}' -DestinationPath '${runtimesDir}' -Force`]);
      if (!existsSync(target) && r.code !== 0) throw new Error(r.err || 'Expand-Archive failed');
    } else {
      const r = await run('unzip', ['-o', zip, '-d', runtimesDir]);
      if (!existsSync(target) && r.code !== 0) throw new Error(r.err || 'unzip failed');
      await run('chmod', ['+x', target]);
    }
  } catch (e) {
    return `Не удалось распаковать Luau: ${e.message}`;
  } finally {
    try { rmSync(zip, { force: true }); } catch { /* */ }
  }

  if (!existsSync(target)) return 'Распаковка прошла, но luau не найден в архиве — формат релиза изменился?';

  // 4) Кладём папку в пользовательский PATH Windows (best-effort, не критично).
  await persistUserPath();

  // 5) Проверяем, что запускается.
  const check = await run(target, ['--version'], { timeout: 8000 });
  const v = (check.out || check.err || '').trim().split('\n')[0];
  return `Luau ${ver || ''} установлен в ${target} и добавлен в PATH. ${v ? 'Версия: ' + v : ''}`.trim();
}

// Добавить runtimesDir в ПОЛЬЗОВАТЕЛЬСКИЙ PATH Windows (через .NET API, без обрезки
// как у setx). Best-effort: если не вышло — рантайм всё равно работает в процессе.
async function persistUserPath() {
  if (platform() !== 'win32') return;
  const ps =
    `$d='${runtimesDir}'; ` +
    `$p=[Environment]::GetEnvironmentVariable('Path','User'); ` +
    `if(($p -split ';') -notcontains $d){ ` +
    `[Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $d), 'User') }`;
  try { await run('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15000 }); } catch { /* */ }
}

// Главная точка: гарантировать рантайм для языка песочницы. Автоустановка — только
// для luau/lua (один маленький exe). node/python ставить автоматически не беремся
// (тяжёлые инсталляторы) — даём понятную инструкцию.
export async function ensureRuntime(lang) {
  const l = String(lang || '').toLowerCase();
  if (l === 'lua' || l === 'luau') {
    if (await hasRuntime('luau')) return { ok: true, message: 'Luau уже доступен.' };
    const msg = await installLuau();
    const ok = await hasRuntime('luau');
    return { ok, message: msg };
  }
  if (l === 'javascript' || l === 'js') {
    const ok = await hasRuntime('node');
    return { ok, message: ok ? 'Node доступен.' : 'Node не найден (но Rublox сам на Node — странно). Установи nodejs.org.' };
  }
  if (l === 'python' || l === 'py') {
    const ok = await hasRuntime('python') || await hasRuntime('python3');
    return { ok, message: ok ? 'Python доступен.' : 'Python не найден. Установи с python.org и поставь галочку «Add to PATH».' };
  }
  return { ok: false, message: `Автоустановка для «${l}» не поддерживается. Установи рантайм вручную.` };
}
