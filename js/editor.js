/*
 * チャートの上での編集（画面表示のチャート専用）。マウスもタッチ（iPad）も、同じ「タップ（クリック）」だけで操作する。
 * ドラッグでタスクを動かしたり作ったりはしない（タッチで、スクロールと間違えて動いてしまうのを防ぐため）。
 *   タップしたところに合わせて、そのものに必要な編集画面だけを出す
 *     空のマス → タスクの追加（そのマスの行に入る）／タスク・◆ → タスクの編集（日ごとの稼働日・非稼働日の選択を含む）／大分類の名前 → 大分類の編集／行事予定の欄 → 行事予定の追加・編集
 *     日付 → その日を非稼働日にする・戻す／年月 → その月の曜日をまとめて選ぶ／右の列 → 稼働日数の表示を切り替える
 *     プロジェクト名・自由記入欄・備考 → その場で文字を入力
 *   編集画面（ダイアログ）の中の変更は、その場でチャートに反映する（元に戻す・やり直しもできる）。
 * データの書き換えは edits.js、取り消しと自動保存は app.js（api.commit）が受け持つ。
 */
(function () {
  'use strict';

  var Dates = window.GanttDate;
  var Cal = window.GanttCalendar;
  var Holidays = window.GanttHolidays;
  var Edits = window.GanttEdits;
  var Chart = window.GanttChart;
  var Model = window.GanttModel;

  var SVGNS = 'http://www.w3.org/2000/svg';
  var ACCENT = '#1f6feb';
  var WEEK = '日月火水木金土';
  var TAP_MOUSE = 5; // これ以上動いたら、タップではない（px）
  var TAP_TOUCH = 12; // 指は少しぶれるので、大きめ
  var GHOST_MS = 400; // 編集画面を開いた直後に、指を離したあとのクリックが当たらないようにする時間

  var api = null;
  var host = null;
  var dlg = null;
  var dlgBody = null;
  var stage = null;
  var cur = { L: null, scale: 1, svg: null, hl: null, state: null };
  var sel = null; // いま編集画面を開いている対象
  var build = null; // 編集画面の中身を作る関数
  var refs = null; // 編集画面の入力欄（データが変わったときに値を合わせる）
  var openedAt = 0;
  var dlgErr = null; // 編集画面の中の、エラーメッセージの欄
  var tap = null;
  var inline = null;
  var freezeNotified = false;

  function h(tag, props, children) {
    var el = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v);
    });
    (children || []).forEach(function (c) {
      if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function n(v) {
    return String(Math.round(v * 1000) / 1000);
  }

  function state() {
    return api.getState();
  }

  function coarse() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  function short(d) {
    return d.slice(0, 4) + '/' + d.slice(5, 7) + '/' + d.slice(8, 10);
  }

  function longDate(d) {
    return short(d) + '（' + WEEK.charAt(Dates.weekday(d)) + '）';
  }

  // ---- 座標 ----

  // 画面の位置 → チャートの座標（mm）
  function toMM(e) {
    var r = cur.svg.getBoundingClientRect();
    var pad = cur.L.pad;
    return { x: (e.clientX - r.left) / cur.scale - pad, y: (e.clientY - r.top) / cur.scale - pad };
  }

  function dayAt(L, x) {
    return clamp(Math.floor((x - L.dayX0) / L.colW), 0, L.dayCount - 1);
  }

  function rowAt(L, y) {
    return L.rows[clamp(Math.floor((y - L.y.rowsTop) / L.rowH), 0, L.rows.length - 1)];
  }

  function rowOfItem(L, id) {
    return L.rows.filter(function (r) { return r.item && r.item.id === id; })[0] || null;
  }

  // その日の行事予定（state.events の番号）
  function eventsAt(s, L, day) {
    var date = L.days[day].date;
    var list = [];
    s.events.forEach(function (e, i) {
      if (e.start <= date && date <= e.end && /\S/.test(e.text)) list.push(i);
    });
    return list;
  }

  // 画面の位置にあるもの
  function hitTest(L, p, s) {
    var Y = L.y;
    if (p.x < 0 || p.y < 0 || p.x > L.W || p.y > L.H) return { kind: 'none' };
    if (p.y < Y.titleBottom) return { kind: 'title' };
    if (p.y < Y.rowsTop) {
      if (p.x >= L.dayX1) return { kind: 'free' };
      if (p.x >= L.dayX0) {
        if (p.y < Y.monthBottom) {
          var m = L.months.filter(function (mm) { return p.x >= mm.x0 && p.x < mm.x1 + 1e-9; })[0];
          return m ? { kind: 'month', month: m } : { kind: 'none' };
        }
        if (p.y < Y.dayBottom) return { kind: 'day', day: dayAt(L, p.x) };
        var d = dayAt(L, p.x);
        var list = eventsAt(s, L, d);
        var index = null;
        if (list.length) {
          var sub = L.colW / list.length;
          index = list[clamp(Math.floor((p.x - (L.dayX0 + d * L.colW)) / sub), 0, list.length - 1)];
        }
        return { kind: 'eventCell', day: d, index: index };
      }
      return { kind: 'none' };
    }
    if (p.y >= L.rowsBottom) return { kind: 'remarks' };
    var row = rowAt(L, p.y);
    if (p.x < L.dayX0) return { kind: 'group', row: row };
    if (p.x >= L.dayX1) return { kind: 'right', row: row };
    var day = dayAt(L, p.x);
    var it = row.item;
    if (!it) return { kind: 'cell', row: row, day: day };
    if (it.type === 'task') {
      for (var i = 0; i < row.segs.length; i++) {
        if (p.x >= row.segs[i].cx0 && p.x <= row.segs[i].cx1) return { kind: 'bar', row: row, day: day };
      }
    } else if (row.milestone && Math.abs(p.x - row.milestone.cx) <= Math.max(row.milestone.size / 2, L.colW / 2)) {
      return { kind: 'diamond', row: row, day: day };
    }
    return { kind: 'rowEmpty', row: row, day: day };
  }

  // ---- 表示（svg の差し替えと、選択・ヒントを重ねる層）----

  function mount(svgHtml, L, scale, s) {
    if (!stage) {
      stage = h('div', { class: 'chart-stage' });
      host.textContent = '';
      host.appendChild(stage);
      bindStage();
    }
    Array.prototype.slice.call(stage.children).forEach(function (c) {
      if (!inline || c !== inline.el) stage.removeChild(c);
    });
    stage.insertAdjacentHTML('afterbegin', svgHtml);
    var svg = stage.firstElementChild;
    var w = Math.round(L.svgW * scale);
    var hh = Math.round(L.svgH * scale);
    svg.style.width = w + 'px';
    svg.style.height = hh + 'px';
    stage.style.width = w + 'px';
    stage.style.height = hh + 'px';
    cur = { L: L, scale: scale, svg: svg, hl: null, state: s };

    if (L.tooLong) {
      closeDialog();
      return;
    }
    var hl = document.createElementNS(SVGNS, 'svg');
    hl.setAttribute('class', 'hl-layer');
    hl.setAttribute('viewBox', n(-L.pad) + ' ' + n(-L.pad) + ' ' + n(L.svgW) + ' ' + n(L.svgH));
    hl.style.width = w + 'px';
    hl.style.height = hh + 'px';
    stage.insertBefore(hl, inline ? inline.el : null);
    cur.hl = hl;
    drawOverlay();
    if (inline && inline.place) inline.place();
  }

  function svgText(x, y, str, fs, anchor) {
    return '<text x="' + n(x) + '" y="' + n(y) + '" font-size="' + n(fs) + '" fill="#9aa5b1"' +
      (anchor === 'middle' ? ' text-anchor="middle"' : '') + '>' + str + '</text>';
  }

  function drawOverlay() {
    if (!cur.hl) return;
    var L = cur.L;
    var s = cur.state;
    var out = [];

    // 何も入っていない欄のヒント
    if (!/\S/.test(s.projectName)) out.push(svgText(L.W / 2, L.titleH / 2 + 1.4, 'プロジェクト名（タップして入力）', 4, 'middle'));
    if (!/\S/.test(s.freeText)) out.push(svgText(L.free.x + 1.5, L.free.y + 4.5, '自由記入欄（タップして入力）', 2.6));
    if (!/\S/.test(s.remarks) && L.remarks.h > 12) out.push(svgText(3, L.remarks.y + 10, '（タップして入力）', 3));
    var blank = L.rows.filter(function (r) { return !r.item; })[0];
    if (blank && L.dayAreaW > 40 && !sel) {
      out.push(svgText(L.dayX0 + 2, blank.y + blank.h * 0.5 + 0.9, '＋ ここをタップしてタスクを追加', 2.6));
    }

    // 編集画面を開いている対象
    var box = 'fill="rgba(31,111,235,0.10)" stroke="' + ACCENT + '" stroke-width="0.5"';
    function rect(x, y, w, hgt) {
      out.push('<rect x="' + n(x) + '" y="' + n(y) + '" width="' + n(w) + '" height="' + n(hgt) + '" ' + box + '/>');
    }
    if (sel && sel.type === 'task') {
      var row = rowOfItem(L, sel.id);
      if (row) {
        rect(L.dayX0, row.y, L.dayAreaW, row.h);
        rect(L.dayX1, row.y, L.rightW, row.h);
      }
    } else if (sel && sel.type === 'add') {
      var ar = L.rows.filter(function (r) { return r.groupId === sel.gid && r.index === sel.rowIndex; })[0];
      if (ar && L.days[sel.day]) rect(L.days[sel.day].x, ar.y, L.colW, ar.h);
    } else if (sel && sel.type === 'group') {
      var g = L.groups.filter(function (x) { return x.group.id === sel.id; })[0];
      if (g) rect(0, g.y, L.leftW, g.h);
    } else if (sel && sel.type === 'event') {
      var e = s.events[sel.index];
      if (e) {
        L.days.forEach(function (d) {
          if (d.date >= e.start && d.date <= e.end) rect(d.x, L.y.eventsTop, L.colW, L.y.rowsTop - L.y.eventsTop);
        });
      }
    } else if (sel && sel.type === 'addEvent') {
      if (L.days[sel.day]) rect(L.days[sel.day].x, L.y.eventsTop, L.colW, L.y.rowsTop - L.y.eventsTop);
    } else if (sel && sel.type === 'day') {
      var dd = L.days.filter(function (d) { return d.date === sel.date; })[0];
      if (dd) rect(dd.x, L.y.monthBottom, L.colW, L.rowsBottom - L.y.monthBottom);
    } else if (sel && sel.type === 'month') {
      var mo = L.months.filter(function (m) { return m.ym === sel.ym; })[0];
      if (mo) rect(mo.x0, L.y.monthTop, mo.x1 - mo.x0, L.y.monthBottom - L.y.monthTop);
    }
    cur.hl.innerHTML = out.join('');
  }

  // ---- 変更（取り消しできる形で app.js に渡す）----

  // 表示期間が「自動」のときは、チャートを編集した時点の期間に固定する（予定を足しても、列がずれないように）
  function freeze(s, range) {
    if (!s.settings.periodStart) s.settings.periodStart = range.start;
    if (!s.settings.periodEnd) s.settings.periodEnd = range.end;
  }

  function withFreeze(fn, L) {
    return function (s) {
      freeze(s, L.range);
      return fn(s);
    };
  }

  function commitEdit(fn, opts) {
    var L = cur.L;
    var s0 = state();
    var wasAuto = !(s0.settings.periodStart && s0.settings.periodEnd);
    var res = api.commit(withFreeze(fn, L), opts);
    if (wasAuto && !freezeNotified) {
      freezeNotified = true;
      api.notice('ok', '表示期間を、今の表示（' + short(L.range.start) + ' 〜 ' + short(L.range.end) + '）に固定しました。変えるときは「基本設定」の表示期間か、チャートの上の「◀＋7日」「−1日▶」「◀−1日」「＋7日▶」で。');
    }
    return res;
  }

  function commitText(fn, key) {
    return api.commit(fn, { key: key || null });
  }

  // 空き行を足す（一番下に足す）
  function addRowTo(gid) {
    commitEdit(function (s) {
      if (!Edits.addRow(s, gid)) api.notice('error', '空き行は ' + window.GanttModel.MAX_EXTRA_ROWS + ' 行までです。');
    });
  }

  // 空き行を減らす（一番下の空きの行を消す）
  function removeRowFrom(gid) {
    commitEdit(function (s) { Edits.removeBlankRow(s, gid); });
  }

  // 表示期間の前（dir < 0）・後ろ（dir > 0）に、days 日（初めは 7 日）足す
  function extendPeriod(dir, days) {
    var L = cur.L;
    if (!L || L.tooLong) return;
    var start = L.range.start;
    var end = L.range.end;
    var d = (days > 0 ? Math.floor(days) : 7) * (dir < 0 ? -1 : 1);
    if (dir < 0) start = Edits.clampDate(Dates.addDays(start, d));
    else end = Edits.clampDate(Dates.addDays(end, d));
    if (Dates.diffDays(start, end) + 1 > Chart.MAX_DAYS) return api.notice('error', '表示期間は最大 ' + Chart.MAX_DAYS + ' 日までです。');
    api.commit(function (s) {
      s.settings.periodStart = start;
      s.settings.periodEnd = end;
    });
  }

  // 表示期間の前（dir < 0）の日を days 日ぶん減らす（開始日が後ろへ動く）・後ろ（dir > 0）の日を days 日ぶん減らす（終了日が前へ動く）。
  // 1 日より短くはならない（開始日 = 終了日で止まる）。外れた日のタスクは、期間の中の部分だけが描かれる
  function shrinkPeriod(dir, days) {
    var L = cur.L;
    if (!L || L.tooLong) return;
    var r = Edits.shrinkRange(L.range, dir, days);
    if (!r) return api.notice('error', '表示期間は、1 日より短くできません。');
    api.commit(function (s) {
      s.settings.periodStart = r.start;
      s.settings.periodEnd = r.end;
    });
  }

  // 大分類を足して、その編集画面を開く（名前をつける）
  function addGroupInteractive() {
    var id = null;
    commitEdit(function (s) { id = Edits.addGroup(s); });
    openGroupDialog(id);
  }

  // ---- その場の文字入力（プロジェクト名・自由記入欄・備考）----

  function closeInline() {
    if (inline) inline.finish();
  }

  // o.place() は、いまのチャートの大きさに合わせた { x, y, w, h, fs }（px）を返す。チャートが作り直されるたびに置き直す。
  // o.onInput があるときは、打つたびに反映する（プロジェクト名の欄は、改行で高くなるのを見ながら入力できる）
  function openInline(o) {
    closeInline();
    var el = h('textarea', { class: 'inline-edit', placeholder: o.placeholder || null });
    el.value = o.value;
    function place() {
      var g = o.place();
      el.style.left = Math.round(g.x) + 'px';
      el.style.top = Math.round(g.y) + 'px';
      el.style.width = Math.round(g.w) + 'px';
      el.style.height = Math.round(g.h) + 'px';
      el.style.fontSize = Math.max(coarse() ? 16 : 12, Math.round(g.fs)) + 'px';
      if (o.align) el.style.textAlign = o.align;
    }
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      inline = null;
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    el.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Escape') {
        ev.preventDefault();
        finish();
      } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        finish();
      }
    });
    el.addEventListener('input', function () { o.onInput(el.value); });
    el.addEventListener('blur', finish);
    inline = { el: el, finish: finish, place: place };
    place();
    stage.appendChild(el);
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  function openTitleEditor() {
    openInline({
      value: state().projectName, placeholder: 'プロジェクト名（改行できます）', align: 'center',
      place: function () {
        var L = cur.L;
        var sc = cur.scale;
        return { x: 3 * sc, y: 0.8 * sc, w: (L.W - 6) * sc, h: (L.titleH - 1.6) * sc, fs: (L.title ? L.title.fs : 5) * sc };
      },
      onInput: function (v) { commitText(function (s) { s.projectName = v; }, 'title'); }
    });
  }

  function openFreeEditor() {
    openInline({
      value: state().freeText, placeholder: '自由記入欄',
      place: function () {
        var L = cur.L;
        var sc = cur.scale;
        return { x: (L.free.x + 0.8) * sc, y: (L.free.y + 0.8) * sc, w: (L.free.w - 1.6) * sc, h: (L.free.h - 1.6) * sc, fs: 3.2 * sc };
      },
      onInput: function (v) { commitText(function (s) { s.freeText = v; }, 'free'); }
    });
  }

  function openRemarksEditor() {
    openInline({
      value: state().remarks, placeholder: '備考',
      place: function () {
        var L = cur.L;
        var sc = cur.scale;
        return { x: 3 * sc, y: (L.remarks.y + 6.5) * sc, w: (L.W - 6) * sc, h: Math.max((L.remarks.h - 7.5) * sc, 60), fs: 3.2 * sc };
      },
      onInput: function (v) { commitText(function (s) { s.remarks = v; }, 'remarks'); }
    });
  }

  // ---- タップ（マウスのクリックも、指のタップも同じ）----

  function bindStage() {
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', function () { tap = null; });
    stage.addEventListener('pointermove', onHover);
  }

  function onHover(e) {
    if (e.pointerType !== 'mouse' || !cur.L || cur.L.tooLong) return;
    var hit = hitTest(cur.L, toMM(e), state());
    var c = 'default';
    if (hit.kind === 'title' || hit.kind === 'free' || hit.kind === 'remarks') c = 'text';
    else if (hit.kind === 'right') c = hit.row.item ? 'pointer' : 'default';
    else if (hit.kind === 'group') c = hit.row.groupId ? 'pointer' : 'default';
    else if (hit.kind !== 'none') c = 'pointer';
    stage.style.cursor = c;
  }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest && e.target.closest('.inline-edit')) return;
    tap = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType };
  }

  // 指を離したとき、ほとんど動いていなければタップとして扱う（スクロールやピンチは、ここまで来ない）
  function onUp(e) {
    if (!tap || tap.id !== e.pointerId) return;
    var t = tap;
    tap = null;
    if (!cur.L || cur.L.tooLong) return;
    if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > (t.type === 'mouse' ? TAP_MOUSE : TAP_TOUCH)) return;
    closeInline();
    perform(hitTest(cur.L, toMM(e), state()));
  }

  function perform(hit) {
    var L = cur.L;
    var it = hit.row && hit.row.item;
    if (hit.kind === 'title') openTitleEditor();
    else if (hit.kind === 'free') openFreeEditor();
    else if (hit.kind === 'remarks') openRemarksEditor();
    else if (hit.kind === 'cell') openAddTaskDialog(hit.row, hit.day);
    else if (hit.kind === 'bar' || hit.kind === 'diamond' || hit.kind === 'rowEmpty') openTaskDialog(it.id);
    else if (hit.kind === 'right') {
      // 右の列のセル: タスクなら、稼働日数（N日）の表示・非表示を切り替える
      if (it && it.type === 'task') commitText(function (s) { Edits.toggleShowWorkDays(s, it.id); });
      else if (it) openTaskDialog(it.id);
    } else if (hit.kind === 'group') {
      if (hit.row.groupId) openGroupDialog(hit.row.groupId);
      else addGroupInteractive(); // 一番最初（大分類がまだ 1 つもない）は、大分類を作って、その編集画面を開く
    } else if (hit.kind === 'day') openDayDialog(L.days[hit.day].date);
    else if (hit.kind === 'month') openMonthDialog(hit.month.ym);
    else if (hit.kind === 'eventCell') {
      if (hit.index !== null) openEventDialog(hit.index);
      else openAddEventDialog(hit.day);
    }
  }

  function onKey(e) {
    var t = e.target;
    var tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    if (!host || host.offsetParent === null) return;
    if (document.querySelector('dialog[open]')) return; // 編集画面・基本設定を開いている間は、チャートのキー操作をしない
    var mod = e.ctrlKey || e.metaKey;
    var k = e.key.toLowerCase();
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); api.undo(); }
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); api.redo(); }
  }

  // ---- 編集画面（ダイアログ）の部品 ----

  function field(label, input, cls) {
    return h('label', { class: 'field dlg-field ' + (cls || '') }, [label, input]);
  }

  function dlgButton(text, onClick, opts) {
    opts = opts || {};
    return h('button', {
      type: 'button', class: (opts.primary ? 'primary ' : '') + (opts.danger ? 'danger' : ''),
      text: text, title: opts.title || null, disabled: !!opts.disabled, autofocus: !!opts.autofocus, onclick: onClick
    });
  }

  // 日付の入力。存在しない日付と、表示している期間の外の日付は受け付けない（メッセージを出して、元に戻す）
  function dateInput(value, onChange) {
    var el = h('input', { type: 'date', value: value });
    el.dataset.last = value;
    el.addEventListener('change', function () {
      var v = el.value;
      var range = cur.L.range;
      if (!Dates.isValid(v)) {
        showError('その日付は選べません（存在しない日付です）。');
        el.value = el.dataset.last;
      } else if (v < range.start || v > range.end) {
        showError('表示している期間（' + short(range.start) + ' 〜 ' + short(range.end) + '）の外の日付は選べません。期間を広げるには、チャートの上の「◀＋7日」「＋7日▶」か、基本設定の表示期間を使ってください。');
        el.value = el.dataset.last;
      } else {
        showError('');
        el.dataset.last = v;
        onChange(v);
      }
    });
    return el;
  }

  // エラーメッセージの欄（編集画面の中。モーダルの外のメッセージは、画面の後ろに隠れて見えないため）
  function errorLine() {
    dlgErr = h('div', { class: 'field-error dlg-error', role: 'alert', hidden: true });
    return dlgErr;
  }

  function showError(msg) {
    if (!dlgErr) return;
    dlgErr.textContent = msg;
    dlgErr.hidden = !msg;
  }

  function head(badge, sub) {
    return h('div', { class: 'dlg-head' }, [
      h('span', { class: 'eb-badge', text: badge }),
      h('span', { class: 'dlg-sub', text: sub || '' })
    ]);
  }

  function footer(left, right) {
    return h('div', { class: 'dlg-foot' }, [h('div', { class: 'dlg-foot-left' }, left || []), h('div', { class: 'dlg-foot-right' }, right || [])]);
  }

  function closeButton() {
    return dlgButton('閉じる', closeDialog, { primary: true, autofocus: true });
  }

  function sameColor(a, b) {
    return String(a || '').toLowerCase() === String(b || '').toLowerCase();
  }

  // ---- 最近使った色 ----
  // 色を選ぶたびに、その色を覚えて、すべての色の選択（矢印・マーカー・文字・行事予定）の「最近使った色」に出す。
  // 新しい順で、RECENT_MAX 色まで。このブラウザに保存する（保存できないときは、開いている間だけ）
  var RECENT_KEY = 'ganttPdf.recentColors.v1';
  var RECENT_MAX = 6;
  var recent = null;
  var paletteViews = []; // いま開いている編集画面の中の色の選択（最近使った色をそろえて更新する）

  function recentColors() {
    if (recent) return recent;
    recent = [];
    try {
      var saved = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]');
      if (Array.isArray(saved)) saved.slice().reverse().forEach(function (c) { recent = Edits.pushRecentColor(recent, c, RECENT_MAX); });
    } catch (e) { /* 保存された色が読めなくても、使うのには困らない */ }
    return recent;
  }

  function rememberColor(color) {
    if (!color) return;
    recent = Edits.pushRecentColor(recentColors(), color, RECENT_MAX);
    try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch (e) { /* 保存できなくても、開いている間は使える */ }
    paletteViews.forEach(function (v) { v.repaintRecent(); });
  }

  // 色の選択（編集画面の中に、色見本を並べる）。allowNone のときは「色なし」（none.label）も選べる。
  // 一番上に、最近使った色を出す
  function paletteRow(label, getColor, allowNone, onPick, noneLabel) {
    var wrap = h('div', { class: 'dlg-palette' }, [h('div', { class: 'dlg-label', text: label })]);
    var recentWrap = h('div', { class: 'palette-recent', hidden: true }, [h('span', { class: 'palette-recent-label', text: '最近使った色' })]);
    var recentGrid = h('div', { class: 'palette' });
    recentWrap.appendChild(recentGrid);
    var grid = h('div', { class: 'palette' });
    var buttons = [];
    var recentButtons = [];
    function pick(color) {
      onPick(color);
      rememberColor(color);
      paint();
    }
    function paint() {
      var c = getColor();
      buttons.concat(recentButtons).forEach(function (b) { b.setAttribute('aria-pressed', sameColor(b.dataset.color, c) ? 'true' : 'false'); });
      if (customWrap) customWrap.className = 'other' + (c && !api.palette.some(function (p) { return sameColor(p, c); }) ? ' selected' : '');
    }
    function swatch(color) {
      var b = h('button', {
        type: 'button', class: 'swatch' + (color === null ? ' none' : ''),
        title: color === null ? (noneLabel || '色なし') : color,
        style: color === null ? null : 'background:' + color,
        onclick: function () { pick(color); }
      });
      b.dataset.color = color === null ? '' : color;
      return b;
    }
    function add(color) {
      var b = swatch(color);
      buttons.push(b);
      grid.appendChild(b);
    }
    function repaintRecent() {
      recentGrid.textContent = '';
      recentButtons = [];
      var list = recentColors();
      recentWrap.hidden = list.length === 0;
      list.forEach(function (c) {
        var b = swatch(c);
        recentButtons.push(b);
        recentGrid.appendChild(b);
      });
      paint();
    }
    if (allowNone) add(null);
    api.palette.forEach(add);
    var custom = h('input', { type: 'color', value: getColor() || '#ff8800', title: 'その他の色' });
    custom.addEventListener('change', function () { pick(custom.value); });
    var customWrap = h('label', { class: 'other' }, ['その他の色', custom]);
    grid.appendChild(customWrap);
    wrap.appendChild(recentWrap);
    wrap.appendChild(grid);
    paletteViews.push({ repaintRecent: repaintRecent });
    repaintRecent();
    return wrap;
  }

  // 稼働日数の入力: 数（自動で数えた日数。「手動で入力する」と、好きな数にできる）と単位（日・人日・h など）、右の列に出すか。
  // get() は { start, end, includeRedDays, dayOverrides, showWorkDays, workDaysManual, workDaysUnit } を返す。
  // set.manual(数 か null)・set.unit(文字)・set.show(true か false) で、データ（または下書き）を書き換える。
  // refresh() で、表示をデータに合わせる（入力中の欄は、そのままにする）
  function workDaysBox(get, set) {
    var manual = h('input', { type: 'checkbox' });
    var num = h('input', { type: 'number', class: 'dlg-days-num', min: '0', step: 'any', inputmode: 'decimal', 'aria-label': '稼働日数' });
    var unit = h('input', { type: 'text', class: 'dlg-days-unit', maxlength: String(Model.MAX_UNIT_LENGTH), placeholder: '単位', 'aria-label': '稼働日数の単位' });
    var show = h('input', { type: 'checkbox' });
    var showText = h('span');
    var wrap = h('div', { class: 'dlg-section dlg-workdays' }, [
      h('div', { class: 'dlg-label', text: '稼働日数（初めは、稼働日を自動で数えた日数）' }),
      h('div', { class: 'dlg-days-row' }, [num, unit, h('label', { class: 'check' }, [manual, ' 手動で入力する'])]),
      h('label', { class: 'check' }, [show, showText])
    ]);
    function auto(t) {
      return Cal.countTaskWorkdays(t, state().workdayOverrides);
    }
    function refresh() {
      var t = get();
      var isManual = typeof t.workDaysManual === 'number';
      manual.checked = isManual;
      num.disabled = !isManual;
      if (document.activeElement !== num) num.value = Cal.formatNumber(isManual ? t.workDaysManual : auto(t));
      if (document.activeElement !== unit) unit.value = typeof t.workDaysUnit === 'string' ? t.workDaysUnit : Model.DEFAULT_DAYS_UNIT;
      show.checked = !!t.showWorkDays;
      showText.textContent = ' 右の列に「（' + Cal.taskDays(t, state().workdayOverrides).text + '）」を表示する';
    }
    manual.addEventListener('change', function () {
      set.manual(manual.checked ? auto(get()) : null);
      showError('');
      refresh();
      if (manual.checked) { num.focus(); num.select(); }
    });
    num.addEventListener('input', function () {
      var v = num.value;
      if (v === '') return; // 入力の途中（消したところ）。確定するとき（change）に確かめる
      var x = Number(v);
      if (!isFinite(x) || x < 0 || x > Model.MAX_DAYS_VALUE) {
        showError('稼働日数は 0 以上、' + Model.MAX_DAYS_VALUE + ' 以下の数で入力してください。');
        return;
      }
      showError('');
      set.manual(x);
      showText.textContent = ' 右の列に「（' + Cal.taskDays(get(), state().workdayOverrides).text + '）」を表示する';
    });
    num.addEventListener('change', function () {
      var x = Number(num.value);
      if (num.value === '' || !isFinite(x) || x < 0 || x > Model.MAX_DAYS_VALUE) {
        showError('稼働日数は 0 以上、' + Model.MAX_DAYS_VALUE + ' 以下の数で入力してください。元の数に戻しました。');
        num.blur();
      } else {
        showError('');
      }
      refresh();
    });
    unit.addEventListener('input', function () {
      set.unit(unit.value);
      showText.textContent = ' 右の列に「（' + Cal.taskDays(get(), state().workdayOverrides).text + '）」を表示する';
    });
    show.addEventListener('change', function () { set.show(show.checked); });
    refresh();
    wrap.refresh = refresh;
    return wrap;
  }

  // タスクの期間の、日ごとの選択（カレンダーの形。選ばれている日 = そのタスクの稼働日。土日祝も、初めから選ばれている）。
  // 日をタップすると、選ぶ・外す（外した日は非稼働日）。getTask() は { start, end, includeRedDays, dayOverrides } を返す。
  // onToggle(date, working) で、データ（または下書き）を書き換える。refresh() で、選ばれている印だけを更新する
  var DAY_GRID_MAX = 200;

  function dayGrid(getTask, onToggle) {
    var wrap = h('div', { class: 'dlg-days' });
    var cells = [];
    function working(date) {
      return Cal.isTaskWorkday(getTask(), date, state().workdayOverrides);
    }
    function refresh() {
      cells.forEach(function (c) {
        var w = working(c.dataset.date);
        c.setAttribute('aria-pressed', w ? 'true' : 'false');
        c.title = longDate(c.dataset.date) + (w ? '（稼働日）' : '（非稼働日）');
      });
    }
    function paint() {
      wrap.textContent = '';
      cells = [];
      var t = getTask();
      wrap.appendChild(h('div', { class: 'dlg-days-head' }, WEEK.split('').map(function (w, i) {
        return h('span', { class: i === 0 ? 'red' : (i === 6 ? 'blue' : ''), text: w });
      })));
      var grid = h('div', { class: 'dlg-days-grid' });
      for (var k = 0; k < Dates.weekday(t.start); k++) grid.appendChild(h('span'));
      var total = Dates.diffDays(t.start, t.end) + 1;
      for (var i = 0; i < Math.min(total, DAY_GRID_MAX); i++) {
        var date = Dates.addDays(t.start, i);
        var wd = Dates.weekday(date);
        var tone = Holidays.holidayName(date) !== null || wd === 0 ? ' red' : (wd === 6 ? ' blue' : '');
        var label = (i === 0 || date.slice(8, 10) === '01') ? Number(date.slice(5, 7)) + '/' + Number(date.slice(8, 10)) : String(Number(date.slice(8, 10)));
        var b = h('button', { type: 'button', class: 'dlg-day' + tone, text: label });
        b.dataset.date = date;
        b.addEventListener('click', function (ev) {
          var d = ev.currentTarget.dataset.date;
          onToggle(d, !working(d));
          refresh();
        });
        cells.push(b);
        grid.appendChild(b);
      }
      wrap.appendChild(grid);
      if (total > DAY_GRID_MAX) wrap.appendChild(h('div', { class: 'dlg-note', text: '期間が長いので、はじめの ' + DAY_GRID_MAX + ' 日だけ表示しています。' }));
      refresh();
    }
    paint();
    wrap.refresh = refresh;
    wrap.repaint = paint;
    return wrap;
  }

  // ---- 編集画面を開く・閉じる・合わせる ----

  function openDialog(target, builder) {
    closeInline();
    sel = target;
    build = builder;
    refs = null;
    dlgErr = null;
    paletteViews = [];
    dlgBody.textContent = '';
    builder();
    openedAt = Date.now();
    if (!dlg.open) {
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    }
    drawOverlay();
  }

  function closeDialog() {
    if (!dlg || !dlg.open) return;
    if (typeof dlg.close === 'function') dlg.close();
    else {
      dlg.removeAttribute('open');
      onDialogClosed();
    }
  }

  function onDialogClosed() {
    sel = null;
    build = null;
    refs = null;
    drawOverlay();
  }

  function rebuildDialog() {
    if (!build || !dlg.open) return;
    dlgBody.textContent = '';
    refs = null;
    dlgErr = null;
    paletteViews = [];
    build();
  }

  // 開いている編集画面の対象が、まだあるか（取り消しなどで、なくなったら閉じる）
  function targetExists() {
    var s = state();
    if (!sel) return true;
    if (sel.type === 'task') return !!Edits.findTask(s, sel.id);
    if (sel.type === 'group') return !!Edits.findGroup(s, sel.id);
    if (sel.type === 'event') return !!s.events[sel.index];
    return true;
  }

  // データが変わったとき（取り消し・やり直しを含む）、開いている編集画面を合わせる
  function sync() {
    if (!dlg || !dlg.open || !build) return;
    if (!targetExists()) return closeDialog();
    if (sel && (sel.type === 'add' || sel.type === 'addEvent')) return; // 追加の途中の入力は、そのままにする
    if (refs && dlgBody.contains(document.activeElement)) {
      updateValues();
      return;
    }
    rebuildDialog();
  }

  // 入力中でない欄の値を、データに合わせる
  function updateValues() {
    if (!refs) return;
    var s = state();
    function set(el, v) {
      if (el && document.activeElement !== el && el.value !== v) {
        el.value = v;
        if (el.dataset) el.dataset.last = v;
      }
    }
    if (refs.type === 'task') {
      var t = Edits.findTask(s, refs.id);
      if (!t) return;
      set(refs.name, t.name);
      if (t.type === 'milestone') {
        set(refs.start, t.date);
      } else {
        set(refs.start, t.start);
        set(refs.end, t.end);
        refs.daysBox.refresh();
        refs.off.checked = !t.includeRedDays;
        refs.grid.repaint();
      }
      if (refs.up) {
        refs.up.disabled = !Edits.canStep(s, refs.id, -1);
        refs.down.disabled = !Edits.canStep(s, refs.id, 1);
      }
    } else if (refs.type === 'group') {
      var g = Edits.findGroup(s, refs.id);
      if (g) {
        set(refs.name, g.name);
        refs.sub.textContent = groupSummary(s, g);
        refs.reduce.disabled = g.extraRows <= 0;
        refs.note.hidden = !refs.reduce.disabled;
        refs.up.disabled = s.groups.indexOf(g) <= 0;
        refs.down.disabled = s.groups.indexOf(g) >= s.groups.length - 1;
      }
    } else if (refs.type === 'event') {
      var e = s.events[refs.index];
      if (e) {
        set(refs.name, e.text);
        set(refs.start, e.start);
        set(refs.end, e.end);
      }
    }
  }

  // ---- タスク・マイルストーンの編集 ----

  function openTaskDialog(id) {
    if (!Edits.findTask(state(), id)) return;
    openDialog({ type: 'task', id: id }, function () { buildTask(id); });
  }

  function buildTask(id) {
    var s = state();
    var t = Edits.findTask(s, id);
    if (!t) return closeDialog();
    var isMs = t.type === 'milestone';
    var g = Edits.findGroup(s, t.groupId);
    var r = { type: 'task', id: id };

    r.name = h('input', { type: 'text', value: t.name, placeholder: '名前' });
    r.name.addEventListener('input', function () {
      commitText(function (st) { Edits.setName(st, id, r.name.value); }, 'name:' + id);
    });
    dlgBody.appendChild(head(isMs ? '◆ マイルストーン' : 'タスク', g ? '大分類: ' + g.name : ''));
    dlgBody.appendChild(errorLine());
    dlgBody.appendChild(field('名前', r.name));

    if (isMs) {
      r.start = dateInput(t.date, function (v) { commitEdit(function (st) { Edits.setDates(st, id, v); }); updateValues(); });
      dlgBody.appendChild(field('日付', r.start));
    } else {
      r.start = dateInput(t.start, function (v) { commitEdit(function (st) { Edits.setDates(st, id, v, Edits.findTask(st, id).end); }); updateValues(); });
      r.end = dateInput(t.end, function (v) { commitEdit(function (st) { Edits.setDates(st, id, Edits.findTask(st, id).start, v); }); updateValues(); });
      dlgBody.appendChild(h('div', { class: 'dlg-two' }, [field('開始日', r.start), field('終了日', r.end)]));
      var current = function () { return Edits.findTask(state(), id) || t; };
      r.daysBox = workDaysBox(current, {
        manual: function (v) { commitText(function (st) { Edits.setWorkDaysManual(st, id, v); }, 'wdm:' + id); },
        unit: function (u) { commitText(function (st) { Edits.setWorkDaysUnit(st, id, u); }, 'wdu:' + id); },
        show: function (b) { commitText(function (st) { Edits.setShowWorkDays(st, id, b); }); }
      });
      // 「土日祝を非稼働日にする」: チェックなし（初め）= 土日祝も稼働日。チェックを入れると、土日祝は非稼働日（矢印が途切れ、稼働日数に数えない）
      r.off = h('input', { type: 'checkbox' });
      r.off.checked = !t.includeRedDays;
      r.off.addEventListener('change', function () {
        commitText(function (st) { Edits.setIncludeRedDays(st, id, !r.off.checked); });
        updateValues();
      });
      r.grid = dayGrid(current, function (date, working) {
        commitText(function (st) { Edits.setTaskDay(st, id, date, working); });
        updateValues();
      });
      dlgBody.appendChild(r.daysBox);
      dlgBody.appendChild(h('div', { class: 'dlg-label', text: '稼働する日を選ぶ（選んだ日 = 稼働日。外した日 = 非稼働日で、矢印が途切れ、自動で数える稼働日数に数えません）' }));
      dlgBody.appendChild(h('label', { class: 'check' }, [r.off, ' 土日祝を非稼働日にする']));
      dlgBody.appendChild(r.grid);
    }

    dlgBody.appendChild(paletteRow(isMs ? '◆の色' : '矢印の色', function () {
      var c = Edits.findTask(state(), id);
      return c ? (c.type === 'milestone' ? c.diamondColor : c.arrowColor) : '#000000';
    }, false, function (c) { commitText(function (st) { Edits.setShapeColor(st, id, c); }); }));
    dlgBody.appendChild(paletteRow('マーカーの色', function () {
      var c = Edits.findTask(state(), id);
      return c ? c.markerColor : null;
    }, true, function (c) { commitText(function (st) { Edits.setMarkerColor(st, id, c); }); }));
    dlgBody.appendChild(paletteRow('文字の色（名前）', function () {
      var c = Edits.findTask(state(), id);
      return c ? c.textColor : null;
    }, true, function (c) { commitText(function (st) { Edits.setTextColor(st, id, c); }); }, '標準（黒）'));

    r.up =dlgButton('↑ 1行上へ', function () { commitEdit(function (st) { Edits.stepTask(st, id, -1); }); updateValues(); }, { disabled: !Edits.canStep(s, id, -1), title: '同じ大分類の中で 1 行上へ（空いている行へも動く）' });
    r.down = dlgButton('↓ 1行下へ', function () { commitEdit(function (st) { Edits.stepTask(st, id, 1); }); updateValues(); }, { disabled: !Edits.canStep(s, id, 1), title: '同じ大分類の中で 1 行下へ（空いている行へも動く）' });
    dlgBody.appendChild(h('div', { class: 'dlg-section dlg-buttons' }, [
      r.up,
      r.down,
      dlgButton(isMs ? 'タスクに変える' : '◆に変える', function () { commitEdit(function (st) { Edits.convertType(st, id); }); rebuildDialog(); })
    ]));
    dlgBody.appendChild(footer([
      dlgButton('削除', function () { deleteTarget(function (st) { Edits.deleteTask(st, id); }); }, { danger: true, title: 'この行（タスク）を削除します（元に戻せます）' })
    ], [closeButton()]));
    refs = r;
  }

  function deleteTarget(fn) {
    closeDialog();
    commitEdit(fn);
  }

  // ---- 空のマスから、タスク・マイルストーンを追加 ----

  function openAddTaskDialog(row, dayIndex) {
    var L = cur.L;
    var date = L.days[dayIndex].date;
    var g = Edits.findGroup(state(), row.groupId);
    var draft = {
      type: 'task', name: 'タスク', start: date, end: date, showWorkDays: false,
      workDaysManual: null, workDaysUnit: Model.DEFAULT_DAYS_UNIT,
      includeRedDays: true, dayOverrides: {},
      arrowColor: '#000000', diamondColor: '#000000', markerColor: null, textColor: null
    };
    openDialog({ type: 'add', gid: row.groupId, rowIndex: row.index, day: dayIndex }, function () { buildAddTask(row, g, draft); });
  }

  function buildAddTask(row, g, draft) {
    dlgBody.appendChild(head('タスクの追加', g ? '大分類: ' + g.name : '大分類を新しく作ります'));
    dlgBody.appendChild(errorLine());
    var name = h('input', { type: 'text', value: draft.name, placeholder: '名前' });
    name.addEventListener('input', function () { draft.name = name.value; });
    var type = h('select', {}, [h('option', { value: 'task', text: 'タスク（期間）' }), h('option', { value: 'milestone', text: '◆ マイルストーン（日付）' })]);
    type.value = draft.type;
    var grid = null;
    var workBox = null;
    var start = dateInput(draft.start, function (v) {
      draft.start = v;
      if (draft.end < v) { draft.end = v; end.value = v; end.dataset.last = v; }
      if (grid) grid.repaint();
      if (workBox) workBox.refresh();
    });
    var end = dateInput(draft.end, function (v) {
      draft.end = v;
      if (draft.start > v) { draft.start = v; start.value = v; start.dataset.last = v; }
      if (grid) grid.repaint();
      if (workBox) workBox.refresh();
    });
    var startField = field('開始日', start);
    var endField = field('終了日', end);
    workBox = workDaysBox(function () { return draft; }, {
      manual: function (v) { draft.workDaysManual = v; },
      unit: function (u) { draft.workDaysUnit = u; },
      show: function (b) { draft.showWorkDays = b; }
    });
    // 「土日祝を非稼働日にする」: チェックなし（初め）= 土日祝も稼働日
    var off = h('input', { type: 'checkbox' });
    off.checked = !draft.includeRedDays;
    off.addEventListener('change', function () {
      draft.includeRedDays = !off.checked;
      draft.dayOverrides = Cal.normalizeTaskDays(draft, state().workdayOverrides);
      grid.refresh();
      workBox.refresh();
    });
    grid = dayGrid(function () { return draft; }, function (date, working) {
      draft.dayOverrides = Cal.setTaskDay(draft, date, working, state().workdayOverrides);
      workBox.refresh();
    });
    var daysBox = h('div', {}, [
      h('div', { class: 'dlg-label', text: '稼働する日を選ぶ（選んだ日 = 稼働日。外した日 = 非稼働日）' }),
      h('label', { class: 'check' }, [off, ' 土日祝を非稼働日にする']),
      grid
    ]);
    var shapeHost = h('div', {});
    function paintType() {
      var ms = draft.type === 'milestone';
      startField.firstChild.nodeValue = ms ? '日付' : '開始日';
      endField.hidden = ms;
      workBox.hidden = ms;
      daysBox.hidden = ms;
      shapeHost.textContent = '';
      shapeHost.appendChild(paletteRow(ms ? '◆の色' : '矢印の色', function () { return ms ? draft.diamondColor : draft.arrowColor; }, false, function (c) {
        if (ms) draft.diamondColor = c; else draft.arrowColor = c;
      }));
    }
    type.addEventListener('change', function () { draft.type = type.value; paintType(); });

    dlgBody.appendChild(field('名前', name));
    dlgBody.appendChild(field('種類', type));
    dlgBody.appendChild(h('div', { class: 'dlg-two' }, [startField, endField]));
    dlgBody.appendChild(workBox);
    dlgBody.appendChild(daysBox);
    dlgBody.appendChild(shapeHost);
    dlgBody.appendChild(paletteRow('マーカーの色', function () { return draft.markerColor; }, true, function (c) { draft.markerColor = c; }));
    dlgBody.appendChild(paletteRow('文字の色（名前）', function () { return draft.textColor; }, true, function (c) { draft.textColor = c; }, '標準（黒）'));
    paintType();
    dlgBody.appendChild(footer([dlgButton('キャンセル', closeDialog)], [
      dlgButton('追加', function () {
        var d = draft;
        var gid = row.groupId;
        var at = row.index;
        closeDialog();
        commitEdit(function (s) {
          var id = gid || Edits.addGroup(s);
          var nm = /\S/.test(d.name) ? d.name : (d.type === 'milestone' ? 'マイルストーン' : 'タスク');
          if (d.type === 'milestone') Edits.createMilestone(s, { groupId: id, name: nm, date: d.start, diamondColor: d.diamondColor, markerColor: d.markerColor, textColor: d.textColor, row: at });
          else Edits.createTask(s, {
            groupId: id, name: nm, start: d.start, end: d.end, arrowColor: d.arrowColor, markerColor: d.markerColor, textColor: d.textColor,
            showWorkDays: d.showWorkDays, workDaysManual: d.workDaysManual, workDaysUnit: d.workDaysUnit,
            includeRedDays: d.includeRedDays, dayOverrides: d.dayOverrides, row: at
          });
        });
      }, { primary: true, autofocus: true })
    ]));
  }

  // ---- 大分類の編集 ----

  function openGroupDialog(gid) {
    if (!Edits.findGroup(state(), gid)) return;
    openDialog({ type: 'group', id: gid }, function () { buildGroup(gid); });
  }

  // 大分類の行の数の説明（空き = タスクがいない行。タスクも空きもないときも、1 行は出る）
  function groupSummary(s, g) {
    var rows = Edits.rowCount(s, g.id);
    var tasks = Edits.groupItems(s, g.id).length;
    return '行: ' + rows + '（タスク ' + tasks + '＋空き ' + (rows - tasks) + '）';
  }

  function buildGroup(gid) {
    var s = state();
    var g = Edits.findGroup(s, gid);
    if (!g) return closeDialog();
    var r = { type: 'group', id: gid };
    var gi = s.groups.indexOf(g);
    r.name = h('textarea', { rows: 2, placeholder: '大分類の名前（改行できます）' });
    r.name.value = g.name;
    r.name.addEventListener('input', function () {
      commitText(function (st) { Edits.renameGroup(st, gid, r.name.value); }, 'gname:' + gid);
    });
    var headEl = head('大分類', groupSummary(s, g));
    r.sub = headEl.querySelector('.dlg-sub');
    dlgBody.appendChild(headEl);
    dlgBody.appendChild(field('名前（改行すると、縦書きの列が増えます）', r.name));
    r.reduce = dlgButton('空きの行を1つ減らす', function () { removeRowFrom(gid); }, { disabled: g.extraRows <= 0, title: '一番下の空きの行を減らします' });
    r.up = dlgButton('↑ 上へ', function () { commitEdit(function (st) { Edits.moveGroup(st, gid, -1); }); }, { disabled: gi <= 0, title: '大分類を上へ' });
    r.down = dlgButton('↓ 下へ', function () { commitEdit(function (st) { Edits.moveGroup(st, gid, 1); }); }, { disabled: gi >= s.groups.length - 1, title: '大分類を下へ' });
    dlgBody.appendChild(h('div', { class: 'dlg-section dlg-buttons' }, [
      dlgButton('＋ 行を追加', function () { addRowTo(gid); }),
      r.reduce, r.up, r.down
    ]));
    r.note = h('div', { class: 'dlg-note', text: '空きの行がないので、行は減らせません。タスクのある行は、タスクを削除すると減ります。', hidden: g.extraRows > 0 });
    dlgBody.appendChild(r.note);
    dlgBody.appendChild(h('div', { class: 'dlg-section dlg-buttons' }, [
      dlgButton('＋ 大分類を追加', function () { closeDialog(); addGroupInteractive(); })
    ]));
    dlgBody.appendChild(footer([
      dlgButton('大分類を削除', function () { deleteTarget(function (st) { Edits.deleteGroup(st, gid); }); }, { danger: true, title: 'この大分類のタスクもすべて消えます（元に戻せます）' })
    ], [closeButton()]));
    refs = r;
  }

  // ---- 行事予定 ----

  function openEventDialog(index) {
    if (!state().events[index]) return;
    openDialog({ type: 'event', index: index }, function () { buildEvent(index); });
  }

  function buildEvent(index) {
    var e = state().events[index];
    if (!e) return closeDialog();
    var r = { type: 'event', index: index };
    r.name = h('input', { type: 'text', value: e.text, placeholder: '行事予定の内容' });
    r.name.addEventListener('input', function () {
      commitText(function (st) { Edits.updateEvent(st, index, { text: r.name.value }); }, 'ev:' + index);
    });
    r.start = dateInput(e.start, function (v) { commitText(function (st) { Edits.updateEvent(st, index, { start: v }); }); updateValues(); });
    r.end = dateInput(e.end, function (v) { commitText(function (st) { Edits.updateEvent(st, index, { end: v }); }); updateValues(); });
    dlgBody.appendChild(head('行事予定', '縦書きで、日付の列の中央に出ます'));
    dlgBody.appendChild(errorLine());
    dlgBody.appendChild(field('内容', r.name));
    dlgBody.appendChild(h('div', { class: 'dlg-two' }, [field('開始日', r.start), field('終了日', r.end)]));
    dlgBody.appendChild(paletteRow('文字の色', function () { var c = state().events[index]; return c ? c.textColor : null; }, true,
      function (c) { commitText(function (st) { Edits.updateEvent(st, index, { textColor: c }); }); }, '標準（黒）'));
    dlgBody.appendChild(paletteRow('マーカーの色', function () { var c = state().events[index]; return c ? c.markerColor : null; }, true,
      function (c) { commitText(function (st) { Edits.updateEvent(st, index, { markerColor: c }); }); }));
    dlgBody.appendChild(footer([
      dlgButton('削除', function () { deleteTarget(function (st) { Edits.deleteEvent(st, index); }); }, { danger: true })
    ], [closeButton()]));
    refs = r;
  }

  function openAddEventDialog(dayIndex) {
    var date = cur.L.days[dayIndex].date;
    var draft = { text: '', start: date, end: date, textColor: null, markerColor: null };
    openDialog({ type: 'addEvent', day: dayIndex }, function () { buildAddEvent(draft); });
  }

  function buildAddEvent(draft) {
    dlgBody.appendChild(head('行事予定の追加', longDate(draft.start)));
    dlgBody.appendChild(errorLine());
    var text = h('input', { type: 'text', value: draft.text, placeholder: '行事予定の内容（例: 打合せ）' });
    text.addEventListener('input', function () { draft.text = text.value; });
    var start = dateInput(draft.start, function (v) { draft.start = v; if (draft.end < v) { draft.end = v; end.value = v; end.dataset.last = v; } });
    var end = dateInput(draft.end, function (v) { draft.end = v; });
    dlgBody.appendChild(field('内容', text));
    dlgBody.appendChild(h('div', { class: 'dlg-two' }, [field('開始日', start), field('終了日', end)]));
    dlgBody.appendChild(paletteRow('文字の色', function () { return draft.textColor; }, true, function (c) { draft.textColor = c; }, '標準（黒）'));
    dlgBody.appendChild(paletteRow('マーカーの色', function () { return draft.markerColor; }, true, function (c) { draft.markerColor = c; }));
    var msg = h('div', { class: 'field-error', role: 'alert', hidden: true });
    dlgBody.appendChild(msg);
    dlgBody.appendChild(footer([dlgButton('キャンセル', closeDialog)], [
      dlgButton('追加', function () {
        if (!/\S/.test(draft.text)) {
          msg.textContent = '内容を入力してください。';
          msg.hidden = false;
          text.focus();
          return;
        }
        var d = draft;
        closeDialog();
        commitEdit(function (s) { Edits.addEvent(s, { start: d.start, end: d.end, text: d.text, textColor: d.textColor, markerColor: d.markerColor }); });
      }, { primary: true })
    ]));
  }

  // ---- 日付・年月: 非稼働日の選択 ----

  // 曜日（日〜土）のボタン。その月のその曜日が全部非稼働日なら「選択中」。押すと、その月のその曜日をまとめて選ぶ・外す
  function weekdayButtons(ym) {
    var s = state();
    return h('div', { class: 'dlg-weekdays' }, WEEK.split('').map(function (label, w) {
      var allOff = Cal.isWeekdayAllOff(ym, w, s.workdayOverrides);
      var b = h('button', {
        type: 'button', class: 'dlg-wd' + (w === 0 ? ' red' : '') + (w === 6 ? ' blue' : ''), text: label,
        'aria-pressed': allOff ? 'true' : 'false',
        title: Number(ym.slice(5, 7)) + '月の' + label + '曜日をすべて' + (allOff ? '稼働日に戻す' : '非稼働日にする'),
        onclick: function () {
          commitText(function (st) { Edits.setWeekdayInMonth(st, ym, w, allOff); });
          rebuildDialog();
        }
      });
      return b;
    }));
  }

  function resetWorkdaysButton() {
    var changed = Object.keys(state().workdayOverrides).length;
    return dlgButton('非稼働日の選択をすべて初期値に戻す', function () {
      commitText(function (st) { Edits.resetWorkdays(st); });
      rebuildDialog();
    }, { disabled: !changed, title: '土日祝だけが非稼働日の状態に戻します' });
  }

  function openDayDialog(date) {
    openDialog({ type: 'day', date: date }, function () { buildDay(date); });
  }

  function buildDay(date) {
    var s = state();
    var off = !Cal.isWorkday(date, s.workdayOverrides);
    var red = Cal.isRedDay(date);
    var holiday = Holidays.holidayName(date);
    var ym = date.slice(0, 7);
    var status;
    if (off) status = red ? '非稼働日（土日祝）' : '非稼働日（選択）';
    else status = red ? '稼働日（土日祝から変更）' : '稼働日';
    dlgBody.appendChild(head('日付', longDate(date) + (holiday ? '　' + holiday : '')));
    dlgBody.appendChild(h('div', { class: 'dlg-info', text: 'この日は ' + status + ' です。' }));
    dlgBody.appendChild(h('div', { class: 'dlg-section dlg-buttons' }, [
      dlgButton(off ? '稼働日に戻す' : '非稼働日にする', function () {
        commitText(function (st) { Edits.setWorkday(st, date, off); });
        rebuildDialog();
      }, { primary: !off })
    ]));
    dlgBody.appendChild(h('div', { class: 'dlg-label', text: Number(ym.slice(5, 7)) + '月の曜日をまとめて選ぶ（選ぶと、その月のその曜日がすべて非稼働日）' }));
    dlgBody.appendChild(weekdayButtons(ym));
    dlgBody.appendChild(h('div', { class: 'dlg-note', text: 'ここで選んだ日は、すべてのタスクに効きます。ただし、タスクの編集画面で「土日祝も稼働日にする」がオンのタスク（新しいタスクは初めからオン）の土日祝と、タスクごとに選んだ日は、そのタスクの設定が優先です。灰色・赤字・青字の見た目は変わりません。' }));
    dlgBody.appendChild(footer([resetWorkdaysButton()], [closeButton()]));
  }

  function openMonthDialog(ym) {
    openDialog({ type: 'month', ym: ym }, function () { buildMonth(ym); });
  }

  function buildMonth(ym) {
    var label = ym.slice(0, 4) + '年' + Number(ym.slice(5, 7)) + '月';
    dlgBody.appendChild(head('年月', label));
    dlgBody.appendChild(h('div', { class: 'dlg-label', text: '曜日をまとめて選ぶ（選ぶと、' + Number(ym.slice(5, 7)) + '月のその曜日がすべて非稼働日）' }));
    dlgBody.appendChild(weekdayButtons(ym));
    dlgBody.appendChild(h('div', { class: 'dlg-note', text: '日付をタップすると、1 日ずつ選べます。' }));
    dlgBody.appendChild(footer([resetWorkdaysButton()], [closeButton()]));
  }

  // ---- 初期化 ----

  function init(a) {
    api = a;
    host = a.host;
    dlg = a.dialog;
    dlgBody = a.dialog.querySelector('.dialog-body');
    document.addEventListener('keydown', onKey);
    dlg.addEventListener('close', onDialogClosed);
    // 編集画面を開いた直後は、指を離したあとに出るクリックが、画面の中のボタンや外側に当たらないようにする
    dlg.addEventListener('click', function (e) {
      if (Date.now() - openedAt < GHOST_MS) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
    // 外側（暗い部分）を押して閉じる。入力欄から外へドラッグして離したときは閉じない
    var downOnBackdrop = false;
    dlg.addEventListener('mousedown', function (e) { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener('click', function (e) {
      if (downOnBackdrop && e.target === dlg) closeDialog();
      downOnBackdrop = false;
    });
  }

  window.GanttEditor = {
    init: init,
    mount: mount,
    sync: sync,
    deselect: function () { closeInline(); closeDialog(); },
    addGroup: addGroupInteractive,
    extendPeriod: extendPeriod,
    shrinkPeriod: shrinkPeriod,
    hitTest: hitTest,
    current: function () { return cur; },
    selection: function () { return sel; }
  };
})();
