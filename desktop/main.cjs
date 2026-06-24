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
const updater = require('./updater.cjs');
const { checkForUpdates } = updater;
// Хук для серверного эндпоинта /api/update/apply (кнопка «Обновить» в баннере).
globalThis.__rubloxUpdater = updater;

const rootDir = join(__dirname, '..');
const PORT = process.env.PORT || 8787;
const APP_URL = `http://localhost:${PORT}`;
const ICON = join(__dirname, 'assets', 'icon.png');

let win = null;
let splash = null;
let tray = null;
let isQuiting = false;

// Глобальные перехватчики: не даём фоновым сбоям (сеть, сторонние модули)
// «всплывать» окном ошибки при запуске — логируем и продолжаем.
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && (e.message || e)));

// Сплеш-окно с анимацией — показываем сразу, пока поднимается сервер.
function createSplash() {
  try {
    splash = new BrowserWindow({
      width: 380, height: 260, frame: false, transparent: true, resizable: false,
      alwaysOnTop: true, center: true, skipTaskbar: true, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    splash.loadFile(join(__dirname, 'splash.html'));
  } catch (e) { console.error('splash:', e && e.message); splash = null; }
}
function splashStage(text) { try { splash && splash.webContents.send('splash-stage', text); } catch { /* закрыт */ } }
function closeSplash() { try { if (splash && !splash.isDestroyed()) splash.close(); } catch { /* ok */ } splash = null; }

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
    show: false, // показываем только когда контент готов (через ready-to-show)
    webPreferences: {
      contextIsolation: true, nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  win.loadURL(APP_URL);
  // Плавная передача: окно появляется готовым, затем гасим сплеш.
  win.once('ready-to-show', () => { win.show(); closeSplash(); });
  // Если страница не загрузилась (сервер ещё не готов) — повторяем загрузку.
  win.webContents.on('did-fail-load', () => {
    setTimeout(() => { try { win && win.loadURL(APP_URL); } catch { /* ok */ } }, 500);
  });
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
    { label: 'Проверить обновления', click: () => checkForUpdates({ silent: false, win }) },
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
    createSplash();
    splashStage('Запуск сервера…');
    try {
      await startServer();
      splashStage('Проверка файлов…');
      await waitServer();
    } catch (e) {
      console.error('startup error:', e && e.message);
    }
    splashStage('Почти готово…');
    createWindow();
    createTray();
    // Обновления больше НЕ проверяем модальным диалогом при старте (это лагало).
    // Проверку делает сам веб-интерфейс через /api/update/info и показывает
    // ненавязчивый баннер сверху. Ручная проверка — в меню трея.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((e) => console.error('whenReady error:', e && e.message));
}

// Живём в трее — не выходим при закрытии окон.
app.on('window-all-closed', () => {});

app.on('before-quit', () => { isQuiting = true; });
