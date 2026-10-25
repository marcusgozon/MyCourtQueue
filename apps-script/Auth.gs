/**
 * Auth.gs — queue-master authentication.
 *
 * Model: each session has an owner password chosen at creation.
 *  - Only a salted, iterated SHA-256 hash is stored (SessionAdmins.credential_hash).
 *  - POST adminLogin verifies the password and returns an HMAC-signed token
 *    "<sessionId>.<expiryMs>.<signature>" valid for 24 h.
 *  - Every admin action re-verifies that token server side (requireAdmin_).
 *  - The signing secret lives in Script Properties, never in the frontend or the sheet.
 */

var TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
var LOGIN_MAX_FAILS = 5;
var LOGIN_LOCK_SECONDS = 300;

function digestHex_(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function hashPassword_(password, salt) {
  var h = salt + '|' + password;
  for (var i = 0; i < 1000; i++) h = digestHex_(h + '|' + salt + '|' + i);
  return h;
}

/** Returns "v1$salt$hash". */
function makeCredential_(password) {
  var salt = Utilities.getUuid().replace(/-/g, '');
  return 'v1$' + salt + '$' + hashPassword_(password, salt);
}

function verifyCredential_(password, stored) {
  var parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  return safeEqual_(hashPassword_(password, parts[1]), parts[2]);
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function tokenSecret_() {
  var s = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET');
  if (!s) fail_('SERVER_NOT_READY', 'Backend not initialised. Run setupDatabase() in the Apps Script editor.');
  return s;
}

function sign_(payload) {
  var raw = Utilities.computeHmacSha256Signature(payload, tokenSecret_());
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '');
}

function signToken_(sessionId, expiresAt) {
  var payload = sessionId + '.' + expiresAt;
  return payload + '.' + sign_(payload);
}

/** Verifies a token and returns its session id, or null. */
function verifyToken_(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  var payload = parts[0] + '.' + parts[1];
  if (!safeEqual_(sign_(payload), parts[2])) return null;
  if (!(Number(parts[1]) > Date.now())) return null;
  return parts[0];
}

/** Authorises an admin request and returns the session row. Throws UNAUTHORIZED otherwise. */
function requireAdmin_(req) {
  var tokenSession = verifyToken_(req.adminToken);
  if (!tokenSession || tokenSession !== String(req.sessionId || '')) {
    fail_('UNAUTHORIZED', 'Your admin session has expired. Please sign in again.');
  }
  var session = findSessionById_(tokenSession);
  if (!session) fail_('NOT_FOUND', 'Session not found.');
  return session;
}

function findSessionById_(sessionId) {
  var rows = readTable_('Sessions');
  for (var i = 0; i < rows.length; i++) if (rows[i].session_id === sessionId) return rows[i];
  return null;
}

/** POST adminLogin { sessionId, password } -> { adminToken, expiresAt, ... } */
function act_adminLogin_(req) {
  var sessionId = String(req.sessionId || '').trim();
  var password = String(req.password || '');
  if (!sessionId || !password) fail_('BAD_REQUEST', 'Session ID and password are required.');

  var cache = CacheService.getScriptCache();
  var key = 'fail_' + sessionId;
  var fails = Number(cache.get(key) || 0);
  if (fails >= LOGIN_MAX_FAILS) fail_('TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again in a few minutes.');

  var session = findSessionById_(sessionId);
  var admins = readTable_('SessionAdmins').filter(function (a) {
    return a.session_id === sessionId && a.role === 'OWNER';
  });
  var ok = !!(session && admins.length && verifyCredential_(password, admins[0].credential_hash));
  if (!ok) {
    cache.put(key, String(fails + 1), LOGIN_LOCK_SECONDS);
    fail_('INVALID_CREDENTIALS', 'Incorrect session ID or password.');
  }
  cache.remove(key);
  var expiresAt = Date.now() + TOKEN_TTL_MS;
  return {
    sessionId: session.session_id,
    name: session.session_name,
    publicToken: session.public_token,
    status: session.status,
    adminToken: signToken_(session.session_id, expiresAt),
    expiresAt: expiresAt
  };
}
