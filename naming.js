// 자동 생성 파일 — 고치지 말고 shared/naming.js 를 고친 뒤 npm run sync
/**
 * 앨범·파일 이름 규칙 (정본). 순수 함수만 둔다.
 * 이 파일을 고친 뒤 `npm run sync` 로 server/admin/Naming.gs 와 web/naming.js 에 복사한다.
 *
 * 앨범: yymmdd_팀이름_프로그램명            예) 260102_기획팀_시무식
 * 연간: yyyyyy(연도 뒷2자리 3번)_팀_프로그램   예) 262626_기획팀_한글
 * 파일: 앨범이름_001.jpg / 연간은 앨범이름_촬영일_001.jpg
 */

var NAMING_MAX_PROGRAM_LEN = 60;
var KST_OFFSET_MS = 9 * 3600 * 1000;

/** 전각→반각, NFC, 공백 정리 */
function normalizeText(s) {
  s = String(s == null ? '' : s);
  if (s.normalize) s = s.normalize('NFC');
  s = s.replace(/[！-～]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });
  s = s.replace(/[　 \t\r\n]/g, ' ');
  s = s.replace(/[\u0000-\u001F\u007F]/g, '');
  return s.replace(/ {2,}/g, ' ').trim();
}

/** 비교용 키: 대소문자·띄어쓰기·기호 무시 */
function compactKey(s) {
  return normalizeText(s).toLowerCase().replace(/[^0-9a-z가-힣ㄱ-ㆎ一-鿿]/g, '');
}

/** 프로그램명 정리: 구분자(_)·경로문자 제거 */
function cleanProgram(s) {
  s = normalizeText(s).replace(/[_\/\\|]+/g, ' ');
  s = s.replace(/ {2,}/g, ' ').trim().replace(/^[=+\-@]+\s*/, ''); // 시트 수식으로 읽히는 시작 문자 제거
  return s.slice(0, NAMING_MAX_PROGRAM_LEN).trim();
}

function pad2_(n) {
  n = String(n);
  return n.length < 2 ? '0' + n : n;
}

/** yymmdd 가 실제 날짜인지 (20yy 기준) */
function isValidYmd(code) {
  if (!/^\d{6}$/.test(String(code))) return false;
  var y = 2000 + Number(code.slice(0, 2));
  var m = Number(code.slice(2, 4));
  var d = Number(code.slice(4, 6));
  if (m < 1 || m > 12 || d < 1) return false;
  var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last;
}

function isAnnualCode(code) {
  return /^(\d{2})\1\1$/.test(String(code));
}

/** 연도(2026 또는 26) → 262626 */
function annualCode(year) {
  var yy = pad2_(Number(year) % 100);
  return yy + yy + yy;
}

/** 날짜코드 검증: 정상 날짜 또는 연간코드 */
function isValidCode(code) {
  return isAnnualCode(code) || isValidYmd(code);
}

function buildAlbumName(code, team, program) {
  return code + '_' + team + '_' + program;
}

/** 밀리초 시각 → 한국시간 yymmdd */
function codeFromMs(ms) {
  var d = new Date(Number(ms) + KST_OFFSET_MS);
  return pad2_(d.getUTCFullYear() % 100) + pad2_(d.getUTCMonth() + 1) + pad2_(d.getUTCDate());
}

/** yymmdd → 2026.01.15 */
function codeToDots(code) {
  return '20' + code.slice(0, 2) + '.' + code.slice(2, 4) + '.' + code.slice(4, 6);
}

/** 확장자 (소문자, 점 포함). 없으면 .jpg */
function fileExt(fileName) {
  var m = String(fileName || '').match(/\.([A-Za-z0-9]{1,5})$/);
  return m ? '.' + m[1].toLowerCase() : '.jpg';
}

/**
 * 앨범 안 파일 이름. 번호는 앨범별로 겹치지 않게 서버가 준다.
 * 날짜 앨범: 260102_기획팀_시무식_001.jpg
 * 연간 앨범: 262626_기획팀_한글_260115_001.jpg (촬영일 포함)
 */
