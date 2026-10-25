/**
 * Matches.gs — match lifecycle and derived player statistics.
 *
 * Teams: players 1 & 2 are Team A, players 3 & 4 are Team B.
 * Only COMPLETED matches count towards statistics; stats are always derived.
 */

/* ---------- creating matches ---------- */

function createMatchOnCourt_(ctx, court, players, notificationType) {
  if (court.status !== 'AVAILABLE') fail_('COURT_BUSY', 'Court No. ' + court.court_number + ' is already in use.');
  if (players.length !== 4) fail_('INVALID_PLAYERS', 'A doubles match needs exactly four players.');
  var ids = players.map(function (p) { return p.player_id; });
  ids.forEach(function (id, i) { if (ids.indexOf(id) !== i) fail_('INVALID_PLAYERS', 'A player cannot be picked twice.'); });
  var active = activePlayerSet_(ctx);
  players.forEach(function (p) {
    if (active[p.player_id]) fail_('PLAYER_BUSY', p.player_name + ' is already in an active match.');
    if (p.status !== 'WAITING') fail_('INVALID_PLAYERS', p.player_name + ' is not waiting in the queue.');
  });

  var now = nowIso_();
  var m = {
    match_id: uid_('M_'), session_id: ctx.session.session_id, court_id: court.court_id,
    player_1_id: ids[0], player_2_id: ids[1], player_3_id: ids[2], player_4_id: ids[3],
    winning_team: '', score: '', status: 'IN_PROGRESS', started_at: now, completed_at: ''
  };
  insertRow_('Matches', m);
  ctx.matches.push(m);
  players.forEach(function (p) { p.status = 'PLAYING'; p.updated_at = now; updateRow_('Players', p); });
  court.status = 'IN_PROGRESS';
  court.current_match_id = m.match_id;
  updateRow_('Courts', court);
  var n = createNotification_(ctx, m, court, players, notificationType);
  return { match: m, notification: n };
}

/** startMatch { courtId, playerIds? } — manual start; defaults to the next four in the queue. */
function act_startMatch_(ctx, req) {
  var court = courtById_(ctx, String(req.courtId || ''));
  if (!court) fail_('NOT_FOUND', 'Court not found.');
  if (court.status !== 'AVAILABLE') fail_('COURT_BUSY', 'Court No. ' + court.court_number + ' is already in use.');
  var players;
  if (Array.isArray(req.playerIds) && req.playerIds.length) {
    players = req.playerIds.map(function (id) {
      var p = playerById_(ctx, String(id));
      if (!p) fail_('NOT_FOUND', 'Player not found.');
      return p;
    });
  } else {
    players = eligibleWaiting_(ctx).slice(0, 4);
    if (players.length < 4) fail_('INSUFFICIENT_PLAYERS', 'Court No. ' + court.court_number + ' is available. Waiting for more players.');
  }
  createMatchOnCourt_(ctx, court, players, NOTIFICATION_TYPES.ASSIGNMENT);
}

/* ---------- results ---------- */

function validateResult_(winningTeam, score) {
  winningTeam = String(winningTeam || '').toUpperCase();
  if (winningTeam !== 'A' && winningTeam !== 'B') fail_('INVALID_RESULT', 'Choose the winning team (A or B).');
  score = (score === undefined || score === null) ? '' : String(score).trim();
  if (score) {
    var m = score.match(/^(\d{1,2})\s*[-:–]\s*(\d{1,2})$/);
    if (!m) fail_('INVALID_SCORE', 'Score must look like 21-15 (Team A – Team B).');
    var a = Number(m[1]), b = Number(m[2]);
    if (a === b) fail_('INVALID_SCORE', 'Scores cannot be tied.');
    if ((a > b ? 'A' : 'B') !== winningTeam) fail_('INVALID_SCORE', 'The score does not match the winning team.');
    score = a + '-' + b;
  }
  return { winningTeam: winningTeam, score: score };
}

/**
 * completeMatch { matchId, winningTeam, score }
 * Idempotent: repeating the identical result is a no-op; a different result on an
 * already completed match is rejected (use correctMatch).
 */
