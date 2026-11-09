/**
 * 사진 촬영일 읽기 (외부 라이브러리 없음)
 * - JPEG: EXIF DateTimeOriginal(0x9003) → 없으면 DateTime(0x0132)
 * - HEIC 등: 앞부분에서 EXIF 날짜 문자열("2026:01:07 11:06:00")을 찾는다
 * - 못 찾으면 null → 호출하는 쪽에서 파일 수정 시각을 쓴다
 * 시간대 정보가 없으면 한국시간으로 본다.
 */
(function (root) {
  'use strict';
  var KST = 9 * 3600 * 1000;

  function exifStringToMs(s, offset) {
    var m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || '').trim());
    if (!m || m[1] === '0000') return null;
    var utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    var off = KST;
    var om = /^([+-])(\d{2}):(\d{2})$/.exec(String(offset || '').trim());
    if (om) off = (om[1] === '-' ? -1 : 1) * (+om[2] * 3600 + +om[3] * 60) * 1000;
    var ms = utc - off;
    // 1990년 이전·미래 1일 이후는 잘못된 값으로 본다
    if (ms < Date.UTC(1990, 0, 1) || ms > Date.now() + 86400000) return null;
    return ms;
  }

  function readAscii(view, off, len) {
    var s = '';
    for (var i = 0; i < len && off + i < view.byteLength; i++) {
      var c = view.getUint8(off + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** TIFF 블록에서 태그 값 읽기 */
  function parseTiff(view, start) {
    var little = view.getUint16(start) === 0x4949;
    var u16 = function (o) { return view.getUint16(start + o, little); };
    var u32 = function (o) { return view.getUint32(start + o, little); };
    var out = {};
    function readIfd(ifdOff, wanted) {
      if (ifdOff <= 0 || start + ifdOff + 2 > view.byteLength) return;
      var n = u16(ifdOff);
      for (var i = 0; i < n; i++) {
        var e = ifdOff + 2 + i * 12;
        if (start + e + 12 > view.byteLength) return;
        var tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        if (wanted[tag] && type === 2) {
          var valOff = count > 4 ? u32(e + 8) : e + 8;
          out[wanted[tag]] = readAscii(view, start + valOff, count);
        }
        if (tag === 0x8769) out._exifIfd = u32(e + 8);
      }
    }
    readIfd(u32(4), { 0x0132: 'DateTime' });
    if (out._exifIfd) readIfd(out._exifIfd, { 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x9011: 'OffsetTimeOriginal' });
    return out;
  }

  /** ArrayBuffer(파일 앞부분) → 촬영 시각(ms) 또는 null */
  function parseShotTime(buffer) {
    var view = new DataView(buffer);
    try {
      if (view.byteLength > 4 && view.getUint16(0) === 0xFFD8) {
        var off = 2;
        while (off + 4 < view.byteLength) {
          var marker = view.getUint16(off);
          var len = view.getUint16(off + 2);
          if (marker === 0xFFE1 && readAscii(view, off + 4, 4) === 'Exif') {
            var t = parseTiff(view, off + 10);
            return exifStringToMs(t.DateTimeOriginal || t.DateTimeDigitized || t.DateTime, t.OffsetTimeOriginal);
          }
          if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
          off += 2 + len;
        }
        return null;
      }
    } catch (e) { /* 손상된 파일은 아래 방법으로 */ }
    // HEIC 등: EXIF 날짜 문자열 찾기
    var bytes = new Uint8Array(buffer);
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var c = bytes[i];
      s += (c >= 0x20 && c < 0x7F) ? String.fromCharCode(c) : '\u0001';
    }
    var m = s.match(/\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}/);
    return m ? exifStringToMs(m[0]) : null;
  }

  /** File → 촬영 시각(ms) 또는 null (앞 256KB만 읽는다) */
  function readShotTime(file) {
    if (!file || !/^image\//.test(file.type || '') && !/\.(jpe?g|heic|heif)$/i.test(file.name || '')) return Promise.resolve(null);
    return file.slice(0, 256 * 1024).arrayBuffer().then(parseShotTime).catch(function () { return null; });
  }

  var api = { parseShotTime: parseShotTime, readShotTime: readShotTime, exifStringToMs: exifStringToMs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Exif = api;
})(this);