function buildUploadName(albumName, annual, shotCode, seq, ext) {
  var n = String(seq);
  while (n.length < 3) n = '0' + n;
  var mid = annual && isValidYmd(shotCode) ? '_' + shotCode : '';
  return albumName + mid + '_' + n + (ext || '.jpg');
}

/** 팀 이름 후보 키 목록: 팀이름, '팀' 뗀 이름, 약칭들 */
function teamKeys_(team) {
  var keys = [compactKey(team.name)];
  var name = normalizeText(team.name);
  if (/팀$/.test(name) && name.length >= 3) keys.push(compactKey(name.slice(0, -1)));
  (team.aliases || []).forEach(function (a) {
    var k = compactKey(a);
    if (k) keys.push(k);
  });
  return keys.filter(function (k, i, arr) { return k && arr.indexOf(k) === i; });
}

// 점은 숫자 사이(1.5km)가 아닐 때만 구분자로 본다
var TOKEN_SPLIT_ = /[\s_\-,()\[\]{}~+]+|(?<!\d)\.|\.(?!\d)/;

/** 토큰 목록에서 팀을 찾아 {team, tokens(팀 제거)} 반환. 순서 번호가 붙은 폴더(7온마을팀, 07.기획팀)도 인식 */
function findTeam_(tokens, teams) {
  tokens = tokens.slice();
  for (var t = 0; t < tokens.length; t++) {
    var tk = compactKey(tokens[t]);
    var tkNoNum = tk.replace(/^\d{1,2}/, '');
    for (var j = 0; j < teams.length; j++) {
      var keys = teamKeys_(teams[j]);
      var hit = keys.indexOf(tk) >= 0 ? tk : (tkNoNum !== tk && keys.indexOf(tkNoNum) >= 0 ? tkNoNum : null);
      if (hit) {
        var name = teams[j].name;
        var removed = tokens.splice(t, 1)[0];
        // 팀 이름('문화누리팀'·'문화누리')이 아니라 약칭('일상' 등 흔한 말일 수 있음)으로 찾았는지
        var viaAlias = keys.indexOf(hit) >= (/팀$/.test(normalizeText(name)) && normalizeText(name).length >= 3 ? 2 : 1);
        return { team: name, tokens: tokens, viaAlias: viaAlias, removed: removed, at: t };
      }
    }
  }
  // 붙여 쓴 경우: 기획팀시무식
  for (var t2 = 0; t2 < tokens.length; t2++) {
    var tok = normalizeText(tokens[t2]);
    for (var j2 = 0; j2 < teams.length; j2++) {
      var nm = normalizeText(teams[j2].name);
      if (/팀$/.test(nm) && tok.indexOf(nm) === 0 && tok.length > nm.length) {
        tokens[t2] = tok.slice(nm.length);
        return { team: teams[j2].name, tokens: tokens, viaPrefix: true }; // 기획팀장 등 오인 가능 → 확인 필요
      }
    }
  }
  return { team: null, tokens: tokens };
}

var DATE_PATTERNS_ = [
  // 2026.01.02 / 2026-1-2 / 2026년 1월 2일
  { re: '(20\\d{2})\\s*[.\\-\\/년]\\s*(\\d{1,2})\\s*[.\\-\\/월]\\s*(\\d{1,2})\\s*일?', f: function (m) { return m[1].slice(2) + pad2_(m[2]) + pad2_(m[3]); } },
  // 20260102
  { re: '(20\\d{2})(\\d{2})(\\d{2})', f: function (m) { return m[1].slice(2) + m[2] + m[3]; } },
  // 26.01.02 / 26-1-2
  { re: '(\\d{2})\\s*[.\\-\\/]\\s*(\\d{1,2})\\s*[.\\-\\/]\\s*(\\d{1,2})', f: function (m) { return m[1] + pad2_(m[2]) + pad2_(m[3]); } },
  // 260102 / 262626
  { re: '(\\d{2})(\\d{2})(\\d{2})', f: function (m) { return m[1] + m[2] + m[3]; } }
];

