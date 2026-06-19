// Electron-обёртка: запускает встроенный сервер, открывает окно,
// прячется в трей (системные/скрытые значки), не закрывается по крестику.
//
// .cjs — CommonJS, т.к. Electron главный процесс надёжнее работает в CJS,
// даже когда package.json помечен как "type": "module".

const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const rootDir = join(__dirname, '..');
const PORT = process.env.PORT || 8787;
const URL = `http://localhost:${PORT}`;

let win = null;
let tray = null;
let serverProc = null;
let isQuiting = false;

function startServer() {
  serverProc = spawn(process.execPath, [join(rootDir, 'server', 'index.js')], {
    cwd: rootDir,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit',
  });
  serverProc.on('exit', (code) => {
    if (!isQuiting) console.error(`Сервер завершился с кодом ${code}`);
  });
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/status`, (res) => {
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
  win.loadURL(URL);
  win.on('close', (e) => {
    if (!isQuiting) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Roblox AI Assistant');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть', click: () => (win ? win.show() : createWindow()) },
    { label: 'Открыть в браузере', click: () => shell.openExternal(URL) },
    { type: 'separator' },
    { label: 'Выход', click: () => { isQuiting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => (win ? win.show() : createWindow()));
}

app.whenReady().then(async () => {
  startServer();
  await waitServer();
  createWindow();
  createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Живём в трее — не выходим при закрытии окон.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuiting = true;
  if (serverProc) serverProc.kill();
});
