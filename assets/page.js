/* =============================================================================
   Публичная страница регламента.
   Читает content.json, рисует hero + оглавление + разделы.
   ?preview=1 — показать черновик из редактора (localStorage), для кнопки
   «Предпросмотр» в админке.
   ============================================================================= */
(function () {
  'use strict';

  var R = window.AM.render;
  var root = document.getElementById('root');
  var bar = document.getElementById('bar');
  var prog = document.getElementById('prog');
  var sheet = document.getElementById('tocsheet');
  var sheetList = document.getElementById('tocsheetList');
  var DRAFT_KEY = 'am.draft.v1';
  var isPreview = new URLSearchParams(location.search).has('preview');
  var sectionEls = [];

  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? m[3] + '.' + m[2] + '.' + m[1] : String(iso || '');
  }

  function loadContent() {
    if (isPreview) {
      try {
        var d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
        if (d && d.doc && d.doc.sections) return Promise.resolve({ doc: d.doc, draft: true });
      } catch (e) { /* битый черновик — читаем опубликованное */ }
    }
    return fetch('content.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (doc) { return { doc: doc, draft: false }; });
  }

  function metaItems(meta) {
    var items = Array.isArray(meta.hero) && meta.hero.length
      ? meta.hero.map(function (p) { return [p && p.k, p && p.v]; })
      : [
        ['Сезон', meta.season],
        ['Формат', meta.format],
        ['Косты', meta.costs],
        ['Редакция', meta.edition ? meta.edition + (meta.updated ? ' · ' + fmtDate(meta.updated) : '') : fmtDate(meta.updated)]
      ];
    items = items.filter(function (p) { return p[1]; }).slice(0, 6);
    return items.map(function (p) {
      return '<div><dt>' + R.esc(p[0]) + '</dt><dd>' + R.esc(p[1]) + '</dd></div>';
    }).join('');
  }

  function heroHTML(doc) {
    var meta = doc.meta || {};
    var art = meta.art
      ? '<div class="hero__art"><img id="heroArt" src="' + R.esc(meta.art)
        + '" alt="" decoding="async" fetchpriority="high"></div>'
      : '';
    return '<header class="hero">' + art
      + '<div class="hero__inner">'
      + (meta.kicker ? '<p class="micro hero__kicker">' + R.esc(meta.kicker) + '</p>' : '')
      + '<h1 class="hero__title">' + R.esc(meta.title || 'Регламент') + '</h1>'
      + (meta.lead ? '<p class="hero__lead">' + R.inline(meta.lead, false) + '</p>' : '')
      + (metaItems(meta) ? '<dl class="hero__meta">' + metaItems(meta) + '</dl>' : '')
      + '</div></header>';
  }

  function tocHTML(doc, meta) {
    var list = (doc.sections || []).map(function (s, i) {
      return '<li><a href="#' + R.esc(s.id) + '"><span class="toc__n">' + R.pad2(i + 1) + '</span>'
        + '<span>' + R.esc(s.title) + '</span></a></li>';
    }).join('');
    return '<nav class="toc" aria-label="Содержание">'
      + '<p class="micro toc__head">Содержание</p>'
      + '<ol class="toc__list">' + list + '</ol>'
      + '<p class="micro toc__stamp">Редакция ' + R.esc(meta.edition || '—')
      + '<br>обновлено ' + R.esc(fmtDate(meta.updated) || '—') + '</p>'
      + '</nav>';
  }

  function footHTML(meta) {
    return '<footer class="site-foot"><div class="site-foot__in">'
      + '<div>'
      + (meta.footnote ? '<p class="site-foot__note">' + R.inline(meta.footnote, false) + '</p>' : '')
      + '<p class="micro">' + R.esc(meta.title || 'Annihilation Masters')
      + (meta.edition ? ' · редакция ' + R.esc(meta.edition) : '')
      + (meta.updated ? ' · обновлено ' + R.esc(fmtDate(meta.updated)) : '')
      + '</p>'
      + '</div>'
      + '<div class="site-foot__acts">'
      + '<a class="foot-btn" href="#top">Наверх</a>'
      + '<a class="foot-btn" href="admin.html">Редактор</a>'
      + '</div></div></footer>';
  }

  function render(data) {
    var doc = R.normalize(data.doc);
    var meta = doc.meta;

    document.title = (meta.title || 'Регламент') + (meta.kicker ? ' — ' + meta.kicker : '');
    var desc = document.querySelector('meta[name="description"]');
    if (desc && meta.lead) desc.setAttribute('content', meta.lead);

    root.innerHTML = heroHTML(doc)
      + '<div class="doc">'
      + tocHTML(doc, meta)
      + '<article class="doc__body">' + R.sections(doc, {}) + '</article>'
      + '</div>'
      + footHTML(meta)
      + (data.draft || isPreview ? '<div class="preview-flag">Черновик</div>' : '');

    var art = document.getElementById('heroArt');
    if (art) art.addEventListener('error', function () { art.parentNode.remove(); });

    sectionEls = Array.prototype.slice.call(root.querySelectorAll('.sec'));
    sheetList.innerHTML = tocHTML(doc, meta).replace(/^<nav[^>]*>|<\/nav>$/g, '');
    wireToc(sheetList);
    wireToc(root.querySelector('.toc'));
    onScroll();
  }

  function wireToc(scope) {
    if (!scope) return;
    scope.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function () {
        closeSheet();
      });
    });
  }

  /* --- скролл: прогресс, залипающая шапка, активный раздел ----------------- */
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      var y = window.pageYOffset || document.documentElement.scrollTop;
      bar.classList.toggle('is-stuck', y > 8);
      var h = document.documentElement.scrollHeight - window.innerHeight;
      prog.style.setProperty('--p', (h > 0 ? Math.min(100, (y / h) * 100) : 0) + '%');

      var active = -1;
      for (var i = 0; i < sectionEls.length; i++) {
        if (sectionEls[i].getBoundingClientRect().top <= 150) active = i;
      }
      if (active < 0 && sectionEls.length) active = 0;
      var links = root.querySelectorAll('.toc__list a');
      for (var k = 0; k < links.length; k++) {
        links[k].classList.toggle('is-active', k === active);
      }
    });
  }

  /* --- мобильное оглавление ------------------------------------------------ */
  function openSheet() { sheet.hidden = false; sheet.classList.add('is-open'); }
  function closeSheet() { sheet.classList.remove('is-open'); sheet.hidden = true; }

  function initShell() {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    var btnToc = document.getElementById('btnToc');
    if (btnToc) btnToc.addEventListener('click', openSheet);
    sheet.addEventListener('click', function (e) {
      if (e.target.hasAttribute('data-close') || e.target.closest('a[href^="#"]')) closeSheet();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
    onScroll();
  }

  initShell();

  loadContent()
    .then(render)
    .catch(function (err) {
      root.innerHTML = '<div class="loading">'
        + 'Не удалось загрузить регламент: ' + R.esc(err.message) + '<br><br>'
        + '<button class="foot-btn" type="button" onclick="location.reload()">Повторить</button>'
        + '</div>';
    });
})();