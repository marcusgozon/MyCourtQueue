/**
 * Database.gs — Google Sheets access layer for CourtQueue.
 *
 * Every read/write to BadmintonQueueDB goes through this file.
 * Run setupDatabase() once from the Apps Script editor to create the tabs.
 */

var DB_NAME = 'BadmintonQueueDB';
/** Bump when SCHEMA gains a column; ensureReady_() then repairs existing sheets once. */
var SCHEMA_VERSION = '2';

/** Sheet definitions. `num` / `bool` list the columns that are coerced on read. */
var SCHEMA = {
  Sessions: {
    cols: ['session_id', 'session_name', 'public_token', 'status', 'court_count', 'next_queue_order', 'created_at', 'updated_at'],
    num: ['court_count', 'next_queue_order'],
    bool: []
  },
  Players: {
    // target_games is appended last so existing sheets gain the column on the next setupDatabase().
    cols: ['player_id', 'session_id', 'player_name', 'queue_order', 'status', 'leave_after_match', 'joined_at', 'updated_at', 'target_games'],
    num: ['queue_order', 'target_games'],
    bool: ['leave_after_match']
  },
  Courts: {
    cols: ['court_id', 'session_id', 'court_number', 'status', 'current_match_id'],
    num: ['court_number'],
    bool: []
  },
  Matches: {
    cols: ['match_id', 'session_id', 'court_id', 'player_1_id', 'player_2_id', 'player_3_id', 'player_4_id',
           'winning_team', 'score', 'status', 'started_at', 'completed_at'],
    num: [],
    bool: []
  },
  Notifications: {
    cols: ['notification_id', 'session_id', 'match_id', 'court_number', 'player_ids', 'notification_message',
           'notification_type', 'created_at'],
    num: ['court_number'],
    bool: []
  },
  SessionAdmins: {
    cols: ['session_id', 'admin_id', 'credential_hash', 'role', 'created_at'],
    num: [],
    bool: []
  }
};

/* Per-execution caches: avoids re-opening the spreadsheet on every read/write. */
var _ss = null;
var _sheets = {};

/** Returns the spreadsheet: SPREADSHEET_ID property first, then the bound spreadsheet. */
function getSpreadsheet_() {
  if (_ss) return _ss;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) {
    try { _ss = SpreadsheetApp.openById(id); return _ss; }
    catch (e) {
      fail_('SERVER_NOT_READY', 'Cannot open the database spreadsheet: ' + e.message +
        ' (Run setupDatabase() in the editor, then deploy a new version.)');
    }
  }
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e2) { ss = null; }
  if (!ss) fail_('SERVER_NOT_READY', 'Database not initialised. Run setupDatabase() in the Apps Script editor.');
  _ss = ss;
  return _ss;
}

/** Returns a tab by name; if it is missing, repairs the database first. */
function sheet_(name) {
  if (_sheets[name]) return _sheets[name];
  var sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) {
    setupDatabase();            // creates any missing tab
    _ss = null;
    sh = getSpreadsheet_().getSheetByName(name);
    if (!sh) fail_('SERVER_NOT_READY', 'Missing sheet "' + name + '".');
  }
  _sheets[name] = sh;
  return sh;
}

/** Runs setupDatabase() automatically if the id, token secret or schema is out of date. */
function ensureReady_() {
  var props = PropertiesService.getScriptProperties();
  var ready = function () {
    return !!(props.getProperty('SPREADSHEET_ID') && props.getProperty('TOKEN_SECRET')) &&
      props.getProperty('SCHEMA_VERSION') === SCHEMA_VERSION;
  };
  if (ready()) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (!ready()) setupDatabase();
  } finally {
    lock.releaseLock();
  }
}

/**
 * One-time setup. Creates (or repairs) every tab and header row, stores the
 * spreadsheet id and generates the secret used to sign admin tokens.
 * Safe to run more than once.
 */
function setupDatabase() {
  var props = PropertiesService.getScriptProperties();
  var ss = null;
  var id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  }
  if (!ss) ss = SpreadsheetApp.create(DB_NAME);
  props.setProperty('SPREADSHEET_ID', ss.getId());
  if (!props.getProperty('TOKEN_SECRET')) {
    props.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid());
  }
  props.setProperty('SCHEMA_VERSION', SCHEMA_VERSION);

  Object.keys(SCHEMA).forEach(function (name) {
    var def = SCHEMA[name];
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var header = sh.getRange(1, 1, 1, def.cols.length);
    header.setValues([def.cols]).setFontWeight('bold').setBackground('#172538').setFontColor('#F8FAFC');
    sh.setFrozenRows(1);
    // Plain-text format keeps "21-15" scores and ISO timestamps from being parsed as dates.
    var rows = Math.max(sh.getMaxRows() - 1, 1);
    sh.getRange(2, 1, rows, def.cols.length).setNumberFormat('@');
  });

  var blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);

  Logger.log('CourtQueue database ready: ' + ss.getUrl());
  return ss.getUrl();
}

/* ---------- value helpers ---------- */

function nowIso_() { return new Date().toISOString(); }

function uid_(prefix) { return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 14); }

function coerce_(def, col, v) {
  if (def.num.indexOf(col) > -1) return (v === '' || v === null || v === undefined) ? 0 : Number(v);
  if (def.bool.indexOf(col) > -1) return v === true || String(v).toUpperCase() === 'TRUE';
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  return String(v);
}

/* ---------- table access ---------- */

/** Reads every data row of a sheet as objects. Each object carries its 1-based sheet row in `_row`. */
function readTable_(name) {
  var def = SCHEMA[name];
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, def.cols.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === '' || values[i][0] === null) continue;
    var o = { _row: i + 2 };
    for (var j = 0; j < def.cols.length; j++) o[def.cols[j]] = coerce_(def, def.cols[j], values[i][j]);
    out.push(o);
  }
  return out;
}

function rowValues_(def, obj) {
  return def.cols.map(function (c) { return obj[c] === undefined || obj[c] === null ? '' : obj[c]; });
}

/** Appends many rows in ONE write. Records each object's sheet row in `_row`. */
function insertRows_(name, objs) {
  if (!objs.length) return objs;
  var def = SCHEMA[name];
  var sh = sheet_(name);
  var start = Math.max(sh.getLastRow(), 1) + 1;
  var end = start + objs.length - 1;
  if (end > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), end - sh.getMaxRows());
  var range = sh.getRange(start, 1, objs.length, def.cols.length);
  range.setNumberFormat('@');   // keep "21-15" and ISO timestamps as text
  range.setValues(objs.map(function (o) { return rowValues_(def, o); }));
  objs.forEach(function (o, i) { o._row = start + i; });
  return objs;
}

function insertRow_(name, obj) {
  insertRows_(name, [obj]);
  return obj;
}

/** Rewrites the row an object was read from / inserted at. */
function updateRow_(name, obj) {
  if (!obj._row) fail_('SERVER_ERROR', 'updateRow_ called on an unsaved ' + name + ' record.');
  var def = SCHEMA[name];
  sheet_(name).getRange(obj._row, 1, 1, def.cols.length).setValues([rowValues_(def, obj)]);
  return obj;
}

/** Deletes the given rows (call with objects read this request; deletes bottom-up). */
function deleteRows_(name, objs) {
  var sh = sheet_(name);
  objs.map(function (o) { return o._row; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (r) { sh.deleteRow(r); });
}
