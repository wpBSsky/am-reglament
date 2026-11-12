/* =============================================================================
   ANNIHILATION MASTERS — рендерер документа
   Один и тот же код рисует публичную страницу и черновик в редакторе.
   В режиме правки текст выводится как есть (plaintext-only), чтобы
   contenteditable не ломал разметку: **жирный** виден звёздочками.

   Модель:
     { meta:{...}, sections:[ { id, title, blocks:[ {type, ...} ] } ] }

   Типы блоков: p · h3 · clauses · note · table · specs · tags
                stages · podium · faq · links
   ============================================================================= */
(function (global) {
  'use strict';

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }
  function pad2(n) { return String(n).padStart(2, '0'); }

  /* --- инлайн-разметка -----------------------------------------------------
     **жирный**  *курсив*  [текст](ссылка)  и голые ссылки http(s).
     Сначала экранируем HTML, потом собираем теги — обратный порядок открыл бы XSS. */
  function inline(raw, edit) {
    var text = String(raw == null ? '' : raw);
    if (edit) return esc(text).replace(/\n/g, '<br>');

    var codes = [];
    function keep(html) { codes.push(html); return '\u0000' + (codes.length - 1) + '\u0000'; }

    var s = esc(text);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, t, u) {
      return keep('<a href="' + esc(u) + '" target="_blank" rel="noopener">' + t + '</a>');
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, function (m, t) { return keep('<strong>' + t + '</strong>'); });
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, function (m, p, t) { return p + keep('<em>' + t + '</em>'); });
    s = s.replace(/(https?:\/\/[^\s<]+)/g, function (m) {
      return keep('<a href="' + esc(m) + '" target="_blank" rel="noopener">' + m + '</a>');
    });
    s = s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return codes[+i]; });
    return s.replace(/\n/g, '<br>');
  }

  function isUrl(u) { return /^https?:\/\//i.test(String(u || '').trim()); }

  /* --- helpers ------------------------------------------------------------ */
  function ctxEdit(ctx) { return !!(ctx && ctx.edit); }
  function ea(path, ctx) {
    if (!ctxEdit(ctx) || !path) return '';
    return ' contenteditable="plaintext-only" spellcheck="false" data-p="' + esc(path) + '"';
  }
  function cls(base, ctx, extra) {
    return [base, ctxEdit(ctx) && base ? 'ed' : '', extra || ''].filter(Boolean).join(' ');
  }
  function mark(path, ctx) { return ctxEdit(ctx) ? ' data-p="' + esc(path) + '"' : ''; }

  /* --- блоки -------------------------------------------------------------- */
  var BLOCKS = {
    p: function (b, p, ctx) {
      return '<p class="' + cls('blk-p', ctx) + '"' + ea(p + '.text', ctx) + '>' + inline(b.text, ctxEdit(ctx)) + '</p>';
    },

    h3: function (b, p, ctx) {
      return '<p class="' + cls('sub', ctx) + '"' + ea(p + '.text', ctx) + '>' + inline(b.text, ctxEdit(ctx)) + '</p>';
    },

    clauses: function (b, p, ctx, at) {
      var items = (b.items || []).map(function (it, i) {
        var ip = p + '.items.' + i;
        var auto = ((at.si + 1) + '.' + (i + 1));
        var label = it.n || auto;
        return '<li data-i="' + i + '">'
          + '<span class="clauses__n"' + ea(ip + '.n', ctx) + '>' + esc(label) + '</span>'
          + '<span class="clauses__t"' + ea(ip + '.text', ctx) + '>' + inline(it.text, ctxEdit(ctx)) + '</span>'
          + '</li>';
      }).join('');
      return '<ol class="clauses">' + items + '</ol>';
    },

    note: function (b, p, ctx) {
      var tone = b.tone ? ' note--' + b.tone : '';
      return '<div class="' + cls('note', ctx, tone) + '">'
        + '<span class="note__label"' + ea(p + '.label', ctx) + '>' + inline(b.label, ctxEdit(ctx)) + '</span>'
        + '<div class="note__text"' + ea(p + '.text', ctx) + '>' + inline(b.text, ctxEdit(ctx)) + '</div>'
        + '</div>';
    },

    table: function (b, p, ctx) {
      var head = (b.head || []).map(function (h, i) {
        return '<th' + ea(p + '.head.' + i, ctx) + '>' + inline(h, ctxEdit(ctx)) + '</th>';
      }).join('');
      var rows = (b.rows || []).map(function (row, ri) {
        var cells = (row || []).map(function (c, ci) {
          return '<td' + ea(p + '.rows.' + ri + '.' + ci, ctx) + '>' + inline(c, ctxEdit(ctx)) + '</td>';
        }).join('');
        return '<tr>' + cells + '</tr>';
      }).join('');
      return '<div class="tblwrap"><table class="table">'
        + (head ? '<thead><tr>' + head + '</tr></thead>' : '')
        + '<tbody>' + rows + '</tbody></table></div>';
    },

    specs: function (b, p, ctx) {
      var items = (b.items || []).map(function (it, i) {
        var ip = p + '.items.' + i;
        return '<div><dt' + ea(ip + '.k', ctx) + '>' + inline(it.k, ctxEdit(ctx)) + '</dt>'
          + '<dd' + ea(ip + '.v', ctx) + '>' + inline(it.v, ctxEdit(ctx)) + '</dd></div>';
      }).join('');
      return '<dl class="specs">' + items + '</dl>';
    },

    tags: function (b, p, ctx) {
      var items = (b.items || []).map(function (it, i) {
        return '<span class="' + (it.key ? 'is-key' : '') + '"' + ea(p + '.items.' + i + '.text', ctx) + '>'
          + inline(it.text, ctxEdit(ctx)) + '</span>';
      }).join('');
      return '<div class="tags">' + items + '</div>';
    },

    stages: function (b, p, ctx) {
      var items = (b.items || []).map(function (it, i) {
        var ip = p + '.items.' + i;
        return '<div class="stage' + (it.state ? ' stage--' + it.state : '') + '">'
          + '<span class="stage__name"' + ea(ip + '.name', ctx) + '>' + inline(it.name, ctxEdit(ctx)) + '</span>'
          + '<span class="stage__meta"' + ea(ip + '.meta', ctx) + '>' + inline(it.meta, ctxEdit(ctx)) + '</span>'
          + '</div>';
      }).join('');
      return '<div class="stages" style="--stages:' + Math.max(1, (b.items || []).length) + '">' + items + '</div>';
    },

    podium: function (b, p, ctx) {
      var items = (b.items || []).map(function (it, i) {
        var ip = p + '.items.' + i;
        return '<div class="place' + (it.first ? ' place--first' : '') + '">'
          + '<span class="place__rank"' + ea(ip + '.rank', ctx) + '>' + inline(it.rank, ctxEdit(ctx)) + '</span>'
          + '<span class="place__sum"' + ea(ip + '.sum', ctx) + '>' + inline(it.sum, ctxEdit(ctx)) + '</span>'
          + (it.note || ctxEdit(ctx)
            ? '<span class="place__note"' + ea(ip + '.note', ctx) + '>' + inline(it.note, ctxEdit(ctx)) + '</span>'
            : '')
          + '</div>';
      }).join('');
      return '<div class="podium">' + items + '</div>';
    },

    faq: function (b, p, ctx) {
      var items = (b.items || []).map(function (it, i) {
        var ip = p + '.items.' + i;
        return '<div class="faq__item">'
          + '<p class="faq__q"' + ea(ip + '.q', ctx) + '>' + inline(it.q, ctxEdit(ctx)) + '</p>'
          + '<p class="faq__a"' + ea(ip + '.a', ctx) + '>' + inline(it.a, ctxEdit(ctx)) + '</p>'
          + '</div>';
      }).join('');
      return '<div class="faq">' + items + '</div>';
    },

    links: function (b, p, ctx) {
      var items = (b.items || []).map(function (it, i) {
        var ip = p + '.items.' + i;
        var label = '<span class="links__label"' + ea(ip + '.label', ctx) + '>' + inline(it.label, ctxEdit(ctx)) + '</span>';
        var url = String(it.url || '');
        var urlHtml = '<span class="links__url"' + ea(ip + '.url', ctx) + '>' + esc(url) + '</span>';
        if (!ctxEdit(ctx) && isUrl(url)) {
          return '<li><a class="links__row" href="' + esc(url.trim()) + '" target="_blank" rel="noopener">'
            + '<span>' + label + urlHtml + '</span><span class="links__arrow">→</span></a></li>';
        }
        return '<li><div class="links__row' + (ctxEdit(ctx) ? '' : ' is-empty') + '"><span>'
          + label + urlHtml + '</span><span class="links__arrow">' + (ctxEdit(ctx) ? '' : '→') + '</span></div></li>';
      }).join('');
      return '<ul class="links">' + items + '</ul>';
    },

    img: function (b, p, ctx) {
      var src = String(b.src || '');
      var size = b.size === 'half' ? ' fig--half' : (b.size === 'mid' ? ' fig--mid' : '');
      /* родные пиксели: картинка не растягивается шире, чем есть (иначе мыло) */
      var w = Math.round(Number(b.w) || 0), h = Math.round(Number(b.h) || 0);
      var dims = w > 0 ? ' width="' + w + '"' + (h > 0 ? ' height="' + h + '"' : '')
        + ' style="max-width:' + w + 'px"' : '';
      var media = src
        ? '<img class="fig__img" src="' + esc(src) + '" alt="' + esc(b.alt || '') + '"' + dims
          + ' decoding="async" loading="lazy">'
        : '<span class="fig__empty" data-pick="' + esc(p) + '">Картинка не выбрана — нажмите «Заменить»</span>';
      var cap = (b.caption || ctxEdit(ctx))
        ? '<figcaption class="fig__cap"' + ea(p + '.caption', ctx) + '>' + inline(b.caption, ctxEdit(ctx)) + '</figcaption>'
        : '';
      return '<figure class="' + cls('fig', ctx, size) + '">' + media + cap + '</figure>';
    }
  };

  var TYPE_NAMES = {
    p: 'Абзац', h3: 'Подзаголовок', clauses: 'Пункты', note: 'Врезка',
    table: 'Таблица', specs: 'Параметры', tags: 'Условия', stages: 'Этапы',
    podium: 'Призовые', faq: 'Вопросы', links: 'Ссылки', img: 'Картинка'
  };

  function blockHTML(b, si, bi, ctx) {
    var fn = BLOCKS[b && b.type];
    if (!fn) return '<div class="blk-unknown">Неизвестный блок: ' + esc(b && b.type) + '</div>';
    return fn(b, 'sections.' + si + '.blocks.' + bi, ctx || {}, { si: si, bi: bi });
  }

  function sectionHTML(sec, si, ctx) {
    var body = (sec.blocks || []).map(function (b, bi) { return blockHTML(b, si, bi, ctx); }).join('');
    return '<section class="sec" id="' + esc(sec.id || ('s' + si)) + '">'
      + '<div class="sec__rail">' + pad2(si + 1) + '</div>'
      + '<div class="sec__body">'
      + '<h2 class="' + cls('sec__title', ctx) + '"' + ea('sections.' + si + '.title', ctx) + '>'
      + esc(sec.title || '') + '</h2>'
      + body
      + '</div></section>';
  }

  function sectionsHTML(doc, ctx) {
    return (doc.sections || []).map(function (s, i) { return sectionHTML(s, i, ctx); }).join('');
  }

  /* Дефолтные блоки для «+ блок» */
  function blankBlock(type) {
    switch (type) {
      case 'p': return { type: 'p', text: '' };
      case 'h3': return { type: 'h3', text: 'Подзаголовок' };
      case 'clauses': return { type: 'clauses', items: [{ text: '' }] };
      case 'note': return { type: 'note', tone: 'key', label: 'Важно', text: '' };
      case 'table': return { type: 'table', head: ['Колонка', 'Колонка'], rows: [['', '']] };
      case 'specs': return { type: 'specs', items: [{ k: 'Параметр', v: 'Значение' }] };
      case 'tags': return { type: 'tags', items: [{ text: 'Условие' }] };
      case 'stages': return { type: 'stages', items: [{ name: 'Этап', meta: 'дата' }] };
      case 'podium': return { type: 'podium', items: [{ rank: 'Первое место', sum: '—', note: '' }] };
      case 'faq': return { type: 'faq', items: [{ q: 'Вопрос?', a: 'Ответ.' }] };
      case 'links': return { type: 'links', items: [{ label: 'Ссылка', url: 'https://' }] };
      case 'img': return { type: 'img', src: '', caption: '', size: 'full' };
      default: return { type: 'p', text: '' };
    }
  }

  /* Уникальные и безопасные id разделов — на них висят якоря и оглавление. */
  function ensureIds(doc) {
    var used = {};
    (doc.sections || []).forEach(function (s, i) {
      var id = String(s.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!id || used[id]) id = 's' + (i + 1);
      while (used[id]) id = id + 'x';
      used[id] = 1;
      s.id = id;
    });
    return doc;
  }

  function normalize(doc) {
    if (!doc || typeof doc !== 'object') throw new Error('Документ пустой');
    doc.meta = doc.meta || {};
    if (!Array.isArray(doc.sections)) doc.sections = [];
    doc.sections.forEach(function (s) {
      if (!s || typeof s !== 'object') s = {};
      if (!Array.isArray(s.blocks)) s.blocks = [];
      s.title = String(s.title || 'Раздел');
    });
    return ensureIds(doc);
  }

  global.AM = global.AM || {};
  global.AM.render = {
    esc: esc,
    normalize: normalize,
    inline: inline,
    pad2: pad2,
    isUrl: isUrl,
    block: blockHTML,
    section: sectionHTML,
    sections: sectionsHTML,
    blankBlock: blankBlock,
    TYPE_NAMES: TYPE_NAMES
  };
})(window);