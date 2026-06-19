// Electron-обёртка: запускает встроенный сервер В ТОМ ЖЕ процессе,
// открывает окно, прячется в трей (системные/скрытые значки),
// не закрывается по крестику.
//
// .cjs — CommonJS для главного процесса. Сервер (ESM) подгружается через
// динамический import(), чтобы корректно работать и в dev, и в упакованном .exe
// (где spawn(node) недоступен).

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const { join } = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const rootDir = join(__dirname, '..');
const PORT = process.env.PORT || 8787;
const APP_URL = `http://localhost:${PORT}`;
const ICON = join(__dirname, 'assets', 'icon.png');

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
  try {
    const img = nativeImage.createFromPath(ICON);
    if (!img.isEmpty()) return img.resize({ width: 18, height: 18 });
  } catch { /* fallback ниже */ }
  return nativeImage.createFromBuffer(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR4nGNgGAWjYBSMglEwCkbBKBgFo2AUAAAGAAFy0Z0kAAAAAElFTkSuQmCC', 'base64'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 760, minHeight: 540,
    title: 'Rublox', backgroundColor: '#0c0708',
    frame: false, // кастомный титлбар
    icon: ICON,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  win.loadURL(APP_URL);
  win.on('close', (e) => {
    if (!isQuiting) { e.preventDefault(); win.hide(); }
  });
}

// IPC управления окном из кастомного титлбара.
ipcMain.on('win', (_e, action) => {
  if (!win) return;
  if (action === 'min') win.minimize();
  else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.hide();
});

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Rublox');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: () => (win ? win.show() : createWindow()) },
    { label: 'Open in browser', click: () => shell.openExternal(APP_URL) },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuiting = true; app.quit(); } },
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
