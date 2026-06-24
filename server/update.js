// Проверка обновлений приложения через GitHub Releases — чистый Node (без Electron),
// чтобы работать и в десктопе, и в браузере. Установку (скачать+запустить .exe)
// делает desktop/updater.cjs в главном процессе Electron; здесь — только ИНФО.

import { get } from 'node:https';
import { config } from './config.js';

const REPO = 'SqwaTik/Rublox';
const UA = 'Rublox-Updater';

function getJson(url) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(getJson(res.headers.location));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// >0 если a новее b. Сравнение "x.y.z" (с ведущей v или без).
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

let cache = { at: 0, data: null };

// Инфо об обновлении. Кэш 10 минут — чтобы баннер не дёргал GitHub на каждый
// заход. Никогда не бросает: при сбое сети возвращает hasUpdate:false.
export async function getUpdateInfo({ force = false } = {}) {
  const current = config.version;
  if (!force && cache.data && Date.now() - cache.at < 10 * 60 * 1000) {
    return { ...cache.data, current };
  }
  try {
    const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const latest = (rel.tag_name || rel.name || '').replace(/^v/i, '');
    const hasUpdate = !!latest && cmpVer(latest, current) > 0;
    const hasInstaller = (rel.assets || []).some((a) => /\.exe$/i.test(a.name));
    const data = {
      hasUpdate, latest, hasInstaller,
      notes: rel.body ? String(rel.body).slice(0, 600) : '',
      url: rel.html_url || `https://github.com/${REPO}/releases/latest`,
    };
    cache = { at: Date.now(), data };
    return { ...data, current };
  } catch {
    return { hasUpdate: false, latest: '', current, hasInstaller: false, notes: '', url: `https://github.com/${REPO}/releases/latest` };
  }
}
