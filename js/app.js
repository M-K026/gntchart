/* 画面操作（チャートの表示、基本設定、ボタン、印刷）。チャートの上の編集は editor.js */
(function () {
  'use strict';

  var Dates = window.GanttDate;
  var Model = window.GanttModel;
  var Chart = window.GanttChart;
  var Editor = window.GanttEditor;

  // 色見本（鮮明な色）。上の段は濃い色、下の段は明るい色（マーカー向き。白黒で印刷しても、土日祝のグレーと見分けられる明るさにしてある）
  var PALETTE = [
    '#000000', '#808080', '#e60012', '#ff6a00', '#ffc400', '#00a650', '#0070ff', '#8e24ff',
    '#c8c8c8', '#ff6b6b', '#ffa94d', '#ffd600', '#69f0ae', '#40c4ff', '#ea80fc', '#ff80ab'
  ];

  var state = Model.loadFromStorage() || Model.createEmpty();
  var ui = { zoom: 1 };
  var ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]; // 1 = 用紙全体が画面に収まる大きさ
  var saveTimer = null;
  var noticeTimer = null;
  var saveWarned = false;
  var lastResult = null;
  var history = { undo: [], redo: [], lastKey: null, lastTime: 0 };
  var HISTORY_MAX = 80;

  function $(id) {
    return document.getElementById(id);
  }

  // 要素を作る（文字は textContent で入れるので、入力内容がそのまま HTML になることはない）
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

  // ---- メッセージ ----

  function hideNotice() {
    $('notice').hidden = true;
  }

  function notice(kind, lines) {
    lines = Array.isArray(lines) ? lines : [lines];
    var body = $('noticeBody');
    body.textContent = '';
    body.appendChild(h('div', { text: lines[0] }));
    if (lines.length > 1) {
      body.appendChild(h('ul', {}, lines.slice(1).map(function (l) { return h('li', { text: l }); })));
    }
    $('notice').className = 'notice ' + kind;
    $('notice').hidden = false;
    clearTimeout(noticeTimer);
    if (kind === 'ok') noticeTimer = setTimeout(hideNotice, 5000);
  }

  function showErrors(title, errors) {
    var shown = errors.slice(0, 8);
    if (errors.length > shown.length) shown.push('ほか ' + (errors.length - shown.length) + ' 件');
    notice('error', [title].concat(shown));
  }

  // ---- 自動保存 ----

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!Model.saveToStorage(state) && !saveWarned) {
      saveWarned = true;
      notice('error', 'このブラウザへの自動保存ができませんでした。「JSON保存」で保存してください。');
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
  }

  window.addEventListener('beforeunload', function () {
    if (saveTimer) flushSave();
  });

  // ---- チャート（画面表示と、PDF 出力用の用紙サイズ版）----

  function shortDate(d) {
    return d.slice(0, 4) + '/' + d.slice(5, 7) + '/' + d.slice(8, 10);
  }

  // チャートを表示できる高さ（px）。チャートの上端から画面の下端まで（下の余白のぶんを引く）
  function viewHeight() {
    var top = $('chartHost').getBoundingClientRect().top + window.pageYOffset;
    return Math.max(window.innerHeight - top - 20, 240);
  }

  // 用紙全体（A4/A3 横）が、チャートを表示する場所にちょうど収まる大きさ（1mm あたりの画素数）。幅と高さの小さいほうに合わせる。
  // 狭い画面（1024px 未満。ページ全体を縦にスクロールできる）は、幅だけに合わせる。
  function fitScale(S) {
    var availW = Math.max((($('chartHost').clientWidth || window.innerWidth - 16)) - 8, 120);
    var scale = availW / S.svgW;
    if (window.innerWidth >= 1024) scale = Math.min(scale, viewHeight() / S.svgH);
    return Math.floor(scale * 100) / 100;
  }

  function renderChart() {
    var today = Dates.today();

    // PDF: 用紙の印刷範囲いっぱい（印刷のときだけ表示する）
    var paper = Chart.render(state, { mode: 'paper', today: today, idPrefix: 'p-' });
    lastResult = paper;
    $('printHost').innerHTML = paper.svg;

    // 印刷の用紙設定（Chart.printCss）。余白 0 の @page と、用紙の高さに余裕を持たせた図の大きさ・
    // 用紙の幅が狭いときの縮み方は、そちらにまとめてある（Safari・iPad で 2 ページ目ができたり、枠がはみ出したりしないように）
    $('printStyle').textContent = Chart.printCss(paper.layout).css;

    $('zoomLabel').textContent = Math.round(ui.zoom * 100) + '%';
    $('zoomOut').disabled = ui.zoom <= ZOOMS[0];
    $('zoomIn').disabled = ui.zoom >= ZOOMS[ZOOMS.length - 1];

    // 注意の欄を先に出す（チャートの上端の位置が変わるので、画面に収まる大きさを測る前に）
    var box = $('warnings');
    box.textContent = '';
    if (paper.warnings.length) {
      box.appendChild(h('div', { text: 'PDF出力時の注意' }));
      box.appendChild(h('ul', {}, paper.warnings.map(function (w) { return h('li', { text: w }); })));
    }
    box.hidden = paper.warnings.length === 0;

    // 画面: PDF と同じ用紙（A4/A3 横）の大きさで組み、画面に収まる大きさ（拡大・縮小 100%）で見せる。
    // 行が少ないときは、画面だけの空の行で埋めて、備考が用紙の 3 分の 1 になる
    var screen = Chart.render(state, { mode: 'screen', today: today, idPrefix: 's-' });
    var S = screen.layout;
    Editor.mount(screen.svg, S, fitScale(S) * ui.zoom, state); // 文字は render() 内でエスケープ済み
    $('rangeInfo').textContent = shortDate(S.range.start) + ' 〜 ' + shortDate(S.range.end) + '（' + S.dayCount + '日）';
  }

  function zoomBy(dir) {
    var i = ZOOMS.indexOf(ui.zoom) + dir;
    if (i < 0 || i >= ZOOMS.length) return;
    ui.zoom = ZOOMS[i];
    renderChart();
  }

  // ---- 基本設定（ボタンで開くダイアログ）----

  function openSettings() {
    var dlg = $('settingsDialog');
    $('periodError').hidden = true;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function closeSettings() {
    var dlg = $('settingsDialog');
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  // チャートだけが変わる入力
  function chartChanged() {
    renderChart();
    scheduleSave();
  }

  function dataChanged() {
    renderChart();
    scheduleSave();
    Editor.sync();
    updateUndoButtons();
  }

  // ---- チャート上の編集（取り消し・やり直し）----

  function snapshot() {
    return Model.serialize(state);
  }

  function updateUndoButtons() {
    $('btnUndo').disabled = history.undo.length === 0;
    $('btnRedo').disabled = history.redo.length === 0;
  }

  function resetHistory() {
    history = { undo: [], redo: [], lastKey: null, lastTime: 0 };
    Editor.deselect();
  }

  // 基本設定の入力欄のうち、チャートの上でも変えられるもの（プロジェクト名・自由記入欄）を合わせる
  function syncSimpleFields() {
    [['projectName', state.projectName], ['freeText', state.freeText]].forEach(function (p) {
      var el = $(p[0]);
      if (document.activeElement !== el && el.value !== p[1]) el.value = p[1];
    });
  }

  // fn(state) でデータを書き換える。書き換える前の状態を取り消し用に残す。
  // key が同じ変更が続くとき（文字を打っているときなど）は、1 回の取り消しにまとめる。
  function commit(fn, opts) {
    opts = opts || {};
    var now = Date.now();
    var merge = opts.key && history.lastKey === opts.key && now - history.lastTime < 2000 && history.undo.length > 0;
    if (!merge) {
      history.undo.push(snapshot());
      if (history.undo.length > HISTORY_MAX) history.undo.shift();
      history.redo = [];
    }
    history.lastKey = opts.key || null;
    history.lastTime = now;
    var res = fn(state);
    syncSimpleFields();
    applyPeriodInputs();
    dataChanged();
    return res;
  }

  function restore(text) {
    var res = Model.parse(text);
    if (!res.ok) return;
    state = res.data;
    applyStateToForm();
    dataChanged();
  }

  function undo() {
    if (!history.undo.length) return;
    history.redo.push(snapshot());
    history.lastKey = null;
    restore(history.undo.pop());
  }

  function redo() {
    if (!history.redo.length) return;
    history.undo.push(snapshot());
    history.lastKey = null;
    restore(history.redo.pop());
  }

  // ---- 基本設定の入力欄 ----

  function applyStateToForm() {
    $('projectName').value = state.projectName;
    $('paper').value = state.settings.paper;
    $('paperQuick').value = state.settings.paper;
    $('freeText').value = state.freeText;
    applyPeriodInputs();
  }

  // 表示期間の入力欄を、データの内容に合わせる
  function applyPeriodInputs() {
    var s = state.settings;
    $('periodSpecify').checked = !!s.periodStart;
    $('periodStart').disabled = !s.periodStart;
    $('periodStart').value = s.periodStart || '';
    $('periodEndSpecify').checked = !!s.periodEnd;
    $('periodEnd').disabled = !s.periodEnd;
    $('periodEnd').value = s.periodEnd || '';
  }

  function applyPeriod() {
    var startOn = $('periodSpecify').checked;
    var endOn = $('periodEndSpecify').checked;
    var startIn = $('periodStart');
    var endIn = $('periodEnd');
    // 指定するにしたとき、入力欄が空なら、今表示している期間の日付を入れる
    var auto = Model.computeRange({ settings: { periodStart: null, periodEnd: null }, tasks: state.tasks, events: state.events }, Dates.today());
    if (startOn && !startIn.value) startIn.value = state.settings.periodStart || auto.start;
    if (endOn && !endIn.value) endIn.value = state.settings.periodEnd || auto.end;
    var start = startOn && Dates.isValid(startIn.value) ? startIn.value : null;
    var end = endOn && Dates.isValid(endIn.value) ? endIn.value : null;
    if (start && end && end < start) {
      $('periodError').textContent = '表示期間の終了日は、開始日以降にしてください。';
      $('periodError').hidden = false;
      applyPeriodInputs();
      return;
    }
    $('periodError').hidden = true;
    state.settings.periodStart = start;
    state.settings.periodEnd = end;
    applyPeriodInputs();
    dataChanged();
  }

  // ---- 新規・JSON の保存と読み込み ----

  function newChart() {
    if (!window.confirm('今の内容を破棄して、新しいチャートを作ります。\nJSON保存していない内容は失われます。よろしいですか？')) return;
    state = Model.createEmpty();
    resetHistory();
    applyStateToForm();
    dataChanged();
    flushSave();
    notice('ok', '新しいチャートを作成しました。');
  }

  function fileNameFor(name) {
    var base = (name || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim();
    return (base || 'ガントチャート') + '.json';
  }

  function downloadText(text, fileName) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: fileName });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function saveJson() {
    var text = Model.serialize(state);
    var fileName = fileNameFor(state.projectName);
    if (typeof window.showSaveFilePicker !== 'function') {
      downloadText(text, fileName);
      return notice('ok', 'ダウンロードフォルダに「' + fileName + '」を保存しました。');
    }
    window.showSaveFilePicker({
      suggestedName: fileName,
      types: [{ description: 'JSON ファイル', accept: { 'application/json': ['.json'] } }]
    }).then(function (handle) {
      return handle.createWritable().then(function (w) {
        return w.write(text).then(function () { return w.close(); });
      }).then(function () {
        notice('ok', '「' + handle.name + '」に保存しました。');
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return;
      downloadText(text, fileName);
      notice('ok', 'ダウンロードフォルダに「' + fileName + '」を保存しました。');
    });
  }

  function loadJsonFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var res = Model.parse(String(reader.result));
      if (!res.ok) return showErrors('「' + file.name + '」は読み込めませんでした。', res.errors);
      if (!window.confirm('今の内容が「' + file.name + '」の内容に置き換わります。よろしいですか？')) return;
      state = res.data;
      resetHistory();
      applyStateToForm();
      dataChanged();
      flushSave();
      notice('ok', '「' + file.name + '」を読み込みました。');
    };
    reader.onerror = function () {
      notice('error', '「' + file.name + '」を読み込めませんでした。');
    };
    reader.readAsText(file);
  }

  // ---- PDF 出力（ブラウザの印刷機能を使う）----

  function printPdf() {
    if (!lastResult || lastResult.layout.tooLong) return notice('error', 'チャートを出力できません。表示期間を確認してください。');
    var oldTitle = document.title;
    document.title = (state.projectName || 'ガントチャート').replace(/[\\/:*?"<>|\r\n]/g, '_');
    notice('ok', '印刷画面の「送信先」を「PDF に保存」にして、保存してください（用紙: ' + lastResult.layout.paper + ' 横）。ヘッダーとフッター（アドレスなど）は付きません。');
    var restoreTitle = function () { document.title = oldTitle; };
    window.addEventListener('afterprint', restoreTitle, { once: true });
    window.print();
  }

  // ---- 初期化 ----

  function init() {
    Editor.init({
      host: $('chartHost'),
      dialog: $('editDialog'),
      getState: function () { return state; },
      commit: commit,
      undo: undo,
      redo: redo,
      palette: PALETTE,
      notice: notice
    });

    // 基本設定
    $('btnSettings').addEventListener('click', openSettings);
    $('settingsClose').addEventListener('click', closeSettings);
    // 枠の外（暗い部分）を押して閉じる。入力欄から外へドラッグして離したときは閉じない
    var downOnBackdrop = false;
    $('settingsDialog').addEventListener('mousedown', function (e) { downOnBackdrop = e.target === e.currentTarget; });
    $('settingsDialog').addEventListener('click', function (e) {
      if (downOnBackdrop && e.target === e.currentTarget) closeSettings();
      downOnBackdrop = false;
    });
    $('projectName').addEventListener('input', function (e) { state.projectName = e.target.value; chartChanged(); });
    $('freeText').addEventListener('input', function (e) { state.freeText = e.target.value; chartChanged(); });
    // 用紙サイズ（A4/A3）。基本設定と、チャートの上の選択のどちらからでも変えられる
    function setPaper(e) {
      state.settings.paper = e.target.value;
      $('paper').value = state.settings.paper;
      $('paperQuick').value = state.settings.paper;
      chartChanged();
    }
    $('paper').addEventListener('change', setPaper);
    $('paperQuick').addEventListener('change', setPaper);
    $('periodSpecify').addEventListener('change', applyPeriod);
    $('periodStart').addEventListener('change', applyPeriod);
    $('periodEndSpecify').addEventListener('change', applyPeriod);
    $('periodEnd').addEventListener('change', applyPeriod);

    // チャートの上のボタン
    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);
    $('btnAddGroup').addEventListener('click', function () { Editor.addGroup(); });
    $('periodPrev').addEventListener('click', function () { Editor.extendPeriod(-1, 7); });
    $('periodNext').addEventListener('click', function () { Editor.extendPeriod(1, 7); });
    $('periodPrev1').addEventListener('click', function () { Editor.shrinkPeriod(-1, 1); });
    $('periodNext1').addEventListener('click', function () { Editor.shrinkPeriod(1, 1); });
    $('zoomOut').addEventListener('click', function () { zoomBy(-1); });
    $('zoomIn').addEventListener('click', function () { zoomBy(1); });
    var resizeTimer = null;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderChart, 150);
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    // 上のバー
    $('btnNew').addEventListener('click', newChart);
    $('btnSave').addEventListener('click', saveJson);
    $('btnLoad').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      loadJsonFile(e.target.files[0]);
      e.target.value = '';
    });
    $('btnPdf').addEventListener('click', printPdf);
    $('noticeClose').addEventListener('click', hideNotice);

    // ドラッグ＆ドロップで JSON を読み込む
    function hasFiles(e) {
      return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
    }
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      document.body.classList.add('dragging');
    });
    window.addEventListener('dragleave', function (e) {
      if (!e.relatedTarget) document.body.classList.remove('dragging');
    });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      document.body.classList.remove('dragging');
      loadJsonFile(e.dataTransfer.files[0]);
    });

    applyStateToForm();
    renderChart();
    updateUndoButtons();
  }

  init();
})();
