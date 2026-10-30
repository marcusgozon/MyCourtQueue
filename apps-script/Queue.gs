/**
 * Queue.gs — sessions, players, courts and the central queue algorithm.
 *
 * All handlers named act_*_(ctx, req) run inside the script lock (see Code.gs)
 * with a freshly loaded context: { session, players, courts, matches }.
 */

/* ---------- context ---------- */

function loadContext_(sessionId) {
  var session = findSessionById_(sessionId);
  if (!session) fail_('NOT_FOUND', 'Session not found.');
  var mine = function (r) { return r.session_id === sessionId; };
  return {
    session: session,
    players: readTable_('Players').filter(mine),
    courts: readTable_('Courts').filter(mine).sort(function (a, b) { return a.court_number - b.court_number; }),
    matches: readTable_('Matches').filter(mine)
  };
}

function touchSession_(ctx) {
  ctx.session.updated_at = nowIso_();
  updateRow_('Sessions', ctx.session);
}

function assertActive_(ctx) {
  if (ctx.session.status !== 'ACTIVE') fail_('SESSION_CLOSED', 'This session has ended.');
}

function nextOrder_(ctx) {
  var n = ctx.session.next_queue_order;
  ctx.session.next_queue_order = n + 1;
  return n;
}

function playerById_(ctx, id) {
  for (var i = 0; i < ctx.players.length; i++) if (ctx.players[i].player_id === id) return ctx.players[i];
  return null;
}
function courtById_(ctx, id) {
  for (var i = 0; i < ctx.courts.length; i++) if (ctx.courts[i].court_id === id) return ctx.courts[i];
  return null;
}
function matchById_(ctx, id) {
  for (var i = 0; i < ctx.matches.length; i++) if (ctx.matches[i].match_id === id) return ctx.matches[i];
  return null;
}
function matchPlayerIds_(m) { return [m.player_1_id, m.player_2_id, m.player_3_id, m.player_4_id]; }

/** Set of player ids in an IN_PROGRESS match (optionally ignoring one match). */
function activePlayerSet_(ctx, exceptMatchId) {
  var set = {};
  ctx.matches.forEach(function (m) {
    if (m.status === 'IN_PROGRESS' && m.match_id !== exceptMatchId) {
      matchPlayerIds_(m).forEach(function (id) { set[id] = true; });
    }
  });
  return set;
}

