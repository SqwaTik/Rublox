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

// Скачать файл (следуя за редиректами GitHub→S3) в dest. onProgress(pct 0..100).
// Обрабатываем ОБА источника ошибок — сеть и запись на диск (раньше ошибка
// файлового потока, напр. блокировка антивирусом, роняла обновление без объяснения).
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let file;
    try { file = fs.createWriteStream(dest); }
    catch (e) { return reject(new Error('не удалось создать файл: ' + e.message)); }
    const fail = (err) => {
      try { file.destroy(); } catch { /* ok */ }
      try { fs.existsSync(dest) && fs.unlinkSync(dest); } catch { /* ok */ }
      reject(err);
    };
    file.on('error', (e) => fail(new Error('запись на диск не удалась: ' + e.message)));
    const go = (u, hops) => {
      if (hops > 6) return fail(new Error('слишком много редиректов'));
      https.get(u, { headers: { 'User-Agent': UA, Accept: 'application/octet-stream' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return go(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return fail(new Error('сервер ответил HTTP ' + res.statusCode)); }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0, lastPct = -1;
        res.on('data', (chunk) => {
          got += chunk.length;
          if (total && onProgress) {
            const pct = Math.floor((got / total) * 100);
            if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
          }
        });
        res.on('error', (e) => fail(new Error('обрыв загрузки: ' + e.message)));
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      }).on('error', (e) => fail(new Error('сеть недоступна: ' + e.message)));
    };
    go(url, 0);
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
      // Тихая установка NSIS (/S) + автозапуск приложения после неё (--force-run —
      // флаг установщика electron-builder, тот же, что использует electron-updater).
      const child = spawn(dest, ['/S', '--force-run'], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch {
      // если тихая установка не сработала — откроем установщик обычным окном
      // (там на финише есть галка «Запустить Rublox»).
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

// Неблокирующая установка: качаем .exe из latest-релиза и запускаем тихо (/S),
// приложение перезапустится. Без модальных диалогов — вызывается с фронта
// (кнопка «Обновить» в баннере) через /api/update/apply. Прогресс шлём в окно.
async function applyUpdate({ win = null } = {}) {
  const target = win || BrowserWindow.getAllWindows()[0] || null;
  const notify = (stage, extra) => {
    try { target && target.webContents.send('update-progress', typeof extra === 'object' ? { stage, ...extra } : { stage, pct: extra }); }
    catch { /* окно закрыто */ }
  };
  let rel = null;
  try {
    notify('check');
    rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const assets = rel.assets || [];
    const exe = assets.find((a) => /\.exe$/i.test(a.name) && /setup/i.test(a.name))
      || assets.find((a) => /\.exe$/i.test(a.name));
    if (!exe) throw new Error('в релизе нет .exe-установщика');

    notify('download', 0);
    // Уникальное имя — чтобы не наткнуться на залоченный антивирусом старый файл.
    const dest = path.join(os.tmpdir(), `RubloxSetup-${exe.name.replace(/[^\w.-]/g, '')}-${process.pid}.exe`);
    await download(exe.browser_download_url, dest, (pct) => notify('download', pct));
    if (!fs.existsSync(dest) || fs.statSync(dest).size < 1024 * 1024) {
      throw new Error('скачанный установщик повреждён или пуст');
    }

    notify('install');
    // Тихая установка с автозапуском. Если spawn не удался — открываем установщик
    // видимым окном (пользователь дойдёт по шагам). Затем выходим, чтобы можно
    // было заменить файлы запущенного приложения.
    let launched = false;
    try {
      const child = spawn(dest, ['/S', '--force-run'], { detached: true, stdio: 'ignore' });
      child.on('error', () => { /* перехвачено ниже через launched */ });
      child.unref();
      launched = true;
    } catch { launched = false; }
    if (!launched) { try { await shell.openPath(dest); launched = true; } catch { /* ok */ } }
    if (!launched) throw new Error('не удалось запустить установщик');
    setTimeout(() => app.exit(0), 800);
  } catch (e) {
    // Реальный текст ошибки — в окно, плюс открываем страницу релиза как запасной путь.
    notify('error', { message: (e && e.message) || String(e), url: (rel && rel.html_url) || `https://github.com/${REPO}/releases/latest` });
    try { shell.openExternal((rel && rel.html_url) || `https://github.com/${REPO}/releases/latest`); } catch { /* ok */ }
  }
}

// BrowserWindow нужен только в applyUpdate; берём лениво, чтобы не падать в тестах.
let BrowserWindow = null;
try { ({ BrowserWindow } = require('electron')); } catch { /* не electron — ok */ }

module.exports = { checkForUpdates, applyUpdate };
