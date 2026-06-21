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

  // Инлайн-разметка внутри строки (после экранирования).
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
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
