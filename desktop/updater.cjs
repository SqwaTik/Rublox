// Проверка и автоустановка обновлений через GitHub Releases.
// Без electron-updater и провайдер-конфигов: берём latest-release у GitHub,
// сравниваем версию, при наличии новой — качаем .exe-установщик (NSIS) и
// запускаем его. Работает с обычными релизами репозитория (exe в ассетах).

const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, dialog, shell, Notification } = require('electron');

const REPO = 'SqwaTik/Rublox';
const UA = 'Rublox-Updater';

// GET JSON с GitHub API (нужен User-Agent, следуем за редиректами).
function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(getJson(res.headers.location));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Скачать файл (следуя за редиректами GitHub→S3) в dest.
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const go = (u) => https.get(u, { headers: { 'User-Agent': UA, Accept: 'application/octet-stream' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return go(res.headers.location);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', reject);
    go(url);
  });
}

// Сравнение версий "x.y.z" (с ведущей v или без). >0 если a новее b.
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

let checking = false;

// silent=true — молча проверить при старте (диалог только если есть обновление).
async function checkForUpdates({ silent = true, win = null } = {}) {
  if (checking) return;
  checking = true;
  try {
    const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const latest = rel.tag_name || rel.name || '';
    const current = app.getVersion();
    if (!latest || cmpVer(latest, current) <= 0) {
      if (!silent) {
        dialog.showMessageBox(win, {
          type: 'info', title: 'Rublox',
          message: 'Установлена последняя версия',
          detail: `Текущая версия ${current} — обновлений нет.`,
        });
      }
      return;
    }
    // Ищем .exe-установщик в ассетах (NSIS Setup).
    const assets = rel.assets || [];
    const exe = assets.find((a) => /\.exe$/i.test(a.name) && /setup/i.test(a.name))
      || assets.find((a) => /\.exe$/i.test(a.name));

    const choice = await dialog.showMessageBox(win, {
      type: 'info', title: 'Доступно обновление Rublox',
      message: `Вышла версия ${latest} (у вас ${current})`,
      detail: (rel.body ? String(rel.body).slice(0, 600) + '\n\n' : '') +
        (exe ? 'Скачать и установить сейчас? Приложение перезапустится.'
             : 'Установщик не найден в релизе — открыть страницу загрузки?'),
      buttons: exe ? ['Обновить', 'Позже'] : ['Открыть страницу', 'Позже'],
      defaultId: 0, cancelId: 1,
    });
    if (choice.response !== 0) return;

    if (!exe) {
      shell.openExternal(rel.html_url || `https://github.com/${REPO}/releases/latest`);
      return;
    }

    // Качаем установщик во временную папку и запускаем.
    const dest = path.join(os.tmpdir(), exe.name);
    try {
      await download(exe.browser_download_url, dest);
    } catch (e) {
      dialog.showMessageBox(win, { type: 'error', title: 'Rublox',
        message: 'Не удалось скачать обновление', detail: String(e && e.message || e) });
      shell.openExternal(rel.html_url || `https://github.com/${REPO}/releases/latest`);
      return;
    }
    try {
      // Тихая установка NSIS (/S) с автозапуском после; затем выходим.
      const child = spawn(dest, ['/S'], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch {
      // если /S не сработал — просто откроем установщик
      shell.openPath(dest);
    }
    app.exit(0);
  } catch (e) {
    if (!silent) {
      dialog.showMessageBox(win, { type: 'error', title: 'Rublox',
        message: 'Не удалось проверить обновления', detail: String(e && e.message || e) });
    } else if (Notification && Notification.isSupported && Notification.isSupported()) {
      // тихо игнорируем сетевые сбои при старте
    }
  } finally {
    checking = false;
  }
}

module.exports = { checkForUpdates };
