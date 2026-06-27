// GLB→FBX через Blender в фоновом режиме. Нужно, чтобы бесплатные генераторы 3D
// (TRELLIS и др.), которые отдают GLB, можно было загрузить в Roblox Open Cloud —
// он принимает для Model только FBX.
//
// Стратегия (как просил пользователь — «оба»):
//   1) если Blender уже установлен (в PATH или в стандартных папках) — используем его;
//   2) иначе АВТО-скачиваем портативный Blender в data/runtimes/blender и используем.
//
// Без внешних npm-зависимостей: глоб. fetch + spawn + PowerShell Expand-Archive.

import { config } from './config.js';
import { join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir, platform } from 'node:os';
import { runtimesDir } from './runtime-installer.js';

const blenderDir = join(runtimesDir, 'blender');

// Портативный Blender (LTS). Версию/URL можно переопределить через env.
const BLENDER_VERSION = process.env.BLENDER_VERSION || '4.2.3';
function blenderZipUrl() {
  const v = BLENDER_VERSION;
  const major = v.split('.').slice(0, 2).join('.'); // 4.2
  const p = platform();
  if (p === 'win32') return process.env.BLENDER_URL || `https://download.blender.org/release/Blender${major}/blender-${v}-windows-x64.zip`;
  if (p === 'darwin') return process.env.BLENDER_URL || `https://download.blender.org/release/Blender${major}/blender-${v}-macos-x64.dmg`;
  return process.env.BLENDER_URL || `https://download.blender.org/release/Blender${major}/blender-${v}-linux-x64.tar.xz`;
}

function run(cmd, args, { timeout = 600000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, child;
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch (e) { resolve({ code: null, out: '', err: e.message }); return; }
    const t = setTimeout(() => { try { child.kill(); } catch { /* */ } if (!done) { done = true; resolve({ code: null, out, err: err + '\n(таймаут)' }); } }, timeout);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(t); resolve({ code: null, out, err: err + '\n' + e.message }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }); } });
  });
}

// Рекурсивно ищем blender.exe/blender в каталоге (распакованный архив кладёт его в подпапку).
function findBlenderExe(dir) {
  const exe = platform() === 'win32' ? 'blender.exe' : 'blender';
  if (!existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = readdirSync(d); } catch { continue; }
    for (const name of entries) {
      const full = join(d, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) stack.push(full);
      else if (name.toLowerCase() === exe) return full;
    }
  }
  return null;
}

// Проверить, запускается ли blender по пути/команде.
function works(cmd) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, ['--version'], { windowsHide: true }); }
    catch { resolve(false); return; }
    let settled = false;
    const fin = (v) => { if (!settled) { settled = true; resolve(v); } };
    p.on('error', () => fin(false));
    p.on('close', (code) => fin(code === 0 || code === null));
    setTimeout(() => { try { p.kill(); } catch { /* */ } fin(true); }, 6000);
  });
}

