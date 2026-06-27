// Electron-обёртка: запускает встроенный сервер В ТОМ ЖЕ процессе,
// открывает окно, прячется в трей (системные/скрытые значки),
// не закрывается по крестику.
//
// .cjs — CommonJS для главного процесса. Сервер (ESM) подгружается через
// динамический import(), чтобы корректно работать и в dev, и в упакованном .exe
// (где spawn(node) недоступен).

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog } = require('electron');
const { join } = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFile } = require('node:child_process');
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
    // Загрузочный экран теперь РИСУЕТСЯ ВНУТРИ окна программы (web/#bootScreen) —
    // он на всё окно, надёжно виден и масштабируется. Отдельное окно-сплеш больше
    // не нужно (прозрачные окна на Windows часто не отрисовывались).
  } catch (e) { console.error('splash:', e && e.message); splash = null; }
}
function splashStage() { /* стадии показывает внутренний #bootScreen */ }
function closeSplash() { splash = null; }

// Занят ли TCP-порт (быстрый connect-чек).
function isPortOccupied(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(700, () => { sock.destroy(); resolve(false); });
  });
}

// Спросить /api/ping: вернёт {version, pid}, если порт держит НАШ сервер (иначе null).
function probeRublox(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/ping`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { const j = JSON.parse(body); resolve(j && j.app === 'rublox' ? j : null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(900, () => { req.destroy(); resolve(null); });
  });
}

// PID процесса, слушающего порт (Windows: парсим netstat -ano).
function pidOnPort(port) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      for (const line of stdout.split(/\r?\n/)) {
        if (line.includes('LISTENING') && new RegExp(`[:.]${port}\\b`).test(line)) {
          const pid = line.trim().split(/\s+/).pop();
          if (/^\d+$/.test(pid)) return resolve(Number(pid));
        }
      }
      resolve(null);
    });
  });
}

// Завершить процесс по PID (taskkill /F). Возвращает true при успехе.
function killPid(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }, (err) => resolve(!err));
  });
}

// Освободить порт от чужого/залипшего процесса и дождаться, пока он реально
// освободится (до ~3 с). true — порт свободен.
async function freePort(port) {
  const pid = await pidOnPort(port);
  if (pid && pid !== process.pid) await killPid(pid);
  for (let i = 0; i < 12; i++) {
    if (!(await isPortOccupied(port))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !(await isPortOccupied(port));
}

// Разрулить занятый порт ПЕРЕД стартом нашего сервера. Возвращает:
//  'free'   — порт свободен, запускаем сервер;
//  'reuse'  — на порту уже наш сервер той же версии, переиспользуем;
//  'quit'   — пользователь выбрал выход.
async function ensurePortClear(port) {
  if (!(await isPortOccupied(port))) return 'free';
  const id = await probeRublox(port);
  if (id && id.version === app.getVersion()) return 'reuse'; // здоровый наш сервер
  // Чужой процесс или СТАРАЯ версия Rublox (классическая причина «залипания»:
  // окно молча подключалось к устаревшему серверу на 8787).
  const who = id ? `старая версия Rublox (v${id.version})` : 'посторонний процесс';
  const choice = dialog.showMessageBoxSync(splash || null, {
    type: 'warning', title: 'Rublox — порт занят',
    message: `Порт ${port} занят: ${who}.`,
    detail: 'Это мешает запустить актуальную версию (окно подключилось бы к чужому/старому серверу). ' +
      'Освободить порт и продолжить?',
    buttons: ['Освободить и запустить', 'Выйти'],
    defaultId: 0, cancelId: 1, noLink: true,
  });
  if (choice !== 0) return 'quit';
  const freed = await freePort(port);
  if (!freed) {
    dialog.showMessageBoxSync(splash || null, {
      type: 'error', title: 'Rublox',
      message: `Не удалось освободить порт ${port}.`,
      detail: 'Закройте процесс, занявший порт, вручную (Диспетчер задач) и запустите Rublox снова.',
      buttons: ['OK'], noLink: true,
    });
    return 'quit';
  }
  return 'free';
}

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
    title: 'Rublox', backgroundColor: '#0c0708', // тёмный фон — без белой вспышки
    frame: false, // кастомный титлбар
    icon: ICON,
    show: true, // показываем сразу: загрузочный экран рисуется внутри окна (#bootScreen)
    webPreferences: {
      contextIsolation: true, nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  win.loadURL(APP_URL);

  // Внешние ссылки (target="_blank" и попытки уйти с приложения) открываем в
  // СИСТЕМНОМ браузере пользователя, а не внутри окна Rublox. Внутренние
  // (localhost / APP_URL) оставляем приложению.
  const isExternal = (u) => /^https?:\/\//i.test(u) && !u.startsWith(APP_URL) && !/^https?:\/\/localhost(:|\/|$)/i.test(u);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isExternal(url)) { e.preventDefault(); shell.openExternal(url); }
  });

  win.once('ready-to-show', () => { try { win.show(); } catch { /* ok */ } closeSplash(); });
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
    splashStage('Проверка окружения…');
    try {
      // Защита от «залипшего» порта: если 8787 держит чужой/старый процесс — не
      // подключаемся к нему молча, а предлагаем освободить (иначе увидишь старый код).
      const state = await ensurePortClear(PORT);
      if (state === 'quit') { isQuiting = true; closeSplash(); app.quit(); return; }
      if (state === 'free') {
        splashStage('Запуск сервера…');
        await startServer();
        splashStage('Проверка файлов…');
        await waitServer();
      } else {
        // 'reuse' — наш сервер уже работает на порту, второй не поднимаем.
        splashStage('Подключение…');
        await waitServer();
      }
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