function act_completeMatch_(ctx, req) {
  var m = matchById_(ctx, String(req.matchId || ''));
  if (!m) fail_('NOT_FOUND', 'Match not found.');
  var r = validateResult_(req.winningTeam, req.score);

  if (m.status === 'COMPLETED') {
    if (m.winning_team === r.winningTeam && m.score === r.score) return { duplicate: true };
    fail_('ALREADY_COMPLETED', 'This match was already completed. Use "Correct result" to change it.');
  }
  if (m.status !== 'IN_PROGRESS') fail_('MATCH_NOT_ACTIVE', 'This match is no longer in progress.');

  var now = nowIso_();
  m.winning_team = r.winningTeam;
  m.score = r.score;
  m.status = 'COMPLETED';
  m.completed_at = now;
  updateRow_('Matches', m);

  var court = courtById_(ctx, m.court_id);
  if (court) { court.status = 'AVAILABLE'; court.current_match_id = ''; updateRow_('Courts', court); }

  returnPlayersToQueue_(ctx, m, 'end');
  processAvailableCourts_(ctx);
}

/**
 * After a match, players go back in their match order.
 * where = 'end'   -> end of the queue (completed match, Rule 3)
 * where = 'front' -> front of the queue (cancelled match, nobody played)
 */
function returnPlayersToQueue_(ctx, m, where) {
  var now = nowIso_();
  var ids = matchPlayerIds_(m);
  var front = 0;
  if (where === 'front') {
    var waiting = ctx.players.filter(function (p) { return p.status === 'WAITING'; });
    front = waiting.length ? Math.min.apply(null, waiting.map(function (p) { return p.queue_order; })) : ctx.session.next_queue_order;
  }
  ids.forEach(function (id, i) {
    var p = playerById_(ctx, id);
    if (!p || p.status !== 'PLAYING') return;
    if (p.leave_after_match) {
      p.status = 'LEFT';
      p.leave_after_match = false;
    } else {
      p.status = 'WAITING';
      p.queue_order = where === 'front' ? front - (4 - i) : nextOrder_(ctx);
    }
    p.updated_at = now;
    updateRow_('Players', p);
  });
}

/** correctMatch { matchId, winningTeam, score } — only for COMPLETED matches. */
function act_correctMatch_(ctx, req) {
  var m = matchById_(ctx, String(req.matchId || ''));
  if (!m) fail_('NOT_FOUND', 'Match not found.');
  if (m.status !== 'COMPLETED') fail_('MATCH_NOT_COMPLETED', 'Only completed matches can be corrected.');
  var r = validateResult_(req.winningTeam, req.score);
  m.winning_team = r.winningTeam;
  m.score = r.score;
  updateRow_('Matches', m);
}

/**
 * cancelMatch { matchId }
 *  - IN_PROGRESS: players go back to the front of the queue; the freed court is
 *    not refilled in this same request (so the same four are not re-announced).
 *  - COMPLETED: the result is voided (status CANCELLED); stats update automatically.
 */
function act_cancelMatch_(ctx, req) {
  var m = matchById_(ctx, String(req.matchId || ''));
  if (!m) fail_('NOT_FOUND', 'Match not found.');
  if (m.status === 'CANCELLED') return { duplicate: true };
  var now = nowIso_();

  if (m.status === 'COMPLETED') {
    m.status = 'CANCELLED';
    updateRow_('Matches', m);
    return { voided: true };
  }
  m.status = 'CANCELLED';
  m.completed_at = now;
  updateRow_('Matches', m);
  var court = courtById_(ctx, m.court_id);
  if (court) { court.status = 'AVAILABLE'; court.current_match_id = ''; updateRow_('Courts', court); }
  returnPlayersToQueue_(ctx, m, 'front');
  processAvailableCourts_(ctx, { skipCourtIds: court ? [court.court_id] : [] });
}

/**
 * setMatchPlayers { matchId, playerIds: [4] } — manual adjustment of a live match.
 * New players must be WAITING; players swapped out take over the incoming
 * player's place in the queue. Reordering inside the four only changes teams.
 */
