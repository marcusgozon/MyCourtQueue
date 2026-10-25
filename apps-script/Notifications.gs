/**
 * Notifications.gs — assignment notifications.
 *
 * A notification row is written by the backend every time four players are
 * assigned to a court (auto fill, manual start, or a manual player swap).
 * Rows are never deleted by dismissal; clients track what they have seen.
 */

var NOTIFICATION_TYPES = { ASSIGNMENT: 'ASSIGNMENT', UPDATE: 'ASSIGNMENT_UPDATE' };
var NOTIFICATION_WINDOW = 40;

/** "Players A, B, C, and D, please proceed to Court No. N." */
function buildAssignmentMessage_(names, courtNumber) {
  var list = names.length === 4
    ? names[0] + ', ' + names[1] + ', ' + names[2] + ', and ' + names[3]
    : names.join(', ');
  return 'Players ' + list + ', please proceed to Court No. ' + courtNumber + '.';
}

function createNotification_(ctx, match, court, players, type) {
  var n = {
    notification_id: uid_('N_'),
    session_id: ctx.session.session_id,
    match_id: match.match_id,
    court_number: court.court_number,
    player_ids: players.map(function (p) { return p.player_id; }).join(','),
    notification_message: buildAssignmentMessage_(players.map(function (p) { return p.player_name; }), court.court_number),
    notification_type: type || NOTIFICATION_TYPES.ASSIGNMENT,
    created_at: nowIso_()
  };
  insertRow_('Notifications', n);
  return n;
}

/** Latest notifications for a session, oldest first, shaped for clients. */
function getNotifications_(sessionId, limit) {
  var rows = readTable_('Notifications').filter(function (n) { return n.session_id === sessionId; });
  rows.sort(function (a, b) {
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a._row - b._row;
  });
  return rows.slice(-(limit || NOTIFICATION_WINDOW)).map(function (n) {
    return {
      id: n.notification_id,
      matchId: n.match_id,
      courtNumber: n.court_number,
      playerIds: n.player_ids ? n.player_ids.split(',') : [],
      message: n.notification_message,
      type: n.notification_type,
      createdAt: n.created_at
    };
  });
}
