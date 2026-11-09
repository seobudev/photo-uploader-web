/* 사진도구 화면 — naming.js, exif.js, uploader.js, config.js 다음에 불러온다 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var S = { server: '', cfg: null, session: null, boot: null, queue: [], folders: [], busy: false, token: null, engine: null };

  /* ───────── 저장소 (실패해도 동작) ───────── */
  function lsGet(k, def) { try { var v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 무시 */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* 무시 */ } }

  function deviceId() {
    var id = lsGet('photo.device', '');
    if (!id) { id = 'D' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); lsSet('photo.device', id); }
    return id;
  }
  var journal = {
    _k: function () { return 'photo.journal.' + S.server; },
    all: function () { return lsGet(this._k(), {}); },
    get: function (key) { return this.all()[key] || null; },
    set: function (key, v) { var a = this.all(); a[key] = v; lsSet(this._k(), a); },
    del: function (key) { var a = this.all(); delete a[key]; lsSet(this._k(), a); }
  };

  /* ───────── 공통 ───────── */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function msg(el, type, text) { el.innerHTML = text ? '<div class="msg ' + type + '">' + esc(text) + '</div>' : ''; }
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function dateInputToCode(v) { return v ? v.slice(2, 4) + v.slice(5, 7) + v.slice(8, 10) : ''; }
  function codeToDateInput(c) { return '20' + c.slice(0, 2) + '-' + c.slice(2, 4) + '-' + c.slice(4, 6); }
  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || ''));
  }
  function show(screen) {
    ['screen-login', 'screen-connect'].forEach(function (id) { $(id).classList.toggle('hidden', id !== screen); });
    $('screen-app').classList.toggle('hidden', screen !== 'screen-app');
  }
  function isMediaFile(f) {
    return /^(image|video)\//.test(f.type) || /\.(jpe?g|png|gif|heic|heif|webp|avif|dng|mp4|mov|m4v|3gp|avi|mkv|webm)$/i.test(f.name);
  }

  var SERVER_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
  function retryErr(m) { var e = new Error(m); e.retryable = true; return e; }

  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' })
      .then(function (r) {
        if (!r.ok) throw retryErr('서버 응답 오류 (HTTP ' + r.status + ')');
        return r.json();
      }, function () { throw retryErr('서버에 연결할 수 없습니다. 인터넷 연결과 주소를 확인하세요.'); })
      .then(function (j) {
        if (!j.ok) { var e = new Error(j.error || '오류'); e.code = j.code; throw e; }
        return j.data;
      });
  }
  /** 다시 시도해도 안전한 요청(준비·기록·조회)은 서버가 바쁘거나 연결이 끊기면 몇 번 더 시도 */
  var RETRY_ACTIONS = { prepare: 1, report: 1, bootstrap: 1, config: 1, adminStatus: 1 };
  function api(action, body, attempt) {
    attempt = attempt || 0;
    var req = Object.assign({ action: action, session: S.session && S.session.token }, body || {});
    return post(S.server, req).catch(function (e) {
      if (e.code === 'LOGIN') { lsDel('photo.session.' + S.server); S.session = null; }
      if (RETRY_ACTIONS[action] && (e.code === 'BUSY' || e.retryable) && attempt < 5) {
        return new Promise(function (r) { setTimeout(r, 1500 * Math.pow(2, attempt)); }).then(function () { return api(action, body, attempt + 1); });
      }
      throw e;
    });
  }
  /** 구글포토 올리기 권한: 40분마다 또는 요청 시 새로 받는다. 동시에 여러 장이 요청해도 한 번만 받는다 */
  var tokenPending = null;
  function getToken(force) {
    var fresh = S.token && Date.now() - S.token.at < (force ? 15 * 1000 : 40 * 60 * 1000);
    if (fresh) return Promise.resolve(S.token.value);
    if (tokenPending) return tokenPending;
    var attempt = 0;
    function once() {
      return post(S.cfg.tokenUrl, { action: 'token', session: S.session && S.session.token }).catch(function (e) {
        if (e.retryable && attempt++ < 2) return new Promise(function (r) { setTimeout(r, 2000); }).then(once);
        throw e;
      });
    }
    tokenPending = once().then(function (d) {
      S.token = { value: d.token, at: Date.now() };
      return d.token;
    }, function (e) {
      if (e.code === 'LOGIN') { var x = new Error('로그인이 만료되었습니다.'); x.code = 'LOGIN'; x.stop = true; throw x; }
      e.stop = true;
      throw e;
    }).then(function (v) { tokenPending = null; return v; }, function (e) { tokenPending = null; throw e; });
    return tokenPending;
  }

  /* ───────── 화면 꺼짐 방지 ───────── */
  var wake = null;
  function keepAwake(on) {
    if (!('wakeLock' in navigator)) return;
    if (on && !wake) navigator.wakeLock.request('screen').then(function (w) { wake = w; w.addEventListener('release', function () { wake = null; }); }).catch(function () {});
    if (!on && wake) { wake.release().catch(function () {}); wake = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (S.busy && document.visibilityState === 'visible') keepAwake(true);
  });
  window.addEventListener('beforeunload', function (e) {
    if (S.busy) { e.preventDefault(); e.returnValue = ''; }
  });
  function setBusy(on) {
    S.busy = on;
    keepAwake(on);
    var n = $('busyNotice');
    n.classList.toggle('hidden', !on);
    n.textContent = isMobile()
      ? '⚠ 올리는 중입니다. 다 끝날 때까지 화면을 끄거나 다른 앱으로 넘어가지 마세요.'
      : '올리는 중입니다. 다른 창에서 일해도 되지만, 이 창을 닫거나 PC를 절전 모드로 두지 마세요.';
  }

  /* ───────── 시작: 연결 → 로그인 → 앱 ───────── */
  function start() {
    var baked = window.PHOTO_CONFIG && window.PHOTO_CONFIG.serverUrl;
    var qs = (new URLSearchParams(location.search).get('s') || '').trim();
    if (qs) history.replaceState(null, '', location.pathname);
    if (baked) { S.server = baked; connect(); return; } // 기관 주소가 정해진 화면은 ?s= 를 무시(피싱 방지)
    var trusted = lsGet('photo.server', '');
    if (qs && qs !== trusted) {
      if (!SERVER_RE.test(qs)) { show('screen-connect'); msg($('connectMsg'), 'err', '주소의 연결 정보가 올바르지 않습니다. 관리자에게 받은 주소인지 확인하세요.'); return; }
      S.server = qs; connect({ confirm: true }); return; // 처음 보는 서버: 확인 후 연결
    }
    S.server = trusted;
    if (!S.server) { show('screen-connect'); return; }
    connect();
  }

  function connect(opt) {
    opt = opt || {};
    $('who').textContent = '연결 중…';
    api('config').then(function (cfg) {
      if (cfg.tokenUrl && !SERVER_RE.test(cfg.tokenUrl)) throw new Error('서버 설정이 올바르지 않습니다(업로드 권한 서버 주소). 관리자에게 알려주세요.');
      S.cfg = cfg;
      if (opt.confirm) {
        $('who').textContent = '';
        show('screen-connect');
        if (!cfg.installed) { msg($('connectMsg'), 'err', '아직 설정이 끝나지 않은 서버입니다. 관리자라면 관리 서버 주소를 아래에 직접 입력하세요.'); return; }
        $('confirmCard').classList.remove('hidden');
        $('confirmText').innerHTML = '기관 이름: <b>' + esc(cfg.orgName || '(이름 없음)') + '</b><br>로그인할 계정: <b>@' + esc((cfg.domains || []).join(', @')) + '</b>';
        $('btnConfirmYes').onclick = function () { $('confirmCard').classList.add('hidden'); lsSet('photo.server', S.server); connect(); };
        return;
      }
      if (!cfg.installed) {
        $('who').textContent = '';
        $('cServer').value = S.server;
        $('installCard').classList.remove('hidden');
        show('screen-connect');
        return;
      }
      lsSet('photo.server', S.server);
      var sess = lsGet('photo.session.' + S.server, null);
      if (sess && sess.exp > Date.now() + 5 * 60 * 1000) { S.session = sess; loadApp(); }
      else showLogin();
    }).catch(function (e) {
      $('who').textContent = '';
      $('cServer').value = S.server;
      show('screen-connect');
      msg($('connectMsg'), 'err', e.message);
    });
  }

  $('btnConnect').onclick = function () {
    var url = $('cServer').value.trim();
    if (!SERVER_RE.test(url)) {
      msg($('connectMsg'), 'err', '관리 서버 주소 형식이 아닙니다. (https://script.google.com/macros/s/…/exec)'); return;
    }
    S.server = url;
    msg($('connectMsg'), 'info', '확인 중…');
    connect();
  };

  $('btnInstall').onclick = function () {
    var b = $('btnInstall'); b.disabled = true;
    msg($('installMsg'), 'info', '두 서버를 연결하는 중… (10초쯤 걸립니다)');
    post(S.server, {
      action: 'install', orgName: $('iOrg').value, installCode: $('iCode').value, clientId: $('iClient').value,
      tokenUrl: $('iTokenUrl').value, tokenCode: $('iTokenCode').value, sheetUrl: $('iSheet').value,
      session: S.session && S.session.token // 다시 연결할 때는 관리자 로그인이 필요
    }).then(function (st) {
      msg($('installMsg'), 'ok', '연결했습니다. 사진 저장 계정: ' + (st.photoAccount || '확인 필요') + '. 이제 관리자 계정으로 로그인하세요.');
      $('installCard').classList.add('hidden');
      // 다시 연결하면 비밀값이 바뀌어 기존 로그인이 끊긴다
      lsDel('photo.session.' + S.server); S.session = null; S.token = null;
      setTimeout(connect, 1200);
    }).catch(function (e) { msg($('installMsg'), 'err', e.message); })
      .then(function () { b.disabled = false; });
  };

  /** 관리자: 연결 정보 바꾸기 (먼저 두 서버 편집기에서 newInstallCode / resetConnection 실행) */
  $('btnReinstall').onclick = function () {
    $('cServer').value = S.server;
    $('installCard').classList.remove('hidden');
    $('iOrg').value = (S.cfg && S.cfg.orgName) || '';
    msg($('installMsg'), 'info', '먼저 관리 서버 편집기에서 newInstallCode, 업로드 권한 서버 편집기에서 resetConnection 을 실행해 새 설치 코드를 받으세요. 이 화면을 닫지 말고 진행하세요.');
    show('screen-connect');
  };

  function whenGsi() {
    return new Promise(function (resolve, reject) {
      var t = 0;
      (function wait() {
        if (window.google && google.accounts && google.accounts.id) return resolve();
        if ((t += 200) > 15000) return reject(new Error('구글 로그인 도구를 불러오지 못했습니다. 인터넷 연결을 확인하세요.'));
        setTimeout(wait, 200);
      })();
    });
  }

  function showLogin() {
    show('screen-login');
    $('who').textContent = S.cfg.orgName || '';
    $('loginTitle').textContent = (S.cfg.orgName ? S.cfg.orgName + ' ' : '') + '기관 계정으로 로그인';
    whenGsi().then(function () {
      google.accounts.id.initialize({
        client_id: S.cfg.clientId,
        callback: onCredential,
        auto_select: true,
        hd: S.cfg.domains && S.cfg.domains.length === 1 ? S.cfg.domains[0] : undefined,
        ux_mode: 'popup'
      });
      google.accounts.id.renderButton($('gsiButton'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ko' });
      google.accounts.id.prompt();
    }).catch(function (e) { $('gsiButton').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
  }

  function onCredential(resp) {
    $('gsiButton').insertAdjacentHTML('afterend', '<div class="msg info" id="loginWait">확인 중…</div>');
    post(S.server, { action: 'login', idToken: resp.credential }).then(function (d) {
      S.session = { token: d.session, exp: d.exp, email: d.email };
      lsSet('photo.session.' + S.server, S.session);
      loadApp();
    }).catch(function (e) {
      var w = $('loginWait'); if (w) w.remove();
      $('gsiButton').insertAdjacentHTML('afterend', '<div class="msg err">' + esc(e.message) + '</div>');
    });
  }

  function loadApp() {
    $('who').textContent = '불러오는 중…';
    api('bootstrap').then(function (b) {
      S.boot = b;
      S.engine = Uploader.createEngine({ api: api, getToken: getToken, fetch: window.fetch.bind(window), journal: journal,
        device: deviceId(), user: b.email, onItem: onItem });
      show('screen-app');
      $('who').textContent = (S.cfg.orgName ? S.cfg.orgName + ' · ' : '') + b.email + (b.myTeam ? ' · ' + b.myTeam : '');
      if (!$('pDate').value) $('pDate').value = codeToDateInput(b.todayCode); // 다시 로그인해도 고른 날짜 유지
      applyTeams();
      if (!b.teams.length) {
        msg($('globalMsg'), 'info', b.isAdmin ? '팀 목록이 비어 있습니다. 설정 탭에서 팀을 먼저 등록하세요.' : '아직 팀 목록이 없습니다. 관리자에게 팀 등록을 요청하세요.');
      } else if (!b.myTeam) msg($('globalMsg'), 'info', '처음 오셨네요. 설정에서 내 팀을 정하면 다음부터 자동으로 선택됩니다.');
      if (b.isAdmin) {
        $('adminCard').classList.remove('hidden');
        $('orgCard').classList.remove('hidden');
        renderTeamRows(b.allTeams);
        $('dbLink').innerHTML = '데이터 시트(앨범·업로드 기록): <a href="' + esc(b.dbUrl) + '" target="_blank" rel="noopener">열기</a>';
      }
      renderQueue();
      // 지난번에 마치지 못한 기록 보내기 (끝날 때까지 올리기 버튼 잠금)
      S.flushing = true; updatePhoneButton();
      S.engine.flushJournal().then(function (n) {
        if (n) msg($('globalMsg'), 'info', '지난번에 끝나지 않은 업로드 ' + n + '건의 결과를 기록했습니다.');
      }).catch(function () {}).then(function () { S.flushing = false; updatePhoneButton(); renderFolders && !$('folderCard').classList.contains('hidden') && renderFolders(); });
    }).catch(function (e) {
      if (e.code === 'LOGIN') return showLogin();
      $('who').textContent = '';
      show('screen-app');
      msg($('globalMsg'), 'err', e.message);
    });
  }

  /* ───────── 탭 ───────── */
  document.querySelectorAll('nav button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('nav button').forEach(function (x) { x.classList.toggle('on', x === b); });
      ['phone', 'folder', 'settings'].forEach(function (t) { $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab); });
      if (b.dataset.tab === 'settings' && S.boot && S.boot.isAdmin) loadOrgStatus();
    });
  });

  function teamOptions(sel, value) {
    sel.innerHTML = S.boot.teams.map(function (t) {
      return '<option' + (t.name === value ? ' selected' : '') + '>' + esc(t.name) + '</option>';
    }).join('');
    if (!value) sel.insertAdjacentHTML('afterbegin', '<option value="" selected disabled>팀 선택</option>');
  }
  function programsOf(team) { return S.boot.programsByTeam[team] || []; }
  function canon(team, program) { return canonicalProgramFrom(programsOf(team), program); }

  /* ───────── 사진 올리기 (폰) ───────── */
  function phoneParts() {
    var annual = $('pAnnual').checked;
    var code = annual ? annualCode(S.boot.year) : dateInputToCode($('pDate').value);
    var team = $('pTeam').value;
    var program = cleanProgram($('pProgram').value);
    if (team && program) program = canon(team, program);
    return { code: code, team: team, program: program, annual: annual };
  }
  function phoneReady(p) { return !!(p.team && p.program && (p.annual ? isAnnualCode(p.code) : isValidYmd(p.code))); }

  function renderPhoneAlbum() {
    var p = phoneParts();
    $('pDate').disabled = p.annual;
    if (!phoneReady(p)) {
      $('pAlbum').innerHTML = '<small>날짜·팀·프로그램명을 모두 정하면 앨범 이름이 나옵니다</small>';
    } else {
      var nm = buildAlbumName(p.code, p.team, p.program);
      var exists = S.boot.albumNames.indexOf(nm) >= 0;
      $('pAlbum').innerHTML = esc(nm) + '<small>' + (exists ? '✔ 이미 있는 앨범에 추가됩니다(번호 이어짐)' : '＋ 새 앨범이 만들어집니다') +
        (p.annual ? ' · ' + S.boot.year + '년 연간 앨범' : '') + '</small>';
    }
    renderDateHint();
    updatePhoneButton();
  }
  /** 고른 사진이 모두 같은 날 찍혔는데 앨범 날짜와 다르면 바꾸기 제안 */
  function renderDateHint() {
    var el = $('pDateHint');
    var p = phoneParts();
    var codes = {};
    S.queue.forEach(function (q) { if (q.status === 'wait' && q.shotAt) codes[codeFromMs(q.shotAt)] = 1; });
    var list = Object.keys(codes);
    if (p.annual || list.length !== 1 || list[0] === p.code) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="msg info">고른 사진의 촬영일은 <b>' + esc(codeToDots(list[0])) + '</b>입니다. ' +
      '<button class="linkbtn" id="btnUseShot">앨범 날짜를 촬영일로 바꾸기</button></div>';
    $('btnUseShot').onclick = function () { $('pDate').value = codeToDateInput(list[0]); renderPhoneAlbum(); };
  }
  function fillPrograms() {
    $('pProgramList').innerHTML = programsOf($('pTeam').value).map(function (p) { return '<option value="' + esc(p) + '">'; }).join('');
  }
  ['pDate', 'pProgram'].forEach(function (id) { $(id).addEventListener('input', renderPhoneAlbum); });
  $('pAnnual').addEventListener('change', renderPhoneAlbum);
  $('pTeam').addEventListener('change', function () { fillPrograms(); renderPhoneAlbum(); });

  $('btnCamera').onclick = function () { $('fCamera').click(); };
  $('btnPick').onclick = function () { $('fPick').click(); };
  [$('fCamera'), $('fPick')].forEach(function (inp) {
    inp.addEventListener('change', function () {
      var files = Array.prototype.filter.call(inp.files, isMediaFile);
      inp.value = '';
      files.forEach(function (file) {
        var item = { file: file, status: 'wait', note: '', shotAt: null };
        if (/^image\//.test(file.type)) { try { item.thumb = URL.createObjectURL(file); } catch (e) { /* 미리보기 없음 */ } }
        S.queue.push(item);
        Exif.readShotTime(file).then(function (ms) { item.shotAt = ms; renderDateHint(); });
      });
      renderQueue();
    });
  });

  var LABEL = { wait: '대기', run: '올리는 중…', sent: '등록 중…', ok: '완료', dup: '이미 올림', err: '실패', warn: '확인 필요' };
  function stCls(s) { return s === 'ok' || s === 'dup' ? 'ok' : s === 'err' ? 'err' : s === 'warn' ? 'warn' : ''; }
  function renderQueue() {
    var ul = $('pQueue');
    S.queue.forEach(function (q, i) {
      if (!q.li) {
        q.li = document.createElement('li');
        q.li.innerHTML = (q.thumb ? '<img alt="" loading="lazy">' : '<span class="ph"></span>') + '<span class="nm"></span><span class="st"></span>';
        if (q.thumb) q.li.firstChild.src = q.thumb;
      }
      if (ul.children[i] !== q.li) ul.insertBefore(q.li, ul.children[i] || null);
      var view = (q.uploadName || q.file.name) + '|' + (q.note || '') + '|' + q.status;
      if (q.li._view !== view) {
        q.li._view = view;
        q.li.children[1].innerHTML = esc(q.uploadName || q.file.name) + (q.note ? '<br><span class="muted">' + esc(q.note) + '</span>' : '');
        q.li.children[2].className = 'st ' + stCls(q.status);
        q.li.children[2].textContent = LABEL[q.status] || '';
      }
    });
    while (ul.children.length > S.queue.length) ul.removeChild(ul.lastChild);
    $('btnClear').classList.toggle('hidden', !S.queue.length || S.busy);
    updatePhoneButton();
  }
  function retryable(q) { return q.status === 'wait' || q.status === 'err'; }
  function updatePhoneButton() {
    if (!S.boot) return;
    var n = S.queue.filter(retryable).length;
    $('btnUpload').disabled = S.busy || S.flushing || !n || !phoneReady(phoneParts());
    $('btnUpload').textContent = S.busy ? '올리는 중…' : (n ? n + '장 올리기' : '올리기');
  }
  $('btnClear').onclick = function () {
    S.queue.forEach(function (q) { if (q.thumb) URL.revokeObjectURL(q.thumb); });
    S.queue = []; renderQueue(); renderDateHint(); msg($('pMsg'), '', '');
  };

  var renderTimer = null;
  function onItem() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () {
      renderTimer = null;
      renderQueue();
      if (!$('folderCard').classList.contains('hidden')) renderFolders();
      updateProgress();
    }, 250);
  }
  var progressItems = [];
  var progressEl = null;
  function updateProgress() {
    if (!progressEl || !progressItems.length) return;
    var done = progressItems.filter(function (q) { return q.status !== 'wait' && q.status !== 'run' && q.status !== 'sent'; }).length;
    progressEl.firstElementChild.style.width = Math.round(done / progressItems.length * 100) + '%';
  }

  function runJobs(jobs, progEl, msgEl) {
    var items = [];
    jobs.forEach(function (j) { j.items.forEach(function (q) { q.status = 'wait'; q.note = ''; items.push(q); }); });
    progressItems = items; progressEl = progEl;
    progEl.classList.remove('hidden');
    setBusy(true);
    msg(msgEl, 'info', items.length + '장을 올립니다.');
    renderQueue();
    return S.engine.run(jobs).then(function (r) {
      setBusy(false);
      renderQueue(); updateProgress();
      setTimeout(function () { progEl.classList.add('hidden'); }, 1500);
      jobs.forEach(function (j) {
        var name = j.items[0] && j.items[0].albumName;
        if (name && S.boot.albumNames.indexOf(name) < 0) S.boot.albumNames.push(name);
        var list = S.boot.programsByTeam[j.album.team] = programsOf(j.album.team);
        if (list.indexOf(j.album.program) < 0) list.unshift(j.album.program);
      });
      var c = r.count, parts = [];
      if (c.ok) parts.push('완료 ' + c.ok + '장');
      if (c.dup) parts.push('이미 올린 사진 ' + c.dup + '장 건너뜀');
      if (c.warn) parts.push('확인 필요 ' + c.warn + '장');
      if (c.err) parts.push('실패 ' + c.err + '장 (다시 누르면 재시도)');
      if (c.wait) parts.push('남음 ' + c.wait + '장');
      var text = parts.join(' · ') + (r.stopped ? ' — 멈춘 이유: ' + r.stopped : '');
      msg(msgEl, c.err || c.warn || r.stopped || c.wait ? 'err' : 'ok', text);
      if (S.session == null) showLogin();
      return r;
    });
  }

  $('btnUpload').onclick = function () {
    if (S.busy || S.flushing) return; // 두 번 누르기 방지
    S.busy = true; updatePhoneButton();
    var p = phoneParts();
    var items = S.queue.filter(retryable);
    Promise.all(items.map(function (q) {
      return q.shotAt != null ? null : Exif.readShotTime(q.file).then(function (ms) { q.shotAt = ms; });
    })).then(function () {
      return runJobs([{ album: { code: p.code, team: p.team, program: p.program }, items: items }], $('pProg'), $('pMsg'));
    }).then(function () { renderPhoneAlbum(); });
  };

  /* ───────── PC 폴더 ───────── */
  $('btnFolder').onclick = function () { $('fFolder').click(); };
  $('fFolder').addEventListener('change', function () {
    var files = Array.prototype.filter.call($('fFolder').files, isMediaFile);
    $('fFolder').value = '';
    var groups = {};
    files.forEach(function (f) {
      var parts = (f.webkitRelativePath || f.name).split('/');
      var key = parts.slice(0, -1).join('/') || '(폴더 없음)';
      if (!groups[key]) {
        var dirs = parts.slice(0, -1);
        groups[key] = { name: dirs[dirs.length - 1] || '(폴더 없음)', path: key, ancestors: dirs.slice(0, -1).reverse(), files: [] };
      }
      groups[key].files.push(f);
    });
    S.folders = Object.keys(groups).sort().map(function (k) { return groups[k]; });
    msg($('annualMsg'), '', '');
    if (!S.folders.length) { msg($('globalMsg'), 'err', '사진·동영상 파일이 있는 폴더가 없습니다.'); return; }
    S.folders.forEach(function (g) {
      g.origName = g.name;
      parseGroup(g);
      g.items = g.files.map(function (f) { return { file: f, status: 'wait', note: '', shotAt: null }; });
    });
    applyHold();
    renderFolders();
  });

  /** 폴더 이름(수기로 고친 이름 포함)을 읽어 날짜·팀·프로그램명을 채운다 */
  function parseGroup(g) {
    var minT = Math.min.apply(null, g.files.map(function (f) { return f.lastModified || Date.now(); }));
    var r = parseFolderName(g.name, S.boot.teams, { hintCode: codeFromMs(minT), year: S.boot.year, ancestors: g.ancestors });
    g.code = r.code || ''; g.annual = !!r.annual; g.team = r.team || ''; g.annualFrom = '';
    g.program = r.team && r.program ? canon(r.team, r.program) : r.program;
    g.issues = r.issues; g.notes = r.notes || []; g.ok = r.ok;
    if (!g.held) g.include = r.ok;
  }

  /* 보류할 폴더 이름: 경로의 어느 폴더 이름에든 들어 있으면(하위 폴더 포함) 올리지 않는다 */
  $('fHold').value = lsGet('photo.hold', '') || '';
  function holdWords() {
    return $('fHold').value.split(/[,，\n]/).map(function (s) { return { raw: s.trim(), key: compactKey(s) }; })
      .filter(function (w) { return w.key; });
  }
  function applyHold() {
    var words = holdWords();
    S.folders.forEach(function (g) {
      var keys = g.path.split('/').map(compactKey);
      var hit = null;
      words.some(function (w) { return keys.some(function (k) { return k.indexOf(w.key) >= 0; }) && (hit = w.raw); });
      if (hit && !g.held) g.include = false;
      else if (!hit && g.held) g.include = g.ok;
      g.held = hit;
    });
  }
  $('fHold').addEventListener('change', function () {
    lsSet('photo.hold', $('fHold').value.trim());
    if (!S.folders.length || S.busy) return;
    applyHold();
    renderFolders();
  });

  function folderValid(g) {
    return !!(g.team && cleanProgram(g.program) && (g.annual ? isAnnualCode(g.code) : isValidYmd(g.code)));
  }
  function folderAlbum(g) { return buildAlbumName(g.code, g.team, canon(g.team, cleanProgram(g.program))); }

  function renderFolders() {
    $('folderCard').classList.remove('hidden');
    var active = document.activeElement;
    if (active && active.dataset && (active.dataset.f === 'program' || active.dataset.f === 'name') && !S.busy) return; // 입력 중엔 다시 그리지 않음
    var heldN = S.folders.filter(function (g) { return g.held; }).length;
    $('folderTitle').textContent = '폴더 확인 (' + S.folders.length + '개' + (heldN ? ', 보류 ' + heldN + '개' : '') + ')';
    $('folderList').innerHTML = S.folders.map(function (g, i) {
      var name = folderValid(g) ? folderAlbum(g) : '';
      var exists = name && S.boot.albumNames.indexOf(name) >= 0;
      var done = g.items.filter(function (q) { return q.status === 'ok' || q.status === 'dup'; }).length;
      var bad = g.items.filter(function (q) { return q.status === 'err' || q.status === 'warn'; });
      return '<div class="folder" data-i="' + i + '">' +
        '<label class="check" style="margin:0"><input type="checkbox" data-f="include"' + (g.include ? ' checked' : '') + (g.held ? ' disabled' : '') + '> ' +
        '<b>' + esc(g.name) + '</b> <span class="muted">' + g.files.length + '장</span>' +
        (g.held ? '<span class="badge warn">보류</span>' : g.ok ? '<span class="badge ok">자동 인식</span>' : '<span class="badge warn">확인 필요</span>') + '</label>' +
        '<div class="src">' + esc(g.path) + '</div>' +
        (g.held ? '<div class="muted">보류: 이름에 \'' + esc(g.held) + '\' 포함 — 올리려면 위 보류 칸에서 지우세요.</div>' : '') +
        '<label>폴더 이름 <span class="muted">— 고치면 날짜·팀·프로그램명을 다시 읽습니다 (예: 250417 봄봄축제)</span></label>' +
        '<div class="row"><input type="text" data-f="name" value="' + esc(g.name) + '" style="flex:3">' +
          (g.name !== g.origName ? '<button class="btn small" data-f="nameReset" style="flex:none">원래대로</button>' : '') + '</div>' +
        (g.issues && g.issues.length ? '<div class="muted" style="color:var(--warn)">' + esc(g.issues.join(' · ')) + '</div>' : '') +
        (g.notes && g.notes.length ? '<div class="muted">' + esc(g.notes.join(' · ')) + '</div>' : '') +
        '<div class="row">' +
          '<div><label>날짜</label><input type="date" data-f="date" value="' + (!g.annual && isValidYmd(g.code) ? codeToDateInput(g.code) : '') + '"' + (g.annual ? ' disabled' : '') + '></div>' +
          '<div><label>팀</label><select data-f="team"><option value=""' + (g.team ? '' : ' selected') + ' disabled>팀 선택</option>' +
            S.boot.teams.map(function (t) { return '<option' + (t.name === g.team ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') +
          '</select></div>' +
        '</div>' +
        '<label class="check"><input type="checkbox" data-f="annual"' + (g.annual ? ' checked' : '') + '> 연간 앨범' +
          (g.annual && isAnnualCode(g.code) ? ' (20' + g.code.slice(0, 2) + '년)' : '') + '</label>' +
        '<label>프로그램명</label><input type="text" data-f="program" value="' + esc(g.program) + '">' +
        '<div class="albumname">' + (name ? esc(name) + '<small>' + (exists ? '✔ 이미 있는 앨범에 추가(번호 이어짐)' : '＋ 새 앨범') + '</small>' :
          '<small>날짜·팀·프로그램명을 확인하세요</small>') + '</div>' +
        (done || bad.length ? '<div class="muted" style="margin-top:6px">완료 ' + done + ' / ' + g.files.length +
          (bad.length ? ' · <span style="color:var(--err)">실패·확인 ' + bad.length + '장: ' +
            esc(bad.slice(0, 3).map(function (q) { return q.file.name + ' (' + q.note + ')'; }).join(', ')) + '</span>' : '') + '</div>' : '') +
        '</div>';
    }).join('');
    var sel = S.folders.filter(function (g) { return g.include; });
    var badN = sel.filter(function (g) { return !folderValid(g); }).length;
    var left = sel.reduce(function (n, g) { return n + g.items.filter(retryable).length; }, 0);
    $('btnFolderUpload').disabled = S.busy || S.flushing || !sel.length || badN > 0 || !left;
    $('btnFolderUpload').textContent = S.busy ? '올리는 중…' : badN ? '확인 필요한 폴더 ' + badN + '개를 고쳐 주세요' :
      !left ? '올릴 사진이 없습니다' : '선택한 폴더 ' + sel.length + '개 (' + left + '장) 올리기';
  }

  $('folderList').addEventListener('change', function (ev) {
    var box = ev.target.closest('.folder'); if (!box) return;
    var g = S.folders[+box.dataset.i], f = ev.target.dataset.f;
    if (f === 'include') g.include = !g.held && ev.target.checked;
    if (f === 'team') g.team = ev.target.value;
    if (f === 'date') { g.code = dateInputToCode(ev.target.value); g.annual = false; }
    if (f === 'annual') {
      g.annual = ev.target.checked;
      if (g.annual) g.annualFrom = g.code;
      g.code = g.annual ? annualCode(isValidYmd(g.code) ? 2000 + +g.code.slice(0, 2) : S.boot.year) : (g.annualFrom || '');
    }
    if (f === 'program') { g.program = ev.target.value; ev.target.blur(); }
    if (f === 'name') {
      var nm = ev.target.value.trim();
      ev.target.blur();
      if (!nm || nm === g.name || S.busy) { renderFolders(); return; }
      g.name = nm; parseGroup(g);
    }
    renderFolders();
  });
  $('folderList').addEventListener('click', function (ev) {
    if (!ev.target.dataset || ev.target.dataset.f !== 'nameReset' || S.busy) return;
    var g = S.folders[+ev.target.closest('.folder').dataset.i];
    g.name = g.origName; parseGroup(g); renderFolders();
  });

  /** 같은 팀·같은 프로그램 폴더가 2개 이상이면 연간 앨범으로 묶기 */
  $('btnAnnualGroup').onclick = function () {
    var groups = {};
    S.folders.forEach(function (g) {
      if (!g.include || !g.team || !cleanProgram(g.program) || g.annual) return;
      var year = isValidYmd(g.code) ? 2000 + +g.code.slice(0, 2) : S.boot.year;
      var k = g.team + '|' + compactKey(g.program) + '|' + year;
      (groups[k] = groups[k] || { year: year, list: [] }).list.push(g);
    });
    var merged = [];
    Object.keys(groups).forEach(function (k) {
      var gr = groups[k];
      if (gr.list.length < 2) return;
      var prog = canon(gr.list[0].team, cleanProgram(gr.list[0].program));
      gr.list.forEach(function (g) { g.annualFrom = g.code; g.annual = true; g.code = annualCode(gr.year); g.program = prog; });
      merged.push(buildAlbumName(annualCode(gr.year), gr.list[0].team, prog) + ' ← 폴더 ' + gr.list.length + '개');
    });
    msg($('annualMsg'), merged.length ? 'ok' : 'info', merged.length
      ? '연간 앨범으로 묶었습니다: ' + merged.join(' / ') + '. 되돌리려면 폴더마다 연간 앨범 체크를 끄세요.'
      : '같은 팀·같은 프로그램 폴더가 2개 이상인 경우가 없습니다.');
    renderFolders();
  };

  $('btnFolderUpload').onclick = function () {
    if (S.busy || S.flushing) return;
    S.busy = true;
    var sel = S.folders.filter(function (g) { return g.include && folderValid(g); });
    var jobsMap = {};
    sel.forEach(function (g) {
      var album = { code: g.code, team: g.team, program: canon(g.team, cleanProgram(g.program)) };
      var k = buildAlbumName(album.code, album.team, album.program);
      (jobsMap[k] = jobsMap[k] || { album: album, items: [] }).items = jobsMap[k].items.concat(g.items.filter(retryable));
    });
    var jobs = Object.keys(jobsMap).sort().map(function (k) { return jobsMap[k]; }).filter(function (j) { return j.items.length; });
    var all = [];
    jobs.forEach(function (j) { all = all.concat(j.items); });
    var read = 0;
    msg($('folderMsg'), 'info', '사진 촬영일을 읽는 중… (0/' + all.length + ')');
    $('btnFolderUpload').disabled = true;
    // 촬영일 읽기 (동시 6개)
    var q = all.slice();
    function reader() {
      if (!q.length) return Promise.resolve();
      var it = q.shift();
      return (it.shotAt != null ? Promise.resolve() : Exif.readShotTime(it.file).then(function (ms) { it.shotAt = ms; }))
        .then(function () { if (++read % 25 === 0) msg($('folderMsg'), 'info', '사진 촬영일을 읽는 중… (' + read + '/' + all.length + ')'); })
        .then(reader);
    }
    Promise.all([reader(), reader(), reader(), reader(), reader(), reader()])
      .then(function () { return runJobs(jobs, $('fProg'), $('folderMsg')); })
      .then(renderFolders);
  };

  /* ───────── 설정 ───────── */
  $('btnSaveMyTeam').onclick = function () {
    var t = $('sMyTeam').value; if (!t) return;
    api('saveMyTeam', { team: t }).then(function () {
      S.boot.myTeam = t; teamOptions($('pTeam'), t); fillPrograms(); renderPhoneAlbum();
      $('who').textContent = (S.cfg.orgName ? S.cfg.orgName + ' · ' : '') + S.boot.email + ' · ' + t;
      msg($('globalMsg'), 'ok', '내 팀을 ' + t + '(으)로 저장했습니다.');
    }).catch(function (e) { msg($('globalMsg'), 'err', e.message); });
  };
  function renderTeamRows(list) {
    list = list && list.length ? list : [{ name: '', aliases: [], active: true }];
    $('teamRows').innerHTML = '<tr><td class="muted">팀 이름</td><td class="muted">약칭(쉼표)</td><td class="muted">사용</td></tr>' +
      list.map(function (t) {
        return '<tr><td><input type="text" data-k="name" value="' + esc(t.name) + '"></td>' +
          '<td><input type="text" data-k="aliases" value="' + esc((t.aliases || []).join(', ')) + '"></td>' +
          '<td style="text-align:center"><input type="checkbox" data-k="active"' + (t.active !== false ? ' checked' : '') + '></td></tr>';
      }).join('');
  }
  function readTeamRows() {
    return Array.prototype.map.call($('teamRows').querySelectorAll('tr'), function (tr) {
      var n = tr.querySelector('[data-k=name]'); if (!n) return null;
      return { name: n.value, aliases: tr.querySelector('[data-k=aliases]').value.split(','), active: tr.querySelector('[data-k=active]').checked };
    }).filter(function (t) { return t && t.name.trim(); });
  }
  $('btnAddTeam').onclick = function () {
    var list = readTeamRows(); list.push({ name: '', aliases: [], active: true }); renderTeamRows(list);
    var inputs = $('teamRows').querySelectorAll('[data-k=name]'); inputs[inputs.length - 1].focus();
  };
  $('btnSaveTeams').onclick = function () {
    api('saveTeams', { teams: readTeamRows() }).then(function (all) {
      S.boot.allTeams = all;
      S.boot.teams = all.filter(function (t) { return t.active; }).map(function (t) { return { name: t.name, aliases: t.aliases }; });
      renderTeamRows(all); applyTeams();
      msg($('globalMsg'), 'ok', '팀 목록을 저장했습니다.');
    }).catch(function (e) { msg($('globalMsg'), 'err', e.message); });
  };
  function applyTeams() {
    var cur = $('pTeam').value || S.boot.myTeam;
    if (!S.boot.teams.some(function (t) { return t.name === cur; })) cur = '';
    teamOptions($('pTeam'), cur);
    teamOptions($('sMyTeam'), S.boot.myTeam);
    fillPrograms(); renderPhoneAlbum();
  }

  function staffLink() {
    var base = location.origin + location.pathname;
    var baked = window.PHOTO_CONFIG && window.PHOTO_CONFIG.serverUrl;
    return baked === S.server ? base : base + '?s=' + encodeURIComponent(S.server);
  }
  function loadOrgStatus() {
    $('staffLink').textContent = staffLink();
    api('adminStatus').then(function (st) {
      $('orgStatus').innerHTML =
        '사진 저장 구글포토 계정: <b>' + esc(st.photoAccount || '확인 불가') + '</b><br>' +
        '업로드 권한 서버: ' + (st.tokenServer.ok ? '✅ 연결됨' : '❌ ' + esc(st.tokenServer.error)) + '<br>' +
        '데이터 시트: ' + (st.sheetUrl ? '<a href="' + esc(st.sheetUrl) + '" target="_blank" rel="noopener">열기</a>' : '없음') + '<br>' +
        '허용 도메인: ' + esc(st.domains.join(', ') || '없음') + (st.domainsCustom ? '' : ' (공용 계정 기준 자동)') + '<br>' +
        '관리 서버 계정: ' + esc(st.adminServerAccount);
      $('oOrg').value = st.orgName;
      $('oDomains').value = st.domainsCustom ? st.domains.join(', ') : '';
      $('oAdmins').value = st.admins;
    }).catch(function (e) { $('orgStatus').innerHTML = '<span style="color:var(--err)">' + esc(e.message) + '</span>'; });
  }
  $('btnSaveOrg').onclick = function () {
    var body = { orgName: $('oOrg').value, domains: $('oDomains').value, admins: $('oAdmins').value };
    if ($('oSheet').value.trim()) body.sheetUrl = $('oSheet').value.trim();
    api('saveSettings', body).then(function () {
      $('oSheet').value = '';
      S.cfg.orgName = body.orgName;
      msg($('globalMsg'), 'ok', '기관 설정을 저장했습니다.');
      loadOrgStatus();
    }).catch(function (e) { msg($('globalMsg'), 'err', e.message); });
  };
  $('btnCopyLink').onclick = function () {
    var t = staffLink();
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () {
      msg($('globalMsg'), 'ok', '직원용 주소를 복사했습니다.');
    }, function () { msg($('globalMsg'), 'info', t); });
  };
  $('btnLogout').onclick = function () {
    lsDel('photo.session.' + S.server);
    S.session = null; S.token = null;
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    showLogin();
  };

  start();
})();
