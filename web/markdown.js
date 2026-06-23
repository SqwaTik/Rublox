// Лёгкий безопасный markdown→HTML рендер для чата (без зависимостей).
// Экранирует HTML, поддерживает: код-блоки ```lang, инлайн-код, заголовки,
// списки, цитаты, жирный/курсив, ссылки, горизонтальные линии.

(function () {
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Инлайн-разметка внутри строки (после экранирования). Устойчиво к диалектам
  // моделей: **bold**, __bold__, *italic*, _italic_, ***bi***, ___bi___,
  // ~~strike~~, `code`, ссылки. Snake_case и числа не ломаются.
  function inline(s) {
    // Разбиваем на сегменты: инлайн-код `...` не форматируем, остальное — да.
    // Так символы * _ ~ внутри кода остаются нетронутыми (без сентинелов).
    const parts = s.split(/(`[^`]+`)/);
    return parts.map((seg) => {
      if (seg.length > 1 && seg[0] === '`' && seg[seg.length - 1] === '`') {
        return `<code>${seg.slice(1, -1)}</code>`;
      }
      return seg
        .replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/___([\s\S]+?)___/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^\w])__([^\n]+?)__(?!\w)/g, '$1<strong>$2</strong>')
        .replace(/~~([\s\S]+?)~~/g, '<del>$1</del>')
        .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    }).join('');
  }

  function render(src) {
    if (src == null) return '';
    const text = String(src).replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    let html = '';
    let i = 0;
    let listOpen = false;

    const closeList = () => {
      if (listOpen) {
        html += '</ul>';
        listOpen = false;
      }
    };

    while (i < lines.length) {
      const line = lines[i];

      // Код-блок ```lang
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        closeList();
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // пропустить закрывающую ```
        const copyIcon = (window.ICON && window.ICON.copy) || 'copy';
        const label = lang ? `<span class="code-lang">${lang}</span>` : '';
        // diff-блок: подсветка добавленных (+) и удалённых (-) строк.
        if (lang === 'diff') {
          const rows = buf.map((ln) => {
            const safe = escapeHtml(ln);
            let cls = 'diff-ctx';
            if (/^\+(?!\+\+)/.test(ln)) cls = 'diff-add';
            else if (/^-(?!--)/.test(ln)) cls = 'diff-del';
            else if (/^@@/.test(ln) || /^(\+\+\+|---)/.test(ln)) cls = 'diff-meta';
            return `<span class="diff-line ${cls}">${safe || ' '}</span>`;
          }).join('\n');
          html += `<div class="codeblock diff"><span class="code-lang">diff</span><button class="copy-btn" title="Copy">${copyIcon}</button><pre><code>${rows}</code></pre></div>`;
          continue;
        }
        const code = escapeHtml(buf.join('\n'));
        html += `<div class="codeblock">${label}<button class="copy-btn" title="Copy">${copyIcon}</button><pre><code>${code}</code></pre></div>`;
        continue;
      }

      // Заголовки
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        closeList();
        const level = h[1].length + 2; // h3..h6
        html += `<h${level}>${inline(escapeHtml(h[2]))}</h${level}>`;
        i++;
        continue;
      }

      // Горизонтальная линия
      if (/^---+\s*$/.test(line)) {
        closeList();
        html += '<hr />';
        i++;
        continue;
      }

      // Цитата
      if (/^>\s?/.test(line)) {
        closeList();
        html += `<blockquote>${inline(escapeHtml(line.replace(/^>\s?/, '')))}</blockquote>`;
        i++;
        continue;
      }

      // Таблица: строка |..|..| + разделитель |---|---|
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length &&
          /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
        closeList();
        const parseRow = (ln) => ln.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(escapeHtml(c.trim())));
        const header = parseRow(line);
        i += 2; // заголовок + разделитель
        let body = '';
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          const cells = parseRow(lines[i]);
          body += '<tr>' + cells.map((c) => `<td>${c}</td>`).join('') + '</tr>';
          i++;
        }
        html += '<div class="md-table"><table><thead><tr>' +
          header.map((c) => `<th>${c}</th>`).join('') +
          '</tr></thead><tbody>' + body + '</tbody></table></div>';
        continue;
      }

      // Нумерованный список 1. 2. 3.
      if (/^\s*\d+\.\s+/.test(line)) {
        closeList();
        let ol = '<ol>';
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          ol += `<li>${inline(escapeHtml(lines[i].replace(/^\s*\d+\.\s+/, '')))}</li>`;
          i++;
        }
        html += ol + '</ol>';
        continue;
      }

      // Список (включая чек-листы/планы)
      if (/^\s*[-*]\s+/.test(line)) {
        if (!listOpen) {
          html += '<ul>';
          listOpen = true;
        }
        const raw = line.replace(/^\s*[-*]\s+/, '');
        // - [x] / - [ ] и строки, начинающиеся с ✔/✓/◻/◼
        const done = /^\[[xX]\]\s+/.test(raw) || /^[✔✓☑]\s+/.test(raw);
        const todo = /^\[\s?\]\s+/.test(raw) || /^[◻◼□▪]\s+/.test(raw);
        const cleaned = raw.replace(/^\[[ xX]?\]\s+/, '').replace(/^[✔✓☑◻◼□▪]\s+/, '');
        const cls = done ? ' class="done"' : todo ? ' class="todo"' : '';
        html += `<li${cls}>${inline(escapeHtml(cleaned))}</li>`;
        i++;
        continue;
      }

      // Пустая строка
      if (line.trim() === '') {
        closeList();
        i++;
        continue;
      }

      // Обычный абзац (склеиваем подряд идущие строки)
      closeList();
      const para = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^```/.test(lines[i]) &&
        !/^(#{1,4})\s/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      html += `<p>${inline(escapeHtml(para.join('\n'))).replace(/\n/g, '<br/>')}</p>`;
    }
    closeList();
    return html;
  }

  window.mdRender = render;
})();
