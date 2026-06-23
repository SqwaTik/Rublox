// Веб-инструменты: поиск в интернете, чтение страниц и поиск ассетов каталога
// Roblox. Доступны всегда (не требуют подключения Studio). Без внешних
// зависимостей — только глобальный fetch (Node 18+).

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

// Поиск через DuckDuckGo HTML (без ключа). Возвращает текстовый список ссылок.
export async function webSearch(query, count = 5) {
  const q = String(query || '').trim();
  if (!q) return 'Пустой запрос.';
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
  let html;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html' },
    });
    html = await res.text();
  } catch (e) {
    return `Ошибка поиска: ${e.message}`;
  }
  const results = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null && results.length < count) {
    let link = decodeEntities(m[1]);
    // DuckDuckGo оборачивает ссылки в редирект /l/?uddg=...
    const um = link.match(/[?&]uddg=([^&]+)/);
    if (um) link = decodeURIComponent(um[1]);
    const title = decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim();
    if (link.startsWith('http')) results.push({ title, link });
  }
  if (!results.length) return `По запросу "${q}" ничего не найдено (или поиск заблокирован).`;
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.link}`).join('\n');
}

// Чтение страницы: возвращает очищенный от тегов текст (с ограничением длины).
export async function webFetch(url, maxChars = 4000) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return 'Нужен корректный http(s) URL.';
  let html;
  try {
    const res = await fetch(u, { headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    if (ct.includes('application/json')) {
      return body.slice(0, maxChars);
    }
    html = body;
  } catch (e) {
    return `Ошибка загрузки: ${e.message}`;
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : '';
  let text = decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
  if (text.length > maxChars) text = text.slice(0, maxChars) + '…';
  return (title ? `# ${title}\n${u}\n\n` : `${u}\n\n`) + text;
}

// Категории каталога Roblox для toolbox-service (часто используемые).
const ASSET_CATEGORY = {
  model: 10,
  decal: 13,
  audio: 3,
  mesh: 40,
  meshpart: 40,
  plugin: 38,
  image: 1,
  video: 62,
};

// Поиск ассетов в каталоге/тулбоксе Roblox. Возвращает список id+name+creator,
// пригодный для последующего insert_model(assetId).
export async function searchAssets(keyword, assetType = 'model', limit = 12) {
  const kw = String(keyword || '').trim();
  if (!kw) return 'Укажите ключевое слово для поиска ассета.';
  const cat = ASSET_CATEGORY[String(assetType).toLowerCase()] || 10;
  const url =
    `https://apis.roblox.com/toolbox-service/v1/marketplace/${cat}` +
    `?keyword=${encodeURIComponent(kw)}&limit=${Math.min(Number(limit) || 12, 30)}` +
    `&pageNumber=0&sortType=Relevance`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) {
      return `Поиск ассетов недоступен (HTTP ${res.status}). Попросите у пользователя точный assetId или используйте insert_model с известным id.`;
    }
    const data = await res.json();
    const items = data.data || data.results || [];
    const ids = items.map((it) => (it.asset && it.asset.id) || it.id).filter(Boolean);
    if (!ids.length) return `По запросу "${kw}" ассетов не найдено.`;

    // Поиск отдаёт только id — имена/авторов берём одним батч-запросом тулбокса.
    let names = {};
    try {
      const d = await fetch(
        `https://apis.roblox.com/toolbox-service/v1/items/details?assetIds=${ids.join(',')}`,
        { headers: { 'user-agent': UA, accept: 'application/json' } }
      );
      if (d.ok) {
        const dj = await d.json();
        for (const it of dj.data || []) {
          const id = (it.asset && it.asset.id) || it.id;
          names[id] = {
            name: (it.asset && it.asset.name) || '',
            creator: (it.creator && it.creator.name) || '',
          };
        }
      }
    } catch { /* имена опциональны */ }

    return ids
      .map((id) => {
        const info = names[id] || {};
        return `assetId ${id}${info.name ? ' — ' + info.name : ''}${info.creator ? ' (автор ' + info.creator + ')' : ''}`;
      })
      .join('\n');
  } catch (e) {
    return `Ошибка поиска ассетов: ${e.message}. Используйте точный assetId с insert_model.`;
  }
}

// Расширенный поиск: помимо текста (для модели) добавляем заголовок с типом —
// фронтенд по нему решает, как рисовать карточки (модель с превью или аудио с
// плеером). Заголовок начинается с «[assets type=…]» и не мешает модели.
export async function searchAssetsTyped(keyword, assetType = 'model', limit = 12) {
  const body = await searchAssets(keyword, assetType, limit);
  const type = String(assetType || 'model').toLowerCase();
  if (typeof body !== 'string' || body.startsWith('Ошибка') || body.startsWith('Поиск') ||
      body.startsWith('Укажите') || body.startsWith('По запросу')) {
    return body;
  }
  return `[assets type=${type}]\n${body}`;
}
