/**
 * Shared renderers (return HTML strings): courts, queue, statistics, results, announcements.
 * Used by both the public session page and the admin dashboard.
 */
(function () {
  var CQ = window.CQ, U = CQ.util, esc = U.esc;
  var V = CQ.views = {};

  /* keeps <details> open across re-renders */
  var openStats = {};
  V.bindDetails = function (container) {
    container.addEventListener('toggle', function (e) {
      var d = e.target;
      if (d && d.dataset && d.dataset.pid) { if (d.open) openStats[d.dataset.pid] = true; else delete openStats[d.dataset.pid]; }
    }, true);
  };

  function mine(meId, id) { return meId && meId === id; }
  V.gamesBadge = function (state, playerId) {
    var stat = state.stats.filter(function (s) { return s.playerId === playerId; })[0];
    var games = stat ? stat.games : 0;
    var label = games + ' game' + (games === 1 ? '' : 's');
    var description = games + ' completed game' + (games === 1 ? '' : 's');
    return '<span class="games-count" title="' + description + '">' + label + '</span>';
  };

  /** Shown while a player is below their target games: resting, then guaranteed a game. */
  V.targetBadge = function (item) {
    if (!item || !item.needsGames) return '';
    var n = item.needsGames;
    return '<span class="prio-badge" title="Catch-up: ' + n + ' more game' + (n === 1 ? '' : 's') +
      ' towards a target of ' + item.targetGames + '. They rest for the next games, then take their turn.">\u2191 ' + n + ' to go</span>';
  };

  /* ---------- courts ---------- */

  /* Top-down doubles court, 50 units per metre (13.4 m x 6.1 m) plus an 18-unit surround.
     Only lines are drawn here; player names are HTML chips laid over it (see .court-draw). */
  var COURT_SVG =
    '<svg class="court-svg" viewBox="0 0 706 341" aria-hidden="true" focusable="false">' +
    '<rect class="cs-surround" x="0" y="0" width="706" height="341" rx="20"/>' +
    '<rect class="cs-floor" x="18" y="18" width="670" height="305"/>' +
    '<g class="cs-lines">' +
      '<rect x="18" y="18" width="670" height="305"/>' +
      '<line x1="18" y1="41" x2="688" y2="41"/><line x1="18" y1="300" x2="688" y2="300"/>' +
      '<line x1="56" y1="18" x2="56" y2="323"/><line x1="650" y1="18" x2="650" y2="323"/>' +
      '<line x1="254" y1="18" x2="254" y2="323"/><line x1="452" y1="18" x2="452" y2="323"/>' +
      '<line x1="18" y1="170.5" x2="254" y2="170.5"/><line x1="452" y1="170.5" x2="688" y2="170.5"/>' +
    '</g>' +
    '<g class="cs-net"><line class="net-shadow" x1="353" y1="8" x2="353" y2="333"/>' +
    '<line class="net-body" x1="353" y1="8" x2="353" y2="333"/>' +
    '<circle cx="353" cy="8" r="6"/><circle cx="353" cy="333" r="6"/></g>' +
    '</svg>';

  V.courts = function (state, opts) {
    opts = opts || {};
    var closed = state.session.status !== 'ACTIVE';
    if (!state.courts.length) return '<div class="empty">No courts configured.</div>';
    return state.courts.map(function (c) {
      var live = c.status === 'IN_PROGRESS' && c.match;
      var head = '<div class="court-head"><span class="court-no">Court ' + c.courtNumber + '</span>' +
        (live ? '<span class="pill pill-green"><i class="dot"></i>IN PLAY</span>' : '<span class="pill pill-gray">AVAILABLE</span>') + '</div>';
      var body;
      if (live) {
        var p = c.match.players;
        var chip = function (x, pos) {
          return '<span class="pchip ' + pos + (mine(opts.meId, x.playerId) ? ' me' : '') + '"><span class="pchip-name">' + esc(x.name) +
            '</span>' + V.gamesBadge(state, x.playerId) + '</span>';
        };
        body = '<figure class="court-draw" aria-label="Court ' + c.courtNumber + ': ' + esc(p[0].name) + ' and ' + esc(p[1].name) +
          ' versus ' + esc(p[2].name) + ' and ' + esc(p[3].name) + '">' + COURT_SVG +
          chip(p[0], 'a1') + chip(p[1], 'a2') + chip(p[2], 'b1') + chip(p[3], 'b2') + '</figure>' +
          '<div class="court-teams"><span>Team A</span><span class="court-meta">' + esc(U.fmtTime(c.match.startedAt)) + ' · ' + esc(U.elapsed(c.match.startedAt)) + '</span><span>Team B</span></div>';
        if (opts.admin && !closed) {
          body += '<div class="court-actions">' +
            '<button class="btn primary sm" data-act="finish" data-match="' + esc(c.match.matchId) + '">Finish match</button>' +
            '<button class="btn sm" data-act="edit-players" data-match="' + esc(c.match.matchId) + '">Change players</button>' +
            '<button class="btn danger sm" data-act="cancel-match" data-match="' + esc(c.match.matchId) + '">Cancel</button></div>';
        }
      } else {
        body = '<figure class="court-draw is-empty" aria-label="Court ' + c.courtNumber + ' is empty">' + COURT_SVG +
          '<span class="court-empty">' + (closed ? 'Session ended' : 'Waiting for players') + '</span></figure>' +
          '<div class="court-avail">' + esc(c.message || (closed ? 'Session ended.' : 'Court available.')) + '</div>';
        if (opts.admin && !closed) {
          body += '<div class="court-actions">' +
            '<button class="btn primary sm" data-act="start-auto" data-court="' + esc(c.courtId) + '"' + (state.queue.length < 4 ? ' disabled' : '') + '>Start next four</button>' +
            '<button class="btn sm" data-act="start-pick" data-court="' + esc(c.courtId) + '"' + (state.queue.length < 4 ? ' disabled' : '') + '>Pick players…</button></div>';
        }
      }
      return '<article class="court-card ' + (live ? 'live' : 'free') + '" aria-label="Court ' + c.courtNumber + '">' + head + body + '</article>';
    }).join('');
  };

  /* ---------- queue ---------- */
  V.counts = function (state) {
    var c = state.counts;
    return '<div class="counts"><span class="pill pill-yellow">' + c.waiting + ' waiting</span>' +
      '<span class="pill pill-green">' + c.playing + ' playing</span>' +
      (c.unavailable ? '<span class="pill pill-gray">' + c.unavailable + ' on break</span>' : '') + '</div>';
  };

  /**
   * Queue grouped into upcoming matches of four. The backend puts queue positions 1-2 on Team A
   * and 3-4 on Team B, so these pairings are exactly what the next assignment will produce
   * (as long as the queue doesn't change before then).
   */
  V.queue = function (state, opts) {
    opts = opts || {};
    var q = state.queue;
    if (!q.length) {
      return '<div class="empty">The queue is empty. ' + (opts.admin ? 'Add players to get started.' : 'Waiting for players to join.') + '</div>';
    }
    var last = q.length - 1;
    var active = state.session.status === 'ACTIVE';

    function row(item) {
      var i = item.position - 1, admin = '';
      if (opts.admin) {
        admin = '<div class="q-actions">' +
          '<button class="btn sm icon" data-act="q-front" data-id="' + esc(item.playerId) + '" aria-label="Move ' + esc(item.name) + ' to front" title="Move to front"' + (i === 0 ? ' disabled' : '') + '>⤒</button>' +
          '<button class="btn sm icon" data-act="q-up" data-id="' + esc(item.playerId) + '" aria-label="Move ' + esc(item.name) + ' up" title="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button class="btn sm icon" data-act="q-down" data-id="' + esc(item.playerId) + '" aria-label="Move ' + esc(item.name) + ' down" title="Move down"' + (i === last ? ' disabled' : '') + '>↓</button>' +
          '<button class="btn sm icon" data-act="q-break" data-id="' + esc(item.playerId) + '" aria-label="Mark ' + esc(item.name) + ' unavailable" title="Mark unavailable">⏸</button>' +
          '<button class="btn sm icon danger" data-act="q-remove" data-id="' + esc(item.playerId) + '" data-name="' + esc(item.name) + '" aria-label="Remove ' + esc(item.name) + '" title="Remove">✕</button></div>';
      }
      return '<li class="q-item' + (mine(opts.meId, item.playerId) ? ' me' : '') + '">' +
        '<span class="pos" aria-label="Position ' + item.position + '">' + item.position + '</span>' +
        '<span class="avatar" aria-hidden="true">' + esc(U.initials(item.name)) + '</span>' +
        '<span class="q-name">' + esc(item.name) + '</span>' + V.targetBadge(item) + V.gamesBadge(state, item.playerId) + admin + '</li>';
    }
    var slot = '<li class="q-item slot"><span class="pos" aria-hidden="true">–</span><span class="q-name">Open spot</span></li>';
    function team(label, a, b) {
      return '<div class="qteam"><div class="team-label">' + label + '</div><ul class="queue">' + (a ? row(a) : slot) + (b ? row(b) : slot) + '</ul></div>';
    }

    var html = '', n = 0;
    for (var g = 0; g < q.length; g += 4, n++) {
      var m = q.slice(g, g + 4), full = m.length === 4;
      var title = !full ? 'Waiting for ' + (4 - m.length) + ' more player' + (4 - m.length > 1 ? 's' : '')
        : n === 0 ? 'Up next' : n === 1 ? 'After that' : 'Coming up';
      var pill = (n === 0 && full && active) ? '<span class="pill pill-yellow">NEXT UP</span>' : '';
      html += '<section class="qgroup' + (n === 0 && full && active ? ' next' : '') + (full ? '' : ' partial') + '" aria-label="' + esc(title) + '">' +
        '<header class="qg-head"><span class="qg-no" aria-hidden="true">' + (n + 1) + '</span><span class="qg-title">' + title + '</span>' + pill + '</header>' +
        '<div class="qg-teams">' + team('Team A', m[0], m[1]) + '<div class="qvs" aria-hidden="true">VS</div>' + team('Team B', m[2], m[3]) + '</div></section>';
    }
    return '<div class="qgroups">' + html + '</div>' +
      '<p class="hint">Teams are projected from the current queue order. They can change if players join, leave or are reordered.</p>';
  };

  /* ---------- statistics ---------- */
  V.stats = function (state, opts) {
    opts = opts || {};
    if (!state.stats.length) return '<div class="empty">No players yet.</div>';
    var rows = state.stats.map(function (s, i) {
      var hist = s.history.length
        ? '<ul class="history">' + s.history.map(function (h) {
            return '<li><span class="res ' + h.result + '" aria-label="' + (h.result === 'W' ? 'Win' : 'Loss') + '">' + h.result + '</span>' +
              '<span>with <b>' + esc(h.partner) + '</b> vs ' + esc(h.opponents.join(' & ')) + '</span>' +
              (h.score ? '<span class="muted">' + esc(h.score) + '</span>' : '') +
              '<span class="muted small">Court ' + h.courtNumber + ' · ' + esc(U.fmtTime(h.completedAt)) + '</span></li>';
          }).join('') + '</ul>'
        : '<p class="muted small" style="padding:4px 8px 14px 38px;margin:0">No completed matches yet.</p>';
      var status = s.status === 'LEFT' ? ' <span class="pill pill-gray">LEFT</span>' : s.status === 'UNAVAILABLE' ? ' <span class="pill pill-gray">BREAK</span>' : '';
      return '<details class="stat-row' + (mine(opts.meId, s.playerId) ? ' me' : '') + '" data-pid="' + esc(s.playerId) + '"' + (openStats[s.playerId] ? ' open' : '') + '>' +
        '<summary><span class="muted">' + (i + 1) + '</span>' +
        '<span><span class="pname">' + esc(s.name) + '</span>' + status + '</span>' +
        '<span class="num">' + s.games + '</span><span class="num">' + s.wins + '</span><span class="num">' + s.losses + '</span>' +
        '<span><span class="rate">' + (s.games ? s.winRate + '%' : '0%') + '</span><div class="bar"><i style="width:' + s.winRate + '%"></i></div></span></summary>' + hist + '</details>';
    }).join('');
    return '<div class="stat-head"><span>#</span><span>Player</span><span class="num" title="Games played">GP</span><span class="num" title="Wins">W</span><span class="num" title="Losses">L</span><span class="rate">Win %</span></div>' + rows +
      '<p class="muted small" style="margin-top:12px">Win rate = wins ÷ games played × 100. Tap a player for match history.</p>';
  };

  /* ---------- recent results ---------- */
  V.results = function (state) {
    if (!state.recentMatches.length) return '<div class="empty">No completed matches yet.</div>';
    return state.recentMatches.map(function (m) {
      var names = function (t) { return t.map(function (p) { return esc(p.name); }).join(' & '); };
      var a = m.winningTeam === 'A', b = m.winningTeam === 'B';
      return '<div class="result"><div class="muted small">Court ' + m.courtNumber + ' · ' + esc(U.fmtTime(m.completedAt)) + '</div>' +
        '<div class="vsline"><span class="' + (a ? 'winner' : '') + '">' + (a ? '🏆 ' : '') + names(m.teamA) + '</span> <span class="muted">vs</span> ' +
        '<span class="' + (b ? 'winner' : '') + '">' + (b ? '🏆 ' : '') + names(m.teamB) + '</span></div>' +
        (m.score ? '<div class="muted small">Score (A–B): ' + esc(m.score) + '</div>' : '') + '</div>';
    }).join('');
  };

  /* ---------- announcements ---------- */
  V.announcements = function (state, limit) {
    var list = state.notifications.slice(-(limit || 6)).reverse();
    if (!list.length) return '<div class="empty">No court assignments yet.</div>';
    return '<ul class="announce">' + list.map(function (n) {
      return '<li><time datetime="' + esc(n.createdAt) + '">' + esc(U.fmtTime(n.createdAt)) + '</time>' + esc(n.message) + '</li>';
    }).join('') + '</ul>';
  };
})();
