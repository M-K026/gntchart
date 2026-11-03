/* データ構造、JSON の書き出し・読み込み・検証、ブラウザへの自動保存 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./dateutil'));
  } else {
    root.GanttModel = factory(root.GanttDate);
  }
})(typeof self !== 'undefined' ? self : this, function (Dates) {
  'use strict';

  var VERSION = 1;
  var STORAGE_KEY = 'ganttPdf.chart.v1';
  var PAPERS = ['A4', 'A3'];
  var HEX = /^#[0-9a-fA-F]{6}$/;
  var MAX_EXTRA_ROWS = 50;
  // 大分類の空き行の初期値。最初の大分類（まだ 1 つもないときの空の欄も同じ）と、あとから足す大分類
  var DEFAULT_GROUP_ROWS = 10;
  var NEW_GROUP_ROWS = 5;
  var DEFAULT_DAYS_UNIT = '日'; // 稼働日数の単位の初期値
  var MAX_UNIT_LENGTH = 8; // 単位の文字数の上限
  var MAX_DAYS_VALUE = 99999; // 手入力できる稼働日数の上限

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function createEmpty() {
    return {
      version: VERSION,
      projectName: '',
      settings: { paper: 'A4', periodStart: null, periodEnd: null },
      freeText: '',
      groups: [],
      tasks: [],
      events: [],
      workdayOverrides: {},
      remarks: ''
    };
  }

  // 次に使える ID（prefix + 連番）
  function nextId(prefix, list) {
    var max = 0;
    var re = new RegExp('^' + prefix + '(\\d+)$');
    list.forEach(function (x) {
      var m = re.exec(x.id);
      if (m) max = Math.max(max, +m[1]);
    });
    return prefix + (max + 1);
  }

  // 大分類の行（count 行）に、タスクを並べる。row（0 始まりの行の位置）を持つタスクはその行へ入る。
  // row を持たないタスク（古い JSON）や、行がかぶったタスク・行の数を超えたタスクは、空いている行の先頭から順に入る。
  // 返すのは、行ごとのタスク（空の行は null）の配列。
  function slotLayout(items, count) {
    var slots = [];
    var i;
    for (i = 0; i < count; i++) slots.push(null);
    var rest = [];
    items.forEach(function (t) {
      var r = t.row;
      if (typeof r === 'number' && Math.floor(r) === r && r >= 0 && r < count && !slots[r]) slots[r] = t;
      else rest.push(t);
    });
    var k = 0;
    rest.forEach(function (t) {
      while (k < count && slots[k]) k++;
      if (k < count) slots[k] = t;
    });
    return slots;
  }

  function isIntInRange(v, min, max) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= min && v <= max;
  }

  // 入力を検証し、既知の項目だけを持つ新しいデータにして返す
  function validate(input) {
    var errors = [];
    if (!isObj(input)) return { ok: false, errors: ['JSON の最上位がオブジェクトではありません。'] };

    var data = createEmpty();

    if (input.version !== VERSION) errors.push('version が ' + VERSION + ' ではありません（この形式は読み込めません）。');

    if (input.projectName !== undefined) {
      if (typeof input.projectName === 'string') data.projectName = input.projectName;
      else errors.push('projectName は文字列で指定してください。');
    }
    if (input.freeText !== undefined) {
      if (typeof input.freeText === 'string') data.freeText = input.freeText;
      else errors.push('freeText は文字列で指定してください。');
    }
    if (input.remarks !== undefined) {
      if (typeof input.remarks === 'string') data.remarks = input.remarks;
      else errors.push('remarks は文字列で指定してください。');
    }

    if (input.settings !== undefined) {
      if (!isObj(input.settings)) {
        errors.push('settings はオブジェクトで指定してください。');
      } else {
        var s = input.settings;
        if (s.paper !== undefined) {
          if (PAPERS.indexOf(s.paper) >= 0) data.settings.paper = s.paper;
          else errors.push('settings.paper は "A4" か "A3" で指定してください。');
        }
        if (s.periodStart !== undefined && s.periodStart !== null) {
          if (Dates.isValid(s.periodStart)) data.settings.periodStart = s.periodStart;
          else errors.push('settings.periodStart が日付（YYYY-MM-DD）ではありません。');
        }
        if (s.periodEnd !== undefined && s.periodEnd !== null) {
          if (Dates.isValid(s.periodEnd)) data.settings.periodEnd = s.periodEnd;
          else errors.push('settings.periodEnd が日付（YYYY-MM-DD）ではありません。');
        }
        if (data.settings.periodStart && data.settings.periodEnd && data.settings.periodEnd < data.settings.periodStart) {
          errors.push('settings.periodEnd が periodStart より前です。');
        }
      }
    }

    var groupIds = {};
    if (!Array.isArray(input.groups)) {
      errors.push('groups は配列で指定してください。');
    } else {
      input.groups.forEach(function (g, i) {
        var at = 'groups[' + i + ']: ';
        if (!isObj(g)) { errors.push(at + 'オブジェクトではありません。'); return; }
        if (typeof g.id !== 'string' || g.id === '') { errors.push(at + 'id がありません。'); return; }
        if (groupIds[g.id]) { errors.push(at + 'id「' + g.id + '」が重複しています。'); return; }
        if (typeof g.name !== 'string') { errors.push(at + 'name は文字列で指定してください。'); return; }
        var extra = g.extraRows === undefined ? 0 : g.extraRows;
        if (!isIntInRange(extra, 0, MAX_EXTRA_ROWS)) { errors.push(at + 'extraRows は 0〜' + MAX_EXTRA_ROWS + ' の整数で指定してください。'); return; }
        groupIds[g.id] = true;
        data.groups.push({ id: g.id, name: g.name, extraRows: extra });
      });
    }

    var taskIds = {};
    if (!Array.isArray(input.tasks)) {
      errors.push('tasks は配列で指定してください。');
    } else {
      input.tasks.forEach(function (t, i) {
        var at = 'tasks[' + i + ']: ';
        if (!isObj(t)) { errors.push(at + 'オブジェクトではありません。'); return; }
        if (typeof t.id !== 'string' || t.id === '') { errors.push(at + 'id がありません。'); return; }
        if (taskIds[t.id]) { errors.push(at + 'id「' + t.id + '」が重複しています。'); return; }
        if (t.type !== 'task' && t.type !== 'milestone') { errors.push(at + 'type は "task" か "milestone" で指定してください。'); return; }
        if (!groupIds[t.groupId]) { errors.push(at + 'groupId「' + t.groupId + '」に対応する大分類がありません。'); return; }
        if (typeof t.name !== 'string') { errors.push(at + 'name は文字列で指定してください。'); return; }
        // 矢印の色はタスク、◆の色はマイルストーンの項目（別々に持つ）。古い JSON のマイルストーンは arrowColor を◆の色として読む
        var colorName = t.type === 'milestone' ? 'diamondColor' : 'arrowColor';
        var colorKey = colorName === 'diamondColor' && t.diamondColor === undefined && t.arrowColor !== undefined ? 'arrowColor' : colorName;
        var shape = t[colorKey] === undefined ? '#000000' : t[colorKey];
        if (typeof shape !== 'string' || !HEX.test(shape)) { errors.push(at + colorKey + ' は #rrggbb の形式で指定してください。'); return; }
        var marker = t.markerColor === undefined ? null : t.markerColor;
        if (marker !== null && (typeof marker !== 'string' || !HEX.test(marker))) { errors.push(at + 'markerColor は #rrggbb の形式か null で指定してください。'); return; }
        // 名前の文字の色。null は「標準（黒）」。古い JSON にはない
        var textColor = t.textColor === undefined ? null : t.textColor;
        if (textColor !== null && (typeof textColor !== 'string' || !HEX.test(textColor))) { errors.push(at + 'textColor は #rrggbb の形式か null で指定してください。'); return; }

        var item = { id: t.id, type: t.type, groupId: t.groupId, name: t.name };
        item[colorName] = shape;
        item.markerColor = marker;
        item.textColor = textColor;
        // 大分類の中の行の位置（0 始まり）。なければ、空いている行の先頭から順に入る（古い JSON）
        if (t.row !== undefined) {
          if (!isIntInRange(t.row, 0, 9999)) { errors.push(at + 'row は 0 以上の整数で指定してください。'); return; }
          item.row = t.row;
        }
        if (t.type === 'milestone') {
          if (!Dates.isValid(t.date)) { errors.push(at + 'date が日付（YYYY-MM-DD）ではありません。'); return; }
          item.date = t.date;
        } else {
          if (!Dates.isValid(t.start) || !Dates.isValid(t.end)) { errors.push(at + 'start / end が日付（YYYY-MM-DD）ではありません。'); return; }
          if (t.start > t.end) { errors.push(at + 'end が start より前です。'); return; }
          // 稼働日数は、初めは自動で数える。右の列に「（N日）」を出すか（showWorkDays。初期値は出さない）、
          // 手入力した数（workDaysManual。null なら自動）と単位（workDaysUnit。初期値は「日」）を持つ。
          // 古い JSON の workDays（手入力の数）は、数が入っていれば「出す」、null なら「出さない」として読む
          var show = false;
          if (t.showWorkDays !== undefined) {
            if (typeof t.showWorkDays !== 'boolean') { errors.push(at + 'showWorkDays は true か false で指定してください。'); return; }
            show = t.showWorkDays;
          } else if (t.workDays !== undefined) {
            if (t.workDays !== null && !isIntInRange(t.workDays, 0, 9999)) { errors.push(at + 'workDays は 0 以上の整数か null で指定してください。'); return; }
            show = t.workDays !== null;
          }
          // このタスクの稼働日・非稼働日。includeRedDays が true なら、土日祝も稼働日（矢印がつながり、稼働日数に数える）。
          // dayOverrides は、日ごとの上書き（true=稼働日、false=非稼働日）。古い JSON（どちらもない）は、土日祝が非稼働日のまま
          var include = false;
          if (t.includeRedDays !== undefined) {
            if (typeof t.includeRedDays !== 'boolean') { errors.push(at + 'includeRedDays は true か false で指定してください。'); return; }
            include = t.includeRedDays;
          }
          var overridesOfTask = {};
          if (t.dayOverrides !== undefined) {
            if (!isObj(t.dayOverrides)) { errors.push(at + 'dayOverrides はオブジェクトで指定してください。'); return; }
            var badKey = Object.keys(t.dayOverrides).some(function (k) {
              if (!Dates.isValid(k) || typeof t.dayOverrides[k] !== 'boolean') return true;
              overridesOfTask[k] = t.dayOverrides[k];
              return false;
            });
            if (badKey) { errors.push(at + 'dayOverrides は 日付（YYYY-MM-DD）をキーに、true か false を指定してください。'); return; }
          }
          var manual = t.workDaysManual === undefined ? null : t.workDaysManual;
          if (manual !== null && !(typeof manual === 'number' && isFinite(manual) && manual >= 0 && manual <= MAX_DAYS_VALUE)) {
            errors.push(at + 'workDaysManual は 0〜' + MAX_DAYS_VALUE + ' の数か null で指定してください。'); return;
          }
          var unit = t.workDaysUnit === undefined ? DEFAULT_DAYS_UNIT : t.workDaysUnit;
          if (typeof unit !== 'string' || unit.length > MAX_UNIT_LENGTH || /[\r\n\t]/.test(unit)) {
            errors.push(at + 'workDaysUnit は ' + MAX_UNIT_LENGTH + ' 文字までの文字列で指定してください。'); return;
          }
          item.start = t.start;
          item.end = t.end;
          item.showWorkDays = show;
          item.workDaysManual = manual === null ? null : Math.round(manual * 100) / 100;
          item.workDaysUnit = unit;
          item.includeRedDays = include;
          item.dayOverrides = overridesOfTask;
        }
        taskIds[t.id] = true;
        data.tasks.push(item);
      });
    }

    if (input.events !== undefined) {
      if (!Array.isArray(input.events)) {
        errors.push('events は配列で指定してください。');
      } else {
        input.events.forEach(function (e, i) {
          var at = 'events[' + i + ']: ';
          if (!isObj(e)) { errors.push(at + 'オブジェクトではありません。'); return; }
          if (!Dates.isValid(e.start) || !Dates.isValid(e.end)) { errors.push(at + 'start / end が日付（YYYY-MM-DD）ではありません。'); return; }
          if (e.start > e.end) { errors.push(at + 'end が start より前です。'); return; }
          if (typeof e.text !== 'string') { errors.push(at + 'text は文字列で指定してください。'); return; }
          // 文字の色（textColor）とマーカーの色（markerColor）。null は「初期値」（文字は黒、マーカーは色なし）
          var textColor = e.textColor === undefined ? null : e.textColor;
          if (textColor !== null && (typeof textColor !== 'string' || !HEX.test(textColor))) { errors.push(at + 'textColor は #rrggbb の形式か null で指定してください。'); return; }
          var evMarker = e.markerColor === undefined ? null : e.markerColor;
          if (evMarker !== null && (typeof evMarker !== 'string' || !HEX.test(evMarker))) { errors.push(at + 'markerColor は #rrggbb の形式か null で指定してください。'); return; }
          data.events.push({ start: e.start, end: e.end, text: e.text, textColor: textColor, markerColor: evMarker });
        });
      }
    }

    if (input.workdayOverrides !== undefined) {
      if (!isObj(input.workdayOverrides)) {
        errors.push('workdayOverrides はオブジェクトで指定してください。');
      } else {
        Object.keys(input.workdayOverrides).forEach(function (k) {
          var v = input.workdayOverrides[k];
          if (!Dates.isValid(k)) errors.push('workdayOverrides のキー「' + k + '」が日付（YYYY-MM-DD）ではありません。');
          else if (typeof v !== 'boolean') errors.push('workdayOverrides["' + k + '"] は true か false で指定してください。');
          else data.workdayOverrides[k] = v;
        });
      }
    }

    return errors.length ? { ok: false, errors: errors } : { ok: true, data: data };
  }

  function serialize(state) {
    var res = validate(state);
    return JSON.stringify(res.ok ? res.data : state, null, 2);
  }

  function parse(text) {
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      return { ok: false, errors: ['JSON として読み込めません（' + e.message + '）。'] };
    }
    return validate(obj);
  }

  // 表示する期間。開始日・終了日は、指定があればそれ、なければ予定（タスク・マイルストーン・行事予定）の最も早い日・最も遅い日。
  function computeRange(state, today) {
    var min = null;
    var max = null;
    function see(d) {
      if (!d) return;
      if (min === null || d < min) min = d;
      if (max === null || d > max) max = d;
    }
    state.tasks.forEach(function (t) {
      if (t.type === 'milestone') {
        see(t.date);
      } else {
        see(t.start);
        see(t.end);
      }
    });
    state.events.forEach(function (e) { see(e.start); see(e.end); });

    var settings = state.settings || {};
    var start = settings.periodStart || min || today || Dates.today();
    var end = settings.periodEnd || max;
    if (!end) end = Dates.addDays(start, 13);
    if (end < start) end = start;
    return { start: start, end: end };
  }

  function saveToStorage(state, storage) {
    try {
      (storage || window.localStorage).setItem(STORAGE_KEY, serialize(state));
      return true;
    } catch (e) {
      return false;
    }
  }

  // 保存済みのデータを読む。なければ null。壊れていれば null。
  function loadFromStorage(storage) {
    try {
      var text = (storage || window.localStorage).getItem(STORAGE_KEY);
      if (!text) return null;
      var res = parse(text);
      return res.ok ? res.data : null;
    } catch (e) {
      return null;
    }
  }

  return {
    VERSION: VERSION,
    STORAGE_KEY: STORAGE_KEY,
    PAPERS: PAPERS,
    MAX_EXTRA_ROWS: MAX_EXTRA_ROWS,
    DEFAULT_GROUP_ROWS: DEFAULT_GROUP_ROWS,
    NEW_GROUP_ROWS: NEW_GROUP_ROWS,
    DEFAULT_DAYS_UNIT: DEFAULT_DAYS_UNIT,
    MAX_UNIT_LENGTH: MAX_UNIT_LENGTH,
    MAX_DAYS_VALUE: MAX_DAYS_VALUE,
    slotLayout: slotLayout,
    createEmpty: createEmpty,
    nextId: nextId,
    validate: validate,
    serialize: serialize,
    parse: parse,
    computeRange: computeRange,
    saveToStorage: saveToStorage,
    loadFromStorage: loadFromStorage
  };
});
