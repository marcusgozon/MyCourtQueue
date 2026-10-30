/** Queue master dashboard. Every action is re-validated and authorised by the backend. */
(function () {
  var CQ = window.CQ, U = CQ.util, V = CQ.views, ui = CQ.ui, $ = U.$, esc = U.esc;
  var sessionId = new URLSearchParams(location.search).get('session') || '';
  var state = null, poller = null, tabsSelect = null, started = false;

  if (!CQ.api.isConfigured()) ui.banner('Setup needed: paste your Apps Script web app URL into js/config.js.', 'error');
  if (!sessionId) { location.replace('index.html'); return; }

  /* ---------- sign-in ---------- */
  function showLogin(message) {
    if (poller) poller.stop();
    CQ.auth.use(null);
    $('#app-view').classList.add('hidden');
    $('#head-actions').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
    if (message) $('#login-sub').textContent = message;
    $('#pw').focus();
  }

  function enterApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    $('#head-actions').classList.remove('hidden');
    if (!started) {
      started = true;
      tabsSelect = ui.tabs($('#tabs'));
      V.bindDetails($('#stats'));
      poller = CQ.createPoller(refresh, {
        onOk: function () { $('#sync').textContent = 'Synced ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); ui.banner(''); },
        onError: function (err, n) {
          if (err.code === 'UNAUTHORIZED') { showLogin('Your sign-in expired. Please sign in again.'); return; }
          if (err.code === 'NOT_FOUND') { ui.banner('Session not found.', 'error'); poller.stop(); return; }
          $('#sync').textContent = 'Reconnecting…';
          if (n >= 2) ui.banner(CQ.errors.friendly(err), 'error');
        }
      });
    }
    poller.start();
  }

  $('#login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var pw = $('#pw').value;
    if (!pw) return;
    await ui.busy(e.submitter, async function () {
      try {
        var r = await CQ.api.adminLogin(sessionId, pw);
        var entry = { sessionId: r.sessionId, name: r.name, publicToken: r.publicToken, adminToken: r.adminToken, expiresAt: r.expiresAt };
        CQ.auth.save(entry); CQ.auth.use(entry);
        $('#pw').value = '';
        enterApp();
      } catch (err) { ui.error(err); }
    });
  });

  $('#logout').addEventListener('click', function () { CQ.auth.forget(sessionId); location.href = 'index.html'; });

  /* ---------- state ---------- */
  function applyState(s) {
    U.setServerTime(s.serverTime);
    state = s;
    render();
  }

  async function refresh() {
    var d = await CQ.api.admin('getAdminSession');
    applyState(d.state);
  }

  /** Run a mutating action; update the UI from the returned state. */
  async function act(btn, action, payload, okMsg) {
    return ui.busy(btn, async function () {
      try {
        var d = await CQ.api.admin(action, payload);
        applyState(d.state);
        if (okMsg) ui.toast(okMsg);
        return d;
      } catch (err) {
        if (err.code === 'UNAUTHORIZED') { showLogin('Your sign-in expired. Please sign in again.'); return null; }
        ui.error(err);
        if (err.code === 'QUEUE_CHANGED' || err.code === 'COURT_BUSY' || err.code === 'MATCH_NOT_ACTIVE') refresh().catch(function () {});
        return null;
      }
    });
  }

  /* ---------- render ---------- */
  function render() {
    var s = state, closed = s.session.status !== 'ACTIVE';
    $('#s-title').textContent = s.session.name;
    document.title = s.session.name + ' — MyCourtQueue Queue Master';
    var pill = $('#s-status');
    pill.textContent = closed ? 'ENDED' : 'LIVE';
    pill.className = 'pill ' + (closed ? 'pill-gray' : 'pill-green');
    $('#open-public').href = U.publicUrl(s.session.publicToken);
    $('#end-session').hidden = closed;
    $('#delete-session').hidden = !closed;
    $('#rename').hidden = closed;
    $('#court-count').textContent = s.courts.length;
    ['#courts-minus', '#courts-plus', '#fill', '#quick-add button'].forEach(function (sel) { $(sel).disabled = closed; });
    ui.banner(closed ? 'This session has ended. You can still correct results.' : '');

    U.setHtml($('#courts'), V.courts(s, { admin: true }));
    U.setHtml($('#announce'), V.announcements(s, 5));
    U.setHtml($('#counts'), V.counts(s));
    U.setHtml($('#queue'), V.queue(s, { admin: true }));
    U.setHtml($('#players'), playersHtml(s, closed));
    U.setHtml($('#matches'), matchesHtml(s));
    U.setHtml($('#stats'), V.stats(s, {}));
  }

  function statusPill(p) {
    if (p.status === 'PLAYING') return '<span class="pill pill-green">PLAYING' + (p.leaveAfterMatch ? ' · leaving' : '') + '</span>';
    if (p.status === 'WAITING') return '<span class="pill pill-yellow">WAITING</span>';
    if (p.status === 'UNAVAILABLE') return '<span class="pill pill-gray">UNAVAILABLE</span>';
    return '<span class="pill pill-red">LEFT</span>';
  }

  function playersHtml(s, closed) {
    if (!s.players.length) return '<div class="empty">No players yet.</div>';
    return s.players.map(function (p) {
      var id = 'data-id="' + esc(p.playerId) + '" data-name="' + esc(p.name) + '"';
      var btns = '';
      if (!closed) {
        btns += '<button class="btn sm" data-act="rename-player" ' + id + '>Rename</button>';
        btns += '<button class="btn sm" data-act="set-target" ' + id + '>Target</button>';
        if (p.status === 'WAITING') btns += '<button class="btn sm" data-act="q-break" ' + id + '>Set unavailable</button>';
        if (p.status === 'UNAVAILABLE') btns += '<button class="btn sm primary" data-act="rejoin" ' + id + '>Rejoin queue</button>';
        if (p.status === 'LEFT') btns += '<button class="btn sm primary" data-act="rejoin" ' + id + '>Re-add</button>';
        if (p.status === 'PLAYING' && p.leaveAfterMatch) btns += '<button class="btn sm" data-act="rejoin" ' + id + '>Undo leave</button>';
        if (p.status !== 'LEFT' && !(p.status === 'PLAYING' && p.leaveAfterMatch)) {
          btns += '<button class="btn sm danger" data-act="q-remove" ' + id + '>' + (p.status === 'PLAYING' ? 'Leave after match' : 'Remove') + '</button>';
        }
      }
      var target = p.targetGames > 0 ? '<span class="games-count" title="Games target">target ' + p.targetGames + '</span>' : '';
      return '<div class="prow"><span class="avatar" aria-hidden="true">' + esc(U.initials(p.name)) + '</span>' +
        '<span class="q-name">' + esc(p.name) + '</span>' + V.gamesBadge(s, p.playerId) + target + V.targetBadge(p) + statusPill(p) + '<div class="q-actions">' + btns + '</div></div>';
    }).join('');
  }

  function teamNames(t) { return t.map(function (p) { return esc(p.name); }).join(' &amp; '); }

  function matchesHtml(s) {
    if (!s.matches.length) return '<div class="empty">No completed matches yet.</div>';
    return s.matches.map(function (m) {
      var cancelled = m.status === 'CANCELLED';
      var a = m.winningTeam === 'A', b = m.winningTeam === 'B';
      var btns = cancelled ? '<span class="pill pill-gray">VOIDED</span>' :
        '<button class="btn sm" data-act="correct" data-match="' + esc(m.matchId) + '">Correct result</button>' +
        '<button class="btn sm danger" data-act="void" data-match="' + esc(m.matchId) + '">Void</button>';
      return '<div class="result' + (cancelled ? ' cancelled' : '') + '"><div class="muted small">Court ' + m.courtNumber + ' · ' + esc(U.fmtTime(m.completedAt || m.startedAt)) + '</div>' +
        '<div class="vsline"><span class="' + (a && !cancelled ? 'winner' : '') + '">' + (a && !cancelled ? '🏆 ' : '') + teamNames(m.teamA) + '</span> <span class="muted">vs</span> ' +
        '<span class="' + (b && !cancelled ? 'winner' : '') + '">' + (b && !cancelled ? '🏆 ' : '') + teamNames(m.teamB) + '</span></div>' +
        (m.score && !cancelled ? '<div class="muted small">Score (A–B): ' + esc(m.score) + '</div>' : '') +
        '<div class="row-flex" style="margin-top:6px">' + btns + '</div></div>';
    }).join('');
  }

  /* ---------- helpers for lookups ---------- */
  function findMatch(id) {
    var c = state.courts.filter(function (x) { return x.match && x.match.matchId === id; })[0];
    if (c) return { teamA: c.match.players.slice(0, 2), teamB: c.match.players.slice(2), players: c.match.players, courtNumber: c.courtNumber, live: true };
    var m = state.matches.filter(function (x) { return x.matchId === id; })[0];
    return m ? { teamA: m.teamA, teamB: m.teamB, courtNumber: m.courtNumber, winningTeam: m.winningTeam, score: m.score, live: false } : null;
  }

  function nameOf(id) {
    var p = state.players.filter(function (x) { return x.playerId === id; })[0];
    return p ? p.name : 'this player';
  }

  /* ---------- modals ---------- */
  function resultModal(matchId, existing) {
    var m = findMatch(matchId);
    if (!m) return;
    var t = function (x) { return x.map(function (p) { return esc(p.name); }).join(' &amp; '); };
    var body =
      '<fieldset style="border:0;padding:0;margin:0 0 14px"><legend class="small muted" style="margin-bottom:8px;font-weight:600">Who won? (Court ' + m.courtNumber + ')</legend>' +
      '<div class="winner-pick">' +
      '<label><input type="radio" name="win" value="A"' + (existing && m.winningTeam === 'A' ? ' checked' : '') + '><span>Team A<small>' + t(m.teamA) + '</small></span></label>' +
      '<label><input type="radio" name="win" value="B"' + (existing && m.winningTeam === 'B' ? ' checked' : '') + '><span>Team B<small>' + t(m.teamB) + '</small></span></label>' +
      '</div></fieldset>' +
      '<div class="small muted" style="margin-bottom:6px;font-weight:600">Score (optional)</div>' +
      '<div class="score-row"><div><label for="sa" class="sr-only">Team A points</label><input id="sa" type="number" min="0" max="99" inputmode="numeric" placeholder="Team A"></div>' +
      '<span class="muted" style="padding-bottom:12px">–</span>' +
      '<div><label for="sb" class="sr-only">Team B points</label><input id="sb" type="number" min="0" max="99" inputmode="numeric" placeholder="Team B"></div></div>';
    ui.modal({
      title: existing ? 'Correct result' : 'Finish match',
      body: body,
      onOpen: function (root) {
        if (existing && m.score) { var p = m.score.split('-'); root.querySelector('#sa').value = p[0]; root.querySelector('#sb').value = p[1]; }
      },
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: existing ? 'Save correction' : 'Save result', kind: 'primary',
          onClick: async function (c) {
            var w = c.root.querySelector('input[name=win]:checked');
            if (!w) { ui.toast('Choose the winning team.', 'warn'); return false; }
            var sa = c.root.querySelector('#sa').value.trim(), sb = c.root.querySelector('#sb').value.trim();
            if ((sa && !sb) || (!sa && sb)) { ui.toast('Enter both scores or leave both empty.', 'warn'); return false; }
            var score = sa ? Number(sa) + '-' + Number(sb) : '';
            var d = await act(null, existing ? 'correctMatch' : 'completeMatch', { matchId: matchId, winningTeam: w.value, score: score },
              existing ? 'Result corrected.' : 'Match saved.');
            return !!d;
          }
        }
      ]
    });
  }

  function slotsHtml(options, selected, labels) {
    var out = '<div class="slots">';
    for (var i = 0; i < 4; i++) {
      if (i === 0) out += '<div class="slot-team">Team A</div>';
      if (i === 2) out += '<div class="slot-team">Team B</div>';
      out += '<label for="slot' + i + '" class="sr-only">' + labels[i] + '</label><select id="slot' + i + '">' +
        options.map(function (o) { return '<option value="' + esc(o.id) + '"' + (o.id === selected[i] ? ' selected' : '') + '>' + esc(o.name) + (o.tag ? ' (' + o.tag + ')' : '') + '</option>'; }).join('') + '</select>';
    }
    return out + '</div>';
  }

  function readSlots(root) {
    return [0, 1, 2, 3].map(function (i) { return root.querySelector('#slot' + i).value; });
  }

  function editPlayersModal(matchId) {
    var m = findMatch(matchId);
    if (!m) return;
    var current = m.players.map(function (p) { return { id: p.playerId, name: p.name, tag: 'on court' }; });
    var waiting = state.queue.map(function (q) { return { id: q.playerId, name: q.name, tag: '#' + q.position }; });
    ui.modal({
      title: 'Change players — Court ' + m.courtNumber,
      body: '<p class="muted small">Swap in waiting players or rearrange teams. A swapped-out player takes the replacement’s place in the queue.</p>' +
        slotsHtml(current.concat(waiting), current.map(function (c) { return c.id; }), ['Team A player 1', 'Team A player 2', 'Team B player 1', 'Team B player 2']),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Save changes', kind: 'primary',
          onClick: async function (c) {
            var ids = readSlots(c.root);
            if (new Set(ids).size !== 4) { ui.toast('Each player can only be picked once.', 'warn'); return false; }
            var d = await act(null, 'setMatchPlayers', { matchId: matchId, playerIds: ids }, 'Court updated.');
            return !!d;
          }
        }
      ]
    });
  }

  function pickPlayersModal(courtId) {
    var court = state.courts.filter(function (c) { return c.courtId === courtId; })[0];
    var waiting = state.queue.map(function (q) { return { id: q.playerId, name: q.name, tag: '#' + q.position }; });
    if (waiting.length < 4) { ui.toast('Need at least four waiting players.', 'warn'); return; }
    ui.modal({
      title: 'Start match — Court ' + court.courtNumber,
      body: '<p class="muted small">Defaults to the next four in the queue. Pick anyone waiting.</p>' +
        slotsHtml(waiting, waiting.slice(0, 4).map(function (w) { return w.id; }), ['Team A player 1', 'Team A player 2', 'Team B player 1', 'Team B player 2']),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Start match', kind: 'primary',
          onClick: async function (c) {
            var ids = readSlots(c.root);
            if (new Set(ids).size !== 4) { ui.toast('Each player can only be picked once.', 'warn'); return false; }
            var d = await act(null, 'startMatch', { courtId: courtId, playerIds: ids }, 'Match started.');
            return !!d;
          }
        }
      ]
    });
  }

  function targetModal(playerId, name) {
    var p = state.players.filter(function (x) { return x.playerId === playerId; })[0];
    if (!p) return;
    ui.modal({
      title: 'Target games — ' + name,
      body: '<p class="muted small">Players below their target are moved to the third group of the queue: they rest for the next two games, then take their turn. A target of 0 turns this off.</p>' +
        '<p class="small" style="margin:0 0 10px">Played <b>' + p.games + '</b> game' + (p.games === 1 ? '' : 's') + ' so far.</p>' +
        '<label for="tg">Games target</label><input id="tg" type="number" min="0" max="200" inputmode="numeric" value="' + p.targetGames + '">',
      onOpen: function (root) { root.querySelector('#tg').select(); },
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Save target', kind: 'primary',
          onClick: async function (c) {
            var v = Number(c.root.querySelector('#tg').value);
            if (!isFinite(v) || v < 0) { ui.toast('Enter 0 or more games.', 'warn'); return false; }
            return !!(await act(null, 'setPlayerTarget', { playerId: playerId, targetGames: Math.floor(v) }, 'Target updated.'));
          }
        }
      ]
    });
  }

  function renameModal(title, current, onSave, max) {
    ui.modal({
      title: title,
      body: '<label for="rn" class="sr-only">Name</label><input id="rn" type="text" maxlength="' + (max || 40) + '" value="' + esc(current) + '" autocomplete="off">',
      onOpen: function (root) { var i = root.querySelector('#rn'); i.select(); i.addEventListener('keydown', function (e) { if (e.key === 'Enter') root.querySelector('.btn.primary').click(); }); },
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Save', kind: 'primary', onClick: async function (c) { var v = c.root.querySelector('#rn').value.trim(); if (!v) return false; var d = await onSave(v); return !!d; } }
      ]
    });
  }

  /* ---------- queue ordering ---------- */
  function reorder(btn, id, how) {
    var ids = state.queue.map(function (q) { return q.playerId; });
    var i = ids.indexOf(id);
    if (i < 0) return;
    ids.splice(i, 1);
    var to = how === 'front' ? 0 : how === 'up' ? Math.max(0, i - 1) : Math.min(ids.length, i + 1);
    ids.splice(to, 0, id);
    return act(btn, 'reorderQueue', { playerIds: ids });
  }

  /* ---------- event delegation ---------- */
  document.addEventListener('click', async function (e) {
    var btn = e.target.closest && e.target.closest('[data-act]');
    if (!btn || !state) return;
    var a = btn.dataset.act, id = btn.dataset.id, match = btn.dataset.match;
    switch (a) {
      case 'finish': return resultModal(match, false);
      case 'correct': return resultModal(match, true);
      case 'edit-players': return editPlayersModal(match);
      case 'start-pick': return pickPlayersModal(btn.dataset.court);
      case 'start-auto': return act(btn, 'startMatch', { courtId: btn.dataset.court }, 'Match started.');
      case 'cancel-match':
        if (await ui.confirm({ title: 'Cancel this match?', message: 'The four players go back to the front of the queue. Nothing is counted in the stats.', confirmLabel: 'Cancel match', danger: true }))
          act(btn, 'cancelMatch', { matchId: match }, 'Match cancelled.');
        return;
      case 'void':
        if (await ui.confirm({ title: 'Void this result?', message: 'The match will no longer count towards anyone’s statistics.', confirmLabel: 'Void result', danger: true }))
          act(btn, 'cancelMatch', { matchId: match }, 'Result voided.');
        return;
      case 'q-front': return reorder(btn, id, 'front');
      case 'q-up': return reorder(btn, id, 'up');
      case 'q-down': return reorder(btn, id, 'down');
      case 'q-break': return act(btn, 'setPlayerStatus', { playerId: id, status: 'UNAVAILABLE' });
      case 'rejoin': return act(btn, 'setPlayerStatus', { playerId: id, status: 'WAITING' }, 'Back in the queue.');
      case 'q-remove': {
        var nm = btn.dataset.name || nameOf(id);
        if (await ui.confirm({ title: 'Remove ' + nm + '?', message: 'They leave the queue. If they are playing, they finish the current match first. Their match history is kept.', confirmLabel: 'Remove', danger: true })) {
          var d = await act(btn, 'removePlayer', { playerId: id });
          if (d && d.result && d.result.leavesAfterMatch) ui.toast(nm + ' will leave after the match.');
        }
        return;
      }
      case 'rename-player':
        return renameModal('Rename player', btn.dataset.name || '', function (v) { return act(null, 'editPlayer', { playerId: id, name: v }, 'Renamed.'); });
      case 'set-target': return targetModal(id, btn.dataset.name || nameOf(id));
    }
  });

  $('#quick-add').addEventListener('submit', async function (e) {
    e.preventDefault();
    var input = $('#quick-name'), v = U.cleanName(input.value);
    if (!v) return;
    var d = await act(e.submitter, 'addPlayers', { names: [v], catchUp: $('#quick-catchup').checked });
    if (d) { input.value = ''; input.focus(); }
  });

  $('#bulk-add').addEventListener('submit', async function (e) {
    e.preventDefault();
    var names = $('#bulk-names').value.split(/[\n,]+/).map(U.cleanName).filter(Boolean);
    if (!names.length) return;
    var d = await act(e.submitter, 'addPlayers', { names: names, catchUp: $('#bulk-catchup').checked }, names.length + ' player' + (names.length > 1 ? 's' : '') + ' added.');
    if (d) $('#bulk-names').value = '';
  });

  $('#fill').addEventListener('click', function (e) { act(e.currentTarget, 'fillCourts', {}, 'Courts checked.'); });
  $('#courts-plus').addEventListener('click', function (e) { act(e.currentTarget, 'setCourtCount', { courtCount: state.courts.length + 1 }); });
  $('#courts-minus').addEventListener('click', function (e) {
    if (state.courts.length > 1) act(e.currentTarget, 'setCourtCount', { courtCount: state.courts.length - 1 });
  });

  $('#copy-link').addEventListener('click', async function () {
    var ok = await U.copy(U.publicUrl(state.session.publicToken));
    ui.toast(ok ? 'Player link copied.' : 'Copy failed — open the player page and copy its address.', ok ? '' : 'warn');
  });

  $('#rename').addEventListener('click', function () {
    renameModal('Rename session', state.session.name, function (v) { return act(null, 'updateSession', { name: v }, 'Session renamed.'); }, 60);
  });

  $('#end-session').addEventListener('click', async function (e) {
    var live = state.courts.filter(function (c) { return c.match; }).length;
    var msg = 'Players will see that the session has ended and no more changes can be made.' + (live ? ' ' + live + ' match' + (live > 1 ? 'es' : '') + ' still in progress will be cancelled and not counted.' : '') + ' You can still correct finished results.';
    if (await ui.confirm({ title: 'End this session?', message: msg, confirmLabel: 'End session', danger: true })) act(e.currentTarget, 'closeSession', {}, 'Session ended.');
  });

  $('#delete-session').addEventListener('click', async function (e) {
    var btn = e.currentTarget;
    var ok = await ui.confirm({
      title: 'Delete this session?',
      message: 'Every player, match, result and announcement for this session will be permanently removed from the database. This cannot be undone.',
      confirmLabel: 'Delete forever', danger: true
    });
    if (!ok) return;
    await ui.busy(btn, async function () {
      try {
        await CQ.api.admin('deleteSession');
        CQ.auth.forget(sessionId);
        if (poller) poller.stop();
        location.replace('../index.html');
      } catch (err) { ui.error(err); }
    });
  });

  /* ---------- boot ---------- */
  var saved = CQ.auth.find(sessionId);
  if (saved && saved.adminToken && saved.expiresAt > Date.now()) {
    CQ.auth.use(saved);
    enterApp();
  } else {
    showLogin();
  }
})();