/** 날짜 뒤에 붙은 기간 표기(~25, -25일, ~0725) 떼기 */
var RANGE_TAIL_ = /^\s*[~\-]\s*\d{1,8}\s*일?(?!\d)/;

/**
 * 온전한 날짜 찾기: 앞 → 뒤 → 가운데(괄호 안 등) 순서.
 * 예) 260102_…, …_260102, 개관기념행사(20250224), 다함께가을(20251001_한복체험사진)
 * 실제 있는 날짜만 받아들인다. 반환: {code, rest, pos:'start'|'end'|'mid', delimited, range}
 */
function extractDate_(s) {
  var where = [
    function (src) { return new RegExp('^' + src + '(?!\\d)'); },
    function (src) { return new RegExp('(?:^|[^\\d])' + src + '$'); },
    function (src) { return new RegExp('(?:^|[^\\d])' + src + '(?!\\d)'); }
  ];
  var posName = ['start', 'end', 'mid'];
  for (var w = 0; w < where.length; w++) {
    for (var i = 0; i < DATE_PATTERNS_.length; i++) {
      var p = DATE_PATTERNS_[i];
      var m = s.match(where[w](p.re));
      if (!m) continue;
      var matched = m[0];
      var lead = (w >= 1 && !/^\d/.test(matched)) ? 1 : 0;
      var groups = m.slice(1);
      groups.unshift(matched.slice(lead));
      var code = p.f(groups);
      if (!isValidYmd(code) && !isAnnualCode(code)) continue;
      var start = m.index + lead;
      var end = m.index + matched.length;
      var after = s.slice(end);
      var range = false;
      var rt = after.match(RANGE_TAIL_);
      if (rt) { range = true; after = after.slice(rt[0].length); }
      var before = s.slice(0, start);
      var delimited = /[(\[_]\s*$/.test(before) || /^\s*[)\]_]/.test(after);
      return { code: code, rest: (before + ' ' + after).trim(), pos: posName[w], delimited: delimited, range: range, sixDigit: i === DATE_PATTERNS_.length - 1 };
    }
  }
  return null;
}

function validMonthDay_(mo, d) {
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}

/**
 * 연도 없는 날짜(이름 맨 앞): "0723 캠페인", "1121 1205 인권교육"(여러 날 → 첫 날),
 * "1.7 비상하리", "1월 7일 비상하리", "7일 비상하리". 뒤에 영문·숫자·점이 붙으면 날짜로 보지 않는다(1.5km).
 * extra: 뒤에 이어진 다른 날짜들(월일), range: 기간 표기(0723~25)
 */
function extractPartialDate_(s) {
  var END = '(?![0-9A-Za-z.])';
  var res = null;
  var m4 = s.match(new RegExp('^(\\d{2})(\\d{2})' + END));
  if (m4 && validMonthDay_(Number(m4[1]), Number(m4[2]))) {
    var rest = s.slice(m4[0].length);
    var extra = [];
    var more;
    while ((more = rest.match(new RegExp('^[\\s_,]*(\\d{2})(\\d{2})' + END))) && validMonthDay_(Number(more[1]), Number(more[2]))) {
      extra.push(more[1] + '.' + more[2]);
      rest = rest.slice(more[0].length);
    }
    res = { month: Number(m4[1]), day: Number(m4[2]), rest: rest, extra: extra };
  }
  if (!res) {
    var m = s.match(new RegExp('^(\\d{1,2})\\s*(?:[.\\-\\/]|월)\\s*(\\d{1,2})\\s*일?' + END));
    if (m && !/^\d{1,2}\s*[.\-\/]\s*\d{1,2}\s*[.\-\/]\s*\d/.test(s) && validMonthDay_(Number(m[1]), Number(m[2]))) {
      res = { month: Number(m[1]), day: Number(m[2]), rest: s.slice(m[0].length), extra: [] };
    }
  }
  if (!res) {
    var d = s.match(/^(\d{1,2})\s*일(?!\d)/);
    if (d && Number(d[1]) >= 1 && Number(d[1]) <= 31) res = { month: null, day: Number(d[1]), rest: s.slice(d[0].length), extra: [] };
  }
  if (!res) return null;
  var rt = res.rest.match(RANGE_TAIL_);
  if (rt) { res.range = true; res.rest = res.rest.slice(rt[0].length); }
  res.rest = res.rest.trim();
  return res;
}

