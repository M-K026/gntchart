/* 日付の文字列（YYYY-MM-DD）を扱う小さな関数。タイムゾーンの影響を受けないよう UTC で計算する。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.GanttDate = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY_MS = 86400000;
  var MIN_YEAR = 1980; // 春分・秋分の計算式が使える範囲
  var MAX_YEAR = 2099;

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function format(t) {
    var d = new Date(t);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  // 形式だけ見て時刻に直す（範囲のチェックはしない）
  function raw(s) {
    return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  }

  function isValid(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
    if (!m) return false;
    var y = +m[1];
    if (y < MIN_YEAR || y > MAX_YEAR) return false;
    var d = new Date(Date.UTC(y, +m[2] - 1, +m[3]));
    return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }

  function addDays(s, n) {
    return format(raw(s) + n * DAY_MS);
  }

  // a から b までの日数（b が後ならプラス）
  function diffDays(a, b) {
    return Math.round((raw(b) - raw(a)) / DAY_MS);
  }

  // 0=日曜 … 6=土曜
  function weekday(s) {
    return new Date(raw(s)).getUTCDay();
  }

  function today() {
    var d = new Date();
    return format(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }

  function make(y, m, d) {
    return y + '-' + pad(m) + '-' + pad(d);
  }

  return {
    MIN_YEAR: MIN_YEAR,
    MAX_YEAR: MAX_YEAR,
    isValid: isValid,
    addDays: addDays,
    diffDays: diffDays,
    weekday: weekday,
    today: today,
    make: make,
    pad: pad
  };
});
