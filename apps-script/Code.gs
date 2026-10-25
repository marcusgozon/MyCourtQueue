/**
 * Code.gs — CourtQueue web-app entry points, routing and session state assembly.
 *
 * API (JSON in, JSON out, envelope { ok, data } or { ok:false, error:{code,message} }):
 *   GET  ?action=ping
 *   GET  ?action=getPublicSession&token=PUBLIC_TOKEN      (read-only, no auth)
 *   POST createSession | adminLogin                       (no admin token yet)
 *   POST <admin action> with { sessionId, adminToken, ... }
 *
 * CORS: POST bodies are sent as text/plain so browsers skip the preflight request,
 * which Apps Script cannot answer. Responses follow Google's redirect to
 * script.googleusercontent.com, which serves Access-Control-Allow-Origin: *.
 */

var LIMITS = { MAX_COURTS: 12, MAX_PLAYERS: 120, NAME_MAX: 40, SESSION_NAME_MAX: 60, MIN_PASSWORD: 6 };
var PUBLIC_CACHE_SECONDS = 3;

/** Admin action table. Built lazily because Apps Script loads files in arbitrary order. */
function adminActions_() {
  return {
    getAdminSession:  { fn: null, mutates: false },
    updateSession:    { fn: act_updateSession_, mutates: true },
    addPlayers:       { fn: act_addPlayers_, mutates: true },
    editPlayer:       { fn: act_editPlayer_, mutates: true },
    removePlayer:     { fn: act_removePlayer_, mutates: true },
    setPlayerStatus:  { fn: act_setPlayerStatus_, mutates: true },
    reorderQueue:     { fn: act_reorderQueue_, mutates: true },
    setCourtCount:    { fn: act_setCourtCount_, mutates: true },
    fillCourts:       { fn: act_fillCourts_, mutates: true },
    startMatch:       { fn: act_startMatch_, mutates: true },
    completeMatch:    { fn: act_completeMatch_, mutates: true },
    cancelMatch:      { fn: act_cancelMatch_, mutates: true, allowClosed: true },
    correctMatch:     { fn: act_correctMatch_, mutates: true, allowClosed: true },
    setMatchPlayers:  { fn: act_setMatchPlayers_, mutates: true },
    closeSession:     { fn: act_closeSession_, mutates: true, allowClosed: true }
  };
}

function doGet(e) { return handle_('GET', (e && e.parameter) || {}); }

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return errorResponse_({ code: 'BAD_REQUEST', message: 'Request body is not valid JSON.' }); }
  return handle_('POST', body || {});
}