/** 상위 폴더 이름들(가까운 순)에서 연도·월 찾기: "2026", "2026.1.", "1월", "2026년 1월". 연도가 둘인 폴더("2024-2025")는 연도로 쓰지 않음 */
function yearMonthFromAncestors_(ancestors) {
  var year = null, month = null, ambiguous = false;
  for (var i = 0; i < ancestors.length; i++) {
    var a = normalizeText(ancestors[i]);
    var years = (a.match(/(?:^|[^\d])(20\d{2})(?!\d)/g) || []).map(function (x) { return x.replace(/\D/g, ''); })
      .filter(function (y, k, arr) { return arr.indexOf(y) === k; });
    if (years.length > 1) { if (!year) ambiguous = true; continue; }
    var ym = a.match(/(20\d{2})\s*[.\-\/년]\s*(\d{1,2})(?!\d)/);
    if (ym) {
      if (!year) year = Number(ym[1]);
      if (!month && Number(ym[2]) >= 1 && Number(ym[2]) <= 12) month = Number(ym[2]);
    }
    if (years.length === 1 && !year) year = Number(years[0]);
    var mo = a.match(/(?:^|[^\d])(\d{1,2})\s*월/);
    if (mo && !month && Number(mo[1]) >= 1 && Number(mo[1]) <= 12) month = Number(mo[1]);
  }
  var all = [];
  ancestors.forEach(function (x) {
    (normalizeText(x).match(/(?:^|[^\d])(20\d{2})(?!\d)/g) || []).forEach(function (y) {
      y = y.replace(/\D/g, '');
      if (all.indexOf(y) < 0) all.push(y);
    });
  });
  return { year: year, month: month, ambiguous: (ambiguous && !year) || all.length > 1 };
}

/** 폴더 앞 순서 표시: "01. ", "10.", "ㅎ. ", "A) ", "03_". 뒤에 숫자가 오면(1.7 행사, 26.01.02) 날짜라서 떼지 않는다 */
var ORDER_PREFIX_ = /^\s*(?:\d{1,2}\s*[.)_\-](?!\s*\d)|[ㄱ-ㅎA-Za-z]\s*[.)](?![A-Za-z]))\s*/;

/**
 * 팀·연도·월 폴더와 사진 폴더 사이에 있는 중간 폴더들(가까운 순 ancestors)을 읽는다.
 * 예) 6문화누리팀 / 10. 취미여가(숲친구) / 20251104 서오릉 → words ['취미여가 숲친구']
 *     8기획팀 / 전직원회의 / 0910 / 서부의 사계 → words ['전직원회의'], 날짜 '0910'
 * 팀·연도·월 폴더를 만나면 멈춘다. 그런 경계가 없으면 맨 위(직접 고른) 폴더는 넣지 않는다.
 * 순서 표시(10. / ㅎ. / 03_)는 뗀다.
 */
/** 상위 폴더(가까운 것부터)에서 팀 찾기. 팀 이름으로 맞은 폴더를 약칭으로 맞은 폴더보다 먼저 쓴다 */
function ancestorTeam_(ancestors, teams) {
  var alias = null;
  for (var i = 0; i < ancestors.length; i++) {
    var a = normalizeText(ancestors[i]);
    var ft = findTeam_(a.split(TOKEN_SPLIT_).filter(Boolean), teams);
    if (!ft.team || ft.viaPrefix) continue;
    if (!ft.viaAlias) return { team: ft.team, from: a, viaAlias: false };
    if (!alias) alias = { team: ft.team, from: a, viaAlias: true };
  }
  return alias || { team: null, from: '', viaAlias: false };
}

