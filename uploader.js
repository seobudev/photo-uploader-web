/**
 * 업로드 엔진 (화면과 분리 — node 테스트 가능)
 *
 * 흐름 (앨범 하나 기준, 촬영일 순서):
 *   ① 관리 서버 prepare: 앨범 확정·번호 예약 (20장 묶음, 다음 묶음은 미리 요청)
 *   ② 사진 원본을 구글포토로 직접 전송 (동시 3장) — 실패해도 사진이 생기지 않음 → '실패'
 *   ③ batchCreate로 앨범에 등록 (촬영일 순서 유지) — 요청이 나간 뒤 결과를 모르면 '확인필요'
 *   ④ 관리 서버 report: 결과 기록 (서버가 처리했다고 돌려준 것만 일지에서 지움)
 * 기기 일지(journal): ③ 직전에 'creating', 결과 후 'done'.
 *   - 일지에 결과가 남아 있는 사진은 다시 올리지 않고 그 결과를 먼저 기록한다(중복 방지).
 *   - 화면이 꺼져도 다음 실행 때 결과를 마저 기록한다.
 */
(function (root) {
  'use strict';

  var UPLOAD_URL = 'https://photoslibrary.googleapis.com/v1/uploads';
  var CREATE_URL = 'https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate';
  var CHUNK = 20;
  var PARALLEL = 3;
  var REPORT_MAX = 100;
  var CREATING_STALE_MS = 15 * 60 * 1000; // 다른 탭이 등록 중일 수 있는 시간

  function StopError(message) {
    var e = new Error(message);
    e.stop = true;
    return e;
  }

  /**
   * @param {object} d
   *  api(action, body) → Promise<data>       관리 서버 호출 (err.code==='LOGIN' 이면 로그인 필요)
   *  getToken(force) → Promise<string>       구글포토 올리기 권한
   *  fetch                                    fetch 함수
   *  journal {get(key), set(key,val), del(key), all()}
   *  device, user                             기기 ID, 로그인한 이메일(일지 구분)
   *  onItem(item)                             상태 변경 알림
   */
  function createEngine(d) {
    var stopped = null;

    function notify(item) {
      try { if (d.onItem) d.onItem(item); } catch (e) { /* 화면 오류가 업로드를 멈추지 않게 */ }
    }
    function setItem(item, status, note) {
      item.status = status;
      if (note != null) item.note = note;
      notify(item);
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    /** 권한을 받아 요청. 권한을 못 받으면 요청이 나가지 않았으므로 err.notSent=true */
    function photosFetch(url, opts, retried) {
      return d.getToken(!!retried).then(function (token) {
        var headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {});
        return d.fetch(url, Object.assign({}, opts, { headers: headers })).then(function (res) {
          if (res.status === 401 && !retried) return photosFetch(url, opts, true); // 401은 처리되지 않은 요청
          return res;
        });
      }, function (err) {
        err.notSent = true;
        throw err;
      });
    }

    function readText(res) {
      return Promise.resolve().then(function () { return res.text(); });
    }

    /** ② 원본 전송 (네트워크·5xx 오류는 2번까지 재시도). 전송은 사진을 만들지 않으므로 실패해도 안전 */
    function sendBytes(item, attempt) {
      attempt = attempt || 0;
      return photosFetch(UPLOAD_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Goog-Upload-Content-Type': item.file.type || 'application/octet-stream',
          'X-Goog-Upload-Protocol': 'raw'
        },
        body: item.file
      }).then(function (res) {
        return readText(res).then(function (t) {
          if (res.status === 200 && t) return t;
          if (res.status === 403 || res.status === 429 || res.status === 401) {
            throw StopError('구글포토 권한·한도 오류로 멈췄습니다 (HTTP ' + res.status + '). 관리자에게 알려주세요.');
          }
          if ((res.status >= 500 || res.status === 200) && attempt < 2) return sleep(1500 * (attempt + 1)).then(function () { return sendBytes(item, attempt + 1); });
          throw new Error('전송 실패 (HTTP ' + res.status + ')');
        });
      }).catch(function (err) {
        if (err && err.stop) throw err;
        if (err && err.notSent) throw StopError('올리기 권한을 받지 못했습니다: ' + err.message);
        if (/^전송 실패/.test(err && err.message)) throw err;
        if (attempt < 2) return sleep(1500 * (attempt + 1)).then(function () { return sendBytes(item, attempt + 1); });
        throw new Error('네트워크 오류로 전송하지 못했습니다');
      });
    }

    function journalSet(item, v) {
      v.row = item.row; v.user = d.user || ''; v.at = Date.now();
      d.journal.set(item.key, v);
    }

    /** ③ 앨범에 등록. 반환: [{item, status, mediaId, memo}] */
    function createInAlbum(albumId, ready) {
      ready.forEach(function (x) { journalSet(x.item, { state: 'creating' }); });
      var body = JSON.stringify({
        albumId: albumId,
        newMediaItems: ready.map(function (x) {
          return { description: x.item.description || '', simpleMediaItem: { fileName: x.item.uploadName, uploadToken: x.token } };
        })
      });
      var all = function (status, memo) { return ready.map(function (x) { return { item: x.item, status: status, memo: memo }; }); };
      return photosFetch(CREATE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
        .then(function (res) {
          return readText(res).then(function (t) {
            if (res.status === 200 || res.status === 207) {
              var j = null;
              try { j = JSON.parse(t); } catch (e) { return all('확인필요', '등록 응답을 읽지 못함'); }
              var byToken = {};
              (j.newMediaItemResults || []).forEach(function (r) { byToken[r.uploadToken] = r; });
              return ready.map(function (x) {
                var r = byToken[x.token];
                if (!r) return { item: x.item, status: '확인필요', memo: '등록 응답에 결과가 없음' };
                if (r.mediaItem && r.mediaItem.id) return { item: x.item, status: '성공', mediaId: r.mediaItem.id };
                if (r.mediaItem) return { item: x.item, status: '확인필요', memo: '등록 결과에 ID가 없음' };
                return { item: x.item, status: '실패', memo: '등록 거부: ' + (r.status && r.status.message || '알 수 없음') };
              });
            }
            if (res.status === 403 || res.status === 429) {
              var r403 = all('실패', 'HTTP ' + res.status);
              r403.stop = '구글포토 권한·한도 오류로 멈췄습니다 (HTTP ' + res.status + '). 관리자에게 알려주세요.';
              return r403;
            }
            // 확실히 처리되지 않은 요청(잘못된 요청·앨범 없음)만 '실패', 나머지는 '확인필요'
            if (res.status === 400 || res.status === 404) {
              var memo = /album/i.test(t) ? '앨범을 찾을 수 없습니다(구글포토에서 삭제됐을 수 있음). 관리자에게 알려주세요' : '등록 실패 (HTTP ' + res.status + ')';
              return all('실패', memo);
            }
            return all('확인필요', '등록 응답 오류 (HTTP ' + res.status + ')');
          });
        })
        .catch(function (err) {
          if (err && err.notSent) {
            var rs = all('실패', '올리기 권한을 받지 못해 등록하지 못함');
            rs.stop = '올리기 권한을 받지 못했습니다: ' + err.message;
            return rs;
          }
          // 요청이 나간 뒤 응답을 못 받음 → 자동 재시도하지 않는다
          return all('확인필요', '등록 응답을 받지 못함');
        })
        .then(function (results) {
          results.forEach(function (r) {
            journalSet(r.item, { state: 'done', status: r.status, mediaId: r.mediaId || '', memo: r.memo || '' });
          });
          if (results.stop) stopped = stopped || results.stop;
          return results;
        });
    }

    /** ④ 결과 기록. 서버가 처리했다고 돌려준 키만 일지에서 지운다. */
    function sendReports(payload) {
      if (!payload.length) return Promise.resolve(0);
      var p = Promise.resolve(0);
      for (var i = 0; i < payload.length; i += REPORT_MAX) {
        (function (part) {
          p = p.then(function (n) {
            return d.api('report', { device: d.device, results: part }).then(function (res) {
              var done = (res && res.done) || [];
              done.forEach(function (k) { d.journal.del(k); });
              return n + done.length;
            });
          });
        })(payload.slice(i, i + REPORT_MAX));
      }
      return p;
    }
    function report(results) {
      return sendReports(results.map(function (r) {
        return { row: r.item.row, key: r.item.key, status: r.status, mediaId: r.mediaId || '', memo: r.memo || '' };
      })).catch(function () { /* 일지에 남김 → 다음에 다시 기록 */ });
    }

    /** 일지 항목 → 보고 내용 (다른 탭이 등록 중일 수 있는 최근 'creating'은 건너뜀) */
    function journalPayload(key, j, now) {
      if (j.state === 'creating') {
        if (now - (j.at || 0) < CREATING_STALE_MS) return null;
        return { row: j.row, key: key, status: '확인필요', memo: '등록 중 화면이 닫힘' };
      }
      return { row: j.row, key: key, status: j.status, mediaId: j.mediaId || '', memo: j.memo || '' };
    }

    /** 지난번에 끝나지 못한 기록 마저 보내기 (지금 로그인한 사람 것만) */
    function flushJournal() {
      var all = d.journal.all();
      var now = Date.now();
      var payload = [];
      Object.keys(all).forEach(function (key) {
        var j = all[key];
        if (!j || !j.row) { d.journal.del(key); return; }
        if (j.user && d.user && j.user !== d.user) return;
        var p = journalPayload(key, j, now);
        if (p) payload.push(p);
      });
      return sendReports(payload);
    }

    function meta(it) {
      return { fileName: it.file.name, size: it.file.size, lastModified: it.file.lastModified, shotAt: it.shotAt, mimeType: it.file.type };
    }
    function localKey(it) { return [it.file.name, it.file.size, it.file.lastModified].join('|'); }

    /** 앨범 하나 올리기. items: [{file, shotAt}] — 촬영일 순으로 정렬해서 올린다 */
    function runAlbum(album, items) {
      // 같은 파일을 두 번 고른 경우 하나만 (묶음 경계에서 중복 업로드 방지)
      var seen = {};
      var list = [];
      items.forEach(function (it) {
        var k = localKey(it);
        if (seen[k]) { setItem(it, 'dup', '같은 사진을 두 번 골랐습니다'); return; }
        seen[k] = true;
        list.push(it);
      });
      list.sort(function (a, b) {
        return (a.shotAt || a.file.lastModified || 0) - (b.shotAt || b.file.lastModified || 0) || (a.file.name < b.file.name ? -1 : 1);
      });
      var chunks = [];
      for (var i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK));
      var reports = [];

      function prepare(chunk) {
        return d.api('prepare', { album: album, device: d.device, items: chunk.map(meta) });
      }

      function doChunk(idx, prepP) {
        if (idx >= chunks.length || stopped) return Promise.resolve();
        var chunk = chunks[idx];
        return prepP.then(function (prep) {
          var nextP = idx + 1 < chunks.length && !stopped ? prepare(chunks[idx + 1]) : null;
          if (nextP) nextP.catch(function () {});
          var toSend = [];
          var fromJournal = [];
          var now = Date.now();
          chunk.forEach(function (it, k) {
            var r = prep.items[k];
            it.albumName = prep.albumName;
            it.key = r.key;
            if (r.action === 'skip') return setItem(it, 'dup', '이미 올린 사진');
            if (r.action === 'check') return setItem(it, 'warn', r.message);
            it.row = r.row; it.uploadName = r.uploadName; it.description = r.description;
            var j = d.journal.get(r.key);
            if (j && j.state === 'creating') {
              var recent = now - (j.at || 0) < CREATING_STALE_MS;
              if (!recent) fromJournal.push({ item: it, status: '확인필요', memo: '이전 등록 결과가 불분명' });
              return setItem(it, 'warn', recent ? '다른 창에서 올리는 중일 수 있습니다' : '이전 등록 결과가 불분명해 관리자 확인이 필요합니다');
            }
            if (j && j.state === 'done') {
              // 이미 결과가 있는 사진: 다시 올리지 않고 결과만 기록
              fromJournal.push({ item: it, status: j.status, mediaId: j.mediaId, memo: j.memo });
              return setItem(it, j.status === '성공' ? 'ok' : j.status === '실패' ? 'err' : 'warn', j.status === '성공' ? '' : j.memo);
            }
            toSend.push(it);
          });
          if (fromJournal.length) reports.push(report(fromJournal));

          // ② 동시 전송
          var ready = [];
          var failed = [];
          var q = toSend.slice();
          function worker() {
            if (stopped || !q.length) return Promise.resolve();
            var it = q.shift();
            setItem(it, 'run', '');
            return sendBytes(it).then(function (token) {
              ready.push({ item: it, token: token });
              setItem(it, 'sent');
            }, function (err) {
              if (err.stop) stopped = stopped || err.message;
              failed.push({ item: it, status: '실패', memo: err.message });
              setItem(it, 'err', err.message);
            }).then(worker);
          }
          var workers = [];
          for (var w = 0; w < PARALLEL; w++) workers.push(worker());
          return Promise.all(workers).then(function () {
            if (failed.length) reports.push(report(failed));
            // 멈췄으면 아직 안 보낸 사진은 '대기'로 둔다(같은 기기에서 같은 번호로 이어 올리기)
            q.forEach(function (it) { setItem(it, 'wait', '중단됨'); });
            if (!ready.length) return;
            ready.sort(function (a, b) { return toSend.indexOf(a.item) - toSend.indexOf(b.item); });
            return createInAlbum(prep.albumId, ready).then(function (results) {
              results.forEach(function (r) {
                setItem(r.item, r.status === '성공' ? 'ok' : r.status === '실패' ? 'err' : 'warn', r.status === '성공' ? '' : r.memo);
              });
              reports.push(report(results));
            });
          }).then(function () {
            if (nextP) return doChunk(idx + 1, nextP);
          });
        });
      }

      if (!chunks.length) return Promise.resolve();
      return doChunk(0, prepare(chunks[0])).then(function () {
        return Promise.all(reports);
      }, function (err) {
        return Promise.all(reports).then(function () { throw err; });
      });
    }

    /** 여러 앨범 차례로. jobs: [{album, items}] → {count, stopped} */
    function run(jobs) {
      stopped = null;
      var all = [];
      jobs.forEach(function (j) { all = all.concat(j.items); });
      var p = flushJournal().catch(function () {});
      jobs.forEach(function (job) {
        p = p.then(function () {
          if (stopped) return;
          return runAlbum(job.album, job.items).catch(function (err) {
            stopped = stopped || (err.code === 'LOGIN' ? '로그인이 만료되었습니다. 다시 로그인한 뒤 같은 사진을 고르면 이어서 올립니다.' : err.message);
          });
        });
      });
      return p.then(function () {
        var c = { ok: 0, dup: 0, err: 0, warn: 0, wait: 0 };
        all.forEach(function (it) {
          if (it.status === 'run' || it.status === 'sent' || !it.status) setItem(it, 'wait', '중단됨');
          if (it.status === 'ok') c.ok++; else if (it.status === 'dup') c.dup++; else if (it.status === 'err') c.err++; else if (it.status === 'warn') c.warn++; else c.wait++;
        });
        return { count: c, stopped: stopped, total: all.length };
      });
    }

    return { run: run, flushJournal: flushJournal };
  }

  var api = { createEngine: createEngine, CHUNK: CHUNK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Uploader = api;
})(this);
