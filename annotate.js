// annotate.js — reader annotations for AIReports report pages (local-only).
// No network, no login, nothing leaves the device. Highlights + notes live in
// localStorage, keyed by page path. Reports are immutable after publish, so a
// quote + surrounding context is a stable anchor for restoring highlights.
//
// Exposes window.AIReportsAnno for power users / tests:
//   list() -> annotations, applyHighlight(color, note) from current selection,
//   updateNote(id, note), setColor(id, color), remove(id), clear(),
//   exportJSON() -> string, importJSON(string) -> number of new items.
(function () {
  'use strict';

  var COLORS = ['yellow', 'green', 'blue', 'pink'];
  var COLOR_HEX = { yellow: '#ffe58f', green: '#b7eb8f', blue: '#91d5ff', pink: '#ffadd2' };
  var KEY = 'aireports-anno:v1:' + location.pathname;
  var CONTEXT = 40;
  var resolved = {}; // id -> true if re-anchored on this load

  // ---------------- storage ----------------
  function load() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
  }
  function uid() {
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------------- DOM helpers ----------------
  function insideUI(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    return !!(el && el.closest && el.closest('.anno-ui'));
  }
  function textNodes() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        var tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('.anno-ui')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var out = [], n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }
  function snapshot() {
    var nodes = textNodes(), full = '', offsets = [];
    nodes.forEach(function (n) { offsets.push(full.length); full += n.nodeValue; });
    return { nodes: nodes, offsets: offsets, full: full };
  }
  function nodeAt(snap, pos) {
    for (var i = 0; i < snap.nodes.length; i++) {
      var s = snap.offsets[i], e = s + snap.nodes[i].nodeValue.length;
      if (pos >= s && pos <= e) return { node: snap.nodes[i], offset: pos - s };
    }
    return null;
  }
  function findQuote(full, anno) {
    var q = anno.quote, idx = -1, best = null;
    while ((idx = full.indexOf(q, idx + 1)) !== -1) {
      var pre = full.slice(Math.max(0, idx - CONTEXT), idx);
      var suf = full.slice(idx + q.length, idx + q.length + CONTEXT);
      if (pre === anno.prefix && suf === anno.suffix) return { start: idx, end: idx + q.length };
      if (!best) best = { start: idx, end: idx + q.length };
    }
    return best;
  }
  function wrapRange(range, anno) {
    var nodes = textNodes().filter(function (n) { return range.intersectsNode(n); });
    nodes.forEach(function (n) {
      var s = 0, e = n.nodeValue.length;
      if (n === range.startContainer) s = range.startOffset;
      if (n === range.endContainer) e = range.endOffset;
      if (s >= e) return;
      var r = document.createRange();
      r.setStart(n, s);
      r.setEnd(n, e);
      var mark = document.createElement('mark');
      mark.setAttribute('data-anno', anno.id);
      mark.setAttribute('data-color', anno.color);
      mark.className = 'anno-mark';
      try { r.surroundContents(mark); } catch (err) { /* partial element overlap: skip */ }
    });
  }
  function unwrapAll() {
    document.querySelectorAll('mark[data-anno]').forEach(function (m) {
      var p = m.parentNode;
      if (!p) return;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
    });
    if (document.body.normalize) document.body.normalize();
  }
  function restoreAll() {
    var list = load();
    unwrapAll();
    var snap = snapshot();
    resolved = {};
    var jobs = [];
    list.forEach(function (anno) {
      var hit = findQuote(snap.full, anno);
      if (!hit) { resolved[anno.id] = false; return; }
      resolved[anno.id] = true;
      jobs.push({ anno: anno, start: hit.start, end: hit.end });
    });
    // Wrap latest-first so earlier offsets stay valid while nodes split.
    jobs.sort(function (a, b) { return b.start - a.start; });
    jobs.forEach(function (j) {
      var a = nodeAt(snap, j.start), b = nodeAt(snap, j.end);
      if (!a || !b) { resolved[j.anno.id] = false; return; }
      var range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      wrapRange(range, j.anno);
    });
  }
  function offsetOfPoint(container, offset) {
    var r = document.createRange();
    r.setStart(document.body, 0);
    r.setEnd(container, offset);
    return r.toString().length;
  }

  // ---------------- actions ----------------
  function applyHighlight(color, note) {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var range = sel.getRangeAt(0).cloneRange();
    if (insideUI(range.startContainer) || insideUI(range.endContainer)) return null;
    var marks = document.querySelectorAll('mark[data-anno]');
    for (var i = 0; i < marks.length; i++) {
      if (range.intersectsNode(marks[i])) return { error: 'overlap' };
    }
    var quote = range.toString();
    if (!quote.trim()) return null;
    var snap = snapshot();
    var start = offsetOfPoint(range.startContainer, range.startOffset);
    var anno = {
      id: uid(),
      color: COLORS.indexOf(color) !== -1 ? color : 'yellow',
      quote: quote,
      prefix: snap.full.slice(Math.max(0, start - CONTEXT), start),
      suffix: snap.full.slice(start + quote.length, start + quote.length + CONTEXT),
      note: note || '',
      created: Date.now()
    };
    wrapRange(range, anno);
    var list = load();
    list.push(anno);
    save(list);
    resolved[anno.id] = true;
    try { sel.removeAllRanges(); } catch (e) {}
    return anno;
  }
  function removeAnno(id) {
    document.querySelectorAll('mark[data-anno="' + id + '"]').forEach(function (m) {
      var p = m.parentNode;
      if (!p) return;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
    });
    if (document.body.normalize) document.body.normalize();
    save(load().filter(function (a) { return a.id !== id; }));
    delete resolved[id];
  }
  function updateAnno(id, fields) {
    var list = load();
    list.forEach(function (a) {
      if (a.id === id) {
        if ('note' in fields) a.note = fields.note;
        if ('color' in fields && COLORS.indexOf(fields.color) !== -1) a.color = fields.color;
      }
    });
    save(list);
    if ('color' in fields) {
      document.querySelectorAll('mark[data-anno="' + id + '"]').forEach(function (m) {
        m.setAttribute('data-color', fields.color);
      });
    }
  }

  // ---------------- UI ----------------
  function el(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    return d.firstChild;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }
  var toolbar = null, popover = null, panel = null, fab = null, currentAnnoId = null;

  function hideToolbar() { if (toolbar) toolbar.style.display = 'none'; }
  function showToolbar() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideToolbar(); return; }
    var range = sel.getRangeAt(0);
    if (insideUI(range.startContainer) || insideUI(range.endContainer)) { hideToolbar(); return; }
    var rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) { hideToolbar(); return; }
    toolbar.style.display = 'flex';
    var w = toolbar.offsetWidth || 300, h = toolbar.offsetHeight || 48;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
    var top = rect.top - h - 8;
    if (top < 8) top = rect.bottom + 8;
    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';
  }
  var toolbarTimer = null;
  function scheduleToolbar() {
    if (toolbarTimer) clearTimeout(toolbarTimer);
    toolbarTimer = setTimeout(showToolbar, 250);
  }

  function openPopover(annoId) {
    currentAnnoId = annoId;
    var list = load();
    var anno = null;
    list.forEach(function (a) { if (a.id === annoId) anno = a; });
    if (!anno) return;
    popover.querySelector('textarea').value = anno.note || '';
    popover.querySelectorAll('.anno-dot').forEach(function (d) {
      d.classList.toggle('sel', d.getAttribute('data-color') === anno.color);
    });
    popover.style.display = 'block';
    var mark = document.querySelector('mark[data-anno="' + annoId + '"]');
    if (mark) {
      var rect = mark.getBoundingClientRect();
      if (window.innerWidth > 640 && rect && rect.width > 0) {
        var w = 360;
        popover.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left)) + 'px';
        popover.style.top = (rect.bottom + 8) + 'px';
        popover.style.bottom = 'auto';
      }
    }
    popover.querySelector('textarea').focus();
  }
  function closePopover() { if (popover) popover.style.display = 'none'; currentAnnoId = null; }

  function flash(id) {
    var mark = document.querySelector('mark[data-anno="' + id + '"]');
    if (!mark) return;
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    mark.classList.add('flash');
    setTimeout(function () { mark.classList.remove('flash'); }, 1600);
  }

  function renderPanel() {
    if (!panel) return;
    var list = load();
    var body = panel.querySelector('.anno-list');
    var count = panel.querySelector('.anno-count');
    if (count) count.textContent = list.length + ' 条';
    if (fab) {
      var badge = fab.querySelector('.anno-badge');
      if (badge) badge.textContent = list.length > 0 ? list.length : '';
    }
    if (list.length === 0) {
      body.innerHTML = '<p class="anno-empty">还没有标注。选中一段文字就能高亮或写备注。</p>';
      return;
    }
    body.innerHTML = list.map(function (a) {
      var found = resolved[a.id] !== false;
      var snippet = esc(a.quote.length > 80 ? a.quote.slice(0, 80) + '…' : a.quote);
      var note = a.note ? '<div class="anno-note">' + esc(a.note) + '</div>' : '';
      return '<div class="anno-item" data-id="' + esc(a.id) + '">'
        + '<span class="anno-dot mini" style="background:' + COLOR_HEX[a.color] + '"></span>'
        + '<div class="anno-item-text"><div class="anno-quote">' + snippet + '</div>' + note
        + (found ? '' : '<div class="anno-lost">（原文未找到，备注仍保留）</div>')
        + '</div>'
        + '<div class="anno-item-btns">'
        + (found ? '<button data-act="goto">定位</button>' : '')
        + '<button data-act="edit">备注</button>'
        + '<button data-act="del">删除</button>'
        + '</div></div>';
    }).join('');
  }

  function buildUI() {
    toolbar = el('<div class="anno-ui anno-toolbar" style="display:none">'
      + COLORS.map(function (c) {
        return '<button class="anno-dot" data-color="' + c + '" style="background:' + COLOR_HEX[c] + '" aria-label="高亮' + c + '"></button>';
      }).join('')
      + '<button class="anno-btn" data-act="note">写备注</button>'
      + '<button class="anno-btn" data-act="close">✕</button></div>');
    document.body.appendChild(toolbar);
    toolbar.addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t) return;
      if (t.getAttribute('data-act') === 'close') { hideToolbar(); return; }
      if (t.getAttribute('data-act') === 'note') {
        var anno = applyHighlight('yellow', '');
        hideToolbar();
        if (anno && !anno.error) { renderPanel(); openPopover(anno.id); }
        return;
      }
      var color = t.getAttribute('data-color');
      if (color) {
        var a2 = applyHighlight(color, '');
        hideToolbar();
        if (a2 && !a2.error) renderPanel();
      }
    });

    popover = el('<div class="anno-ui anno-popover" style="display:none">'
      + '<div class="anno-pop-colors">' + COLORS.map(function (c) {
        return '<button class="anno-dot" data-color="' + c + '" style="background:' + COLOR_HEX[c] + '"></button>';
      }).join('') + '</div>'
      + '<textarea placeholder="写点备注…"></textarea>'
      + '<div class="anno-pop-btns"><button data-act="save">保存</button>'
      + '<button data-act="del">删除标注</button><button data-act="close">关闭</button></div></div>');
    document.body.appendChild(popover);
    popover.addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t || !currentAnnoId) return;
      var act = t.getAttribute('data-act');
      if (act === 'save') {
        updateAnno(currentAnnoId, { note: popover.querySelector('textarea').value });
        closePopover(); renderPanel();
      } else if (act === 'del') {
        removeAnno(currentAnnoId); closePopover(); renderPanel();
      } else if (act === 'close') { closePopover(); }
      else if (t.classList.contains('anno-dot')) {
        var c = t.getAttribute('data-color');
        updateAnno(currentAnnoId, { color: c });
        popover.querySelectorAll('.anno-dot').forEach(function (d) {
          d.classList.toggle('sel', d.getAttribute('data-color') === c);
        });
        renderPanel();
      }
    });

    panel = el('<div class="anno-ui anno-panel" style="display:none">'
      + '<div class="anno-panel-head"><strong>本页标注</strong> <span class="anno-count"></span>'
      + '<button data-act="close">✕</button></div>'
      + '<div class="anno-list"></div>'
      + '<div class="anno-panel-foot"><button data-act="export">导出</button>'
      + '<button data-act="import">导入</button><button data-act="clear">清空本页</button></div>'
      + '<input type="file" accept=".json,application/json" style="display:none"></div>');
    document.body.appendChild(panel);
    panel.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'close') { panel.style.display = 'none'; return; }
      if (act === 'export') {
        var blob = new Blob([JSON.stringify(load(), null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'annotations-' + location.pathname.split('/').pop().replace(/\.html$/, '') + '.json';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        return;
      }
      if (act === 'import') { panel.querySelector('input').click(); return; }
      if (act === 'clear') {
        if (window.confirm('清空本页全部标注？')) {
          unwrapAll(); save([]); resolved = {}; renderPanel();
        }
        return;
      }
      var item = ev.target.closest('.anno-item');
      if (!item) return;
      var id = item.getAttribute('data-id');
      if (act === 'goto') { panel.style.display = 'none'; flash(id); }
      else if (act === 'edit') { openPopover(id); }
      else if (act === 'del') { removeAnno(id); renderPanel(); }
    });
    panel.querySelector('input').addEventListener('change', function (ev) {
      var file = ev.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var n = window.AIReportsAnno.importJSON(reader.result);
          restoreAll(); renderPanel();
          alert('导入 ' + n + ' 条新标注');
        } catch (e) { alert('导入失败：文件不是有效的标注 JSON'); }
      };
      reader.readAsText(file);
      ev.target.value = '';
    });

    fab = el('<button class="anno-ui anno-fab">标注 <span class="anno-badge"></span></button>');
    document.body.appendChild(fab);
    fab.addEventListener('click', function () {
      renderPanel();
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    document.addEventListener('click', function (ev) {
      var mark = ev.target.closest ? ev.target.closest('mark[data-anno]') : null;
      if (mark) { openPopover(mark.getAttribute('data-anno')); renderPanel(); }
    });
    document.addEventListener('selectionchange', scheduleToolbar);
    document.addEventListener('scroll', hideToolbar, { passive: true });
    window.addEventListener('resize', hideToolbar);
  }

  function exportJSON() { return JSON.stringify(load(), null, 2); }
  function importJSON(text) {
    var arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('not an array');
    var list = load(), seen = {};
    list.forEach(function (a) { seen[a.id] = true; });
    var n = 0;
    arr.forEach(function (a) {
      if (a && typeof a.quote === 'string' && a.id && !seen[a.id]) {
        if (COLORS.indexOf(a.color) === -1) a.color = 'yellow';
        list.push({ id: a.id, color: a.color, quote: a.quote,
          prefix: a.prefix || '', suffix: a.suffix || '',
          note: a.note || '', created: a.created || Date.now() });
        seen[a.id] = true; n++;
      }
    });
    save(list);
    return n;
  }

  window.AIReportsAnno = {
    list: load,
    applyHighlight: applyHighlight,
    updateNote: function (id, note) { updateAnno(id, { note: note }); },
    setColor: function (id, color) { updateAnno(id, { color: color }); },
    remove: removeAnno,
    clear: function () { unwrapAll(); save([]); resolved = {}; },
    exportJSON: exportJSON,
    importJSON: importJSON
  };

  try {
    buildUI();
    restoreAll();
    renderPanel();
  } catch (e) { /* never break reading */ if (window.console) console.warn('[anno] init failed', e); }
})();