function act_setMatchPlayers_(ctx, req) {
  var m = matchById_(ctx, String(req.matchId || ''));
  if (!m) fail_('NOT_FOUND', 'Match not found.');
  if (m.status !== 'IN_PROGRESS') fail_('MATCH_NOT_ACTIVE', 'Only matches in progress can be changed.');
  var ids = Array.isArray(req.playerIds) ? req.playerIds.map(String) : [];
  if (ids.length !== 4) fail_('INVALID_PLAYERS', 'Pick exactly four players.');
  ids.forEach(function (id, i) { if (ids.indexOf(id) !== i) fail_('INVALID_PLAYERS', 'A player cannot be picked twice.'); });

  var oldIds = matchPlayerIds_(m);
  var activeElsewhere = activePlayerSet_(ctx, m.match_id);
  var incoming = ids.filter(function (id) { return oldIds.indexOf(id) === -1; });
  var outgoing = oldIds.filter(function (id) { return ids.indexOf(id) === -1; });
  incoming.forEach(function (id) {
    var p = playerById_(ctx, id);
    if (!p) fail_('NOT_FOUND', 'Player not found.');
    if (activeElsewhere[id]) fail_('PLAYER_BUSY', p.player_name + ' is already in another active match.');
    if (p.status !== 'WAITING') fail_('INVALID_PLAYERS', p.player_name + ' is not waiting in the queue.');
  });

  var now = nowIso_();
  outgoing.forEach(function (outId, i) {
    var outP = playerById_(ctx, outId);
    var inP = playerById_(ctx, incoming[i]);
    if (outP.leave_after_match) {
      outP.status = 'LEFT';
      outP.leave_after_match = false;
    } else {
      outP.status = 'WAITING';
      outP.queue_order = inP.queue_order;
    }
    outP.updated_at = now;
    updateRow_('Players', outP);
    inP.status = 'PLAYING';
    inP.updated_at = now;
    updateRow_('Players', inP);
  });

  m.player_1_id = ids[0]; m.player_2_id = ids[1]; m.player_3_id = ids[2]; m.player_4_id = ids[3];
  updateRow_('Matches', m);

  if (incoming.length) {
    var court = courtById_(ctx, m.court_id);
    createNotification_(ctx, m, court, ids.map(function (id) { return playerById_(ctx, id); }), NOTIFICATION_TYPES.UPDATE);
  }
}

/* ---------- statistics (derived) ---------- */

/** Returns { playerId: { games, wins, losses, winRate, history[] } } from COMPLETED matches only. */
function calculateStats_(ctx) {
  var names = {};
  ctx.players.forEach(function (p) { names[p.player_id] = p.player_name; });
  var courtNo = {};
  ctx.courts.forEach(function (c) { courtNo[c.court_id] = c.court_number; });
  var stats = {};
  ctx.players.forEach(function (p) { stats[p.player_id] = { games: 0, wins: 0, losses: 0, winRate: 0, history: [] }; });

  var done = ctx.matches
    .filter(function (m) { return m.status === 'COMPLETED' && (m.winning_team === 'A' || m.winning_team === 'B'); })
    .sort(function (a, b) { return a.completed_at < b.completed_at ? -1 : a.completed_at > b.completed_at ? 1 : a._row - b._row; });

  done.forEach(function (m) {
    var ids = matchPlayerIds_(m);
    ids.forEach(function (id, idx) {
      var s = stats[id];
      if (!s) return;
      var team = idx < 2 ? 'A' : 'B';
      var won = team === m.winning_team;
      s.games++;
      if (won) s.wins++; else s.losses++;
      var mates = (team === 'A' ? [ids[0], ids[1]] : [ids[2], ids[3]]).filter(function (x) { return x !== id; });
      var opps = team === 'A' ? [ids[2], ids[3]] : [ids[0], ids[1]];
      var score = m.score;
      if (score && team === 'B') { var p = score.split('-'); score = p[1] + '-' + p[0]; }
      s.history.push({
        matchId: m.match_id,
        courtNumber: courtNo[m.court_id] || 0,
        result: won ? 'W' : 'L',
        partner: names[mates[0]] || 'Unknown',
        opponents: opps.map(function (x) { return names[x] || 'Unknown'; }),
        score: score || '',
        completedAt: m.completed_at
      });
    });
  });

  Object.keys(stats).forEach(function (id) {
    var s = stats[id];
    s.winRate = s.games ? Math.round((s.wins / s.games) * 1000) / 10 : 0;
    s.history.reverse();
    s.history = s.history.slice(0, 30);
  });
  return stats;
}