// Стандартные места установки Blender на Windows.
function commonInstallPaths() {
  if (platform() !== 'win32') return ['/usr/bin/blender', '/usr/local/bin/blender', '/Applications/Blender.app/Contents/MacOS/Blender'];
  const bases = [process.env['ProgramFiles'] || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'];
  const found = [];
  for (const base of bases) {
    const bf = join(base, 'Blender Foundation');
    if (!existsSync(bf)) continue;
    try {
      for (const v of readdirSync(bf)) {
        const exe = join(bf, v, 'blender.exe');
        if (existsSync(exe)) found.push(exe);
      }
    } catch { /* */ }
  }
  return found;
}

let cachedBlender = null;

// Найти Blender: PATH → стандартные папки → ранее скачанный портативный.
export async function findBlender() {
  if (cachedBlender && existsSync(cachedBlender)) return cachedBlender;
  // 1) в PATH
  if (await works('blender')) { cachedBlender = 'blender'; return 'blender'; }
  // 2) стандартные установки
  for (const p of commonInstallPaths()) {
    if (existsSync(p) && await works(p)) { cachedBlender = p; return p; }
  }
  // 3) портативный, скачанный ранее
  const local = findBlenderExe(blenderDir);
  if (local && await works(local)) { cachedBlender = local; return local; }
  return null;
}

// Гарантировать наличие Blender: найти или скачать. Возвращает {ok, path, message}.
export async function ensureBlender(onProgress) {
  const existing = await findBlender();
  if (existing) return { ok: true, path: existing, message: 'Blender найден.' };
  if (platform() !== 'win32') {
    return { ok: false, path: null, message: 'Авто-скачивание Blender реализовано для Windows. Установите Blender вручную (blender.org) — он подхватится из PATH.' };
  }
  try { mkdirSync(blenderDir, { recursive: true }); } catch { /* */ }
  const url = blenderZipUrl();
  const zip = join(tmpdir(), `rublox-blender-${Date.now()}.zip`);
  // Скачиваем (~300 МБ) с индикацией прогресса по возможности.
  try {
    if (onProgress) onProgress(0, 'скачивание Blender');
    const res = await fetch(url, { headers: { 'user-agent': 'Rublox-blender-installer' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      got += value.length;
      if (onProgress && total) onProgress(Math.round((got / total) * 100), 'скачивание Blender');
    }
    writeFileSync(zip, Buffer.concat(chunks));
  } catch (e) {
    return { ok: false, path: null, message: `Не удалось скачать Blender: ${e.message}. Можно установить вручную с blender.org — подхватится автоматически.` };
  }
  // Распаковываем.
  try {
    if (onProgress) onProgress(100, 'распаковка');
    const r = await run('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -Path '${zip}' -DestinationPath '${blenderDir}' -Force`], { timeout: 300000 });
    if (r.code !== 0 && !findBlenderExe(blenderDir)) throw new Error(r.err || 'Expand-Archive failed');
  } catch (e) {
    return { ok: false, path: null, message: `Не удалось распаковать Blender: ${e.message}` };
  } finally {
    try { rmSync(zip, { force: true }); } catch { /* */ }
  }
  const exe = findBlenderExe(blenderDir);
  if (!exe || !(await works(exe))) return { ok: false, path: null, message: 'Blender скачан, но запустить не удалось.' };
  cachedBlender = exe;
  return { ok: true, path: exe, message: `Blender ${BLENDER_VERSION} установлен.` };
}

// Конвертировать GLB-буфер в FBX-буфер через Blender headless.
export async function glbToFbx(glbBuffer, { onProgress } = {}) {
  const ens = await ensureBlender(onProgress);
  if (!ens.ok) throw new Error(ens.message);
  const blender = ens.path;

  const work = join(tmpdir(), `rublox-conv-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const inGlb = join(work, 'in.glb');
  const outFbx = join(work, 'out.fbx');
  const pyFile = join(work, 'conv.py');
  writeFileSync(inGlb, glbBuffer);
  // Скрипт Blender: чистый старт → импорт glTF/GLB → экспорт FBX (с текстурами).
  const py =
    'import bpy, sys\n' +
    'argv = sys.argv[sys.argv.index("--")+1:]\n' +
    'inp, outp = argv[0], argv[1]\n' +
    'bpy.ops.wm.read_factory_settings(use_empty=True)\n' +
    'bpy.ops.import_scene.gltf(filepath=inp)\n' +
    'bpy.ops.export_scene.fbx(filepath=outp, path_mode="COPY", embed_textures=True, use_selection=False, apply_unit_scale=True)\n';
  writeFileSync(pyFile, py);

  if (onProgress) onProgress(50, 'конвертация GLB→FBX');
  const r = await run(blender, ['--background', '--factory-startup', '--python', pyFile, '--', inGlb, outFbx], { timeout: 300000 });
  if (!existsSync(outFbx)) {
    const tail = ((r.err || '') + (r.out || '')).slice(-400);
    try { rmSync(work, { recursive: true, force: true }); } catch { /* */ }
    throw new Error(`Blender не создал FBX (code ${r.code}). ${tail}`);
  }
  const fbx = readFileSync(outFbx);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* */ }
  return fbx;
}