function fail_(code, message) {
  var e = new Error(message);
  e.code = code;
  throw e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errorResponse_(e) {
  var known = !!(e && e.code);
  if (!known) console.error(e && e.stack ? e.stack : e);
  var message = known ? e.message : 'Unexpected server error. Please try again.';
  // Debug switch: set Script Property DEBUG = 1 to show the real error in the app.
  if (!known && PropertiesService.getScriptProperties().getProperty('DEBUG') === '1') {
    message = 'Unexpected server error: ' + String(e && e.message || e);
  }
  return json_({ ok: false, error: { code: known ? e.code : 'SERVER_ERROR', message: message } });
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) fail_('BUSY', 'The server is busy. Please try again.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function handle_(method, req) {
  try {
    var action = String(req.action || 'ping');
    if (action === 'ping') return json_({ ok: true, data: { pong: true, time: nowIso_() } });
    if (action === 'getPublicSession') ensureReady_();
    if (action === 'getPublicSession') return json_({ ok: true, data: act_getPublicSession_(req) });
    if (method !== 'POST') fail_('METHOD_NOT_ALLOWED', 'This action must be sent with POST.');
    ensureReady_();

    if (action === 'createSession') {
      return json_({ ok: true, data: withLock_(function () { return act_createSession_(req); }) });
    }
    if (action === 'adminLogin') return json_({ ok: true, data: act_adminLogin_(req) });

    var def = adminActions_()[action];
    if (!def) fail_('UNKNOWN_ACTION', 'Unknown action.');
    var session = requireAdmin_(req);

    if (!def.mutates) {
      return json_({ ok: true, data: { state: buildState_(loadContext_(session.session_id), true), result: null } });
    }

    var cache = CacheService.getScriptCache();
    var rid = req.requestId ? String(req.requestId).slice(0, 64) : '';
    var cacheKey = rid ? 'req_' + session.session_id + '_' + rid : '';

    var body = withLock_(function () {
      // Retried requests (same requestId) replay the first response instead of running twice.
      if (cacheKey) {
        var hit = cache.get(cacheKey);
        if (hit) return hit;
      }
      var ctx = loadContext_(session.session_id);
      if (def.allowClosed !== true) assertActive_(ctx);
      var result = def.fn(ctx, req) || null;
      touchSession_(ctx);
      cache.remove('pub_' + ctx.session.public_token);
      var out = JSON.stringify({
        ok: true,
        data: { state: buildState_(loadContext_(session.session_id), true), result: result }
      });
      if (cacheKey && out.length < 90000) cache.put(cacheKey, out, 600);
      return out;
    });
    return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
  } catch (e) {
    return errorResponse_(e);
  }
}

/* ---------- public read ---------- */

function act_getPublicSession_(req) {
  var token = String(req.token || '');
  if (!/^[A-Za-z0-9]{20,64}$/.test(token)) fail_('INVALID_TOKEN', 'This session link is not valid.');
  var cache = CacheService.getScriptCache();
  var hit = cache.get('pub_' + token);
  if (hit) return JSON.parse(hit);

  var sessions = readTable_('Sessions');
  var session = null;
  for (var i = 0; i < sessions.length; i++) if (sessions[i].public_token === token) { session = sessions[i]; break; }
  if (!session) fail_('NOT_FOUND', 'This session link is not valid.');

  var state = buildState_(loadContext_(session.session_id), false);
  var s = JSON.stringify(state);
  if (s.length < 90000) cache.put('pub_' + token, s, PUBLIC_CACHE_SECONDS);
  return state;
}

/* ---------- state assembly ---------- */

function buildState_(ctx, isAdmin) {
  var s = ctx.session;
  var active = s.status === 'ACTIVE';
  var names = {};
  ctx.players.forEach(function (p) { names[p.player_id] = p.player_name; });
  var ref = function (id) { return { playerId: id, name: names[id] || 'Unknown' }; };

  var eligible = eligibleWaiting_(ctx);
  var courts = ctx.courts.map(function (c) {
    var match = null;
    if (c.status === 'IN_PROGRESS') {
      var m = matchById_(ctx, c.current_match_id);
      if (m && m.status === 'IN_PROGRESS') {
        match = {
          matchId: m.match_id,
          startedAt: m.started_at,
          players: matchPlayerIds_(m).map(ref)
        };
      }
    }
    var out = {
      courtNumber: c.court_number,
      status: match ? 'IN_PROGRESS' : 'AVAILABLE',
      match: match,
      message: (!match && active)
        ? 'Court No. ' + c.court_number + ' is available. Waiting for more players.'
        : ''
    };
    if (isAdmin) out.courtId = c.court_id;
    if (!isAdmin && match) delete match.matchId;
    return out;
  });

  var queue = eligible.map(function (p, i) {
    return { playerId: p.player_id, name: p.player_name, position: i + 1, nextUp: active && i < 4 };
  });
  var counts = {
    waiting: queue.length,
    playing: ctx.players.filter(function (p) { return p.status === 'PLAYING'; }).length,
    unavailable: ctx.players.filter(function (p) { return p.status === 'UNAVAILABLE'; }).length
  };

  var stats = calculateStats_(ctx);
  var statList = ctx.players
    .filter(function (p) { return p.status !== 'LEFT' || stats[p.player_id].games > 0; })
    .map(function (p) {
      var st = stats[p.player_id];
      return {
        playerId: p.player_id, name: p.player_name, status: p.status,
        games: st.games, wins: st.wins, losses: st.losses, winRate: st.winRate, history: st.history
      };
    })
    .sort(function (a, b) { return b.wins - a.wins || b.winRate - a.winRate || a.games - b.games || a.name.localeCompare(b.name); });

  var courtNo = {};
  ctx.courts.forEach(function (c) { courtNo[c.court_id] = c.court_number; });
  var teams = function (m) {
    var ids = matchPlayerIds_(m);
    return { a: [ids[0], ids[1]].map(ref), b: [ids[2], ids[3]].map(ref) };
  };
  var byDoneDesc = function (a, b) { return a.completed_at < b.completed_at ? 1 : a.completed_at > b.completed_at ? -1 : b._row - a._row; };

  var recent = ctx.matches.filter(function (m) { return m.status === 'COMPLETED'; }).sort(byDoneDesc).slice(0, 15)
    .map(function (m) {
      var t = teams(m);
      return { courtNumber: courtNo[m.court_id] || 0, teamA: t.a, teamB: t.b, winningTeam: m.winning_team, score: m.score, completedAt: m.completed_at };
    });

  var state = {
    serverTime: nowIso_(),
    session: { name: s.session_name, status: s.status, courtCount: s.court_count, createdAt: s.created_at },
    courts: courts,
    queue: queue,
    counts: counts,
    stats: statList,
    recentMatches: recent,
    notifications: getNotifications_(s.session_id, NOTIFICATION_WINDOW).map(function (n) {
      // Names resolved from the assigned player ids (same order as the message).
      var resolved = n.playerIds.map(function (id) { return names[id]; });
      if (resolved.every(function (x) { return !!x; })) n.names = resolved;
      return n;
    })
  };

  if (isAdmin) {
    state.session.sessionId = s.session_id;
    state.session.publicToken = s.public_token;
    state.players = ctx.players
      .filter(function (p) { return p.status !== 'LEFT' || stats[p.player_id].games > 0; })
      .sort(function (a, b) { return a.player_name.localeCompare(b.player_name); })
      .map(function (p) {
        return { playerId: p.player_id, name: p.player_name, status: p.status, leaveAfterMatch: p.leave_after_match };
      });
    state.matches = ctx.matches
      .filter(function (m) { return m.status === 'COMPLETED' || m.status === 'CANCELLED'; })
      .sort(byDoneDesc).slice(0, 60)
      .map(function (m) {
        var t = teams(m);
        return {
          matchId: m.match_id, status: m.status, courtNumber: courtNo[m.court_id] || 0,
          teamA: t.a, teamB: t.b, winningTeam: m.winning_team, score: m.score,
          startedAt: m.started_at, completedAt: m.completed_at
        };
      });
  }
  return state;
}
