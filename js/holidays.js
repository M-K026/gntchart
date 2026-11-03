/* 日本の祝日（1980〜2099年）。振替休日・国民の休日を含む。ネット接続は不要。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./dateutil'));
  } else {
    root.GanttHolidays = factory(root.GanttDate);
  }
})(typeof self !== 'undefined' ? self : this, function (Dates) {
  'use strict';

  var cache = {};

  // y年m月の第n月曜日の日付（日）
  function nthMonday(y, m, n) {
    var first = Dates.weekday(Dates.make(y, m, 1));
    return 1 + ((8 - first) % 7) + 7 * (n - 1);
  }

  function springEquinox(y) {
    return Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  }

  function autumnEquinox(y) {
    return Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  }

  function build(y) {
    var h = {};
    function add(m, d, name) {
      h[Dates.make(y, m, d)] = name;
    }

    add(1, 1, '元日');
    add(1, y >= 2000 ? nthMonday(y, 1, 2) : 15, '成人の日');
    add(2, 11, '建国記念の日');
    if (y >= 2020) add(2, 23, '天皇誕生日');
    else if (y >= 1989 && y <= 2018) add(12, 23, '天皇誕生日');
    add(3, springEquinox(y), '春分の日');
    add(4, 29, y >= 2007 ? '昭和の日' : (y >= 1989 ? 'みどりの日' : '天皇誕生日'));
    add(5, 3, '憲法記念日');
    if (y >= 2007) add(5, 4, 'みどりの日');
    add(5, 5, 'こどもの日');

    // 海の日（2020・2021年は東京オリンピックのため移動）
    if (y === 2020) add(7, 23, '海の日');
    else if (y === 2021) add(7, 22, '海の日');
    else if (y >= 2003) add(7, nthMonday(y, 7, 3), '海の日');
    else if (y >= 1996) add(7, 20, '海の日');

    // 山の日
    if (y === 2020) add(8, 10, '山の日');
    else if (y === 2021) add(8, 8, '山の日');
    else if (y >= 2016) add(8, 11, '山の日');

    add(9, y >= 2003 ? nthMonday(y, 9, 3) : 15, '敬老の日');
    add(9, autumnEquinox(y), '秋分の日');

    // 体育の日 → スポーツの日
    if (y === 2020) add(7, 24, 'スポーツの日');
    else if (y === 2021) add(7, 23, 'スポーツの日');
    else if (y >= 2022) add(10, nthMonday(y, 10, 2), 'スポーツの日');
    else if (y >= 2000) add(10, nthMonday(y, 10, 2), '体育の日');
    else add(10, 10, '体育の日');

    add(11, 3, '文化の日');
    add(11, 23, '勤労感謝の日');

    if (y === 2019) {
      add(5, 1, '即位の日');
      add(10, 22, '即位礼正殿の儀');
    }
    if (y === 1993) add(6, 9, '結婚の儀');

    // 国民の休日（前日と翌日がどちらも祝日の平日）
    var base = {};
    Object.keys(h).forEach(function (k) { base[k] = true; });
    var t = Dates.make(y, 1, 1);
    for (; t <= Dates.make(y, 12, 31); t = Dates.addDays(t, 1)) {
      if (!base[t] && base[Dates.addDays(t, -1)] && base[Dates.addDays(t, 1)] && Dates.weekday(t) !== 0) {
        h[t] = '国民の休日';
      }
    }

    // 振替休日（日曜の祝日の次の平日。2007年以降は祝日が続く間は先送り）
    Object.keys(h).sort().forEach(function (d) {
      if (Dates.weekday(d) !== 0) return;
      var next = Dates.addDays(d, 1);
      if (y >= 2007) {
        while (h[next]) next = Dates.addDays(next, 1);
        h[next] = '振替休日';
      } else if (!h[next]) {
        h[next] = '振替休日';
      }
    });

    return h;
  }

  // その年の祝日 { 'YYYY-MM-DD': 名前 }
  function getHolidays(y) {
    if (!cache[y]) cache[y] = build(y);
    return cache[y];
  }

  // 祝日なら名前、そうでなければ null
  function holidayName(dateStr) {
    var y = +dateStr.slice(0, 4);
    if (y < Dates.MIN_YEAR || y > Dates.MAX_YEAR) return null;
    return getHolidays(y)[dateStr] || null;
  }

  return { getHolidays: getHolidays, holidayName: holidayName };
});
