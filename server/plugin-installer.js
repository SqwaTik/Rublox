// Сборка .rbxm из Lua-исходника плагина и авто-установка в папку плагинов Roblox.
//
// Studio определяет формат модели по содержимому (а не по расширению), поэтому
// мы кладём XML-модель Roblox в файл с расширением .rbxm — Studio её загрузит
// как обычный плагин. Бинарный .rbxm генерировать вручную не нужно.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { config } from './config.js';

const pluginLuaPath = join(config.rootDir, 'plugin', 'AIAssistantPlugin.server.lua');
const buildDir = join(config.rootDir, 'build');

// Экранирование для XML-CDATA: разбиваем последовательность ]]>, если встретится.
function cdataSafe(src) {
  return src.replace(/\]\]>/g, ']]]]><![CDATA[>');
}

// Генерирует модель .rbxm (XML внутри) с одним Script — исходником плагина.
export function buildRbxm() {
  const lua = readFileSync(pluginLuaPath, 'utf8');
  const xml = `<roblox version="4">
  <Item class="Script" referent="RBX0">
    <Properties>
      <string name="Name">AIAssistantPlugin</string>
      <ProtectedString name="Source"><![CDATA[${cdataSafe(lua)}]]></ProtectedString>
      <token name="RunContext">0</token>
    </Properties>
  </Item>
</roblox>`;
  if (!existsSync(buildDir)) mkdirSync(buildDir, { recursive: true });
  const out = join(buildDir, 'AIAssistantPlugin.rbxm');
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
  const dest = join(dir, 'AIAssistantPlugin.rbxm');
  writeFileSync(dest, readFileSync(rbxm));
  return {
    ok: true,
    installedTo: dest,
    pluginsDir: dir,
    message:
      'Плагин установлен в папку плагинов Roblox. Перезапустите Studio (или ' +
      'переоткройте плейс) — AIAssistantPlugin появится на вкладке Plugins.',
  };
}