/** Copy of list in random order (Fisher–Yates). */
function shuffle_(list) {
  var out = list.slice();
  for (var i = out.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/** Games played per player id. Only COMPLETED matches count, exactly like the stats. */
function gamesPlayedMap_(ctx) {
  var map = {};
  ctx.players.forEach(function (p) { map[p.player_id] = 0; });
  ctx.matches.forEach(function (m) {
    if (m.status !== 'COMPLETED') return;
    matchPlayerIds_(m).forEach(function (id) { if (map[id] !== undefined) map[id]++; });
  });
  return map;
}

/** Games a player still owes to reach their target (0 = no target, or target met). */
function gamesNeeded_(p, played) {
  var target = Math.max(0, Number(p.target_games) || 0);
  return Math.max(0, target - (played[p.player_id] || 0));
}

/** Most games played by any player still in the session (used for "catch up"). */
function maxGamesPlayed_(ctx) {
  var played = gamesPlayedMap_(ctx);
  var max = 0;
  ctx.players.forEach(function (p) {
    if (p.status === 'LEFT') return;
    if ((played[p.player_id] || 0) > max) max = played[p.player_id];
  });
  return max;
}

/**
 * WAITING players that are in no active match, in queue order.
 * Players below their target games are NOT pulled forward here: they were placed a couple
 * of games back when they were added (see placeInThirdGroup_), so they get their rest and
 * then play in turn. Their queue position decides the game, which is what guarantees it.
 */
function eligibleWaiting_(ctx) {
  var active = activePlayerSet_(ctx);
  return ctx.players
    .filter(function (p) { return p.status === 'WAITING' && !active[p.player_id]; })
    .sort(function (a, b) { return a.queue_order - b.queue_order || a._row - b._row; });
}

/**
 * Puts a catch-up player at the start of the third group of four, so they sit out the next
 * two games (rest) and are then guaranteed their turn. Players behind that point each move
 * back one slot; players in front are untouched.
 * With fewer than PRIORITY_REST_SLOTS players waiting there is nothing to rest behind, so
 * the player simply keeps the newest (end-of-queue) position.
 */
function placeInThirdGroup_(ctx, p) {
  var others = ctx.players
    .filter(function (q) { return q.status === 'WAITING' && q.player_id !== p.player_id; })
    .sort(function (a, b) { return a.queue_order - b.queue_order || a._row - b._row; });
  var at = Math.min(LIMITS.PRIORITY_REST_SLOTS, others.length);
  var now = nowIso_();
  p.queue_order = nextOrder_(ctx);
  p.updated_at = now;
  updateRow_('Players', p);
  for (var i = at; i < others.length; i++) {
    others[i].queue_order = nextOrder_(ctx);
    others[i].updated_at = now;
    updateRow_('Players', others[i]);
  }
}

/** Puts every waiting player who still owes games at the start of the third group. */
function applyTargetPriority_(ctx, players) {
  var played = gamesPlayedMap_(ctx);
  (players || ctx.players).forEach(function (p) {
    if (p.status !== 'WAITING') return;
    if (gamesNeeded_(p, played) <= 0) return;
    placeInThirdGroup_(ctx, p);
  });
}

/* ---------- validation ---------- */

/**
 * Reduces pasted text to just the player's name: drops list numbering ("1.", "2)", "(3)"),
 * bullets, emoji, digits and other symbols, keeping letters, marks, spaces, apostrophes
 * and hyphens ("Anne-Marie"). Returns '' when nothing name-like is left.
 */
function stripNameNoise_(raw) {
  var s = String(raw === undefined || raw === null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^\s*(?:\(?\d{1,3}\)?[.):\-–—]?|[-–—•*·])\s*/, '')
    .replace(/[^\p{L}\p{M}\s'’\-]/gu, ' ')
    .replace(/[’]/g, "'")
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^-+|-+$/g, '')
    .trim();
  return s;
}

function cleanName_(raw) {
  var n = stripNameNoise_(raw);
  if (!n) fail_('INVALID_NAME', 'Player names cannot be empty.');
  if (n.length > LIMITS.NAME_MAX) fail_('INVALID_NAME', 'Player names are limited to ' + LIMITS.NAME_MAX + ' characters.');
  return n;
}

function parseTargetGames_(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  var n = Math.floor(Number(raw));
  if (!isFinite(n) || n < 0 || n > LIMITS.MAX_TARGET_GAMES) {
    fail_('INVALID_TARGET', 'Target games must be between 0 and ' + LIMITS.MAX_TARGET_GAMES + '.');
  }
  return n;
}

function parseNames_(req) {
  var src = req.names !== undefined ? req.names : req.name;
  var list = [];
  if (Array.isArray(src)) list = src;
  else if (typeof src === 'string') list = src.split(/[\n,]+/);
  // Clean first, then drop entries that were only numbering/symbols (e.g. a stray "1." line).
  list = list.map(stripNameNoise_).filter(function (n) { return n.length; });
  return list.map(cleanName_);
}

/* ---------- sessions ---------- */

function newPublicToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
}

/** createSession { name, courtCount, players[], password } */
function act_createSession_(req) {
  var name = String(req.name || '').replace(/\s+/g, ' ').trim();
  if (!name) fail_('INVALID_NAME', 'Please enter a session name.');
  if (name.length > LIMITS.SESSION_NAME_MAX) fail_('INVALID_NAME', 'Session names are limited to ' + LIMITS.SESSION_NAME_MAX + ' characters.');
  var courtCount = Math.floor(Number(req.courtCount));
  if (!(courtCount >= 1 && courtCount <= LIMITS.MAX_COURTS)) fail_('INVALID_COURTS', 'Courts must be between 1 and ' + LIMITS.MAX_COURTS + '.');
  var password = String(req.password || '');
  if (password.length < LIMITS.MIN_PASSWORD) fail_('WEAK_PASSWORD', 'Password must be at least ' + LIMITS.MIN_PASSWORD + ' characters.');
  var names = parseNames_({ names: req.players });
  if (names.length > LIMITS.MAX_PLAYERS) fail_('TOO_MANY_PLAYERS', 'Too many players (max ' + LIMITS.MAX_PLAYERS + ').');

  var now = nowIso_();
  var session = {
    session_id: uid_('S_'),
    session_name: name,
    public_token: newPublicToken_(),
    status: 'ACTIVE',
    court_count: courtCount,
    next_queue_order: 1,
    created_at: now,
    updated_at: now
  };
  insertRow_('Sessions', session);
  insertRow_('SessionAdmins', {
    session_id: session.session_id,
    admin_id: uid_('A_'),
    credential_hash: makeCredential_(password),
    role: 'OWNER',
    created_at: now
  });
  var courtRows = [];
  for (var i = 1; i <= courtCount; i++) {
    courtRows.push({ court_id: uid_('C_'), session_id: session.session_id, court_number: i, status: 'AVAILABLE', current_match_id: '' });
  }
  insertRows_('Courts', courtRows);

  var ctx = loadContext_(session.session_id);
  addPlayersCore_(ctx, names);
  processAvailableCourts_(ctx);
  touchSession_(ctx);

  var expiresAt = Date.now() + TOKEN_TTL_MS;
  return {
    sessionId: session.session_id,
    name: session.session_name,
    publicToken: session.public_token,
    adminToken: signToken_(session.session_id, expiresAt),
    expiresAt: expiresAt
  };
}

function act_updateSession_(ctx, req) {
  var name = String(req.name || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > LIMITS.SESSION_NAME_MAX) fail_('INVALID_NAME', 'Enter a session name up to ' + LIMITS.SESSION_NAME_MAX + ' characters.');
  ctx.session.session_name = name;
}

/**
 * deleteSession: permanently removes the session and every row that belongs to it.
 * Callers must not read the session state afterwards (Code.gs flags this action noState).
 */
function act_deleteSession_(ctx) {
  var id = ctx.session.session_id;
  var tables = ['Notifications', 'Matches', 'Players', 'Courts', 'SessionAdmins', 'Sessions'];
  var removed = {};
  tables.forEach(function (name) {
    var rows = readTable_(name).filter(function (r) { return r.session_id === id; });
    if (rows.length) deleteRows_(name, rows);
    removed[name] = rows.length;
  });
  CacheService.getScriptCache().remove('fail_' + id);
  return { deleted: true, removed: removed };
}

/** closeSession: cancels live matches, releases courts, marks the session CLOSED. */
function act_closeSession_(ctx) {
  if (ctx.session.status === 'CLOSED') return { alreadyClosed: true };
  var now = nowIso_();
  ctx.matches.filter(function (m) { return m.status === 'IN_PROGRESS'; }).forEach(function (m) {
    m.status = 'CANCELLED';
    m.completed_at = now;
    updateRow_('Matches', m);
    matchPlayerIds_(m).forEach(function (id) {
      var p = playerById_(ctx, id);
      if (p && p.status === 'PLAYING') { p.status = p.leave_after_match ? 'LEFT' : 'WAITING'; p.updated_at = now; updateRow_('Players', p); }
    });
  });
  ctx.courts.forEach(function (c) {
    if (c.status !== 'AVAILABLE') { c.status = 'AVAILABLE'; c.current_match_id = ''; updateRow_('Courts', c); }
  });
  ctx.session.status = 'CLOSED';
  return { closed: true };
}

/* ---------- players ---------- */

/** targetGames = null keeps a returning player's target (new players start at 0). */
function addPlayersCore_(ctx, names, targetGames) {
  var seen = {};
  names.forEach(function (n) {
    var k = n.toLowerCase();
    if (seen[k]) fail_('DUPLICATE_NAME', 'Duplicate name in the list: ' + n);
    seen[k] = true;
    var clash = ctx.players.filter(function (p) { return p.status !== 'LEFT' && p.player_name.toLowerCase() === k; })[0];
    if (clash) fail_('DUPLICATE_NAME', '"' + clash.player_name + '" is already in this session.');
  });
  var activeCount = ctx.players.filter(function (p) { return p.status !== 'LEFT'; }).length;
  if (activeCount + names.length > LIMITS.MAX_PLAYERS) fail_('TOO_MANY_PLAYERS', 'Too many players (max ' + LIMITS.MAX_PLAYERS + ').');

  var now = nowIso_();
  var added = [];
  var fresh = [];
  names.forEach(function (n) {
    var k = n.toLowerCase();
    var returning = ctx.players.filter(function (p) { return p.status === 'LEFT' && p.player_name.toLowerCase() === k; })[0];
    if (returning) {
      returning.status = 'WAITING';
      returning.leave_after_match = false;
      returning.queue_order = nextOrder_(ctx);
      if (targetGames !== null) returning.target_games = targetGames;
      returning.updated_at = now;
      updateRow_('Players', returning);
      added.push(returning);
    } else {
      var p = {
        player_id: uid_('P_'), session_id: ctx.session.session_id, player_name: n,
        queue_order: nextOrder_(ctx), status: 'WAITING', leave_after_match: false,
        target_games: targetGames === null ? 0 : targetGames,
        joined_at: now, updated_at: now
      };
      fresh.push(p);
      ctx.players.push(p);
      added.push(p);
    }
  });
  insertRows_('Players', fresh);
  return added;
}

/**
 * addPlayers { names[], targetGames?, catchUp? }
 * targetGames applies to every name in the request; catchUp sets the target to the
 * most games anyone in the session has played, so a late arrival catches up.
 */
function act_addPlayers_(ctx, req) {
  var names = parseNames_(req);
  if (!names.length) fail_('INVALID_NAME', 'Enter at least one player name.');
  var target = null;
  if (req.catchUp) target = maxGamesPlayed_(ctx);
  else if (req.targetGames !== undefined && req.targetGames !== null && req.targetGames !== '') target = parseTargetGames_(req.targetGames);
  var added = addPlayersCore_(ctx, names, target);
  applyTargetPriority_(ctx, added);
  processAvailableCourts_(ctx);
}

/** setPlayerTarget { playerId, targetGames } — 0 removes priority. */
function act_setPlayerTarget_(ctx, req) {
  var p = playerById_(ctx, String(req.playerId || ''));
  if (!p) fail_('NOT_FOUND', 'Player not found.');
  p.target_games = parseTargetGames_(req.targetGames);
  p.updated_at = nowIso_();
  updateRow_('Players', p);
  applyTargetPriority_(ctx, [p]);
}

function act_editPlayer_(ctx, req) {
  var p = playerById_(ctx, String(req.playerId || ''));
  if (!p) fail_('NOT_FOUND', 'Player not found.');
  var name = cleanName_(req.name);
  var clash = ctx.players.filter(function (o) {
    return o.player_id !== p.player_id && o.status !== 'LEFT' && o.player_name.toLowerCase() === name.toLowerCase();
  })[0];
  if (clash) fail_('DUPLICATE_NAME', '"' + clash.player_name + '" is already in this session.');
  p.player_name = name;
  p.updated_at = nowIso_();
  updateRow_('Players', p);
}

/** Removes a player. A player in a live match keeps playing and leaves afterwards. */
function act_removePlayer_(ctx, req) {
  var p = playerById_(ctx, String(req.playerId || ''));
  if (!p) fail_('NOT_FOUND', 'Player not found.');
  if (p.status === 'LEFT') return;
  var result = {};
  if (p.status === 'PLAYING') {
    p.leave_after_match = true;
    result.leavesAfterMatch = true;
  } else {
    p.status = 'LEFT';
    p.leave_after_match = false;
  }
  p.updated_at = nowIso_();
  updateRow_('Players', p);
  return result;
}

/** setPlayerStatus { playerId, status: WAITING | UNAVAILABLE } */
function act_setPlayerStatus_(ctx, req) {
  var p = playerById_(ctx, String(req.playerId || ''));
  if (!p) fail_('NOT_FOUND', 'Player not found.');
  var target = String(req.status || '');
  if (target !== 'WAITING' && target !== 'UNAVAILABLE') fail_('INVALID_STATUS', 'Status must be WAITING or UNAVAILABLE.');
  var now = nowIso_();

  if (p.status === 'PLAYING') {
    if (target === 'UNAVAILABLE') fail_('PLAYER_IN_MATCH', 'This player is in a match. Remove them to leave after the match.');
    if (p.leave_after_match) { p.leave_after_match = false; p.updated_at = now; updateRow_('Players', p); }
    return;
  }
  if (p.status === target) return;
  if (target === 'UNAVAILABLE') {
    p.status = 'UNAVAILABLE';
  } else {
    p.status = 'WAITING';
    p.leave_after_match = false;
    p.queue_order = nextOrder_(ctx);
  }
  p.updated_at = now;
  updateRow_('Players', p);
  applyTargetPriority_(ctx, [p]);
  processAvailableCourts_(ctx);
}

/** reorderQueue { playerIds: [...] } — must be exactly the current waiting set. */
function act_reorderQueue_(ctx, req) {
  var ids = Array.isArray(req.playerIds) ? req.playerIds.map(String) : [];
  var waiting = ctx.players.filter(function (p) { return p.status === 'WAITING'; });
  var waitingIds = waiting.map(function (p) { return p.player_id; }).sort();
  var given = ids.slice().sort();
  var distinct = given.every(function (id, i) { return i === 0 || id !== given[i - 1]; });
  if (!distinct || given.length !== waitingIds.length || given.some(function (id, i) { return id !== waitingIds[i]; })) {
    fail_('QUEUE_CHANGED', 'The queue changed while you were editing. It has been refreshed — please try again.');
  }
  var orders = waiting.map(function (p) { return p.queue_order; }).sort(function (a, b) { return a - b; });
  var now = nowIso_();
  ids.forEach(function (id, i) {
    var p = playerById_(ctx, id);
    if (p.queue_order !== orders[i]) { p.queue_order = orders[i]; p.updated_at = now; updateRow_('Players', p); }
  });
}

/* ---------- courts ---------- */

function act_setCourtCount_(ctx, req) {
  var count = Math.floor(Number(req.courtCount));
  if (!(count >= 1 && count <= LIMITS.MAX_COURTS)) fail_('INVALID_COURTS', 'Courts must be between 1 and ' + LIMITS.MAX_COURTS + '.');
  var current = ctx.courts.length;
  if (count > current) {
    for (var n = current + 1; n <= count; n++) {
      var c = { court_id: uid_('C_'), session_id: ctx.session.session_id, court_number: n, status: 'AVAILABLE', current_match_id: '' };
      insertRow_('Courts', c);
      ctx.courts.push(c);
    }
  } else if (count < current) {
    var doomed = ctx.courts.filter(function (c) { return c.court_number > count; });
    if (doomed.some(function (c) { return c.status !== 'AVAILABLE'; })) {
      fail_('COURT_BUSY', 'Finish or cancel the matches on the courts being removed first.');
    }
    deleteRows_('Courts', doomed);
    ctx.courts = ctx.courts.filter(function (c) { return c.court_number <= count; });
  }
  ctx.session.court_count = count;
  processAvailableCourts_(ctx);
}

/* ---------- central queue algorithm ---------- */

/**
 * Fills every AVAILABLE court (ascending court number) with the next four
 * eligible waiting players. Returns the created { match, notification } pairs.
 * opts.skipCourtIds: court ids to leave alone this pass.
 */
function processAvailableCourts_(ctx, opts) {
  var created = [];
  if (ctx.session.status !== 'ACTIVE') return created;
  var skip = (opts && opts.skipCourtIds) || [];
  var free = ctx.courts
    .filter(function (c) { return c.status === 'AVAILABLE' && skip.indexOf(c.court_id) === -1; })
    .sort(function (a, b) { return a.court_number - b.court_number; });
  for (var i = 0; i < free.length; i++) {
    var eligible = eligibleWaiting_(ctx);
    if (eligible.length < 4) break;
    created.push(createMatchOnCourt_(ctx, free[i], eligible.slice(0, 4), NOTIFICATION_TYPES.ASSIGNMENT));
  }
  return created;
}

/** Public entry point matching the spec: processAvailableCourts(sessionId). */
function processAvailableCourts(sessionId) {
  return withLock_(function () {
    var ctx = loadContext_(sessionId);
    var created = processAvailableCourts_(ctx);
    touchSession_(ctx);
    return created.length;
  });
}

function act_fillCourts_(ctx) {
  processAvailableCourts_(ctx);
}