function middleFolders_(ancestors, teams) {
  var words = [], dateText = '', dateFrom = '';
  for (var i = 0; i < ancestors.length; i++) {
    var a = normalizeText(ancestors[i]);
    var fd = extractDate_(a);
    if (fd && isAnnualCode(fd.code)) fd = null;
    if (!fd && (/(?:^|[^\d])20\d{2}(?!\d)/.test(a) || /(?:^|[^\d])\d{1,2}\s*월/.test(a))) break; // 연도·월 폴더
    var ft = findTeam_(a.split(TOKEN_SPLIT_).filter(Boolean), teams);
    // 팀 폴더. 약칭으로만 맞은 폴더('일상 프로그램')는 더 위에 진짜 팀 폴더가 있으면 팀 폴더로 보지 않는다
    if (ft.team && !ft.viaPrefix && !(ft.viaAlias && ancestorTeam_(ancestors.slice(i + 1), teams).team && !ancestorTeam_(ancestors.slice(i + 1), teams).viaAlias)) break;
    if (i === ancestors.length - 1) break; // 경계 없이 맨 위까지 오면 고른 폴더 이름은 넣지 않음
    var rest = a;
    if (fd) {
      if (!dateText) { dateText = fd.code; dateFrom = a; }
      rest = fd.rest;
    } else {
      var pd = extractPartialDate_(a);
      if (pd && pd.month) {
        if (!dateText) { dateText = pad2_(pd.month) + pad2_(pd.day); dateFrom = a; }
        rest = pd.rest;
      }
    }
    rest = rest.replace(ORDER_PREFIX_, '');
    rest = rest.split(TOKEN_SPLIT_).filter(Boolean).join(' ');
    if (rest) words.unshift(rest);
  }
  return { words: words, dateText: dateText, dateFrom: dateFrom };
}

function codeDays_(code) {
  return Date.UTC(2000 + Number(code.slice(0, 2)), Number(code.slice(2, 4)) - 1, Number(code.slice(4, 6))) / 86400000;
}

var ANNUAL_WORD_ = /(^|[\s_\-(\[])(연간|1년|일년)(사업)?(?=$|[\s_\-)\]])/;

/**
 * 폴더 이름을 앨범 규칙으로 해석한다. 확실하지 않으면 ok=false(확인 필요)로 돌려준다.
 * @param {string} raw 사진이 든 폴더 이름
 * @param {{name:string, aliases?:string[]}[]} teams 사용 중인 팀 목록
 * @param {{hintCode?:string, year?:number, ancestors?:string[]}} [opts]
 *   hintCode: 사진 파일 날짜(가장 이른 것, yymmdd), year: 올해, ancestors: 상위 폴더 이름(가까운 순)
 * @return {{code:string|null, annual:boolean, team:string|null, program:string, issues:string[], notes:string[], ok:boolean}}
 */
