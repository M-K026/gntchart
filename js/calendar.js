/* 稼働日の判定（土日・祝日・個別の上書き）と、矢印を稼働日ごとに分ける処理 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./dateutil'), require('./holidays'));
  } else {
    root.GanttCalendar = factory(root.GanttDate, root.GanttHolidays);
  }
})(typeof self !== 'undefined' ? self : this, function (Dates, Holidays) {
  'use strict';

  function has(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  // 土日祝か（列をグレーにし、日付を赤字にする日）
  function isRedDay(date) {
    var w = Dates.weekday(date);
    return w === 0 || w === 6 || Holidays.holidayName(date) !== null;
  }

  // 初期値（上書きなし）での稼働日
  function defaultWorkday(date) {
    return !isRedDay(date);
  }

  function isWorkday(date, overrides) {
    if (has(overrides, date)) return !!overrides[date];
    return defaultWorkday(date);
  }

  // start〜end を稼働日の連続ごとに分ける。非稼働日は含めない。
  function splitSegments(start, end, overrides) {
    var segs = [];
    var cur = null;
    for (var d = start; d <= end; d = Dates.addDays(d, 1)) {
      if (isWorkday(d, overrides)) {
        if (cur) {
          cur.end = d;
        } else {
          cur = { start: d, end: d };
          segs.push(cur);
        }
      } else {
        cur = null;
      }
    }
    return segs;
  }

  // 指定した日の稼働⇄非稼働を切り替えた新しい overrides を返す（初期値と同じになったら項目を消す）
  function toggleOverride(overrides, date) {
    var next = {};
    Object.keys(overrides || {}).forEach(function (k) { next[k] = overrides[k]; });
    var want = !isWorkday(date, overrides);
    if (want === defaultWorkday(date)) delete next[date];
    else next[date] = want;
    return next;
  }

  // ---- タスクごとの稼働日 ----
  // タスクの day が稼働日か。順番は、(1) そのタスクの日ごとの上書き（task.dayOverrides）、
  // (2) そのタスクが「土日祝も稼働日」（task.includeRedDays）なら、土日祝は稼働日、(3) それ以外は、全体の決まり（土日祝が非稼働日。全体の上書き）
  function taskBaseWorkday(task, date, overrides) {
    if (task && task.includeRedDays && isRedDay(date)) return true;
    return isWorkday(date, overrides);
  }

  function isTaskWorkday(task, date, overrides) {
    if (task && has(task.dayOverrides, date)) return !!task.dayOverrides[date];
    return taskBaseWorkday(task, date, overrides);
  }

  // start〜end を、そのタスクの稼働日の連続ごとに分ける（非稼働日は含めない）
  function splitTaskSegments(task, start, end, overrides) {
    var segs = [];
    var cur = null;
    for (var d = start; d <= end; d = Dates.addDays(d, 1)) {
      if (isTaskWorkday(task, d, overrides)) {
        if (cur) cur.end = d;
        else {
          cur = { start: d, end: d };
          segs.push(cur);
        }
      } else {
        cur = null;
      }
    }
    return segs;
  }

  // タスクの期間（start〜end）の稼働日の日数
  function countTaskWorkdays(task, overrides) {
    var n = 0;
    for (var d = task.start; d <= task.end; d = Dates.addDays(d, 1)) {
      if (isTaskWorkday(task, d, overrides)) n++;
    }
    return n;
  }

  // 数を、小数 2 桁までの文字にする（5 → "5"、2.5 → "2.5"、1.234 → "1.23"）
  function formatNumber(v) {
    return String(Math.round(v * 100) / 100);
  }

  // 右の列に出す稼働日数。手入力（workDaysManual）があればそれ、なければ期間の稼働日を数えた値（自動）。
  // 単位は workDaysUnit（なければ「日」）。{ value, text（例 "5日"）, manual } を返す
  function taskDays(task, overrides) {
    var manual = task && typeof task.workDaysManual === 'number' ? task.workDaysManual : null;
    var value = manual !== null ? manual : countTaskWorkdays(task, overrides);
    var unit = task && typeof task.workDaysUnit === 'string' ? task.workDaysUnit : '日';
    return { value: value, text: formatNumber(value) + unit, manual: manual !== null };
  }

  // そのタスクの day を、稼働日（working=true）・非稼働日（false）にした、新しい dayOverrides を返す（上書きなしと同じになったら項目を消す）
  function setTaskDay(task, date, working, overrides) {
    var next = {};
    Object.keys((task && task.dayOverrides) || {}).forEach(function (k) { next[k] = task.dayOverrides[k]; });
    if (!!working === taskBaseWorkday(task, date, overrides)) delete next[date];
    else next[date] = !!working;
    return next;
  }

  // 「土日祝も稼働日」を切り替えたあとで、上書きなしと同じになった項目を消した dayOverrides を返す
  function normalizeTaskDays(task, overrides) {
    var next = {};
    Object.keys((task && task.dayOverrides) || {}).forEach(function (k) {
      if (task.dayOverrides[k] !== taskBaseWorkday(task, k, overrides)) next[k] = task.dayOverrides[k];
    });
    return next;
  }

  // start〜end の稼働日の日数（土日祝と、非稼働日に選んだ日は数えない。稼働日に戻した土日祝は数える）
  function countWorkdays(start, end, overrides) {
    var n = 0;
    for (var d = start; d <= end; d = Dates.addDays(d, 1)) {
      if (isWorkday(d, overrides)) n++;
    }
    return n;
  }

  // 日の稼働／非稼働を指定した新しい overrides を返す（初期値と同じになったら項目を消す）
  function setWorkday(overrides, date, working) {
    var next = {};
    Object.keys(overrides || {}).forEach(function (k) { next[k] = overrides[k]; });
    if (working === defaultWorkday(date)) delete next[date];
    else next[date] = !!working;
    return next;
  }

  // ym（YYYY-MM）の月の、指定した曜日（0=日〜6=土）の日付の一覧
  function weekdayDatesInMonth(ym, weekday) {
    var y = +ym.slice(0, 4);
    var m = +ym.slice(5, 7);
    var out = [];
    for (var day = 1; day <= 31; day++) {
      var date = Dates.make(y, m, day);
      if (!Dates.isValid(date)) break; // その月にない日（2/30、4/31 など）は数えない
      if (Dates.weekday(date) === weekday) out.push(date);
    }
    return out;
  }

  // 月の中のその曜日が、すべて非稼働日か
  function isWeekdayAllOff(ym, weekday, overrides) {
    var list = weekdayDatesInMonth(ym, weekday);
    return list.length > 0 && list.every(function (d) { return !isWorkday(d, overrides); });
  }

  // 月の中のその曜日を、まとめて非稼働日（working=false）／稼働日（true）にした新しい overrides を返す
  function setWeekdayInMonth(overrides, ym, weekday, working) {
    var next = overrides;
    weekdayDatesInMonth(ym, weekday).forEach(function (d) { next = setWorkday(next, d, working); });
    return next;
  }

  // start〜end を月ごとに分ける
  function eachMonth(start, end) {
    var months = [];
    var total = Dates.diffDays(start, end) + 1;
    var cur = null;
    for (var i = 0; i < total; i++) {
      var d = Dates.addDays(start, i);
      var ym = d.slice(0, 7);
      if (!cur || cur.ym !== ym) {
        cur = { ym: ym, year: +d.slice(0, 4), month: +d.slice(5, 7), start: d, end: d, startIndex: i, count: 0 };
        months.push(cur);
      }
      cur.end = d;
      cur.count++;
    }
    return months;
  }

  return {
    isRedDay: isRedDay,
    defaultWorkday: defaultWorkday,
    isWorkday: isWorkday,
    splitSegments: splitSegments,
    toggleOverride: toggleOverride,
    countWorkdays: countWorkdays,
    isTaskWorkday: isTaskWorkday,
    splitTaskSegments: splitTaskSegments,
    countTaskWorkdays: countTaskWorkdays,
    formatNumber: formatNumber,
    taskDays: taskDays,
    setTaskDay: setTaskDay,
    normalizeTaskDays: normalizeTaskDays,
    setWorkday: setWorkday,
    weekdayDatesInMonth: weekdayDatesInMonth,
    isWeekdayAllOff: isWeekdayAllOff,
    setWeekdayInMonth: setWeekdayInMonth,
    eachMonth: eachMonth
  };
});
