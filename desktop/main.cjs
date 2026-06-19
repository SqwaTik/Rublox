// Electron-обёртка: запускает встроенный сервер В ТОМ ЖЕ процессе,
// открывает окно, прячется в трей (системные/скрытые значки),
// не закрывается по крестику.
//
// .cjs — CommonJS для главного процесса. Сервер (ESM) подгружается через
// динамический import(), чтобы корректно работать и в dev, и в упакованном .exe
// (где spawn(node) недоступен).

const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const { join } = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const rootDir = join(__dirname, '..');
const PORT = process.env.PORT || 8787;
const APP_URL = `http://localhost:${PORT}`;

let win = null;
let tray = null;
let isQuiting = false;

// Запуск сервера в текущем процессе.
async function startServer() {
  process.env.PORT = String(PORT);
  // Данные (сессии, провайдеры, сборка плагина) — в userData, чтобы работало
  // в упакованном приложении (папка установки доступна только на чтение).
  process.env.ROBLOX_AI_DATA_DIR = app.getPath('userData');
  const serverEntry = pathToFileURL(join(rootDir, 'server', 'index.js')).href;
  try {
    await import(serverEntry);
  } catch (err) {
    console.error('Не удалось запустить сервер:', err);
  }
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${APP_URL}/api/status`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

async function waitServer(retries = 40) {
  for (let i = 0; i < retries; i++) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function trayIcon() {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAvElEQVR4nO3WMQ6CQBCF4X' +
    '8XCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLEzN5xUtm' +
    'dndmZ3dmYHfsfBPZ3l7yQ7sLDDDDDDDDPMP7Cwd2dndmZndmZndmYHdmZndmZndmZndmZn' +
    'dmZndmZndmZndmYHdmZndmZndmZndmZndmZndmYHdmZndmZndmZndmZndmYHdmZndmZndmY' +
    'HfsfBPwAH8wKQO2x0bQAAAABJRU5ErkJggg==';
  return nativeImage.createFromBuffer(Buffer.from(png, 'base64'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 720, minHeight: 520,
    title: 'Roblox AI Assistant', backgroundColor: '#0a0b14', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(APP_URL);
  win.on('close', (e) => {
    if (!isQuiting) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Roblox AI Assistant');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть', click: () => (win ? win.show() : createWindow()) },
    { label: 'Открыть в браузере', click: () => shell.openExternal(APP_URL) },
    { type: 'separator' },
    { label: 'Выход', click: () => { isQuiting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => (win ? win.show() : createWindow()));
}

// Один экземпляр приложения.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    await startServer();
    await waitServer();
    createWindow();
    createTray();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Живём в трее — не выходим при закрытии окон.
app.on('window-all-closed', () => {});

app.on('before-quit', () => { isQuiting = true; });
