/* =============================================================================
   РЕДАКТОР РЕГЛАМЕНТА — логика
   Правит документ прямо в макете: коснулся текста — печатаешь. Структура
   (разделы, блоки, пункты) — кнопками, без перетаскивания: на планшете
   drag&drop врёт, кнопки нет. Черновик живёт в localStorage, публикация —
   на сервер.
   ============================================================================= */
(function () {
  'use strict';

  var R = window.AM.render;
  var DRAFT_KEY = 'am.draft.v1';
  var DRAFTS_KEY = 'am.drafts.v1';   /* лента автосохранений: к ней и откатываемся */
  var DRAFTS_MAX = 12;
  var DRAFT_EVERY = 90000;           /* не чаще раза в 1,5 минуты, если правки идут */
  var PASS_KEY = 'am.pass';

  var S = { doc: null, published: null, store: null, authed: false, dirty: false, lock: false, stale: false };

  /* ── история шагов ───────────────────────────────────────────────────────
     Снимки документа до каждого изменения. На планшете цtrl+z нет, поэтому
     те же действия висят кнопками ↶ ↷ в левом нижнем углу. */
  var UNDO_MAX = 40;
  var undoStack = [], redoStack = [], metaSnapped = false;

  function paintUndo() {
    var box = $('undo');
    if (!box) return;
    var u = $('btnUndo'), r = $('btnRedo');
    if (u) u.hidden = !undoStack.length;
    if (r) r.hidden = !redoStack.length;
    box.hidden = !undoStack.length && !redoStack.length;
  }

  function snap() {
    try {
      var cur = JSON.stringify(S.doc);
      if (undoStack[undoStack.length - 1] === cur) return;
      undoStack.push(cur);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
      redoStack.length = 0;
    } catch (e) { }
    paintUndo();
  }

  function applySnap(json) {
    S.doc = R.normalize(JSON.parse(json));
    touch();
    renderAll();
    paintUndo();
  }

  function undoStep() {
    if (!undoStack.length) { toast('Отменять нечего'); return; }
    redoStack.push(JSON.stringify(S.doc));
    applySnap(undoStack.pop());
    toast('Шаг назад');
  }

  function redoStep() {
    if (!redoStack.length) { toast('Повторять нечего'); return; }
    undoStack.push(JSON.stringify(S.doc));
    applySnap(redoStack.pop());
    toast('Шаг вперёд');
  }

  var $ = function (id) { return document.getElementById(id); };
  var gate = $('gate'), app = $('app'), adoc = $('adoc'), sheet = $('sheet'),
      sheetCard = $('sheetCard'), toastEl = $('toast'), statusEl = $('status'),
      statusText = $('statusText');

  /* ── утилиты ─────────────────────────────────────────────────────────── */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function getIn(path) {
    var parts = path.split('.'), o = S.doc;
    for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
    return o;
  }
  function setIn(path, val) {
    var parts = path.split('.'), o = S.doc;
    for (var i = 0; i < parts.length - 1; i++) { o = o[parts[i]]; }
    o[parts[parts.length - 1]] = val;
  }
  function moveItem(arr, from, to) {
    if (to < 0 || to >= arr.length) return false;
    arr.splice(to, 0, arr.splice(from, 1)[0]);
    return true;
  }
  function today() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function clock(at) {
    var d = at instanceof Date ? at : new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function stamp(ms) {
    var d = new Date(ms);
    return String(d.getDate()).padStart(2, '0') + '.' +
      String(d.getMonth() + 1).padStart(2, '0') + ' в ' + clock(d);
  }

  var toastTimer;
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = 'toast is-on' + (isError ? ' is-err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, isError ? 5200 : 2600);
  }

  /* ── статус / черновик ───────────────────────────────────────────────── */
  function updateStatus(text) {
    if (text) { statusEl.className = 'astatus is-busy'; statusText.textContent = text; return; }
    if (S.dirty) {
      statusEl.className = 'astatus is-dirty';
      statusText.textContent = 'Есть правки' + (S.draftAt ? ' · сохранено ' + clock(new Date(S.draftAt)) : '');
    }
    else { statusEl.className = 'astatus is-saved'; statusText.textContent = 'Опубликовано'; }
  }

  /* ── чужак опубликовал: предупредить до нажатия «Опубликовать» ────────── */
  var freshAt = 0, freshBusy = false;
  function checkFresh() {
    if (!S.authed || !S.store || S.store.mode === 'readonly') return;
    if (freshBusy || Date.now() - freshAt < 20000) return;
    freshBusy = true;
    freshAt = Date.now();
    S.store.load().then(function (fresh) {
      freshBusy = false;
      var theirs = R.normalize(clone(fresh));
      if (sameDoc(theirs, S.published)) return;
      var typing = document.activeElement && document.activeElement.getAttribute
        && document.activeElement.getAttribute('data-p');
      if (!S.dirty && !typing) {
        /* терять нечего — просто подтягиваем свежую версию */
        S.published = theirs;
        S.doc = R.normalize(clone(theirs));
        S.stale = false;
        saveDraft();
        renderAll();
        toast('Страницу обновили с другого устройства — подтянул свежую версию');
        return;
      }
      S.stale = true;
      toast('Пока вы правите, страницу обновили — при публикации ваша версия заменит чужую', true);
    }, function () { freshBusy = false; });
  }

  window.addEventListener('focus', checkFresh);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) checkFresh();
  });

  var draftTimer;
  function touch() {
    S.dirty = true;
    updateStatus();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 400);
  }
  function saveDraft() {
    try {
      S.draftAt = Date.now();
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ doc: S.doc, at: S.draftAt }));
      snapshotDraft(false);
    } catch (e) { }
    if (S.dirty) updateStatus();
  }

  /* ── лента автосохранений: из неё достаём работу после сбоя ───────────── */
  function readDrafts() {
    try {
      var list = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '[]');
      return Array.isArray(list) ? list.filter(function (d) { return d && d.doc && d.at; }) : [];
    } catch (e) { return []; }
  }

  function writeDrafts(list) {
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(list)); }
    catch (e) {
      /* не влезли — выкидываем самые старые и пробуем ещё раз */
      try {
        list = list.slice(0, Math.max(2, Math.floor(list.length / 2)));
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(list));
      } catch (e2) { }
    }
    paintDraftBadge();
  }

  function snapshotDraft(force) {
    if (!S.doc || !S.doc.sections) return;
    var list = readDrafts();
    var top = list[0];
    var same = top && sameDoc(top.doc, S.doc);
    if (same) {
      if (force) { top.at = Date.now(); writeDrafts(list); }
      return;
    }
    if (!force && top && Date.now() - top.at < DRAFT_EVERY) return;
    list.unshift({ at: Date.now(), doc: clone(S.doc) });
    if (list.length > DRAFTS_MAX) list.length = DRAFTS_MAX;
    writeDrafts(list);
    if (S.dirty) updateStatus();
  }

  function paintDraftBadge() {
    var btn = $('btnRecovery');
    if (!btn) return;
    var n = readDrafts().length;
    var label = btn.querySelector('.rlabel');
    if (label) label.textContent = n ? 'Черновики · ' + n : 'Черновики';
    btn.title = n
      ? 'Черновики и откат версий — сохранено автосохранений: ' + n
      : 'Черновики и откат версий';
  }
  function readDraft() {
    try {
      var d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      return d && d.doc && Array.isArray(d.doc.sections) ? d : null;
    } catch (e) { return null; }
  }
  function sameDoc(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; } }

  /* ── разметка редактора ──────────────────────────────────────────────── */
  var SMALL_W = 900;      /* уже этого на широкой колонке начнёт мылить */
  var SMALL_ART_W = 2400; /* баннеру шапки мало 2× от экрана: иначе на ретине мыло */

  var ITEM_ADD_LABEL = {
    clauses: '＋ пункт', faq: '＋ вопрос', specs: '＋ параметр', tags: '＋ условие',
    stages: '＋ этап', podium: '＋ место', links: '＋ ссылка', table: '＋ строка'
  };
  var ITEM_DEFAULT = {
    clauses: function () { return { text: '' }; },
    faq: function () { return { q: '', a: '' }; },
    specs: function () { return { k: '', v: '' }; },
    tags: function () { return { text: '' }; },
    stages: function () { return { name: '', meta: '' }; },
    podium: function () { return { rank: '', sum: '', note: '' }; },
    links: function () { return { label: '', url: 'https://' }; }
  };
  var ITEM_FIRST_FIELD = { clauses: 'text', faq: 'q', specs: 'k', tags: 'text', stages: 'name', podium: 'rank', links: 'label' };

  function tbtn(act, glyph, label) {
    return '<button class="tbtn" type="button" data-act="' + act + '" aria-label="' + label + '" title="' + label + '">' + glyph + '</button>';
  }

  function blockWrap(b, si, bi) {
    var type = (b && b.type) || 'p';
    var addBtn = ITEM_ADD_LABEL[type]
      ? '<div class="addrow"><button class="btn btn--sm btn--ghost" type="button" data-act="add-item">' + ITEM_ADD_LABEL[type] + '</button></div>'
      : '';
    var pickBtn = type === 'img'
      ? '<button class="btn btn--sm" type="button" data-act="pick-img">Заменить картинку</button>'
      : '';
    return '<div class="ablk" data-si="' + si + '" data-bi="' + bi + '">'
      + '<div class="ablk__bar">'
      + '<span class="ablk__type">' + R.esc(R.TYPE_NAMES[type] || type) + '</span>'
      + '<div class="ablk__tools">' + tbtn('add-after', '＋', 'Новый абзац следом') + tbtn('up', '↑', 'Блок выше') + tbtn('down', '↓', 'Блок ниже') + tbtn('menu', '⋯', 'Действия с блоком') + '</div>'
      + '</div>'
      + '<div class="ablk__body">' + R.block(b, si, bi, { edit: true }) + '</div>'
      + pickBtn
      + addBtn
      + '</div>';
  }

  function sectionWrap(s, si) {
    var blocks = (s.blocks || []).map(function (b, bi) { return blockWrap(b, si, bi); }).join('');
    return '<div class="asec" data-si="' + si + '">'
      + '<div class="asec__head">'
      + '<span class="asec__n">' + R.pad2(si + 1) + '</span>'
      + '<h2 class="sec__title ed" contenteditable="plaintext-only" spellcheck="false" '
      + 'data-p="sections.' + si + '.title">' + R.esc(s.title || '') + '</h2>'
      + '<div class="asec__tools">' + tbtn('sec-up', '↑', 'Раздел выше') + tbtn('sec-down', '↓', 'Раздел ниже') + tbtn('sec-menu', '⋯', 'Действия с разделом') + '</div>'
      + '</div>'
      + '<div class="asec__blocks">' + blocks + '</div>'
      + '<button class="addblk" type="button" data-act="add-block">＋ Блок</button>'
      + '</div>';
  }

  function renderAll() {
    S.lock = true;
    adoc.innerHTML = (S.doc.sections || []).map(sectionWrap).join('')
      || '<p class="micro">Разделов пока нет — нажмите «Добавить раздел».</p>';
    /* любой узел с data-p — редактируемый: подсветка и плейсхолдер навешиваются здесь */
    Array.prototype.forEach.call(adoc.querySelectorAll('[data-p]'), function (el) {
      el.classList.add('ed');
    });
    Array.prototype.forEach.call(adoc.querySelectorAll('.ed'), function (el) {
      if (!el.textContent.trim()) el.setAttribute('data-ph', 'пусто');
    });
    paintDocStyle();
    setTimeout(function () { S.lock = false; }, 0);
    updateStatus();
  }

  /* ── правка текста в макете ──────────────────────────────────────────── */
  function commit(el) {
    var path = el.getAttribute('data-p');
    if (!path) return;
    var val = (el.innerText || '').replace(/\u00a0/g, ' ');
    val = val.replace(/\n+$/g, '');
    if (/\.title$/.test(path)) val = val.replace(/\n/g, ' ').trim();

    /* авто-номер пункта: если текст совпал с автонумерацией — храним пусто */
    var m = /^sections\.(\d+)\.blocks\.(\d+)\.items\.(\d+)\.n$/.exec(path);
    if (m) {
      var auto = (+m[1] + 1) + '.' + (+m[3] + 1);
      if (val.trim() === auto) val = '';
    }
    if (getIn(path) === val) return;
    snap();
    setIn(path, val);
    touch();
  }

  function flushFocused() {
    var el = document.activeElement;
    if (el && el.getAttribute && el.getAttribute('data-p')) commit(el);
  }

  function focusPath(path) {
    var el = adoc.querySelector('[data-p="' + path.replace(/"/g, '\\"') + '"]');
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(function () { try { el.focus(); } catch (e) { } }, 60);
  }

  /* печатаем — значит есть неопубликованное: статус, автосохранение и защита
     от чужой версии. Пауза 1,5 с фиксирует текст в документ: иначе при сбое
     терялось бы то, что набрано в текущем поле. */
  var typingTimer;
  adoc.addEventListener('input', function (e) {
    var el = e.target;
    if (!el || !el.getAttribute || !el.getAttribute('data-p')) return;
    if (S.lock) return;
    if (!S.dirty) { S.dirty = true; updateStatus(); }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function () {
      var cur = document.activeElement;
      if (cur && cur.getAttribute && cur.getAttribute('data-p')) commit(cur);
    }, 1500);
  });

  /* закрытие вкладки не должно съедать набранное: фиксируем поле в черновик */
  window.addEventListener('beforeunload', function () {
    try { flushFocused(); saveDraft(); snapshotDraft(true); } catch (e) { }
  });
  window.addEventListener('pagehide', function () {
    try { flushFocused(); snapshotDraft(true); } catch (e) { }
  });

  adoc.addEventListener('focusout', function (e) {
    var el = e.target;
    if (!el || !el.getAttribute || !el.getAttribute('data-p')) return;
    if (S.lock) return;
    commit(el);
  });

  /* Вставка как чистый текст: иначе в макет прилетит чужая разметка */
  adoc.addEventListener('paste', function (e) {
    var el = e.target;
    if (!el || !el.getAttribute || !el.getAttribute('data-p')) return;
    var text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (text == null) return;
    e.preventDefault();
    document.execCommand('insertText', false, text.replace(/\r/g, ''));
  });

  adoc.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var el = e.target;
    if (!el || !el.getAttribute || !el.getAttribute('data-p')) return;
    var path = el.getAttribute('data-p');

    /* Shift/Ctrl+Enter — «закончил, выйди из правки» */
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      el.blur();
      return;
    }

    var m = path.match(/^sections\.(\d+)\.blocks\.(\d+)(?:\.items\.(\d+))?\.([a-z0-9]+)$/i);
    if (!m) {
      /* заголовок раздела, шапка, название — одна строка, Enter завершает */
      e.preventDefault();
      el.blur();
      return;
    }
    var si = +m[1], bi = +m[2], item = m[3] === undefined ? null : +m[3], field = m[4];
    var sec = S.doc.sections[si];
    var b = sec && sec.blocks[bi];
    if (!b) { e.preventDefault(); el.blur(); return; }

    /* сначала фиксируем набранное: иначе Enter уносит текст в никуда */
    commit(el);

    /* внутри списка — новый пункт под текущим */
    if (item !== null) {
      if (ITEM_DEFAULT[b.type]) {
        e.preventDefault();
        addItem(si, bi, item);
        return;
      }
      e.preventDefault();
      el.blur();
      return;
    }

    /* абзац, подзаголовок, врезка, подпись — новый абзац следом */
    if (field === 'text' || field === 'caption') {
      e.preventDefault();
      addParagraphAfter(si, bi);
      return;
    }

    e.preventDefault();
    el.blur();
  });

  /* ── действия ────────────────────────────────────────────────────────── */
  adoc.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn || !adoc.contains(btn)) return;
    e.preventDefault();
    flushFocused();
    var act = btn.getAttribute('data-act');
    var blk = btn.closest('.ablk'), sec = btn.closest('.asec');
    var si = sec ? +sec.getAttribute('data-si') : -1;
    var bi = blk ? +blk.getAttribute('data-bi') : -1;
    actOn(act, si, bi);
  });

  function actOn(act, si, bi) {
    var sec = S.doc.sections[si];
    if (!sec) return;

    switch (act) {
      case 'up':
        if (bi > 0) { snap(); moveItem(sec.blocks, bi, bi - 1); renderAll(); }
        break;
      case 'down':
        if (bi < sec.blocks.length - 1) { snap(); moveItem(sec.blocks, bi, bi + 1); renderAll(); }
        break;
      case 'menu':
        blockMenu(si, bi);
        break;
      case 'add-item':
        addItem(si, bi);
        break;
      case 'add-after':
        addParagraphAfter(si, bi);
        break;
      case 'pick-img':
        pickImgBlock(si, bi);
        break;
      case 'add-block':
        typeChooser(si);
        break;
      case 'sec-up':
        if (si > 0) { snap(); moveItem(S.doc.sections, si, si - 1); renderAll(); }
        break;
      case 'sec-down':
        if (si < S.doc.sections.length - 1) { snap(); moveItem(S.doc.sections, si, si + 1); renderAll(); }
        break;
      case 'sec-menu':
        sectionMenu(si);
        break;
    }
  }

  function addItem(si, bi, afterIdx) {
    var b = S.doc.sections[si].blocks[bi];
    snap();
    if (b.type === 'table') {
      b.rows = b.rows || [];
      b.rows.push((b.head || []).map(function () { return ''; }));
      renderAll();
      focusPath('sections.' + si + '.blocks.' + bi + '.rows.' + (b.rows.length - 1) + '.0');
      return;
    }
    var make = ITEM_DEFAULT[b.type];
    if (!make) return;
    b.items = b.items || [];
    var at = (typeof afterIdx === 'number' && afterIdx >= 0 && afterIdx < b.items.length) ? afterIdx + 1 : b.items.length;
    b.items.splice(at, 0, make());
    renderAll();
    focusPath('sections.' + si + '.blocks.' + bi + '.items.' + at + '.' + ITEM_FIRST_FIELD[b.type]);
  }

  /* новый абзац сразу после блока — то, что нужно в 9 случаях из 10 */
  function addParagraphAfter(si, bi) {
    var sec = S.doc.sections[si];
    if (!sec) return;
    snap();
    var at = (typeof bi === 'number' && bi >= 0 && bi < sec.blocks.length) ? bi + 1 : sec.blocks.length;
    sec.blocks.splice(at, 0, R.blankBlock('p'));
    renderAll();
    focusPath('sections.' + si + '.blocks.' + at + '.text');
  }

  /* ── листы (sheet) ───────────────────────────────────────────────────── */
  var sheetHandler = null;
  function openSheet(html, handler) {
    sheetCard.innerHTML = html;
    sheetHandler = handler || null;
    sheet.hidden = false;
  }
  function closeSheet() { sheet.hidden = true; sheetHandler = null; sheetCard.innerHTML = ''; }

  sheetCard.addEventListener('click', function (e) {
    var b = e.target.closest('[data-cmd]');
    if (!b) return;
    var cmd = b.getAttribute('data-cmd');
    if (cmd === 'close') { closeSheet(); return; }
    if (sheetHandler) {
      try { sheetHandler(cmd, b); }
      catch (err) {
        toast('Не получилось: ' + (err && err.message ? err.message : err), true);
      }
    }
  });
  sheet.addEventListener('click', function (e) {
    if (e.target.hasAttribute('data-close')) closeSheet();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  function opt(cmd, name, desc, danger) {
    var current = danger === 'current';
    return '<button class="opt' + (danger === true ? ' opt--danger' : '') + (current ? ' is-current' : '') + '" type="button" data-cmd="' + cmd + '">'
      + '<span class="opt__name">' + R.esc(name) + (current ? ' <i>· сейчас</i>' : '') + '</span>'
      + (desc ? '<span class="opt__desc">' + R.esc(desc) + '</span>' : '')
      + '</button>';
  }

  function confirmSheet(title, text, okName, onOk) {
    openSheet(
      '<p class="sheet__title">' + R.esc(title) + '</p>'
      + '<p style="font-size:.92rem;line-height:1.5;margin:0 0 4px">' + R.esc(text) + '</p>'
      + '<div class="sheet__actions">'
      + '<button class="btn btn--primary" type="button" data-cmd="ok">' + R.esc(okName) + '</button>'
      + '<button class="btn btn--ghost" type="button" data-cmd="close">Отмена</button>'
      + '</div>',
      function (cmd) { if (cmd === 'ok') { closeSheet(); onOk(); } }
    );
  }

  function blockMenu(si, bi) {
    var b = S.doc.sections[si].blocks[bi];
    var rows = opt('dup', 'Дублировать блок')
      + (b.type === 'img'
        ? opt('img-pick', 'Заменить картинку')
          + opt('size:full', 'Во всю ширину', null, (b.size || 'full') === 'full' ? 'current' : false)
          + opt('size:mid', 'Поуже', null, b.size === 'mid' ? 'current' : false)
          + opt('size:half', 'Половина', null, b.size === 'half' ? 'current' : false)
        : '')
      + (ITEM_DEFAULT[b.type] || b.type === 'table' ? opt('add-item', ITEM_ADD_LABEL[b.type] || 'Добавить строку') : '')
      + (b.type === 'note'
        ? opt('tone-none', 'Врезка: обычная') + opt('tone-key', 'Врезка: важная') + opt('tone-ban', 'Врезка: запрет')
        : '')
      + (b.type === 'table' ? opt('add-col', 'Добавить колонку') + opt('del-col', 'Удалить последнюю колонку') : '')
      + (b.type === 'table' ? opt('del-row', 'Удалить последнюю строку') : '')
      + (S.doc.sections.length > 1 ? opt('move', 'Перенести в другой раздел') : '')
      + opt('add-after', 'Вставить блок ниже')
      + opt('convert', 'Превратить в другой тип')
      + opt('del', 'Удалить блок', null, true);

    openSheet('<p class="sheet__title">' + R.esc(R.TYPE_NAMES[b.type] || b.type) + '</p>' + rows, function (cmd) {
      var blk = S.doc.sections[si].blocks[bi];
      if (cmd === 'close') { closeSheet(); return; }
      if (cmd === 'img-pick') { closeSheet(); pickImgBlock(si, bi); return; }
      if (cmd === 'convert') { closeSheet(); typeChooser(si, bi); return; }
      if (cmd === 'move') { closeSheet(); moveMenu(si, bi); return; }
      if (cmd === 'add-after') { closeSheet(); typeChooser(si, bi, 'after'); return; }
      if (cmd.indexOf('size:') === 0) {
        snap();
        blk.size = cmd.slice(5);
        closeSheet(); renderAll();
        return;
      }
      if (cmd === 'dup') {
        snap();
        S.doc.sections[si].blocks.splice(bi + 1, 0, clone(blk));
        closeSheet(); renderAll();
        return;
      }
      if (cmd === 'add-item') { closeSheet(); addItem(si, bi); return; }
      if (cmd.indexOf('tone-') === 0) {
        snap();
        blk.tone = cmd === 'tone-none' ? '' : cmd.slice(5);
        closeSheet(); renderAll(); return;
      }
      if (cmd === 'add-col') {
        snap();
        blk.head = blk.head || []; blk.head.push('');
        blk.rows = (blk.rows || []).map(function (r) { r.push(''); return r; });
        closeSheet(); renderAll(); return;
      }
      if (cmd === 'del-col') {
        if ((blk.head || []).length > 1) {
          snap();
          blk.head.pop();
          (blk.rows || []).forEach(function (r) { r.pop(); });
          closeSheet(); renderAll();
        } else { toast('Последнюю колонку удалить нельзя', true); }
        return;
      }
      if (cmd === 'del-row') {
        if ((blk.rows || []).length > 1) { snap(); blk.rows.pop(); closeSheet(); renderAll(); }
        else { toast('Последнюю строку удалить нельзя', true); }
        return;
      }
      if (cmd === 'del') {
        confirmSheet('Удалить блок?', 'Блок «' + (R.TYPE_NAMES[blk.type] || blk.type) + '» исчезнет из раздела.', 'Удалить', function () {
          snap();
          S.doc.sections[si].blocks.splice(bi, 1);
          touch(); renderAll();
        });
      }
    });
  }

  function sectionMenu(si) {
    var s = S.doc.sections[si];
    openSheet('<p class="sheet__title">Раздел ' + R.pad2(si + 1) + '</p>'
      + opt('add-block', 'Добавить блок в конец')
      + opt('dup', 'Дублировать раздел')
      + opt('del', 'Удалить раздел', null, true),
      function (cmd) {
        if (cmd === 'close') { closeSheet(); return; }
        if (cmd === 'add-block') { closeSheet(); typeChooser(si); return; }
        if (cmd === 'dup') {
          snap();
          var copy = clone(s);
          copy.id = '';
          S.doc.sections.splice(si + 1, 0, copy);
          R.normalize(S.doc);
          closeSheet(); touch(); renderAll();
          return;
        }
        if (cmd === 'del') {
          confirmSheet('Удалить раздел?', 'Раздел «' + (s.title || '') + '» и все его блоки будут удалены.',
            'Удалить раздел', function () {
              snap();
              S.doc.sections.splice(si, 1);
              touch(); renderAll();
            });
        }
      });
  }

  var TYPES = [
    ['p', 'Абзац', 'обычный текст'],
    ['h3', 'Подзаголовок', 'мелкий капс'],
    ['clauses', 'Пункты', 'нумерованный список'],
    ['note', 'Врезка', 'замечание или запрет'],
    ['table', 'Таблица', 'строки и колонки'],
    ['specs', 'Параметры', 'параметр → значение'],
    ['tags', 'Условия', 'перечисление через линии'],
    ['stages', 'Этапы', 'таймлайн'],
    ['podium', 'Призовые', 'места и суммы'],
    ['faq', 'Вопросы', 'вопрос → ответ'],
    ['links', 'Ссылки', 'список ссылок'],
    ['img', 'Картинка', 'скриншот или схема с подписью']
  ];

  /* Перенос содержимого при смене типа блока — насколько формы совпадают. */
  function convertBlock(old, type) {
    var nb = R.blankBlock(type);
    if (type === 'img') {
      if (old.src) nb.src = old.src;
      return nb;
    }
    if (old.text != null) {
      if (nb.text !== undefined) nb.text = old.text;
      else if (type === 'clauses' || type === 'tags') nb.items = [{ text: old.text }];
      else if (type === 'faq') nb.items = [{ q: old.text, a: '' }];
      else if (type === 'links') nb.items = [{ label: old.text, url: 'https://' }];
      else if (type === 'specs') nb.items = [{ k: old.text, v: '' }];
      else if (type === 'podium') nb.items = [{ rank: old.text, sum: '', note: '' }];
      else if (type === 'stages') nb.items = [{ name: old.text, meta: '' }];
      return nb;
    }
    if (Array.isArray(old.items)) {
      if (nb.text !== undefined) {
        nb.text = old.items.map(function (it) {
          return it.text || it.q || it.k || it.name || it.label || it.rank || '';
        }).filter(Boolean).join(' ');
      } else if (type === 'tags' || type === 'clauses') {
        nb.items = old.items.map(function (it) { return { text: it.text || it.q || it.k || it.name || it.label || '' }; });
      } else if (type === 'faq') {
        nb.items = old.items.map(function (it) { return { q: it.text || it.q || it.k || it.name || '', a: it.v || it.a || '' }; });
      } else if (type === 'links') {
        nb.items = old.items.map(function (it) { return { label: it.text || it.q || it.name || it.label || '', url: 'https://' }; });
      }
    }
    return nb;
  }

  function typeChooser(si, bi, mode) {
    mode = mode || (typeof bi === 'number' ? 'convert' : 'append');
    var converting = mode === 'convert';
    var sec = S.doc.sections[si];
    var cur = converting ? sec.blocks[bi] : null;
    var at = (mode === 'after' && typeof bi === 'number') ? bi + 1 : (sec.blocks || []).length;
    var title = converting
      ? 'Превратить «' + R.esc(R.TYPE_NAMES[cur.type] || cur.type) + '» в…'
      : (mode === 'after' ? 'Новый блок после «' + R.esc(R.TYPE_NAMES[(sec.blocks[bi] || {}).type] || '') + '»' : 'Новый блок в раздел ' + R.pad2(si + 1));
    var html = '<p class="sheet__title">' + title + '</p>'
      + (converting ? '<p class="field__hint">Текст перенесётся, оформление станет новым.</p>' : '')
      + TYPES.map(function (t) { return opt('type:' + t[0], t[1], t[2], converting && cur.type === t[0]); }).join('');
    openSheet(html, function (cmd) {
      if (cmd.indexOf('type:') !== 0) return;
      var type = cmd.slice(5);
      if (converting) {
        if (type === cur.type) { closeSheet(); return; }
        snap();
        sec.blocks[bi] = convertBlock(cur, type);
        closeSheet();
        touch();
        renderAll();
        return;
      }
      var b = R.blankBlock(type);
      sec.blocks = sec.blocks || [];
      sec.blocks.splice(at, 0, b);
      closeSheet();
      touch();
      renderAll();
      if (type === 'img') { pickImgBlock(si, at); return; }
      var first = { p: 'text', h3: 'text', note: 'text', clauses: 'items.0.text', table: 'rows.0.0', specs: 'items.0.k', tags: 'items.0.text', stages: 'items.0.name', podium: 'items.0.rank', faq: 'items.0.q', links: 'items.0.label' }[type];
      if (first) focusPath('sections.' + si + '.blocks.' + at + '.' + first);
    });
  }

  /* ── картинки ────────────────────────────────────────────────────────── */
  function pickImgBlock(si, bi) {
    var blk = S.doc.sections[si].blocks[bi];
    pickImage(function (url, w, h) {
      snap();
      blk.src = url;
      if (w) { blk.w = w; blk.h = h || 0; }
      if (w && w < SMALL_W) toast('Кадр ' + w + '×' + (h || 0) + ' — мелковат: на широкой колонке растянется', true);
      touch();
      renderAll();
      toast('Картинка вставлена');
    });
  }

  /* Лист выбора: загрузить новый файл, взять из уже загруженных, вставить путь. */
  function pickImage(onPick) {
    var canUpload = !!S.store.canUpload && typeof S.store.upload === 'function';

    /* размер кадра меряем в браузере: сервер отдаёт его не всегда (GitHub, ручной путь) */
    function measure(url) {
      return new Promise(function (resolve) {
        var im = new Image();
        im.onload = function () { resolve({ w: im.naturalWidth, h: im.naturalHeight }); };
        im.onerror = function () { resolve({ w: 0, h: 0 }); };
        im.src = url;
      });
    }
    function deliver(url, w, h) {
      if (w) { onPick(url, w, h); return; }
      measure(url).then(function (m) { onPick(url, m.w, m.h); });
    }

    var html = '<p class="sheet__title">Картинка</p>'
      + (canUpload
        ? '<div class="sheet__actions" style="margin:0 0 8px">'
          + '<button class="btn btn--primary" type="button" data-cmd="upload">Загрузить с устройства</button>'
          + '</div>'
          + '<p class="field__hint" style="margin-bottom:14px">'
          + (S.store.mode === 'github'
            ? 'Файл уйдёт коммитом в репозиторий — картинка сразу станет частью сайта.'
            : 'Файл попадёт в assets/uploads и сразу появится здесь.')
          + '</p><input type="file" id="imgFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden>'
        : '<p class="field__hint">Загрузка файлов здесь недоступна. Положите картинку рядом с сайтом и впишите путь ниже.</p>')
      + '<label class="field"><span class="field__label">Путь или ссылка</span>'
      + '<input class="field__input" id="imgPath" placeholder="assets/uploads/… или https://…"></label>'
      + '<div class="sheet__actions" style="margin:0 0 16px">'
      + '<button class="btn" type="button" data-cmd="manual">Вставить этот путь</button>'
      + '</div>'
      + '<p class="micro" style="margin-bottom:10px">Уже загруженные</p>'
      + '<div class="imgs" id="imgList"><span class="field__hint">Загружаю список…</span></div>'
      + '<div class="sheet__actions">'
      + '<button class="btn btn--ghost" type="button" data-cmd="close">Закрыть</button>'
      + '</div>';

    openSheet(html, function (cmd, btn) {
      if (cmd === 'close') { closeSheet(); return; }
      if (cmd === 'upload') {
        var input = $('imgFile');
        if (!input) return;
        input.click();
        return;
      }
      if (cmd === 'manual') {
        var val = ($('imgPath') || {}).value || '';
        if (!val.trim()) { toast('Путь пустой', true); return; }
        closeSheet();
        deliver(val.trim(), 0, 0);
        return;
      }
      if (cmd === 'pick') {
        closeSheet();
        deliver(btn.getAttribute('data-url'), Number(btn.getAttribute('data-w')) || 0,
          Number(btn.getAttribute('data-h')) || 0);
        return;
      }
      if (cmd === 'del') {
        var name = btn.getAttribute('data-name');
        confirmSheet('Удалить картинку?', name + (S.store.mode === 'github'
      ? ' будет удалена из репозитория отдельным коммитом. Если она стоит в тексте, там будет пусто.'
      : ' исчезнет с сервера. Если она стоит в тексте, там будет пусто.'), 'Удалить', function () {
          S.store.removeImage(name).then(function () {
            toast('Удалено');
            openImages_refresh();
          }, function (e) { toast('Не удалилось: ' + e.message, true); });
        });
        return;
      }
    });

    var current = [];

    function openImages_refresh() {
      S.store.images().then(function (items) {
        current = items;
        var list = $('imgList');
        if (!list) return;
        list.innerHTML = items.length
          ? items.map(function (it) {
            var w = Number(it.w) || 0, h = Number(it.h) || 0;
            var dim = w ? (w + '×' + h) : '—';
            var weak = w && w < SMALL_W ? ' is-small' : '';
            return '<div class="imgs__row">'
              + '<img class="imgs__thumb" src="' + R.esc(it.url) + '" alt="" loading="lazy">'
              + '<span class="imgs__name">' + R.esc(it.name) + '<i class="imgs__dim' + weak + '">' + dim
              + (w && w < SMALL_W ? ' · мелко' : '') + '</i></span>'
              + '<button class="btn btn--sm" type="button" data-cmd="pick" data-url="' + R.esc(it.url) + '"'
              + ' data-w="' + w + '" data-h="' + h + '">Вставить</button>'
              + '<button class="btn btn--sm btn--ghost" type="button" data-cmd="del" data-name="' + R.esc(it.name) + '">✕</button>'
              + '</div>';
          }).join('')
          : '<span class="field__hint">Пока ничего не загружено.</span>';
      }, function (e) {
        var list = $('imgList');
        if (list) list.innerHTML = '<span class="field__hint">' + R.esc(e.message) + '</span>';
      });
    }

    /* слушатель вешаем сразу: лист уже в DOM, задержка тут только мешала */
    var input = $('imgFile');
    if (input) {
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        toast('Загружаю ' + file.name + '…');
        var blobUrl = '';
        try { blobUrl = window.URL.createObjectURL(file); } catch (err) { blobUrl = ''; }
        var size = blobUrl ? measure(blobUrl) : Promise.resolve({ w: 0, h: 0 });
        S.store.upload(file, file.name).then(function (res) {
          return size.then(function (m) {
            if (blobUrl) { try { window.URL.revokeObjectURL(blobUrl); } catch (err) { } }
            closeSheet();
            deliver(res.url, Number(res.w) || m.w, Number(res.h) || m.h);
          });
        }, function (e) { toast('Не загрузилось: ' + e.message, true); });
      });
    }
    if (canUpload) openImages_refresh();
  }

  /* ── история версий ──────────────────────────────────────────────────── */
  function openHistory() {
    if (S.store.mode === 'github') {
      openSheet('<p class="sheet__title">История версий</p>'
        + '<div class="help"><p>На GitHub каждая публикация — это коммит, поэтому история версий '
        + 'ведётся самим репозиторием.</p>'
        + '<p>Откатить или сравнить: репозиторий → файл <code>content.json</code> → «History». '
        + 'Любой прошлый коммит можно вернуть через <b>Revert</b> — страница обновится сама.</p>'
        + '<p>В панели редактора снимки и кнопка «Вернуть» появляются при работе с локальным сервером.</p></div>'
        + '<div class="sheet__actions"><button class="btn btn--primary" type="button" data-cmd="close">Понятно</button></div>',
        function (cmd) { if (cmd === 'close') closeSheet(); });
      return;
    }
    openSheet('<p class="sheet__title">История версий</p>'
      + '<div id="histList"><span class="field__hint">Загружаю…</span></div>'
      + '<p class="field__hint">Каждая публикация оставляет снимок предыдущей версии — до 40 штук. '
      + '«Вернуть» сразу публикует ту версию, её увидят все.</p>'
      + '<div class="sheet__actions"><button class="btn btn--ghost" type="button" data-cmd="close">Закрыть</button></div>',
      function (cmd, btn) {
        if (cmd === 'close') { closeSheet(); return; }
        if (cmd === 'load') { loadVersion(btn.getAttribute('data-name')); return; }
        if (cmd === 'back') { restoreVersion(btn.getAttribute('data-name')); return; }
      });

    S.store.history().then(function (items) {
      var box = $('histList');
      if (!box) return;
      if (!items.length) {
        box.innerHTML = '<span class="field__hint">Версий пока нет: они появляются после первой публикации.</span>';
        return;
      }
      box.innerHTML = items.map(function (it, i) {
        var when = it.at ? stamp(new Date(it.at).getTime()) : it.name;
        return '<div class="hist">'
          + '<div class="hist__info">'
          + '<span class="hist__when">' + R.esc(when) + (i === 0 ? ' · предыдущая' : '') + '</span>'
          + '<span class="hist__meta">' + it.sections + ' разд. · ' + Math.round(it.bytes / 1024) + ' КБ · ' + R.esc(it.name) + '</span>'
          + '</div>'
          + '<div class="hist__acts">'
          + '<button class="btn btn--sm" type="button" data-cmd="load" data-name="' + R.esc(it.name) + '">В редактор</button>'
          + '<button class="btn btn--sm btn--ghost" type="button" data-cmd="back" data-name="' + R.esc(it.name) + '">Вернуть</button>'
          + '</div></div>';
      }).join('');
    }, function (e) {
      var box = $('histList');
      if (box) box.innerHTML = '<span class="field__hint">' + R.esc(e.message) + '</span>';
    });
  }

  /* ── восстановление: автосохранения + опубликованные версии ──────────── */
  function blockCount(doc) {
    var n = 0;
    (doc.sections || []).forEach(function (sec) { n += (sec.blocks || []).length; });
    return n;
  }

  function recRow(when, meta, openCmd, backCmd, key) {
    return '<div class="rec">'
      + '<div class="rec__info">'
      + '<span class="rec__when">' + R.esc(when) + '</span>'
      + '<span class="rec__meta">' + R.esc(meta) + '</span>'
      + '</div>'
      + '<div class="rec__acts">'
      + '<button class="btn btn--sm" type="button" data-cmd="' + openCmd + '" data-i="' + R.esc(key) + '">'
      + (backCmd ? 'В редактор' : 'Открыть в редакторе') + '</button>'
      + (backCmd
        ? '<button class="btn btn--sm btn--ghost" type="button" data-cmd="' + backCmd
          + '" data-i="' + R.esc(key) + '">Вернуть</button>'
        : '')
      + '</div></div>';
  }

  function paintDraftList() {
    var box = $('recDrafts');
    if (!box) return;
    var list = readDrafts();
    if (!list.length) {
      box.innerHTML = '<span class="field__hint">Автосохранений пока нет: они появляются, как только вы что-то правите.</span>';
      return;
    }
    box.innerHTML = list.map(function (d, i) {
      var when = stamp(d.at) + (i === 0 ? ' · последнее' : '');
      var meta = (d.doc.sections || []).length + ' разд. · ' + blockCount(d.doc) + ' блоков · '
        + Math.round(JSON.stringify(d.doc).length / 1024) + ' КБ';
      return recRow(when, meta, 'draftopen', null, i);
    }).join('');
  }

  function paintVersionList() {
    var box = $('recVersions');
    if (!box) return;
    if (S.store.mode === 'github') {
      box.innerHTML = '<span class="field__hint">На GitHub история версий — это коммиты репозитория: '
        + 'файл <code>content.json</code> → «History» → <b>Revert</b>. Здесь показываются '
        + 'автосохранения этого браузера.</span>';
      return;
    }
    box.innerHTML = '<span class="field__hint">Загружаю…</span>';
    S.store.history().then(function (items) {
      var box2 = $('recVersions');
      if (!box2) return;
      if (!items.length) {
        box2.innerHTML = '<span class="field__hint">Пока нет: снимок появляется после каждой публикации.</span>';
        return;
      }
      box2.innerHTML = items.map(function (it, i) {
        var when = it.at ? stamp(new Date(it.at).getTime()) : it.name;
        return recRow(when + (i === 0 ? ' · предыдущая' : ''),
          it.sections + ' разд. · ' + Math.round(it.bytes / 1024) + ' КБ', 'veropen', 'verback', it.name);
      }).join('');
    }, function (e) {
      var box2 = $('recVersions');
      if (box2) box2.innerHTML = '<span class="field__hint">' + R.esc(e.message) + '</span>';
    });
  }

  function openRecovery() {
    openSheet('<p class="sheet__title">Восстановление</p>'
      + '<p class="field__hint" style="margin:0 0 10px">Автосохранения лежат в этом браузере: '
      + 'если пропал интернет, вкладка упала или страница закрылась — работа осталась здесь.</p>'
      + '<div class="rec__head">Автосохранения <button class="rec__clear" type="button" data-cmd="draftclear">очистить</button></div>'
      + '<div id="recDrafts"></div>'
      + '<div class="rec__head" style="margin-top:20px">Опубликованные версии</div>'
      + '<div id="recVersions"></div>'
      + '<div class="sheet__actions"><button class="btn btn--ghost" type="button" data-cmd="close">Закрыть</button></div>',
      function (cmd, btn) {
        if (cmd === 'close') { closeSheet(); return; }
        if (cmd === 'draftopen') { openDraft(+btn.getAttribute('data-i')); return; }
        if (cmd === 'draftclear') { clearDrafts(); return; }
        if (cmd === 'veropen') { loadVersion(btn.getAttribute('data-i')); return; }
        if (cmd === 'verback') { closeSheet(); restoreVersion(btn.getAttribute('data-i')); return; }
      });
    paintDraftList();
    paintVersionList();
  }

  function openDraft(i) {
    var d = readDrafts()[i];
    if (!d) return;
    snapshotDraft(true);          /* что открыто сейчас — тоже в автосохранения */
    S.doc = R.normalize(clone(d.doc));
    S.dirty = true;
    saveDraft();
    closeSheet();
    renderAll();
    updateStatus();
    toast('Автосохранение от ' + stamp(d.at) + ' открыто — проверьте и опубликуйте');
  }

  function clearDrafts() {
    var n = readDrafts().length;
    confirmSheet('Очистить автосохранения?',
      'Удалятся все ' + n + ' автосохранений этого браузера. Опубликованная страница и её история не тронуты.',
      'Очистить', function () {
        try { localStorage.removeItem(DRAFTS_KEY); } catch (e) { }
        paintDraftBadge();
        openRecovery();
        toast('Автосохранения очищены');
      });
  }

  function loadVersion(name) {
    S.store.historyDoc(name).then(function (doc) {
      snapshotDraft(true);
      snap();
      S.doc = R.normalize(doc);
      S.dirty = true;
      saveDraft();
      closeSheet();
      renderAll();
      toast('Версия ' + name + ' открыта в редакторе — проверьте и опубликуйте');
    }, function (e) { toast('Не открылось: ' + e.message, true); });
  }

  function restoreVersion(name) {
    confirmSheet('Вернуть эту версию?', 'Текущая страница станет ровно такой, какой была в снимке. '
      + 'Текущая версия останется в истории, так что откат обратим.', 'Вернуть', function () {
      S.store.restore(name).then(function () {
        return S.store.load();
      }).then(function (doc) {
        S.published = R.normalize(clone(doc));
        S.doc = R.normalize(clone(doc));
        S.dirty = false;
        saveDraft();
        closeSheet();
        renderAll();
        updateStatus('Опубликовано');
        toast('Версия возвращена — страница уже обновлена');
      }, function (e) { toast('Не получилось: ' + e.message, true); });
    });
  }

  /* ── подсказки ───────────────────────────────────────────────────────── */
  function openHelp() {
    openSheet('<p class="sheet__title">Как это работает</p>'
      + '<div class="help">'
      + '<p><b>Правка текста.</b> Коснитесь любого текста и печатайте. Enter в абзаце создаёт следующий абзац, в списке — следующий пункт; Shift+Enter завершает правку, '
      + 'структура (разделы, блоки, пункты) — кнопками, без перетаскивания.</p>'
      + '<p><b>Разметка.</b> <code>**жирный**</code>, <code>*курсив*</code>, <code>[текст](ссылка)</code>, '
      + 'просто ссылка тоже станет кликабельной.</p>'
      + '<p><b>Отмена.</b> Кнопки ↶ ↷ слева внизу, до 40 шагов. На клавиатуре Ctrl+Z и Ctrl+Shift+Z.</p>'
      + '<p><b>Новый блок на месте.</b> «＋» в полоске блока добавляет пустой абзац прямо под ним и ставит курсор. '
        + 'Другой тип — «⋯» → «Вставить блок ниже»; «＋ Блок» внизу раздела добавляет в конец.</p>'
        + '<p><b>Где я.</b> «⋯» в панели → «Перейти к разделу»: оглавление, сразу к нужному месту.</p>'
        + '<p><b>Публикация.</b> «Опубликовать» в верхней панели. До этого всё живёт в черновике этого браузера; '
      + '«Просмотр» показывает черновик в новой вкладке.</p>'
    + '<p><b>Если правите вдвоём.</b> Перед публикацией редактор проверяет страницу: если кто-то успел '
    + 'опубликовать своё, он покажет, какие разделы расходятся, и спросит — заменить чужую версию вашей '
    + 'или взять их. Заменённая версия не теряется, она остаётся в истории. Надёжнее договориться '
    + 'и публиковать по очереди.</p>'
      + '<p><b>Картинки.</b> Блок «Картинка» → «Заменить картинку»: загрузить с устройства или взять из уже '
      + 'загруженных. Картинка шапки меняется там же, в «Шапке страницы»; в списке виден размер кадра.</p>'
        + '<p><b>Размер картинки.</b> Ширина блока: во всю, поуже, половина. Кадр никогда не растягивается '
        + 'шире своих пикселей, а на телефоне блок сам становится во всю ширину.</p>'
      + '<p><b>История.</b> Каждая публикация сохраняет предыдущую версию. «Вернуть» откатывает страницу, '
      + '«В редактор» открывает снимок, чтобы поправить и опубликовать заново.</p>'
      + '<p><b>Блоки.</b> «⋯» на блоке: дублировать, превратить в другой тип, перенести в раздел, удалить. '
      + 'Содержимое в шапке — надзаголовок, название, лид, сезон, формат, косты, арт, подвал.</p>'
      + '</div>'
      + '<div class="sheet__actions"><button class="btn btn--primary" type="button" data-cmd="close">Понятно</button></div>',
      function (cmd) { if (cmd === 'close') closeSheet(); });
  }

  function moveMenu(si, bi) {
    var html = '<p class="sheet__title">Куда перенести блок?</p>'
      + S.doc.sections.map(function (s, i) {
        return opt('to:' + i, R.pad2(i + 1) + ' · ' + (s.title || 'Раздел'),
          i === si ? 'это текущий раздел' : ((s.blocks || []).length + ' блоков'));
      }).join('');
    openSheet(html, function (cmd) {
      if (cmd.indexOf('to:') !== 0) return;
      var to = +cmd.slice(3);
      if (to === si) { closeSheet(); return; }
      snap();
      var blk = S.doc.sections[si].blocks.splice(bi, 1)[0];
      S.doc.sections[to].blocks = S.doc.sections[to].blocks || [];
      S.doc.sections[to].blocks.push(blk);
      closeSheet();
      touch();
      renderAll();
      toast('Блок перенесён в раздел ' + R.pad2(to + 1));
    });
  }

  /* ── меню «ещё» ──────────────────────────────────────────────────────── */
  function moreMenu() {
    openSheet('<p class="sheet__title">Ещё</p>'
      + opt('jump', 'Перейти к разделу', 'оглавление: сразу к нужному месту')
        + opt('meta', 'Шапка страницы', 'название, лид, косты, арт')
      + opt('images', 'Картинки', 'что загружено и удалить лишнее')
      + opt('history', 'История версий', 'посмотреть и откатить')
      + opt('pdf', 'Скачать PDF', 'печать браузера → «Сохранить как PDF»')
      + opt('help', 'Подсказки', 'как править и публиковать')
      + opt('logout', 'Выйти', 'закрыть редактор на этом устройстве')
      + '<p class="field__hint" style="margin-top:14px">Сборка ' + R.esc(BUILD) + ' — '
      + 'если она не совпадает с той, что вам назвали, обновите страницу (Ctrl+F5).</p>',
      function (cmd) {
        if (cmd === 'jump') { closeSheet(); openJump(); }
          else if (cmd === 'meta') { closeSheet(); openMeta(); }
        else if (cmd === 'images') { closeSheet(); manageImages(); }
        else if (cmd === 'history') { closeSheet(); openHistory(); }
        else if (cmd === 'pdf') {
          closeSheet();
          flushFocused();
          window.open('index.html?preview=1&print=1', '_blank', 'noopener');
          toast('Открыл печать черновика — выберите «Сохранить как PDF»');
        }
        else if (cmd === 'help') { closeSheet(); openHelp(); }
        else if (cmd === 'logout') { closeSheet(); logout(); }
      });
  }

  function openJump() {
      var items = S.doc.sections.map(function (sec, i) {
        var name = (sec.title || '').trim() || 'Раздел без названия';
        var blocks = (sec.blocks || []).length;
        return opt('goto:' + i, R.pad2(i + 1) + ' · ' + name, blocks + ' блок(ов)');
      }).join('');
      openSheet('<p class="sheet__title">Куда перейти</p>' + items
        + '<div class="sheet__actions"><button class="btn btn--ghost" type="button" data-cmd="close">Отмена</button></div>',
        function (cmd) {
          if (cmd.indexOf('goto:') !== 0) return;
          var i = +cmd.slice(5);
          var target = adoc.querySelector('.asec[data-si="' + i + '"]');
          closeSheet();
          if (!target) return;
          target.scrollIntoView({ block: 'start', behavior: 'smooth' });
          target.classList.add('is-flash');
          setTimeout(function () { target.classList.remove('is-flash'); }, 1400);
        });
    }

    function manageImages() {
    pickImage(function () {
      toast('Путь скопирован — вставьте его в блок «Картинка»');
    });
  }

  function logout() {
    sessionStorage.removeItem(PASS_KEY);
    stopPresence();
    S.authed = false;
    app.hidden = true;
    closeSheet();
    showGate('');
  }

  /* ── шапка страницы ──────────────────────────────────────────────────── */
  /* ── кто ещё в редакторе ─────────────────────────────────────────────────
     Локальный сервер знает это точно (api/presence). На статическом хостинге
     узнать, кто держит вкладку открытой, неоткуда — там следим за опубликованным
     документом и честно говорим, если его поменяли после нашего входа. */
  var PRES = {
    id: 'e' + Math.random().toString(36).slice(2) + Date.now().toString(36),
    timer: null,
    stamp: null,
    busy: false
  };

  function paintPresence(text, tone) {
    var el = $('presence');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = text;
    el.setAttribute('data-tone', tone || '');
  }

  function stampOf(doc) {
    try { return (doc.meta && doc.meta.updated || '') + '|' + JSON.stringify(doc).length; }
    catch (e) { return ''; }
  }

  function presenceBeat() {
    if (!S.store || PRES.busy) return;
    PRES.busy = true;
    if (S.store.mode === 'local') {
      fetch('api/presence', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: PRES.id })
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        PRES.busy = false;
        if (!d) return;
        if (d.others > 0) {
          paintPresence('● ещё ' + d.others + ' — сейчас правят', 'warn');
        } else {
          paintPresence('● вы один в редакторе', 'ok');
        }
      }).catch(function () { PRES.busy = false; paintPresence('', ''); });
      return;
    }
    /* статический хостинг */
    fetch('content.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (doc) {
        PRES.busy = false;
        if (!doc) return;
        var now = stampOf(doc);
        if (PRES.stamp === null) {
          PRES.stamp = now;
          paintPresence('● вы один в редакторе', 'ok');
          return;
        }
        if (now !== PRES.stamp && now !== stampOf(S.doc)) {
          PRES.stamp = now;
          paintPresence('● опубликованное изменили (' + clock(new Date()) + ') — кто-то ещё работает', 'warn');
        }
      }).catch(function () { PRES.busy = false; });
  }

  function startPresence() {
    stopPresence();
    presenceBeat();
    PRES.timer = setInterval(presenceBeat, 20000);
  }

  function stopPresence() {
    if (PRES.timer) clearInterval(PRES.timer);
    PRES.timer = null;
    paintPresence('', '');
  }

  /* версия сборки: видно сразу, старая страница в браузере или новая */
  var BUILD = (function () {
    try {
      var m = /[?&]v=([0-9a-f]+)/.exec(document.currentScript && document.currentScript.src);
      return (m && m[1]) || 'dev';
    } catch (e) { return 'dev'; }
  })();
  try { document.documentElement.setAttribute('data-build', BUILD); } catch (e) {}

  /* сезон, формат, косты и редакция живут только в строках под названием —
     иначе одни и те же значения дублируются в двух местах */
  var META_FIELDS = [
    ['brand', 'Название сайта (шапка)', 0],
    ['brandSub', 'Подпись рядом с названием', 0],
    ['kicker', 'Надзаголовок', 0],
    ['title', 'Название турнира', 0],
    ['lead', 'Лид под названием', 1],
    ['footnote', 'Примечание в подвале', 1]
  ];

  function artBlock(m) {
    var src = m.art || '';
    return '<div class="field"><span class="field__label">Картинка шапки</span>'
      + '<div class="artpick">'
      + (src
        ? '<img class="artpick__img" id="artPrev" src="' + R.esc(src) + '" alt="">'
        : '<span class="artpick__none" id="artPrev">не выбрана</span>')
      + '<div class="artpick__acts">'
      + '<button class="btn btn--sm" type="button" data-cmd="art-pick">Выбрать</button>'
      + (src ? '<button class="btn btn--sm btn--ghost" type="button" data-cmd="art-clear">Убрать</button>' : '')
      + '</div></div></div>';
  }

  /* строки шапки: если своих нет — показываем стандартные как обычные, чтобы их
     можно было переименовать, убрать и переставить */
  function heroRows(m) {
    if (Array.isArray(m.hero)) {
      return m.hero.map(function (r) { return { k: (r && r.k) || '', v: (r && r.v) || '' }; });
    }
    return defaultHero(m);
  }

  function setHero(m, rows) {
    /* всегда массив: пустой массив = «под названием ничего не выводим» */
    m.hero = rows.map(function (r) { return { k: r.k || '', v: r.v || '' }; });
  }

  function heroBlock(m) {
    var rows = heroRows(m);
    var own = Array.isArray(m.hero);
    var html = '<p class="micro" style="margin:20px 0 8px">Строки под названием</p>'
      + '<p class="field__hint" style="margin:0 0 10px">'
      + (own ? '' : 'Пока стандартные — правьте их прямо здесь: переименовать, убрать, переставить. ')
      + 'На странице видно до шести строк, пустое значение строку скрывает. '
      + 'Вместо даты можно вписать <code>{updated}</code> — подставится дата обновления.</p>';
    rows.forEach(function (r, i) {
      html += '<div class="pair">'
        + '<input class="field__input pair__k" data-hero="' + i + '.k" value="' + R.esc(r.k || '') + '" placeholder="Подпись">'
        + '<input class="field__input pair__v" data-hero="' + i + '.v" value="' + R.esc(r.v || '') + '" placeholder="Значение">'
        + '<div class="pair__acts">'
        + '<button class="btn btn--sm btn--ghost pair__x" type="button" data-cmd="hero-up" data-i="' + i
        + '" aria-label="Выше"' + (i === 0 ? ' disabled' : '') + '>↑</button>'
        + '<button class="btn btn--sm btn--ghost pair__x" type="button" data-cmd="hero-down" data-i="' + i
        + '" aria-label="Ниже"' + (i === rows.length - 1 ? ' disabled' : '') + '>↓</button>'
        + '<button class="btn btn--sm btn--ghost pair__x" type="button" data-cmd="hero-del" data-i="' + i
        + '" aria-label="Убрать строку">✕</button>'
        + '</div></div>';
    });
    if (!rows.length) {
      html += '<p class="field__hint">Строк нет — под названием ничего не выводится.</p>';
    }
    html += '<div class="sheet__actions" style="margin:10px 0 0">'
      + '<button class="btn btn--sm" type="button" data-cmd="hero-add">＋ Строка</button>'
      + (own ? '<button class="btn btn--sm btn--ghost" type="button" data-cmd="hero-reset">Сбросить к стандартным</button>' : '')
      + '</div>';
    return html;
  }

  function defaultHero(m) {
    var date = m.updated ? '{updated}' : '';   /* {updated} подставится датой при показе */
    var ed = m.edition ? (date ? m.edition + ' · ' + date : m.edition) : date;
    return [
      { k: 'Сезон', v: m.season || '' },
      { k: 'Формат', v: m.format || '' },
      { k: 'Косты', v: m.costs || '' },
      { k: 'Редакция', v: ed }
    ].filter(function (p) { return p.v; });
  }

  /* оформление: шрифт и цвет текста документа */
  var DOC_FONTS = [['antiqua', 'Антиква'], ['grotesk', 'Гротеск'], ['mono', 'Моно']];
  var DOC_COLORS = ['#F3F1ED', '#E6D9C0', '#D9B26A', '#C8D2DC', '#E9A6A6'];

  function styleBlock(m) {
    var st = m.style || {};
    var font = st.font || 'antiqua';
    var color = (st.color || '#F3F1ED').toLowerCase();
    return '<p class="micro" style="margin:20px 0 8px">Оформление документа</p>'
      + '<div class="chips">' + DOC_FONTS.map(function (f) {
        return '<button class="chip' + (f[0] === font ? ' is-on' : '') + '" type="button"'
          + ' data-cmd="font:' + f[0] + '">' + f[1] + '</button>';
      }).join('') + '</div>'
      + '<div class="swatches">' + DOC_COLORS.map(function (c) {
        return '<button class="sw' + (c.toLowerCase() === color ? ' is-on' : '') + '" type="button"'
          + ' style="background:' + c + '" data-cmd="color:' + c + '"'
          + ' aria-label="цвет ' + c + '"></button>';
      }).join('')
      + '<input class="sw sw--pick" type="color" id="docColor" value="' + R.esc(color) + '"'
      + ' aria-label="свой цвет текста"></div>'
      + '<p class="field__hint">К тексту регламента. Служебная графика (линии, плашки) не меняется.</p>';
  }

  function paintDocStyle() {
    var st = (S.doc.meta && S.doc.meta.style) || {};
    if (!adoc) return;
    adoc.setAttribute('data-font', st.font || 'antiqua');
    if (st.color) adoc.style.setProperty('--doc-color', st.color);
    else adoc.style.removeProperty('--doc-color');
  }

  function openMeta() {
    var m = S.doc.meta || (S.doc.meta = {});
    var html = '<p class="sheet__title">Шапка страницы</p>'
      + META_FIELDS.map(function (f) {
        var v = R.esc(m[f[0]] == null ? '' : m[f[0]]);
        return '<label class="field"><span class="field__label">' + f[1] + '</span>'
          + (f[2]
            ? '<textarea class="field__area" data-meta="' + f[0] + '">' + v + '</textarea>'
            : '<input class="field__input" data-meta="' + f[0] + '" value="' + v + '">')
          + '</label>';
      }).join('')
      + artBlock(m)
      + styleBlock(m)
      + heroBlock(m)
      + '<p class="field__hint">В текстах работает <b>**жирный**</b>, <i>*курсив*</i> и <b>[текст](ссылка)</b>. '
      + 'Обновление даты ставится автоматически при публикации.</p>'
      + '<div class="sheet__actions">'
      + '<button class="btn" type="button" data-cmd="export">Скачать JSON</button>'
      + '<button class="btn" type="button" data-cmd="import">Загрузить JSON</button>'
      + '<button class="btn btn--ghost" type="button" data-cmd="restart">Начать текст заново</button>'
      + '<button class="btn btn--ghost" type="button" data-cmd="revert">Вернуть опубликованное</button>'
      + '<button class="btn btn--primary" type="button" data-cmd="close">Готово</button>'
      + '</div>';

    metaSnapped = false;
    openSheet(html, function (cmd, btn) {
      if (cmd === 'close') { closeSheet(); return; }
      if (cmd === 'export') return exportJson();
      if (cmd === 'import') return importJson();
      if (cmd && cmd.indexOf('font:') === 0) {
        snap();
        S.doc.meta = S.doc.meta || {};
        S.doc.meta.style = S.doc.meta.style || {};
        S.doc.meta.style.font = cmd.slice(5);
        touch(); renderAll(); openMeta();
        return;
      }
      if (cmd && cmd.indexOf('color:') === 0) {
        snap();
        S.doc.meta = S.doc.meta || {};
        S.doc.meta.style = S.doc.meta.style || {};
        S.doc.meta.style.color = cmd.slice(6);
        touch(); renderAll(); openMeta();
        return;
      }
      if (cmd === 'art-pick') {
        pickImage(function (url, w, h) {
          if (w && w < SMALL_ART_W) {
            toast('Кадр ' + w + '×' + (h || 0) + ' — для шапки мелковат: на экранах с ретиной нужно от ' + SMALL_ART_W + ' px по ширине', true);
          }
          snap();
          S.doc.meta = S.doc.meta || {};
          S.doc.meta.art = url;
          touch();
          renderAll();
          openMeta();
          toast('Картинка шапки заменена');
        });
        return;
      }
      if (cmd === 'art-clear') {
        snap();
        delete S.doc.meta.art;
        touch();
        renderAll();
        openMeta();
        return;
      }
      if (cmd === 'hero-add') {
        snap();
        S.doc.meta = S.doc.meta || {};
        setHero(S.doc.meta, heroRows(S.doc.meta).concat([{ k: '', v: '' }]));
        touch();
        renderAll();
        openMeta();
        return;
      }
      if (cmd === 'hero-up' || cmd === 'hero-down') {
        var ri = +(btn && btn.getAttribute('data-i'));
        var rowsNow = heroRows(S.doc.meta || {});
        var j = cmd === 'hero-up' ? ri - 1 : ri + 1;
        if (j >= 0 && j < rowsNow.length) {
          snap();
          var tmp = rowsNow[ri];
          rowsNow[ri] = rowsNow[j];
          rowsNow[j] = tmp;
          setHero(S.doc.meta, rowsNow);
          touch();
          renderAll();
          openMeta();
        }
        return;
      }
      if (cmd === 'hero-reset') {
        snap();
        delete S.doc.meta.hero;
        touch();
        renderAll();
        openMeta();
        return;
      }
      if (cmd === 'hero-del') {
        var di = +(btn && btn.getAttribute('data-i'));
        snap();
        var left = heroRows(S.doc.meta || {});
        left.splice(di, 1);
        setHero(S.doc.meta, left);
        touch();
        renderAll();
        openMeta();
        return;
      }
      if (cmd === 'restart') {
        confirmSheet('Очистить весь текст?',
          'Все разделы и блоки исчезнут, шапка останется. Вернуть можно кнопкой ↶ — или «Вернуть опубликованное».',
          'Очистить', function () {
            snap();
            S.doc.sections = [{ id: '', title: 'Раздел 1', blocks: [R.blankBlock('p')] }];
            R.normalize(S.doc);
            touch(); renderAll(); closeSheet();
            toast('Текст очищен — можно писать заново');
          });
        return;
      }
      if (cmd === 'revert') {
        confirmSheet('Вернуть опубликованное?', 'Все неопубликованные правки пропадут.', 'Вернуть', function () {
          snap();
          S.doc = R.normalize(clone(S.published));
          saveDraft(); S.dirty = false; renderAll(); closeSheet(); toast('Вернули опубликованную версию');
        });
        return;
      }
      if (cmd === 'logout') { closeSheet(); logout(); }
    });

    var picker = sheetCard.querySelector('#docColor');
    if (picker) {
      picker.addEventListener('input', function () {
        S.doc.meta = S.doc.meta || {};
        S.doc.meta.style = S.doc.meta.style || {};
        S.doc.meta.style.color = picker.value;
        touch();
        paintDocStyle();
      });
    }
    sheetCard.querySelectorAll('[data-meta]').forEach(function (input) {
      input.addEventListener('input', function () {
        if (!metaSnapped) { snap(); metaSnapped = true; }
        if (!S.doc.meta) S.doc.meta = {};
        S.doc.meta[input.getAttribute('data-meta')] = input.value;
        touch();
      });
    });

    sheetCard.querySelectorAll('[data-hero]').forEach(function (input) {
      input.addEventListener('input', function () {
        if (!metaSnapped) { snap(); metaSnapped = true; }
        var parts = input.getAttribute('data-hero').split('.');
        S.doc.meta = S.doc.meta || {};
        var rows = heroRows(S.doc.meta);
        var idx = +parts[0];
        rows[idx] = rows[idx] || { k: '', v: '' };
        rows[idx][parts[1]] = input.value;
        setHero(S.doc.meta, rows);
        touch();
      });
    });
  }

  function exportJson() {
    var blob = new Blob([JSON.stringify(S.doc, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'reglament-' + today() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function importJson() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var doc = JSON.parse(fr.result);
          snap();
          S.doc = R.normalize(doc);
          touch(); renderAll(); closeSheet(); toast('JSON загружен — не забудьте опубликовать');
        } catch (e) { toast('Не похоже на JSON регламента: ' + e.message, true); }
      };
      fr.readAsText(file);
    });
    input.click();
  }

  /* ── публикация ──────────────────────────────────────────────────────── */
  /* что именно расходится с чужой версией — коротким списком */
  function diffSummary(mine, theirs) {
    var out = [];
    function metaKey(m) {
      var c = clone(m || {});
      delete c.updated;   /* дата обновления меняется при каждой публикации */
      return JSON.stringify(c);
    }
    if (metaKey(mine.meta) !== metaKey(theirs.meta)) out.push('шапка страницы');
    var max = Math.max(mine.sections.length, theirs.sections.length);
    for (var i = 0; i < max; i++) {
      var a = mine.sections[i], b = theirs.sections[i];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        var name = (b && b.title) || (a && a.title) || ('раздел ' + (i + 1));
        out.push('«' + name + '»');
      }
    }
    return out;
  }

  function doPublish(doc) {
    updateStatus('Публикую…');
    S.store.publish(doc).then(function () {
      S.doc = clone(doc);
      S.published = clone(doc);
      S.dirty = false;
      S.stale = false;
      saveDraft();
      renderAll();
      toast('Опубликовано · ' + clock());
    }, function (e) {
      updateStatus();
      if (e.status === 401) {
        S.authed = false;
        showGate('Сессия истекла — войдите заново');
        return;
      }
      toast('Не сохранилось: ' + e.message, true);
    });
  }

  function conflictSheet(fresh) {
    var mine = clone(S.doc);
    mine.meta = mine.meta || {};
    mine.meta.updated = today();
    var changed = diffSummary(mine, fresh);
    var list = changed.length
      ? '<p class="field__hint" style="margin:0 0 12px">Расходится: ' + R.esc(changed.slice(0, 6).join(', '))
        + (changed.length > 6 ? ' и ещё ' + (changed.length - 6) : '') + '.</p>'
      : '';
    openSheet('<p class="sheet__title">Регламент успели изменить</p>'
      + '<p style="font-size:.92rem;line-height:1.55;margin:0 0 10px">Пока вы правили, кто-то опубликовал свою '
      + 'версию. Если опубликовать сейчас, его правки заменит ваша — они останутся в истории версий, '
      + 'но на странице их не будет.</p>' + list
      + '<div class="sheet__list">'
      + opt('force', 'Опубликовать мою версию', 'ваша заменит чужую')
      + opt('theirs', 'Взять их версию', 'мои неопубликованные правки пропадут')
      + '</div>'
      + '<div class="sheet__actions"><button class="btn btn--ghost" type="button" data-cmd="close">Отмена</button></div>',
      function (cmd) {
        if (cmd === 'close') { closeSheet(); updateStatus(); return; }
        if (cmd === 'force') {
          closeSheet();
          doPublish(mine);
          return;
        }
        if (cmd === 'theirs') {
          closeSheet();
          snap();
          S.published = R.normalize(clone(fresh));
          S.doc = R.normalize(clone(fresh));
          S.dirty = false;
          S.stale = false;
          saveDraft();
          renderAll();
          toast('Взял свежую версию — ваши несохранённые правки отменены');
        }
      });
  }

  function publish(force) {
    if (!S.authed) { showGate(); return; }
    if (S.store.mode === 'readonly') {
      toast('Публикация не настроена — см. setup.html', true);
      return;
    }
    flushFocused();
    snapshotDraft(true);          /* перед публикацией — снимок того, что было */
    var doc = clone(S.doc);
    doc.meta = doc.meta || {};
    doc.meta.updated = today();

    if (force) { doPublish(doc); return; }

    updateStatus('Проверяю, не правил ли кто-то ещё…');
    /* перед записью смотрим, что лежит на сервере: чужую публикацию не затираем молча */
    S.store.load().then(function (fresh) {
      var theirs = R.normalize(clone(fresh));
      if (!sameDoc(theirs, S.published)) { conflictSheet(theirs); return; }
      doPublish(doc);
    }, function () {
      doPublish(doc);   /* не смогли проверить — публикуем как раньше */
    });
  }

  /* ── вход ────────────────────────────────────────────────────────────── */
  function showGate(message) {
    gate.hidden = false;
    var hint = $('gateHint');
    var readonly = S.store && S.store.mode === 'readonly';
    if (readonly) {
      hint.innerHTML = R.esc(message || '') +
        (message ? '<br>' : '') +
        'Сохранение здесь не настроено: соберите <code>site-config.json</code> и ' +
        '<code>admin.lock.json</code> в <a href="setup.html">мастере настройки</a>.';
    } else {
      hint.textContent = message || '';
    }
    setTimeout(function () { try { $('gatePass').focus(); } catch (e) { } }, 80);
  }

  $('gateForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var pass = $('gatePass').value;
    if (!pass) return;
    $('gateBtn').disabled = true;
    $('gateHint').textContent = '';
    S.store.auth(pass).then(function () {
      S.authed = true;
      sessionStorage.setItem(PASS_KEY, pass);
      $('gatePass').value = '';
      gate.hidden = true;
      startEditing();
    }, function (err) {
      if (S.store.mode === 'readonly') showGate(err.message || 'Публикация не настроена');
      else $('gateHint').textContent = err.message || 'Не вошло';
    }).then(function () { $('gateBtn').disabled = false; });
  });

  /* ── запуск ──────────────────────────────────────────────────────────── */
  var bound = false;
  function startEditing() {
    paintDraftBadge();
    app.hidden = false;
    paintDocStyle();
    startPresence();
    if (!bound) {
      bound = true;
      $('btnPublish').addEventListener('click', function () { publish(false); });
      $('btnUndo').addEventListener('click', function () { flushFocused(); undoStep(); });
      $('btnRedo').addEventListener('click', function () { flushFocused(); redoStep(); });
      document.addEventListener('keydown', function (e) {
        if (!(e.ctrlKey || e.metaKey)) return;
        var k = (e.key || '').toLowerCase();
        var isUndo = k === 'z' || k === 'я';
        var isRedo = k === 'y' || k === 'н' || (isUndo && e.shiftKey);
        if (!isUndo && !isRedo) return;
        var el = document.activeElement;
        /* внутри поля пусть отменяет сам браузер — это точнее посимвольно */
        if (isUndo && !e.shiftKey && el && el.getAttribute && el.getAttribute('data-p')) return;
        e.preventDefault();
        if (isRedo) redoStep(); else undoStep();
      });
      $('btnMore').addEventListener('click', moreMenu);
      $('btnAddSection').addEventListener('click', function () {
        flushFocused();
        snap();
        S.doc.sections.push({ id: '', title: 'Новый раздел', blocks: [R.blankBlock('p')] });
        R.normalize(S.doc);
        touch();
        renderAll();
        focusPath('sections.' + (S.doc.sections.length - 1) + '.title');
      });
      $('btnRecovery').addEventListener('click', openRecovery);
      $('btnDrafts').addEventListener('click', openRecovery);
      $('btnRestore').addEventListener('click', function () {
        if (readDrafts().length > 1) { openRecovery(); return; }
        var d = readDraft();
        if (!d) return;
        S.doc = R.normalize(clone(d.doc));
        S.dirty = true;
        $('draftbar').hidden = true;
        renderAll();
        toast('Черновик восстановлен');
      });
      $('btnDiscard').addEventListener('click', function () {
        try { localStorage.removeItem(DRAFT_KEY); } catch (e) { }
        $('draftbar').hidden = true;
        toast('Черновик отброшен');
      });
      window.addEventListener('beforeunload', function (e) {
        if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
      });
    }
    renderAll();
    paintUndo();
  }

  function showFatal(msg) {
    document.body.insertAdjacentHTML('beforeend',
      '<div class="gate"><div class="gate__card"><h1 class="gate__title">Не открылось</h1>'
      + '<p style="font-size:.9rem">' + R.esc(msg) + '</p>'
      + '<p class="field__hint">' + (S.store && S.store.mode === 'github'
        ? 'Откройте адрес сайта в браузере и обновите страницу.'
        : 'Запустите сервер: <code>python server.py</code> — и откройте страницу с его адреса.')
      + '</p>'
      + '</div></div>');
  }

  /* подсказка под паролем: на сайте нет никакого server.py — не пугаем посетителей */
  function paintGateNote() {
    var el = $('gateNote');
    if (!el || !S.store) return;
    if (S.store.mode === 'local') {
      el.hidden = false;
      el.innerHTML = 'Пароль администратора задаётся на сервере: '
        + '<code>python server.py --set-password</code>.';
    } else if (S.store.mode === 'github') {
      el.hidden = false;
      el.textContent = 'Пароль выдаёт организатор турнира. Если вы его не получали — эта страница не для вас.';
    } else {
      el.hidden = true;
    }
  }

  /* честно показываем, куда уйдёт публикация: в этот файл или в репозиторий */
  function paintPlace() {
    var el = $('place');
    if (!el || !S.store) return;
    var mode = S.store.mode;
    if (mode === 'github') {
      el.className = 'aplace aplace--github';
      el.textContent = 'GitHub';
      el.title = 'Публикация уходит коммитом в репозиторий GitHub Pages';
    } else if (mode === 'local') {
      el.className = 'aplace';
      el.textContent = 'Этот файл';
      el.title = 'Публикация пишет content.json рядом с сайтом';
    } else {
      el.className = 'aplace';
      el.textContent = 'Только чтение';
      el.title = 'Публикация не настроена';
    }
  }

  var store = window.AMStore.init();
  store.then(function (s) {
    S.store = s;
    paintPlace();
    paintGateNote();
    return s.load();
  }).then(function (doc) {
    S.published = R.normalize(clone(doc));
    S.doc = R.normalize(clone(doc));

    var draft = readDraft();
    if (draft && !sameDoc(draft.doc, S.published)) {
      $('draftbar').hidden = false;
      $('draftText').textContent = 'Есть черновик от ' + stamp(draft.at).trim() + ' — он расходится с опубликованной версией.';
    }

    var pass = sessionStorage.getItem(PASS_KEY);
    if (!pass) { showGate(); return; }
    return S.store.auth(pass).then(function () {
      S.authed = true;
      gate.hidden = true;
      startEditing();
    }, function () {
      sessionStorage.removeItem(PASS_KEY);
      showGate();
    });
  }).catch(function (e) {
    if (e && e.status === 404) showFatal('content.json не найден рядом со страницей.');
    else showFatal('Не удалось загрузить документ: ' + (e && e.message ? e.message : e));
  });
})();