function parseFolderName(raw, teams, opts) {
  opts = opts || {};
  teams = teams || [];
  var ancestors = opts.ancestors || [];
  var s = normalizeText(raw).replace(ORDER_PREFIX_, ''); // 01. 성인문해 → 성인문해
  var issues = [];
  var notes = []; // 안내만 하고 '확인 필요'로 막지 않는 것
  var mid = middleFolders_(ancestors, teams);
  // 사진 폴더 이름에 날짜가 없고 중간 폴더에 날짜가 있으면(…/0910/서부의 사계) 그 날짜를 쓴다
  if (mid.dateText && !extractDate_(s) && !extractPartialDate_(s)) {
    s = mid.dateText + ' ' + s;
    notes.push('날짜는 상위 폴더(' + mid.dateFrom + ')에서 찾았습니다');
  }
  var code = null;
  var annual = false;
  var fromName = false;
  var anc = yearMonthFromAncestors_(ancestors);
  var hint = opts.hintCode && isValidYmd(opts.hintCode) ? opts.hintCode : null;
  var curYear = Number(opts.year) || new Date().getFullYear();

  var d = extractDate_(s);
  if (d) {
    code = d.code; annual = isAnnualCode(d.code); s = d.rest; fromName = true;
    if (d.pos === 'mid' && !d.delimited && d.sixDigit) issues.push('이름 가운데 숫자를 날짜(' + codeToDots(code) + ')로 읽었습니다. 맞는지 확인하세요');
    if (d.range) notes.push('기간 표기라 첫날로 정했습니다');
    var d2 = extractDate_(s);
    if (d2) issues.push('날짜가 여러 개라 앞의 날짜(' + (annual ? '연간' : codeToDots(code)) + ')로 정했습니다');
  }

  // 연도 없는 날짜 → 상위 폴더(예: "2025 사진", "1월")에서 연도·월 채우기
  if (!code) {
    var pd = extractPartialDate_(s);
    if (pd) {
      var month = pd.month || anc.month;
      if (anc.ambiguous) {
        issues.push('상위 폴더에 연도가 여러 개라 연도를 정할 수 없습니다');
      } else if (anc.year && month) {
        var c = pad2_(anc.year % 100) + pad2_(month) + pad2_(pd.day);
        if (isValidYmd(c)) {
          code = c; s = pd.rest;
          notes.push('연도' + (pd.month ? '' : '·월') + '는 상위 폴더에서 채웠습니다');
          if (pd.range) notes.push('기간 표기라 첫날로 정했습니다');
          if (pd.extra && pd.extra.length) {
            issues.push('날짜가 여러 개(' + [pad2_(pd.month) + '.' + pad2_(pd.day)].concat(pd.extra).join(', ') + ')라 첫 날짜로 정했습니다');
          }
          // 프로그램명 앞 숫자(1004 천사데이 등)를 날짜로 잘못 읽는 경우 대비: 사진 날짜와 크게 다르면 확인
          if (!hint) {
            issues.push('이름 앞 숫자를 날짜(' + codeToDots(c) + ')로 읽었습니다. 사진 날짜로 확인할 수 없어 확인이 필요합니다');
          } else if (Math.abs(codeDays_(c) - codeDays_(hint)) > 45) {
            issues.push('폴더 이름의 날짜(' + codeToDots(c) + ')와 사진 날짜(' + codeToDots(hint) + ')가 많이 다릅니다. 앞 숫자가 날짜가 맞는지 확인하세요');
          }
        }
      } else if (!anc.year) {
        issues.push('폴더 이름에 연도가 없고 상위 폴더에서도 찾지 못했습니다');
      }
    }
  }

  // '연간', '1년' 표기 (단어로 쓴 경우만: 21년·연간계획은 제외)
  if (ANNUAL_WORD_.test(s)) {
    s = s.replace(new RegExp(ANNUAL_WORD_.source, 'g'), '$1 ').replace(/[(\[]\s*[)\]]/g, ' ');
    if (!code) {
      var yr = s.match(/(?:^|[^\d])(20\d{2})(?!\d)/);
      if (yr) {
        code = annualCode(yr[1]); annual = true; fromName = true;
        s = s.replace(yr[1], ' ');
      } else {
        var ay = anc.year || opts.year;
        if (ay) {
          code = annualCode(ay); annual = true;
          issues.push('연도를 이름에서 찾지 못해 ' + ay + '년 연간 앨범으로 정했습니다');
        }
      }
    } else if (!annual) {
      issues.push('연간 표기가 있지만 날짜가 있어 날짜 앨범으로 정했습니다');
    }
  }

  // 연도 확인: 너무 먼 연도, 상위 폴더 연도와 다름
  if (code) {
    var y = 2000 + Number(code.slice(0, 2));
    if (y < curYear - 15 || y > curYear + 1) issues.push('연도(' + y + ')가 이상합니다. 날짜를 확인하세요');
    else if (annual && (y < curYear - 5 || y > curYear + 1)) issues.push('연간 앨범 연도(' + y + ')가 올해와 많이 다릅니다');
    if (fromName && anc.year && anc.year !== y) issues.push('폴더 이름의 연도(' + y + ')와 상위 폴더의 연도(' + anc.year + ')가 다릅니다');
  }
  if (anc.ambiguous) notes.push('상위 폴더에 연도가 둘이라 연도로 쓰지 않았습니다');

  // 팀
  var found = findTeam_(s.split(TOKEN_SPLIT_).filter(Boolean), teams);
  var team = found.team;
  if (found.viaPrefix) issues.push('팀 이름(' + team + ')이 다른 글자와 붙어 있어 나눴습니다. 맞는지 확인하세요');
  if (team) {
    var second = findTeam_(found.tokens, teams);
    if (second.team && second.team !== team && !second.viaPrefix) issues.push('팀 이름이 여러 개(' + team + ', ' + second.team + ')입니다');
  }
  var anc2 = ancestorTeam_(ancestors, teams);
  var ancTeam = anc2.team, ancTeamFrom = anc2.from;
  // 약칭으로만 찾은 팀(예: '일상')이 상위 폴더의 팀과 다르면, 그 말은 프로그램명으로 보고 상위 폴더의 팀을 쓴다
  if (team && found.viaAlias && ancTeam && team !== ancTeam && !anc2.viaAlias) {
    found.tokens.splice(found.at, 0, found.removed);
    notes.push('\'' + normalizeText(found.removed) + '\'은(는) ' + team + ' 약칭이지만 상위 폴더가 ' + ancTeam + '이라 프로그램명으로 봤습니다');
    team = null;
  }
  if (team && ancTeam && team !== ancTeam) issues.push('폴더 이름의 팀(' + team + ')과 상위 폴더의 팀(' + ancTeam + ')이 다릅니다');
  if (!team && ancTeam) { team = ancTeam; notes.push('팀은 상위 폴더(' + ancTeamFrom + ')에서 찾았습니다'); }

  // 중간 폴더 이름을 프로그램명 앞에 붙인다 (이미 들어 있는 말은 빼고)
  var leafProg = found.tokens.join(' ');
  var addWords = mid.words.filter(function (w) { return compactKey(leafProg).indexOf(compactKey(w)) < 0; });
  if (addWords.length) notes.push('프로그램명 앞에 상위 폴더 이름(' + addWords.join(' · ') + ')을 붙였습니다');
  var fullProg = addWords.concat(leafProg ? [leafProg] : []).join(' ');
  var program = cleanProgram(fullProg);
  if (normalizeText(fullProg).length > NAMING_MAX_PROGRAM_LEN) issues.push('프로그램명이 길어 ' + NAMING_MAX_PROGRAM_LEN + '자로 줄였습니다');

  // 날짜 없는 폴더가 연도 폴더 안에 있으면: 1년 내내 하는 사업으로 보고 그해 연간 앨범 제안
  if (!code && anc.year) {
    code = annualCode(anc.year); annual = true;
    issues.push('폴더 이름에 날짜가 없어 ' + anc.year + '년 연간 앨범으로 정했습니다. 한 번 행사라면 날짜를 넣으세요');
  }
  if (!code && hint) {
    code = hint;
    issues.push('폴더 이름에 날짜가 없어 사진 날짜로 추정했습니다');
  }
  if (!code) issues.push('날짜를 찾지 못했습니다');
  if (!team) issues.push('팀을 찾지 못했습니다');
  if (!program) issues.push('프로그램명이 비어 있습니다');

  return { code: code, annual: annual, team: team, program: program, issues: issues, notes: notes, ok: !!(code && team && program) && issues.length === 0 };
}

/** 같은 팀에 띄어쓰기·기호만 다른 프로그램이 있으면 기존 표기를 쓴다 (programs: 최근 것 먼저) */
function canonicalProgramFrom(programs, program) {
  var key = compactKey(program);
  for (var i = 0; i < (programs || []).length; i++) {
    if (compactKey(programs[i]) === key) return programs[i];
  }
  return program;
}

// node 테스트·브라우저 공용 내보내기 (Apps Script에서는 무시됨)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeText: normalizeText, compactKey: compactKey, cleanProgram: cleanProgram,
    isValidYmd: isValidYmd, isAnnualCode: isAnnualCode, annualCode: annualCode, isValidCode: isValidCode,
    buildAlbumName: buildAlbumName, codeFromMs: codeFromMs, codeToDots: codeToDots, fileExt: fileExt,
    buildUploadName: buildUploadName, parseFolderName: parseFolderName, canonicalProgramFrom: canonicalProgramFrom
  };
}
