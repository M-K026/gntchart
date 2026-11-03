/*
 * チャート上の編集（行の追加・削除・移動、期間の変更など）。データ（state）を直接書き換える関数だけを集めた部品。
 * 画面のことは知らないので、Node でテストできる。取り消し（元に戻す）や自動保存は app.js が受け持つ。
 *
 * 行の考え方: 大分類の行 = その大分類のタスク（とマイルストーン）の数 + 空き行（extraRows）。画面に出ている行が、そのままデータの行。
 * タスクは、行の位置（row。0 始まり）を持つ。空きの行へも動かせる（1 行ずつ上下へ。大分類をまたがない）。
 * タスクを消すとその行はなくなり、下の行が詰まる（行の高さは全部同じ）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./dateutil'), require('./model'), require('./calendar'));
  } else {
    root.GanttEdits = factory(root.GanttDate, root.GanttModel, root.GanttCalendar);
  }
})(typeof self !== 'undefined' ? self : this, function (Dates, Model, Cal) {
  'use strict';

  var MIN_DATE = Dates.MIN_YEAR + '-01-01';
  var MAX_DATE = Dates.MAX_YEAR + '-12-31';
  var MAX_EXTRA = Model.MAX_EXTRA_ROWS;

  function clampDate(d) {
    if (d < MIN_DATE) return MIN_DATE;
    if (d > MAX_DATE) return MAX_DATE;
    return d;
  }

  // 表示期間（{start, end}）の、前（dir < 0）または後ろ（dir > 0）の days 日（初めは 1 日）を減らした期間。
  // 1 日より短くなるとき（開始日が終了日を超えるとき）は null。元の期間は変えない
  function shrinkRange(range, dir, days) {
    var d = days > 0 ? Math.floor(days) : 1;
    var start = range.start;
    var end = range.end;
    if (dir < 0) start = Dates.addDays(start, d);
    else end = Dates.addDays(end, -d);
    return end < start ? null : { start: clampDate(start), end: clampDate(end) };
  }

  function findTask(state, id) {
    return state.tasks.filter(function (t) { return t.id === id; })[0] || null;
  }

  function findGroup(state, id) {
    return state.groups.filter(function (g) { return g.id === id; })[0] || null;
  }

  function groupItems(state, gid) {
    return state.tasks.filter(function (t) { return t.groupId === gid; });
  }

  // 大分類の行数（チャートの描き方と同じ。空でも 1 行は見せる）
  function rowCount(state, gid) {
    var g = findGroup(state, gid);
    return Math.max(groupItems(state, gid).length + (g ? g.extraRows : 0), 1);
  }

  // 大分類の行ごとのタスク（空の行は null）。チャートに出ている並びと同じ
  function slots(state, gid) {
    return Model.slotLayout(groupItems(state, gid), rowCount(state, gid));
  }

  // その大分類のタスクすべてに、いまの行の位置（row）を持たせる（行を動かす前にそろえる）
  function materialize(state, gid) {
    slots(state, gid).forEach(function (t, i) { if (t) t.row = i; });
  }

  // タスクがいる行（0 始まり）。なければ -1
  function slotOf(state, id) {
    var t = findTask(state, id);
    return t ? slots(state, t.groupId).indexOf(t) : -1;
  }

  // ---- 大分類 ----

  var DEFAULT_GROUP_ROWS = Model.DEFAULT_GROUP_ROWS; // 最初の大分類の行数（空き行）
  var NEW_GROUP_ROWS = Model.NEW_GROUP_ROWS; // あとから足す大分類の行数（見た目の釣り合いを取る。いらない行は消せる）

  // 大分類を足す。名前は、決めなければ「グループ」＋番号
  function addGroup(state, name, extraRows) {
    var id = Model.nextId('g', state.groups);
    state.groups.push({
      id: id,
      name: name === undefined ? 'グループ' + (state.groups.length + 1) : name,
      extraRows: extraRows === undefined ? (state.groups.length ? NEW_GROUP_ROWS : DEFAULT_GROUP_ROWS) : extraRows
    });
    return id;
  }

  function renameGroup(state, id, name) {
    var g = findGroup(state, id);
    if (!g) return false;
    g.name = name;
    return true;
  }

  function deleteGroup(state, id) {
    if (!findGroup(state, id)) return false;
    state.groups = state.groups.filter(function (g) { return g.id !== id; });
    state.tasks = state.tasks.filter(function (t) { return t.groupId !== id; });
    return true;
  }

  function moveGroup(state, id, dir) {
    var i = state.groups.indexOf(findGroup(state, id));
    var j = i + dir;
    if (i < 0 || j < 0 || j >= state.groups.length) return false;
    var tmp = state.groups[i];
    state.groups[i] = state.groups[j];
    state.groups[j] = tmp;
    return true;
  }

  // 空き行を 1 行足す（一番下に足す）
  function addRow(state, gid) {
    var g = findGroup(state, gid);
    if (!g || g.extraRows >= MAX_EXTRA) return false;
    g.extraRows += 1;
    return true;
  }

  // 空き行を 1 行減らす（一番下の空きの行を消す。その下にタスクがあれば、1 行ずつ上がる）。
  // タスクの行は消さない（タスクの行は、タスクを削除する）。空きの行がなければ false
  function removeBlankRow(state, gid) {
    var g = findGroup(state, gid);
    if (!g || g.extraRows <= 0) return false;
    materialize(state, gid);
    var last = -1;
    slots(state, gid).forEach(function (t, i) { if (!t) last = i; });
    if (last < 0) return false;
    groupItems(state, gid).forEach(function (t) { if (t.row > last) t.row -= 1; });
    g.extraRows -= 1;
    return true;
  }

  // ---- タスク・マイルストーン ----

  // タスクを作る。row があれば、その空きの行へ（なければ、いちばん上の空きの行へ）。
  // 空き行があればそれを使うので、行の数は変わらない（空き行がなければ、一番下に行が増える）。
  // 「土日祝も稼働日」（includeRedDays）は、初めからオン（土日祝も選ばれている）。非稼働日にした日は dayOverrides。
  // 右の列の稼働日数（showWorkDays）は、初めは出さない。出すときの数は、初めは自動（workDaysManual が null）、単位は「日」
  function createTask(state, o) {
    var gid = o.groupId;
    if (!findGroup(state, gid)) return null;
    var start = clampDate(o.start);
    var end = clampDate(o.end || o.start);
    if (end < start) { var tmp = start; start = end; end = tmp; }
    var task = {
      id: Model.nextId('t', state.tasks), type: 'task', groupId: gid,
      name: o.name === undefined ? 'タスク' : o.name,
      start: start, end: end, showWorkDays: o.showWorkDays === undefined ? false : !!o.showWorkDays,
      workDaysManual: normalizeManual(o.workDaysManual), workDaysUnit: normalizeUnit(o.workDaysUnit),
      includeRedDays: o.includeRedDays === undefined ? true : !!o.includeRedDays,
      dayOverrides: o.dayOverrides ? JSON.parse(JSON.stringify(o.dayOverrides)) : {},
      arrowColor: o.arrowColor || '#000000', markerColor: o.markerColor || null, textColor: o.textColor || null
    };
    place(state, task, o.row);
    return task.id;
  }

  function createMilestone(state, o) {
    var gid = o.groupId;
    if (!findGroup(state, gid)) return null;
    var task = {
      id: Model.nextId('t', state.tasks), type: 'milestone', groupId: gid,
      name: o.name === undefined ? 'マイルストーン' : o.name,
      date: clampDate(o.date), diamondColor: o.diamondColor || '#000000', markerColor: o.markerColor || null, textColor: o.textColor || null
    };
    place(state, task, o.row);
    return task.id;
  }

  // 大分類にタスクを入れる。row が空いていればその行、そうでなければ、いちばん上の空きの行、なければ一番下に行を足す
  function place(state, task, row) {
    var gid = task.groupId;
    materialize(state, gid);
    var sl = slots(state, gid);
    var r = -1;
    if (typeof row === 'number' && Math.floor(row) === row && row >= 0 && row < sl.length && !sl[row]) r = row;
    else r = sl.indexOf(null);
    if (r < 0) r = sl.length;
    task.row = r;
    state.tasks.push(task);
    var g = findGroup(state, gid);
    if (g && g.extraRows > 0) g.extraRows -= 1; // 空き行を使う（行の数は変わらない）
  }

  function deleteTask(state, id) {
    var t = findTask(state, id);
    if (!t) return false;
    var gid = t.groupId;
    materialize(state, gid);
    var r = t.row;
    state.tasks.splice(state.tasks.indexOf(t), 1);
    groupItems(state, gid).forEach(function (x) { if (x.row > r) x.row -= 1; }); // 下の行が詰まる
    return true;
  }

  function setName(state, id, name) {
    var t = findTask(state, id);
    if (!t) return false;
    t.name = name;
    return true;
  }

  // 矢印の色（タスク）・◆の色（マイルストーン）
  function setShapeColor(state, id, color) {
    var t = findTask(state, id);
    if (!t) return false;
    if (t.type === 'milestone') t.diamondColor = color || '#000000';
    else t.arrowColor = color || '#000000';
    return true;
  }

  function setMarkerColor(state, id, color) {
    var t = findTask(state, id);
    if (!t) return false;
    t.markerColor = color || null;
    return true;
  }

  // 名前（矢印の上・◆の上の文字）の色。null は標準（黒）
  function setTextColor(state, id, color) {
    var t = findTask(state, id);
    if (!t) return false;
    t.textColor = color || null;
    return true;
  }

  // 手入力の稼働日数: 0 以上の数（小数 2 桁まで）。それ以外（空・文字・負の数）は null（自動）
  function normalizeManual(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    var n = Number(v);
    if (!isFinite(n) || n < 0 || n > Model.MAX_DAYS_VALUE) return null;
    return Math.round(n * 100) / 100;
  }

  // 単位: 改行などを除いて、上限の文字数まで。指定がなければ「日」（空の文字は、単位なし）
  function normalizeUnit(u) {
    if (u === undefined || u === null) return Model.DEFAULT_DAYS_UNIT;
    return String(u).replace(/[\r\n\t]/g, '').slice(0, Model.MAX_UNIT_LENGTH);
  }

  // 稼働日数を手入力にする（数）／自動に戻す（null）。数でないもの・負の数は自動に戻す。入れた値（null なら自動）を返す。タスクでなければ undefined
  function setWorkDaysManual(state, id, value) {
    var t = findTask(state, id);
    if (!t || t.type !== 'task') return undefined;
    t.workDaysManual = normalizeManual(value);
    return t.workDaysManual;
  }

  // 稼働日数の単位（日・人日・h など）
  function setWorkDaysUnit(state, id, unit) {
    var t = findTask(state, id);
    if (!t || t.type !== 'task') return false;
    t.workDaysUnit = normalizeUnit(unit);
    return true;
  }

  // 最近使った色の一覧に、色を足す（先頭が最新。同じ色は 1 つにして先頭へ。上限まで）。新しい一覧を返す（元の一覧は変えない）
  function pushRecentColor(list, color, max) {
    var c = String(color || '').toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(c)) return (list || []).slice();
    var out = [c];
    (list || []).forEach(function (x) {
      var y = String(x || '').toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(y) && out.indexOf(y) < 0) out.push(y);
    });
    return out.slice(0, max || 6);
  }

  // 右の列に「（N日）」の稼働日数を出すか（N は、初めは期間の稼働日を数えた自動の値。手入力もできる）
  function setShowWorkDays(state, id, show) {
    var t = findTask(state, id);
    if (!t || t.type !== 'task') return false;
    t.showWorkDays = !!show;
    return true;
  }

  // 稼働日数の表示を切り替える。切り替えたあとの値を返す（タスクでなければ null）
  function toggleShowWorkDays(state, id) {
    var t = findTask(state, id);
    if (!t || t.type !== 'task') return null;
    t.showWorkDays = !t.showWorkDays;
    return t.showWorkDays;
  }

  // 期間を変える（マイルストーンは start が日付）。開始が期日より後なら入れ替える。
  function setDates(state, id, start, end) {
    var t = findTask(state, id);
    if (!t) return false;
    var s = clampDate(start);
    if (t.type === 'milestone') {
      t.date = s;
      return true;
    }
    var e = clampDate(end === undefined ? t.end : end);
    if (e < s) { var tmp = s; s = e; e = tmp; }
    t.start = s;
    t.end = e;
    return true;
  }

  // タスク ⇄ マイルストーン（行の位置は変わらない）
  function convertType(state, id) {
    var t = findTask(state, id);
    if (!t) return false;
    var i = state.tasks.indexOf(t);
    var base = { id: t.id, groupId: t.groupId, name: t.name, markerColor: t.markerColor, textColor: t.textColor || null };
    if (t.row !== undefined) base.row = t.row;
    if (t.type === 'task') {
      base.type = 'milestone';
      base.date = t.start;
      base.diamondColor = t.arrowColor;
    } else {
      base.type = 'task';
      base.start = t.date;
      base.end = t.date;
      base.showWorkDays = false;
      base.workDaysManual = null;
      base.workDaysUnit = Model.DEFAULT_DAYS_UNIT;
      base.includeRedDays = true;
      base.dayOverrides = {};
      base.arrowColor = t.diamondColor;
    }
    state.tasks[i] = base;
    return true;
  }

  // 1 行上（dir=-1）・下（dir=+1）へ。となりの行が空いていればそこへ、タスクがいれば入れ替える。
  // 大分類をまたいでは動かない（大分類の一番上・一番下では動かない）
  function canStep(state, id, dir) {
    var t = findTask(state, id);
    if (!t) return false;
    var r = slotOf(state, id) + dir;
    return r >= 0 && r < rowCount(state, t.groupId);
  }

  function stepTask(state, id, dir) {
    if (!canStep(state, id, dir)) return false;
    var t = findTask(state, id);
    materialize(state, t.groupId);
    var sl = slots(state, t.groupId);
    var from = t.row;
    var to = from + dir;
    if (sl[to]) sl[to].row = from;
    t.row = to;
    return true;
  }

  // ---- タスクごとの稼働日・非稼働日 ----

  // そのタスクの 1 日を、稼働日（working=true）・非稼働日（false）にする。マイルストーンにはない
  function setTaskDay(state, id, date, working) {
    var t = findTask(state, id);
    if (!t || t.type !== 'task' || !Dates.isValid(date)) return false;
    t.dayOverrides = Cal.setTaskDay(t, date, working, state.workdayOverrides);
    return true;
  }

  // そのタスクで、土日祝も稼働日にするか（オンなら、土日祝も選ばれる）。日ごとの上書きは、そのまま残す
  function setIncludeRedDays(state, id, include) {
    var t = findTask(state, id);
    if (!t || t.type !== 'task') return false;
    t.includeRedDays = !!include;
    t.dayOverrides = Cal.normalizeTaskDays(t, state.workdayOverrides);
    return true;
  }

  // ---- 行事予定 ----

  function addEvent(state, o) {
    var start = clampDate(o.start);
    var end = clampDate(o.end || o.start);
    if (end < start) { var tmp = start; start = end; end = tmp; }
    state.events.push({
      start: start, end: end, text: o.text === undefined ? '予定' : o.text,
      textColor: o.textColor || null, markerColor: o.markerColor || null
    });
    return state.events.length - 1;
  }

  function updateEvent(state, index, patch) {
    var e = state.events[index];
    if (!e) return false;
    if (patch.text !== undefined) e.text = patch.text;
    if (patch.textColor !== undefined) e.textColor = patch.textColor || null;
    if (patch.markerColor !== undefined) e.markerColor = patch.markerColor || null;
    var s = patch.start !== undefined ? clampDate(patch.start) : e.start;
    var en = patch.end !== undefined ? clampDate(patch.end) : e.end;
    if (en < s) { var tmp = s; s = en; en = tmp; }
    e.start = s;
    e.end = en;
    return true;
  }

  function deleteEvent(state, index) {
    if (!state.events[index]) return false;
    state.events.splice(index, 1);
    return true;
  }

  // ---- 非稼働日（土日祝は、初めから非稼働日。ここでは、それ以外の日を非稼働日にしたり、土日祝を稼働日に戻したりする）----

  // 1 日だけ。working=false で非稼働日、true で稼働日
  function setWorkday(state, date, working) {
    if (!Dates.isValid(date)) return false;
    state.workdayOverrides = Cal.setWorkday(state.workdayOverrides, date, working);
    return true;
  }

  // 月（ym = YYYY-MM）の中の、その曜日（0=日〜6=土）をすべて
  function setWeekdayInMonth(state, ym, weekday, working) {
    if (!/^\d{4}-\d{2}$/.test(ym) || !(weekday >= 0 && weekday <= 6)) return false;
    state.workdayOverrides = Cal.setWeekdayInMonth(state.workdayOverrides, ym, weekday, working);
    return true;
  }

  // 非稼働日の選択をすべて初期値（土日祝だけが非稼働日）に戻す
  function resetWorkdays(state) {
    state.workdayOverrides = {};
    return true;
  }

  return {
    NEW_GROUP_ROWS: NEW_GROUP_ROWS,
    DEFAULT_GROUP_ROWS: DEFAULT_GROUP_ROWS,
    MIN_DATE: MIN_DATE,
    MAX_DATE: MAX_DATE,
    clampDate: clampDate,
    shrinkRange: shrinkRange,
    findTask: findTask,
    findGroup: findGroup,
    groupItems: groupItems,
    rowCount: rowCount,
    slots: slots,
    slotOf: slotOf,
    addGroup: addGroup,
    renameGroup: renameGroup,
    deleteGroup: deleteGroup,
    moveGroup: moveGroup,
    addRow: addRow,
    removeBlankRow: removeBlankRow,
    createTask: createTask,
    createMilestone: createMilestone,
    deleteTask: deleteTask,
    setName: setName,
    setShapeColor: setShapeColor,
    setMarkerColor: setMarkerColor,
    setTextColor: setTextColor,
    setWorkDaysManual: setWorkDaysManual,
    setWorkDaysUnit: setWorkDaysUnit,
    pushRecentColor: pushRecentColor,
    setShowWorkDays: setShowWorkDays,
    toggleShowWorkDays: toggleShowWorkDays,
    setWorkday: setWorkday,
    setWeekdayInMonth: setWeekdayInMonth,
    resetWorkdays: resetWorkdays,
    setDates: setDates,
    convertType: convertType,
    canStep: canStep,
    stepTask: stepTask,
    setTaskDay: setTaskDay,
    setIncludeRedDays: setIncludeRedDays,
    addEvent: addEvent,
    updateEvent: updateEvent,
    deleteEvent: deleteEvent
  };
});
