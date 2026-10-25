/**
 * API communication. All requests go to the Apps Script web app.
 * - GET for public reads (no custom headers => no CORS preflight).
 * - POST with Content-Type text/plain (a "simple" request => no preflight either).
 * - redirect:'follow' is required: Apps Script answers via a 302 to googleusercontent.com.
 */
(function () {
  var CQ = window.CQ;

  function apiError(code, message) {
    var e = new Error(message);
    e.code = code;
    e.isApiError = true;
    return e;
  }

  function isConfigured() {
    var u = CQ.config.API_URL;
    return !!u && u.indexOf('PASTE_') !== 0;
  }

  async function request(url, init) {
    if (!isConfigured()) throw apiError('NOT_CONFIGURED', 'The API URL is not set. Edit js/config.js and paste your Apps Script web app URL.');
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 25000);
    var res;
    try {
      res = await fetch(url, Object.assign({ redirect: 'follow', cache: 'no-store', signal: ctrl.signal }, init));
    } catch (err) {
      if (err && err.name === 'AbortError') throw apiError('TIMEOUT', 'The server took too long to respond.');
      throw apiError('NETWORK', 'Cannot reach the server. Check your connection.');
    } finally {
      clearTimeout(timer);
    }
    var text = await res.text();
    var json;
    try { json = JSON.parse(text); }
    catch (e) { throw apiError('BAD_RESPONSE', 'Unexpected response from the server. Check that the Apps Script web app is deployed with access set to "Anyone".'); }
    if (!json.ok) throw apiError((json.error && json.error.code) || 'SERVER_ERROR', (json.error && json.error.message) || 'Server error.');
    return json.data;
  }

  function get(action, params) {
    var q = new URLSearchParams(Object.assign({ action: action }, params || {}));
    var base = CQ.config.API_URL;
    return request(base + (base.indexOf('?') > -1 ? '&' : '?') + q.toString(), { method: 'GET' });
  }

  function post(action, body) {
    return request(CQ.config.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action: action }, body || {}))
    });
  }

  CQ.api = {
    isConfigured: isConfigured,
    ping: function () { return get('ping'); },
    getPublicSession: function (token) { return get('getPublicSession', { token: token }); },
    createSession: function (payload) { return post('createSession', payload); },
    adminLogin: function (sessionId, password) { return post('adminLogin', { sessionId: sessionId, password: password }); },
    /** Authorised admin call. Mutating calls get a requestId so retries are replayed, not repeated. */
    admin: function (action, payload) {
      var auth = CQ.auth.current();
      if (!auth) return Promise.reject(apiError('UNAUTHORIZED', 'Please sign in.'));
      return post(action, Object.assign({
        sessionId: auth.sessionId,
        adminToken: auth.adminToken,
        requestId: CQ.util.uid()
      }, payload || {}));
    }
  };
})();
