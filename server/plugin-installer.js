// Сборка .rbxm из Lua-исходника плагина и авто-установка в папку плагинов Roblox.
//
// Studio определяет формат модели по содержимому (а не по расширению), поэтому
// мы кладём XML-модель Roblox в файл с расширением .rbxm — Studio её загрузит
// как обычный плагин. Бинарный .rbxm генерировать вручную не нужно.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { config } from './config.js';
import { getBridgeToken } from './app-config.js';

// Исходник плагина: в dev — в rootDir/plugin, в упакованном — в resources/plugin.
function findPluginLua() {
  const names = ['RubloxPlugin.server.lua', 'AIAssistantPlugin.server.lua'];
  const dirs = [
    join(config.rootDir, 'plugin'),
    process.resourcesPath ? join(process.resourcesPath, 'plugin') : null,
  ].filter(Boolean);
  for (const d of dirs) {
    for (const n of names) {
      const c = join(d, n);
      if (existsSync(c)) return c;
    }
  }
  return join(dirs[0], names[0]);
}

// Версия ВСТРОЕННОГО плагина (из исходника) — с ней сервер сравнивает версию
// плагина, подключённого в Studio, чтобы предлагать переустановку только когда
// бандл реально новее (а не на каждый апдейт приложения).
export function bundledPluginVersion() {
  try {
    const src = readFileSync(findPluginLua(), 'utf8');
    const m = src.match(/PLUGIN_VERSION\s*=\s*["']([\d.]+)["']/);
    return m ? m[1] : config.version;
  } catch { return config.version; }
}

const buildDir = join(config.dataDir, 'build');

// Экранирование для XML-CDATA: разбиваем последовательность ]]>, если встретится.
function cdataSafe(src) {
  return src.replace(/\]\]>/g, ']]]]><![CDATA[>');
}

// Подставляет актуальные URL сервера и токен прямо в исходник плагина, чтобы
// пользователю не нужно было вводить их вручную — достаточно нажать Connect.
function injectConfig(lua) {
  const url = `http://localhost:${config.port}`;
  const token = getBridgeToken();
  return lua
    .replace(/local serverUrl = "[^"]*"/, `local serverUrl = "${url}"`)
    .replace(/local token = "[^"]*"/, `local token = "${token}"`);
}

// Генерирует модель .rbxm (XML внутри) с одним Script — исходником плагина.
export function buildRbxm() {
  const lua = injectConfig(readFileSync(findPluginLua(), 'utf8'));
  const xml = `<roblox version="4">
  <Item class="Script" referent="RBX0">
    <Properties>
      <string name="Name">RubloxPlugin</string>
      <ProtectedString name="Source"><![CDATA[${cdataSafe(lua)}]]></ProtectedString>
      <token name="RunContext">0</token>
    </Properties>
  </Item>
</roblox>`;
  if (!existsSync(buildDir)) mkdirSync(buildDir, { recursive: true });
  const out = join(buildDir, 'Rublox.rbxm');
  writeFileSync(out, xml, 'utf8');
  return out;
}

// Путь к папке локальных плагинов Roblox Studio по ОС.
export function pluginsDir() {
  const home = homedir();
  const p = platform();
  if (p === 'win32') {
    // %LOCALAPPDATA%\Roblox\Plugins
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(local, 'Roblox', 'Plugins');
  }
  if (p === 'darwin') {
    return join(home, 'Documents', 'Roblox', 'Plugins');
  }
  // Linux (часто Roblox через Wine) — кладём в Documents как запасной вариант.
  return join(home, 'Documents', 'Roblox', 'Plugins');
}

// Собирает .rbxm и копирует его в папку плагинов Studio.
export function installPlugin() {
  const rbxm = buildRbxm();
  const dir = pluginsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dest = join(dir, 'Rublox.rbxm');
  writeFileSync(dest, readFileSync(rbxm));
  return {
    ok: true,
    installedTo: dest,
    pluginsDir: dir,
    message:
      'Плагин Rublox установлен (URL и токен уже встроены). Перезапустите Studio ' +
      'или переоткройте плейс — Rublox появится на вкладке Plugins. Затем нажмите ' +
      'Connect в панели плагина.',
  };
}

