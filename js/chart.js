/*
 * ガントチャートの SVG 描画とレイアウト計算。座標の単位は mm。
 *   mode 'paper'  : 用紙（横向き）の印刷範囲いっぱいにチャートを組み立てる（PDF 出力用）
 *   mode 'screen' : 同じ用紙の大きさ・同じ中身で組む（画面表示用。画面に収まる大きさに縮小して見せる）
 * layout() が配置と文字の大きさを決め、render() がそれを SVG の文字列にする。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./dateutil'), require('./calendar'), require('./model'), require('./holidays'));
  } else {
    root.GanttChart = factory(root.GanttDate, root.GanttCalendar, root.GanttModel, root.GanttHolidays);
  }
})(typeof self !== 'undefined' ? self : this, function (Dates, Cal, Model, Holidays) {
  'use strict';

  var PAGES = { A4: { w: 297, h: 210 }, A3: { w: 420, h: 297 } };
  // 印刷時の余白（mm）。プリンターには、紙の端の印刷できない部分（4〜6mm ほど）があるので、それより内側に収める
  var MARGIN = 10;
  var PAD = 1; // 図の外側に取る余白（mm）。両端の太線の外側の半分が、図の枠で切れないようにする
  var FONT = "'Yu Gothic','Meiryo','Hiragino Sans','Noto Sans JP',sans-serif";
  var MAX_DAYS = 366;
  var READABLE_FS = 1.8; // これより小さい文字には注意を出す（mm）
  var TASK_FS = 3.0; // タスク名の大きさ（全タスク共通・mm）
  var ARROW = { hl: 1.6, hh: 0.9, stroke: 0.35 }; // 矢印の大きさ（全タスク共通・mm）

  var TITLE_FS = 6.5; // プロジェクト名の最大の大きさ（mm）
  var TITLE_MAX_LINES = 3; // プロジェクト名の欄が、改行に合わせて高くなる最大の行数

  var DIM = {
    titleH: 10, // プロジェクト名が 1 行のときの高さ（改行が増えると、その行数ぶん高くなる）
    monthH: 7, // 年月の行の高さ（文字を大きくしたので、以前の 5.5mm より高い）
    dayH: 9,
    eventsH: 22,
    leftW: 12,
    rightMin: 40, // 右の列（自由記入欄・タスク名＋稼働日数）の幅は、中の文字の長さに合わせて、この幅から広がる
    rightMaxShare: 0.32, // 右の列の幅の上限（図の幅に対する割合）
    colMin: 2.4, // 日付の列の幅の下限（mm）。右の列を広げても、日付の列はこれより狭くしない
    rowMax: 7,
    rowFloor: 2,
    remarksMin: 14
  };
  var MONTH_FS = 4.4; // 年月の文字の最大の大きさ（mm。以前は 3.4mm）
  var LINE_CLEAR = 0.8; // 太線（大分類の区切り）と矢印・◆の間に空ける隙間（mm）

  // 色（Design.md の案A モノクロ）
  var COLOR = {
    line: '#1A1A1A', text: '#1A1A1A', sub: '#6B6B6B', hair: '#D6D6D6',
    red: '#C0392B', blue: '#1565C0', gray: '#ECECEC', band: '#F6F6F6'
  };
  var HAIR_DASH = '0.5 0.6'; // 薄い線（日付と行の区切り）は点線（線の長さと隙間。mm）
  var STRONG = 600; // 文字の太さは「普通」と「やや太い」の 2 段階だけ
  var LABEL_SPACING = 0.1; // 「行事予定」「備考」のラベルの字間（文字の大きさに対する割合）
  // 線の太さ（A3 での mm。A4 は用紙の幅に合わせて縮める）
  var LINES = { top: 1.0, major: 0.7, mid: 0.5, group: 0.4, thin: 0.25, hair: 0.15 };

  function lineWidths(pageW) {
    var k = pageW / PAGES.A3.w;
    var o = {};
    Object.keys(LINES).forEach(function (key) {
      o[key] = Math.max(LINES[key] * k, key === 'hair' ? 0.12 : 0.15);
    });
    return o;
  }

  // ---- 印刷（PDF 出力）の CSS ----
  // 図の高さのほかに、用紙の高さから空けておく余裕（mm）。ページの高さが用紙より少し小さく計算されるブラウザ（Safari など）で、
  // 図がぴったりで 2 ページ目ができないようにする
  var PRINT_SLACK = 6;

  // 印刷（PDF 出力）の CSS。@page は余白 0 にして（ブラウザが、ページ下にアドレスなどを入れる場所をなくす）、
  // 図の周りの余白は、印刷する範囲の中（padding）で取る。
  // ブラウザが、用紙の端に独自の余白（0.5 インチなど）を足すとき（iPad・Safari）は、印刷できる範囲が狭くなる。
  // 横向きの用紙では、上下左右の余白が同じなら「内容の高さ = 内容の幅 − (用紙の幅 − 用紙の高さ)」なので、
  // 図の幅を、内容の幅から決めて縮める（高さは、幅に比率を掛けて決まる）。
  //   図の幅 = min(図の大きさ, 内容の幅, (内容の幅 − k) × 図の縦横比)    ← 内容の幅 = 100%（ホストの余白を除いた幅）
  //   k = (用紙の幅 − 用紙の高さ) + 上下の余白 + PRINT_SLACK − 左右の余白 × 2
  // 余白 0 のとき（Chrome の PDF）は、ほぼ図の大きさのまま（A4 で 276mm → 271mm）。縦向きの用紙（iPad が @page の向きを使わないとき）は、
  // 高さに余裕があるので、幅いっぱいまで（図の大きさまで）。
  // iPad・iPhone の Safari（@supports (-webkit-touch-callout: none) が真になるのは iOS だけ）は、ブラウザが用紙の端に余白を足すので、
  // こちらの余白（padding）をなくして、図を大きくする（iosK = (用紙の幅 − 用紙の高さ) + PRINT_SLACK。余白が 0 なので、k より小さい）。
  // L は layout() の結果。css は <style> に入れる文字、widthFor(内容の幅 mm) は、その幅のときの図の幅（mm。CSS と同じ計算）、
  // iosWidthFor は、iOS のときの同じ計算（内容の幅は、padding がない分だけ広い）
  function printCss(L) {
    var page = PAGES[L.paper];
    var padTop = L.margin;
    var padBottom = L.margin - 2;
    var padSide = L.margin;
    var ratio = Math.floor(L.svgW / L.svgH * 10000) / 10000; // 切り捨てる（図の高さが、少しでも大きくならないように）
    var k = (page.w - page.h) + padTop + padBottom + PRINT_SLACK - 2 * padSide;
    var iosK = (page.w - page.h) + PRINT_SLACK;
    var css = '@page { size: ' + L.paper + ' landscape; margin: 0; }' +
      '@media print {' +
      ' html, body { height: auto !important; min-height: 0 !important; overflow: visible !important; margin: 0 !important; padding: 0 !important; }' +
      ' #printHost { width: 100%; padding: ' + padTop + 'mm ' + padSide + 'mm ' + padBottom + 'mm; box-sizing: border-box; overflow: hidden;' +
      ' break-inside: avoid; page-break-inside: avoid; break-after: avoid; page-break-after: avoid;' +
      ' -webkit-print-color-adjust: exact; print-color-adjust: exact; }' +
      ' #printHost svg { display: block; width: 100%; max-width: ' + L.svgW + 'mm; height: auto; margin: 0 auto; } }' +
      '@media print and (orientation: landscape) {' +
      ' #printHost svg { width: min(' + L.svgW + 'mm, 100%, calc((100% - ' + k + 'mm) * ' + ratio + ')); max-width: none; height: auto; aspect-ratio: ' + L.svgW + ' / ' + L.svgH + '; } }' +
      '@supports (-webkit-touch-callout: none) {' +
      ' @media print { #printHost { padding: 0; } }' +
      ' @media print and (orientation: landscape) { #printHost svg { width: min(' + L.svgW + 'mm, 100%, calc((100% - ' + iosK + 'mm) * ' + ratio + ')); } } }';
    function widthFor(contentW) {
      return Math.min(L.svgW, contentW, (contentW - k) * ratio);
    }
    function iosWidthFor(contentW) {
      return Math.min(L.svgW, contentW, (contentW - iosK) * ratio);
    }
    return { css: css, k: k, iosK: iosK, ratio: ratio, widthFor: widthFor, iosWidthFor: iosWidthFor, padTop: padTop, padBottom: padBottom, padSide: padSide, maxW: L.svgW, maxH: L.svgH };
  }

  // ---- 文字の幅の見積もり（全角=1em、半角=0.6em。やや大きめに見積もる）----

  function charWidth(ch) {
    var c = ch.codePointAt(0);
    if (c === 0x20) return 0.3;
    if (c < 0x80) return 0.6;
    if (c >= 0xff61 && c <= 0xff9f) return 0.5;
    return 1;
  }

  function textWidth(str, fs) {
    var w = 0;
    Array.from(String(str)).forEach(function (ch) { w += charWidth(ch); });
    return w * fs;
  }

  // 1 行に収める。fs は maxFs 以下で、収まる最大の大きさ（minFs 未満になる場合は fits=false）
  function fitSingle(text, maxW, maxFs, minFs) {
    var w1 = textWidth(text, 1);
    var natural = w1 > 0 ? Math.min(maxFs, maxW / w1) : maxFs;
    return { fs: Math.max(natural, minFs), natural: natural, fits: natural >= minFs - 1e-9 };
  }

  // 幅 maxW で折り返した行の配列
  function wrapText(text, maxW, fs) {
    var lines = [];
    String(text).split(/\r?\n/).forEach(function (para) {
      var cur = '';
      var w = 0;
      Array.from(para).forEach(function (ch) {
        var cw = charWidth(ch) * fs;
        if (cur && w + cw > maxW + 1e-9) {
          lines.push(cur);
          cur = '';
          w = 0;
        }
        cur += ch;
        w += cw;
      });
      lines.push(cur);
    });
    return lines;
  }

  // 枠（boxW × boxH）に収まるように、大きい文字から順に小さくして折り返す
  function fitWrapped(text, boxW, boxH, maxFs, minFs, lh) {
    lh = lh || 1.3;
    var fs;
    var lines;
    for (fs = maxFs; fs >= minFs - 1e-9; fs -= 0.1) {
      lines = wrapText(text, boxW, fs);
      if (lines.length * fs * lh <= boxH + 1e-9) return { fs: fs, lines: lines, fits: true, lh: lh };
    }
    fs = minFs;
    lines = wrapText(text, boxW, fs);
    var maxLines = Math.max(1, Math.floor(boxH / (fs * lh)));
    return { fs: fs, lines: lines.slice(0, maxLines), fits: lines.length <= maxLines, lh: lh };
  }

  // ---- 縦書き ----
  // 縦書きは、ブラウザの縦書きの指定（writing-mode）を使わず、1 文字ずつ上から並べて描く。
  // iPad の Safari などは SVG の縦書きの指定を正しく扱えず、半角の文字や、縦書きにならない文字が出るため。
  // 文字は全部、正立（まっすぐ）に置く。全角は 1 文字ぶん、半角（英数字）は少し詰めて送る。

  // 縦書きで 1 文字が使う高さ（文字の大きさに対する倍率）
  function vPitch(ch) {
    var c = ch.codePointAt(0);
    if (c === 0x20) return 0.4;
    if (c < 0x80) return 0.75;
    if (c >= 0xff61 && c <= 0xff9f) return 0.75; // 半角のカナ
    return 1;
  }

  // 縦書きの文字列の長さ（文字の大きさ fs のとき）
  function vLength(str, fs) {
    var w = 0;
    Array.from(String(str)).forEach(function (ch) { w += vPitch(ch); });
    return w * fs;
  }

  // 縦書きで、右へ 90° 回して置く文字（長音符・波線・括弧など。縦書きではこの向きになる）
  var V_ROTATE = 'ー－―—～〜…‥()（）[]［］{}｛｝「」『』【】〈〉《》〔〕＜＞<>';
  // 縦書きで、マスの右上に寄せる文字（句読点）
  var V_CORNER = '、。，．,.';

  // 縦書き 1 列ぶんを描く（cx: 列の中心の x、top: 一番上の y）。文字は 1 つずつ別の text にして、位置を決めて置く。
  function verticalChars(str, cx, top, fs, fill, extra) {
    var out = [];
    var y = top;
    Array.from(String(str)).forEach(function (ch) {
      var pitch = vPitch(ch) * fs;
      if (ch !== ' ' && ch !== '　') {
        var cy = y + pitch / 2;
        var attrs = ' font-size="' + n(fs) + '" text-anchor="middle"' + (fill ? ' fill="' + fill + '"' : '') + (extra || '');
        var x = cx;
        var by = baseline(cy, fs);
        if (V_ROTATE.indexOf(ch) >= 0) {
          out.push('<text x="' + n(cx) + '" y="' + n(by) + '"' + attrs + ' transform="rotate(90 ' + n(cx) + ' ' + n(cy) + ')">' + esc(ch) + '</text>');
        } else {
          if (V_CORNER.indexOf(ch) >= 0) {
            x = cx + fs * 0.45;
            by -= fs * 0.5;
          }
          out.push('<text x="' + n(x) + '" y="' + n(by) + '"' + attrs + '>' + esc(ch) + '</text>');
        }
      }
      y += pitch;
    });
    return out.join('');
  }

  // 縦書き（右の列から左へ）。できるだけ 1 列で読める大きさにし、無理なら列を増やす。
  // 改行（\n）で区切った行は、それぞれ別の列になる（最初の行が一番右）。
  // columns は右の列から順の文字列の配列。
  function fitVertical(text, boxW, boxH, maxFs, minFs, lh) {
    lh = lh || 1.2;
    var SINGLE_MIN = 2.2;
    var lines = String(text).replace(/\s+$/, '').split(/\r?\n/).map(function (l) {
      return Array.from(l.replace(/[ \t\u3000]+/g, ' ').trim());
    }).filter(function (chars) { return chars.length; });
    if (!lines.length) lines = [[]];
    var fs;
    function splitLine(chars, size) {
      var cols = [];
      var cur = '';
      var len = 0;
      chars.forEach(function (ch) {
        var p = vPitch(ch) * size;
        if (cur && len + p > boxH + 1e-9) {
          cols.push(cur);
          cur = '';
          len = 0;
        }
        cur += ch;
        len += p;
      });
      if (cur) cols.push(cur);
      return cols;
    }
    function split(size) {
      var cols = [];
      lines.forEach(function (chars) { cols = cols.concat(splitLine(chars, size)); });
      return cols;
    }
    if (lines.length === 1) {
      for (fs = maxFs; fs >= Math.max(SINGLE_MIN, minFs) - 1e-9; fs -= 0.1) {
        if (vLength(lines[0].join(''), fs) <= boxH + 1e-9 && fs * lh <= boxW + 1e-9) {
          return { fs: fs, columns: [lines[0].join('')], fits: true, lh: lh };
        }
      }
    }
    var cols;
    for (fs = maxFs; fs >= minFs - 1e-9; fs -= 0.1) {
      cols = split(fs);
      if (cols.length * fs * lh <= boxW + 1e-9) return { fs: fs, columns: cols, fits: true, lh: lh };
    }
    fs = minFs;
    cols = split(fs);
    var maxCols = Math.max(1, Math.floor(boxW / (fs * lh)));
    return { fs: fs, columns: cols.slice(0, maxCols), fits: cols.length <= maxCols, lh: lh };
  }

  // 同じタスクの矢印ごとにタスク名を置く位置。大きさは fs のまま変えず、矢印からはみ出して表示する。
  // 隣のタスク名と重ならないようにずらし、日付エリア（leftLimit〜rightLimit）の外には出さない。
  // 全部を並べても領域に入らないときだけ、そのタスクの名前を小さくする。
  function placeLabels(segs, text, fs, leftLimit, rightLimit) {
    var GAP = 0.4;
    var w1 = textWidth(text, 1);
    var n = segs.length;
    var room = rightLimit - leftLimit;
    var size = fs;
    var shrunk = false;
    if (n * w1 * size + (n - 1) * GAP > room) {
      size = Math.max((room - (n - 1) * GAP) / (n * w1), 0.6);
      shrunk = true;
    }
    var w = w1 * size;
    var lefts = segs.map(function (s) {
      var cx = (s.x0 + s.x1) / 2;
      return Math.max(leftLimit, Math.min(cx - w / 2, rightLimit - w));
    });
    for (var i = 1; i < n; i++) lefts[i] = Math.max(lefts[i], lefts[i - 1] + w + GAP);
    lefts[n - 1] = Math.min(lefts[n - 1], rightLimit - w);
    for (var j = n - 2; j >= 0; j--) lefts[j] = Math.min(lefts[j], lefts[j + 1] - w - GAP);
    return segs.map(function (s, k) {
      return {
        text: text,
        x: lefts[k] + w / 2,
        anchor: 'middle',
        fs: size,
        overflow: w > s.x1 - s.x0 - 0.6,
        shrunk: shrunk
      };
    });
  }

  // 右の列の文字。稼働日数を出すタスクは「名前（N日）」。N は、手入力があればその数、なければ期間の稼働日を数えた自動の値
  // （非稼働日に選んだ日は数えない）。単位は、そのタスクの単位（初期値は「日」）
  function rightLabel(t, overrides) {
    if (t.type === 'task' && t.showWorkDays) return t.name + '（' + Cal.taskDays(t, overrides).text + '）';
    return t.name;
  }

  function hasText(s) {
    return typeof s === 'string' && s.trim() !== '';
  }

  // 右の列の幅。自由記入欄の一番長い行と、タスク名＋稼働日数（「名前（N日）」）の一番長いものが 1 行で入る幅（最小 DIM.rightMin）。
  // 広げるのは、図の幅の DIM.rightMaxShare までで、日付の列が DIM.colMin より狭くならない範囲まで
  // （3 か月・約 90 日でも、日付が読めるように）。収まらない文字は、折り返して小さくする
  function rightColumnWidth(state, overrides, W, dayCount) {
    var need = 0;
    state.tasks.forEach(function (t) {
      var label = rightLabel(t, overrides);
      if (hasText(label)) need = Math.max(need, textWidth(label, TASK_FS) + 2.4 + 0.6);
    });
    if (hasText(state.freeText)) {
      String(state.freeText).split(/\r?\n/).forEach(function (line) { need = Math.max(need, textWidth(line, 3.2) + 3 + 0.6); });
    }
    var most = Math.max(DIM.rightMin, Math.min(W * DIM.rightMaxShare, W - DIM.leftW - dayCount * DIM.colMin));
    return Math.min(Math.max(need, DIM.rightMin), most);
  }

  // ---- レイアウト ----

  function layout(state, options) {
    options = options || {};
    var mode = options.mode === 'screen' ? 'screen' : 'paper';
    var paper = PAGES[state.settings.paper] ? state.settings.paper : 'A4';
    var page = PAGES[paper];
    var L = { mode: mode, paper: paper, margin: MARGIN, warnings: [], tooLong: false, lines: lineWidths(page.w) };
    function warn(msg) {
      if (L.warnings.indexOf(msg) < 0) L.warnings.push(msg);
    }

    var range = Model.computeRange(state, options.today);
    var count = Dates.diffDays(range.start, range.end) + 1;
    L.range = range;
    L.dayCount = count;
    // 図の大きさ（svgW × svgH）は、用紙から余白を引いた印刷範囲より 1mm 小さくする（端数で、はみ出して次のページに行かないように）。
    // その内側の PAD ぶんは余白で、チャート（W × H）はその内側
    var svgW = page.w - 2 * MARGIN - 1;
    var svgH = page.h - 2 * MARGIN - 1;
    L.pad = PAD;
    if (count > MAX_DAYS) {
      L.tooLong = true;
      L.W = svgW - 2 * PAD;
      L.H = svgH - 2 * PAD;
      L.svgW = svgW;
      L.svgH = svgH;
      warn('表示する期間が長すぎます（' + count + '日）。日付の入力に誤りがないか確認してください（最大' + MAX_DAYS + '日）。');
      return L;
    }

    var overrides = state.workdayOverrides || {};
    var D = DIM;
    // 用紙（A4/A3 横）の印刷範囲いっぱい。画面（mode: 'screen'）も同じ大きさで組み、画面の大きさに合わせて縮小して見せる
    var W = svgW - 2 * PAD;
    var H = svgH - 2 * PAD;
    // 右の列（自由記入欄・タスク名＋稼働日数）の幅は、中の文字の長さに合わせる（図全体の大きさは変えない。日付の列が、そのぶん狭くなる）
    var rightW = rightColumnWidth(state, overrides, W, count);
    var dayAreaW = W - D.leftW - rightW;
    var colW = dayAreaW / count;
    var dayX0 = D.leftW;
    var dayX1 = dayX0 + dayAreaW;
    L.W = W;
    L.dayX0 = dayX0;
    L.dayX1 = dayX1;
    L.dayAreaW = dayAreaW;
    L.colW = colW;
    L.leftW = D.leftW;
    L.rightW = rightW;

    // プロジェクト名の欄の高さ: 1 行は D.titleH。改行（複数行）が増えるたびに、その行数ぶん高くする
    var titleH = D.titleH;
    if (hasText(state.projectName)) {
      var titleLines = Math.min(TITLE_MAX_LINES, String(state.projectName).replace(/\s+$/, '').split(/\r?\n/).length);
      titleH = Math.max(D.titleH, titleLines * TITLE_FS * 1.2 + 1.6);
    }
    L.titleH = titleH;

    var y = {};
    y.titleBottom = titleH;
    y.monthTop = titleH;
    y.monthBottom = y.monthTop + D.monthH;
    y.dayBottom = y.monthBottom + D.dayH;
    y.eventsTop = y.dayBottom;
    y.rowsTop = y.eventsTop + D.eventsH;
    L.y = y;

    // タイトル
    L.title = hasText(state.projectName)
      ? fitWrapped(state.projectName, W - 6, titleH - 1.6, TITLE_FS, 2.0, 1.2)
      : null;
    if (L.title && !L.title.fits) warn('プロジェクト名が長すぎて枠に収まりません。');

    // 日付
    L.days = [];
    for (var i = 0; i < count; i++) {
      var date = Dates.addDays(range.start, i);
      L.days.push({
        date: date,
        x: dayX0 + i * colW,
        day: +date.slice(8, 10),
        weekday: Dates.weekday(date),
        red: Cal.isRedDay(date), // 土日祝（列を灰色にする）
        tone: Holidays.holidayName(date) !== null || Dates.weekday(date) === 0 ? 'red' : (Dates.weekday(date) === 6 ? 'blue' : null), // 日付・曜日の文字の色: 日曜・祝日は赤、土曜は青
        workday: Cal.isWorkday(date, overrides)
      });
    }
    // 日付の数字は小さめにする（以前は 3.2mm まで大きくなって、大きすぎた）
    L.dayFs = Math.min(2.4, colW * 0.7);
    L.weekFs = Math.min(2.2, colW * 0.8);
    if (L.dayFs < 1.6) warn('日数が多いため、日付の文字が小さくなっています（用紙をA3にするか、期間を短くしてください）。');

    // 年月
    L.months = Cal.eachMonth(range.start, range.end).map(function (m) {
      var x0 = dayX0 + m.startIndex * colW;
      var w = m.count * colW;
      var labels = [m.year + '年' + m.month + '月', m.month + '月', String(m.month)];
      var pick = null;
      for (var k = 0; k < labels.length && !pick; k++) {
        var f = fitSingle(labels[k], w - 0.8, MONTH_FS, k === 0 ? READABLE_FS : 1.4);
        if (f.fits) pick = { text: labels[k], fs: f.fs };
      }
      if (!pick) {
        pick = { text: labels[2], fs: fitSingle(labels[2], w - 0.4, MONTH_FS, 0.6).fs };
        warn('日数が多いため、年月の文字が小さくなっています。');
      }
      return { ym: m.ym, x0: x0, x1: x0 + w, text: pick.text, fs: pick.fs };
    });

    // 自由記入欄（右上）
    L.free = { x: dayX1, y: y.monthTop, w: rightW, h: y.rowsTop - y.monthTop, text: null };
    if (hasText(state.freeText)) {
      L.free.text = fitWrapped(state.freeText, rightW - 3, L.free.h - 3, 3.2, 1.4, 1.35);
      if (!L.free.text.fits) warn('右上の自由記入欄に収まらない文字があります。');
    }

    // 「行事予定」ラベル（縦書き。左の列の、行事予定の枠の中央）
    // 小さめのグレーの文字で、字間を少し空ける（字間の分だけ長さを多めに見積もる）
    L.eventsLabel = { fs: Math.min(2.8, (D.eventsH - 3) / (vLength('行事予定', 1) * (1 + LABEL_SPACING))) };

    // 行事予定（各日付の列に縦書き。列の中央、行事予定の枠の中央に置く）。マーカー（枠の背景）の色は L.eventMarkers
    var byDay = {};
    state.events.forEach(function (e) {
      var s = e.start < range.start ? range.start : e.start;
      var en = e.end > range.end ? range.end : e.end;
      for (var d = s; d <= en; d = Dates.addDays(d, 1)) {
        var idx = Dates.diffDays(range.start, d);
        (byDay[idx] = byDay[idx] || []).push(e);
      }
    });
    L.events = [];
    L.eventMarkers = [];
    var smallEvent = false;
    Object.keys(byDay).forEach(function (key) {
      var list = byDay[key];
      var idx = +key;
      var subW = colW / list.length;
      list.forEach(function (e, j) {
        if (e.markerColor) L.eventMarkers.push({ x: dayX0 + idx * colW + subW * j, y: y.eventsTop, w: subW, h: D.eventsH, color: e.markerColor });
        var text = e.text.replace(/\s+/g, ' ').trim();
        if (!text) return;
        var fs = Math.min(3.2, subW * 0.88, (D.eventsH - 3) / vLength(text, 1));
        if (fs < 1.4) smallEvent = true;
        var top = y.eventsTop + (D.eventsH - vLength(text, fs)) / 2;
        L.events.push({ text: text, x: dayX0 + idx * colW + subW * (j + 0.5), y: top, fs: fs, color: e.textColor || null });
      });
    });
    if (smallEvent) warn('行事予定の文字が小さくなっています（文字数が多いか、同じ日に予定が重なっています）。');

    // 大分類と行（データの行がそのまま画面・PDF の行。タスクは、持っている行の位置に入る）
    var groups = state.groups.map(function (g) {
      var items = state.tasks.filter(function (t) { return t.groupId === g.id; });
      var rowCount = Math.max(items.length + g.extraRows, 1);
      return { group: g, slots: Model.slotLayout(items, rowCount), rowCount: rowCount };
    });
    if (!groups.length) {
      // 大分類が 1 つもないときは、最初の大分類と同じ行数の空の欄を出す（タップすると、大分類ができる）
      groups.push({ group: { id: '', name: '', extraRows: 0 }, slots: Model.slotLayout([], Model.DEFAULT_GROUP_ROWS), rowCount: Model.DEFAULT_GROUP_ROWS });
    }
    var totalRows = groups.reduce(function (sum, g) { return sum + g.rowCount; }, 0);

    // 行の高さは最大 7mm。行が多いと低くして用紙に収める（画面も PDF も同じ）
    var rowH = Math.min(D.rowMax, (H - y.rowsTop - D.remarksMin) / totalRows);
    if (rowH < D.rowFloor) {
      rowH = D.rowFloor;
      warn('行が多すぎて用紙に収まりません。タスクや空き行を減らすか、用紙をA3にしてください。');
    }
    L.rowH = rowH;
    var taskFs = Math.min(TASK_FS, rowH * 0.43);
    L.taskFs = taskFs;
    if (taskFs < READABLE_FS) warn('行が多いため、タスク名などの文字が小さくなっています（用紙をA3にするか、行を減らしてください）。');

    // 矢印の大きさ（全タスク共通）
    var hl = Math.min(ARROW.hl, colW * 0.35, rowH * 0.25);
    L.arrow = { hl: hl, hh: Math.min(ARROW.hh, hl * 0.6), stroke: ARROW.stroke };

    L.rows = [];
    L.groups = [];
    var yy = y.rowsTop;
    var cut = false;
    groups.forEach(function (g, gi) {
      var top = yy;
      for (var r = 0; r < g.rowCount; r++) {
        var item = g.slots[r] || null;
        var last = r === g.rowCount - 1;
        var row = {
          groupIndex: gi, groupId: g.group.id, index: r, item: item, y: yy, h: rowH,
          first: r === 0, last: last, segs: [], labels: [], milestone: null, right: null
        };
        // 矢印は行の下の点線の上に置き、タスク名はその上に書く。
        // 大分類の最後の行は下が太線なので、太線にかぶらないよう矢印の分だけ上げる。
        row.arrowY = yy + rowH - (last ? L.arrow.hh + LINE_CLEAR : 0);
        row.labelY = Math.max(yy + taskFs * 0.5 + 0.2, row.arrowY - L.arrow.hh - 0.5 - taskFs * 0.5);
        if (item) buildRow(row, item);
        L.rows.push(row);
        yy += rowH;
      }
      var nameFit = hasText(g.group.name)
        ? fitVertical(g.group.name, D.leftW - 1.6, Math.max(yy - top - 1.2, 1), TASK_FS, 1.4, 1.2)
        : null;
      if (nameFit && !nameFit.fits) cut = true;
      L.groups.push({ index: gi, group: g.group, y: top, h: yy - top, name: nameFit, rows: g.rowCount });
    });
    if (cut) warn('大分類名が長すぎて枠に収まらない部分があります。');
    L.rowsBottom = yy;

    function buildRow(row, item) {
      var label = rightLabel(item, overrides);
      if (hasText(label)) {
        row.right = fitWrapped(label, rightW - 2.4, rowH - 0.6, taskFs, 1.2, 1.15);
        if (!row.right.fits) warn('右の列に収まらない文字があります。');
      }
      if (item.type === 'task') {
        var s = item.start < range.start ? range.start : item.start;
        var e = item.end > range.end ? range.end : item.end;
        if (s <= e) {
          var segs = Cal.splitTaskSegments(item, s, e, overrides);
          if (!segs.length) segs = [{ start: s, end: e }];
          var pad = Math.min(0.4, colW * 0.1);
          row.segs = segs.map(function (g) {
            var i0 = Dates.diffDays(range.start, g.start);
            var i1 = Dates.diffDays(range.start, g.end);
            var cx0 = dayX0 + i0 * colW;
            var cx1 = dayX0 + (i1 + 1) * colW;
            return { start: g.start, end: g.end, cx0: cx0, cx1: cx1, x0: cx0 + pad, x1: cx1 - pad };
          });
          if (hasText(item.name)) {
            row.labels = placeLabels(row.segs, item.name, taskFs, dayX0 + 0.3, dayX1 - 0.3);
            if (row.labels[0].shrunk) warn('日数が多いため、一部のタスク名が小さくなっています。');
          }
        }
      } else {
        var idx = Dates.diffDays(range.start, item.date);
        if (idx >= 0 && idx < count) {
          var size = Math.min(rowH * 0.4, 3.0);
          var cx = dayX0 + (idx + 0.5) * colW;
          // ◆ は矢印と同じく行の下の点線の上（中心を点線に合わせる）に置き、名前はその上に書く。
          // 大分類の最後の行は下が太線なので、太線にかぶらないよう上げる。
          var cy = row.y + rowH - (row.last ? size / 2 + LINE_CLEAR : 0);
          var ms = { cellX: dayX0 + idx * colW, cx: cx, cy: cy, size: size, label: null };
          if (hasText(item.name)) {
            var w1 = textWidth(item.name, 1);
            var room = dayX1 - dayX0 - 0.6;
            var fs = Math.max(Math.min(taskFs, room / w1), 0.6);
            var half = (w1 * fs) / 2;
            // ◆ の真上を中心にして、日付エリアからはみ出す分だけ内側へずらす
            var from = Math.min(Math.max(cx - half, dayX0 + 0.3), dayX1 - 0.3 - half * 2);
            var labelCy = Math.max(row.y + fs * 0.5 + 0.2, cy - size / 2 - 0.5 - fs * 0.5);
            ms.label = { text: item.name, x: from, anchor: 'start', fs: fs, cy: labelCy };
          }
          row.milestone = ms;
        }
      }
    }

    // 備考
    // タスクの下に残ったスペースをすべて使う（画面も PDF も同じ）
    L.remarks = { y: L.rowsBottom, h: 0, body: null };
    var remarksH = H - L.rowsBottom;
    L.remarks.h = Math.max(remarksH, 0);
    if (remarksH < 0) warn('行が多すぎて、備考の欄がありません。');
    if (hasText(state.remarks)) {
      L.remarks.body = fitWrapped(state.remarks, W - 6, Math.max(remarksH - 6.5, 0), 3.2, 1.6, 1.35);
      if (!L.remarks.body.fits) warn('備考が欄に収まりません（文章を短くするか、タスクの行を減らしてください）。');
    }

    L.H = H;
    L.svgW = svgW;
    L.svgH = svgH;
    return L;
  }

  // ---- SVG への変換 ----

  function n(v) {
    return String(Math.round(v * 1000) / 1000);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // 文字の縦方向の中心が cy に来るベースライン位置
  function baseline(cy, fs) {
    return cy + fs * 0.36;
  }

  function textEl(x, y, str, fs, anchor, fill, extra) {
    return '<text x="' + n(x) + '" y="' + n(y) + '" font-size="' + n(fs) + '"' +
      (anchor && anchor !== 'start' ? ' text-anchor="' + anchor + '"' : '') +
      (fill ? ' fill="' + fill + '"' : '') + (extra || '') + '>' + esc(str) + '</text>';
  }

  // 複数行の文字（ボックスの中で上下左右の位置を指定）
  function blockText(fit, boxX, boxY, boxW, boxH, hAlign, vAlign, fill, extra) {
    var lh = fit.fs * fit.lh;
    var total = fit.lines.length * lh;
    var top = vAlign === 'middle' ? boxY + (boxH - total) / 2 : boxY;
    var x = hAlign === 'middle' ? boxX + boxW / 2 : boxX;
    var out = [];
    fit.lines.forEach(function (line, k) {
      if (line === '') return;
      out.push(textEl(x, baseline(top + (k + 0.5) * lh, fit.fs), line, fit.fs, hAlign === 'middle' ? 'middle' : 'start', fill, extra));
    });
    return out.join('');
  }

  var STRONG_ATTR = ' font-weight="' + STRONG + '"';

  // 小さめのグレーのラベル（字間を少し空ける）
  function labelEl(x, cy, str, fs, anchor) {
    return textEl(x, baseline(cy, fs), str, fs, anchor, COLOR.sub, ' letter-spacing="' + n(fs * LABEL_SPACING) + '"');
  }

  // 縦書きの小さなグレーのラベル（字間を少し空ける。cx: 列の中心、top: 一番上）
  function verticalLabel(cx, top, str, fs) {
    var out = [];
    var y = top;
    Array.from(str).forEach(function (ch) {
      var pitch = vPitch(ch) * fs * (1 + LABEL_SPACING);
      out.push(textEl(cx, baseline(y + pitch / 2, fs), ch, fs, 'middle', COLOR.sub));
      y += pitch;
    });
    return out.join('');
  }

  // 縦書き（ボックスの中央に、右の列から並べる。1 文字ずつ置く）
  function verticalBlock(fit, boxX, boxY, boxW, boxH) {
    var pitch = fit.fs * fit.lh;
    var cols = fit.columns.length;
    var cx = boxX + boxW / 2;
    var top = boxY + (boxH - vLength(fit.columns[0] || '', fit.fs)) / 2;
    var out = [];
    fit.columns.forEach(function (col, k) {
      var x = cx + ((cols - 1) / 2 - k) * pitch;
      out.push(verticalChars(col, x, top, fit.fs));
    });
    return out.join('');
  }

  function arrowPath(x0, x1, cy, hl, hh) {
    // 両矢印（線 + 両端の三角）
    var d = 'M' + n(x0 + hl) + ' ' + n(cy) + 'H' + n(x1 - hl);
    d += 'M' + n(x0) + ' ' + n(cy) + 'L' + n(x0 + hl) + ' ' + n(cy - hh) + 'V' + n(cy + hh) + 'Z';
    d += 'M' + n(x1) + ' ' + n(cy) + 'L' + n(x1 - hl) + ' ' + n(cy - hh) + 'V' + n(cy + hh) + 'Z';
    return d;
  }

  function render(state, options) {
    options = options || {};
    var L = layout(state, options);
    var out = [];
    var W = L.W;
    var H = L.H;
    var prefix = options.idPrefix || '';
    // viewBox は、チャート（0〜W, 0〜H）の外に PAD ぶんの余白を持つ。overflow を visible にして、線の太さの半分が枠で切れないようにする
    var pad = L.pad;
    out.push('<svg xmlns="http://www.w3.org/2000/svg" class="gantt-svg" viewBox="' + n(-pad) + ' ' + n(-pad) + ' ' + n(L.svgW) + ' ' + n(L.svgH) +
      '" width="' + n(L.svgW) + 'mm" height="' + n(L.svgH) + 'mm" overflow="visible" font-family="' + FONT + '" fill="' + COLOR.text + '">');
    out.push('<rect x="' + n(-pad) + '" y="' + n(-pad) + '" width="' + n(L.svgW) + '" height="' + n(L.svgH) + '" fill="#fff"/>');

    if (L.tooLong) {
      out.push('<rect x="0" y="0" width="' + n(W) + '" height="' + n(H) + '" fill="none" stroke="' + COLOR.line + '" stroke-width="0.5"/>');
      out.push(textEl(W / 2, H / 2, L.warnings[0], 4, 'middle'));
      out.push('</svg>');
      return { svg: out.join(''), layout: L, warnings: L.warnings };
    }

    var y = L.y;
    var clipId = 0;
    var defs = [];
    function clip(x, yy, w, h) {
      var id = prefix + 'gc' + clipId++;
      defs.push('<clipPath id="' + id + '"><rect x="' + n(x) + '" y="' + n(yy) + '" width="' + n(w) + '" height="' + n(h) + '"/></clipPath>');
      return id;
    }
    var body = [];
    var LW = L.lines;

    // 日付の行の帯
    body.push('<rect x="' + n(L.dayX0) + '" y="' + n(y.monthBottom) + '" width="' + n(L.dayAreaW) + '" height="' + n(DIM.dayH) + '" fill="' + COLOR.band + '"/>');

    // 土日祝の列（日付の行から最下段のタスク行まで）をグレーにする
    L.days.forEach(function (d) {
      if (d.red) {
        body.push('<rect x="' + n(d.x) + '" y="' + n(y.monthBottom) + '" width="' + n(L.colW) + '" height="' + n(L.rowsBottom - y.monthBottom) + '" fill="' + COLOR.gray + '"/>');
      }
    });

    // 行事予定のマーカー（行事予定の枠の、その日の列の背景。グレーの上に重ねる）
    L.eventMarkers.forEach(function (m) {
      body.push('<rect x="' + n(m.x) + '" y="' + n(m.y) + '" width="' + n(m.w) + '" height="' + n(m.h) + '" fill="' + m.color + '"/>');
    });

    // マーカー（矢印の上の行のセルを塗る。稼働日の連続ごと。グレーの上に重ねる）
    L.rows.forEach(function (row) {
      var it = row.item;
      if (!it || !it.markerColor) return;
      row.segs.forEach(function (s) {
        body.push('<rect x="' + n(s.cx0) + '" y="' + n(row.y) + '" width="' + n(s.cx1 - s.cx0) + '" height="' + n(row.h) + '" fill="' + it.markerColor + '"/>');
      });
      if (row.milestone) {
        body.push('<rect x="' + n(row.milestone.cellX) + '" y="' + n(row.y) + '" width="' + n(L.colW) + '" height="' + n(row.h) + '" fill="' + it.markerColor + '"/>');
      }
    });

    // 罫線（区切りは横線で示す。左右の両端には太い縦線を引く。太さは用紙に合わせて縮める）
    //   top   : プロジェクト名の上・左右の両端（縦）  major: 日付見出し・タスク・備考の各区切りの上
    //   mid   : 左右の列の境・月の区切り（縦）       group: 大分類の区切り
    //   thin  : 日付見出しと行事予定の境             hair : 日付と行の区切り（薄いグレーの実線）
    var P = { top: [], major: [], mid: [], group: [], thin: [], hair: [] };
    function hline(kind, x1, x2, yy) { P[kind].push('M' + n(x1) + ' ' + n(yy) + 'H' + n(x2)); }
    function vline(kind, x, y1, y2) { P[kind].push('M' + n(x) + ' ' + n(y1) + 'V' + n(y2)); }

    hline('top', 0, W, 0);
    // 左右の両端（プロジェクト名の上の線と同じ太さ）。チャートから、備考の枠の下まで通す。
    // 角が欠けないよう、上は一番上の線の太さの半分、下は備考の枠の下の線の太さの半分だけ延ばす
    vline('top', 0, -LW.top / 2, H + LW.major / 2);
    vline('top', W, -LW.top / 2, H + LW.major / 2);
    // 備考の枠の下の線（備考の上の線は、チャートの下の線と同じ）
    hline('major', 0, W, H);
    hline('major', 0, W, y.titleBottom);
    hline('hair', L.dayX0, L.dayX1, y.monthBottom);
    hline('thin', 0, L.dayX1, y.dayBottom);
    hline('major', 0, W, y.rowsTop);
    hline('major', 0, W, L.rowsBottom);
    vline('mid', L.dayX0, y.titleBottom, L.rowsBottom);
    vline('mid', L.dayX1, y.titleBottom, L.rowsBottom);
    L.months.forEach(function (m, k) {
      if (k > 0) vline('mid', m.x0, y.monthTop, L.rowsBottom);
    });
    L.days.forEach(function (d, k) {
      if (k === 0) return;
      var isMonthStart = L.months.some(function (m) { return Math.abs(m.x0 - d.x) < 1e-6; });
      if (!isMonthStart) vline('hair', d.x, y.monthBottom, L.rowsBottom);
    });
    L.rows.forEach(function (row) {
      if (row.first) {
        if (row.groupIndex > 0) hline('group', 0, W, row.y);
      } else {
        hline('hair', L.dayX0, W, row.y);
      }
    });

    [['hair', COLOR.hair], ['thin', COLOR.line], ['group', COLOR.line], ['mid', COLOR.line], ['major', COLOR.line], ['top', COLOR.line]].forEach(function (k) {
      if (P[k[0]].length) {
        // 薄い線（hair）は点線にする
        var dash = k[0] === 'hair' ? ' stroke-dasharray="' + HAIR_DASH + '"' : '';
        body.push('<path d="' + P[k[0]].join('') + '" fill="none" stroke="' + k[1] + '" stroke-width="' + n(LW[k[0]]) + '"' + dash + '/>');
      }
    });

    // 矢印・タスク名・マイルストーン・右の列
    L.rows.forEach(function (row) {
      var it = row.item;
      if (!it) return;
      var color = it.arrowColor || COLOR.line;
      var diamondColor = it.diamondColor || COLOR.line;
      row.segs.forEach(function (s) {
        body.push('<path d="' + arrowPath(s.x0, s.x1, row.arrowY, L.arrow.hl, L.arrow.hh) + '" fill="' + color + '" stroke="' + color + '" stroke-width="' + L.arrow.stroke + '" stroke-linejoin="miter"/>');
      });
      row.labels.forEach(function (lb) {
        body.push(textEl(lb.x, baseline(row.labelY, lb.fs), lb.text, lb.fs, lb.anchor, it.textColor || null, STRONG_ATTR));
      });
      if (row.milestone) {
        var ms = row.milestone;
        var cy = ms.cy;
        var r = ms.size / 2;
        body.push('<path d="M' + n(ms.cx) + ' ' + n(cy - r) + 'L' + n(ms.cx + r) + ' ' + n(cy) + 'L' + n(ms.cx) + ' ' + n(cy + r) + 'L' + n(ms.cx - r) + ' ' + n(cy) + 'Z" fill="' + diamondColor + '"/>');
        if (ms.label) body.push(textEl(ms.label.x, baseline(ms.label.cy, ms.label.fs), ms.label.text, ms.label.fs, ms.label.anchor, it.textColor || null, STRONG_ATTR));
      }
      if (row.right) {
        var id = clip(L.dayX1, row.y, L.rightW, row.h);
        body.push('<g clip-path="url(#' + id + ')">' + blockText(row.right, L.dayX1 + 1.2, row.y, L.rightW - 2.4, row.h, 'start', 'middle') + '</g>');
      }
    });

    // 大分類名（縦書き）
    L.groups.forEach(function (g) {
      if (!g.name) return;
      var id = clip(0, g.y, L.leftW, g.h);
      body.push('<g clip-path="url(#' + id + ')">' + verticalBlock(g.name, 0.8, g.y + 0.6, L.leftW - 1.6, g.h - 1.2) + '</g>');
    });

    // 行事予定（ラベルも、各日付の列も縦書き）
    body.push(verticalLabel(L.leftW / 2, y.eventsTop + (DIM.eventsH - vLength('行事予定', L.eventsLabel.fs) * (1 + LABEL_SPACING)) / 2, '行事予定', L.eventsLabel.fs));
    L.events.forEach(function (e) {
      body.push(verticalChars(e.text, e.x, e.y, e.fs, e.color));
    });

    // 年月・日付
    L.months.forEach(function (m) {
      body.push(textEl((m.x0 + m.x1) / 2, baseline((y.monthTop + y.monthBottom) / 2, m.fs), m.text, m.fs, 'middle'));
    });
    L.days.forEach(function (d) {
      var fill = d.tone === 'red' ? COLOR.red : (d.tone === 'blue' ? COLOR.blue : COLOR.text);
      var cx = d.x + L.colW / 2;
      body.push(textEl(cx, baseline(y.monthBottom + DIM.dayH * 0.3, L.dayFs), String(d.day), L.dayFs, 'middle', fill, STRONG_ATTR));
      body.push(textEl(cx, baseline(y.monthBottom + DIM.dayH * 0.72, L.weekFs), '日月火水木金土'.charAt(d.weekday), L.weekFs, 'middle', fill));
    });

    // タイトル
    if (L.title) {
      // 中央寄せの大きな太字
      body.push(blockText(L.title, 3, 0.8, W - 6, L.titleH - 1.6, 'middle', 'middle', null, STRONG_ATTR));
    }

    // 自由記入欄
    if (L.free.text) {
      var fid = clip(L.free.x, L.free.y, L.free.w, L.free.h);
      body.push('<g clip-path="url(#' + fid + ')">' + blockText(L.free.text, L.free.x + 1.5, L.free.y + 1.5, L.free.w - 3, L.free.h - 3, 'start', 'top') + '</g>');
    }

    // 備考
    if (L.remarks.h > 0) {
      var rid = clip(0, L.remarks.y, W, L.remarks.h);
      var rem = [labelEl(3, L.remarks.y + 3.4, '備考', 2.4, 'start')];
      if (L.remarks.body) {
        rem.push(blockText(L.remarks.body, 3, L.remarks.y + 6.5, W - 6, Math.max(L.remarks.h - 6.5, 0), 'start', 'top'));
      }
      body.push('<g clip-path="url(#' + rid + ')">' + rem.join('') + '</g>');
    }

    out.push('<defs>' + defs.join('') + '</defs>');
    out.push(body.join(''));
    out.push('</svg>');
    return { svg: out.join(''), layout: L, warnings: L.warnings };
  }

  return {
    PAGES: PAGES,
    MARGIN: MARGIN,
    DIM: DIM,
    COLOR: COLOR,
    LINES: LINES,
    lineWidths: lineWidths,
    printCss: printCss,
    PRINT_SLACK: PRINT_SLACK,
    ARROW: ARROW,
    TASK_FS: TASK_FS,
    MAX_DAYS: MAX_DAYS,
    charWidth: charWidth,
    textWidth: textWidth,
    fitSingle: fitSingle,
    wrapText: wrapText,
    fitWrapped: fitWrapped,
    fitVertical: fitVertical,
    vLength: vLength,
    vPitch: vPitch,
    placeLabels: placeLabels,
    layout: layout,
    render: render
  };
});
