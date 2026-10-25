/**
 * Shared utilities: helpers, saved-session storage + admin auth, UI (toasts, modals,
 * tabs), error handling and the polling loop.
 */
(function () {
  var CQ = window.CQ;
  var U = CQ.util = {};

  /* ---------- helpers ---------- */
  U.esc = function (s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  U.$ = function (sel, root) { return (root || document).querySelector(sel); };
  U.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  U.uid = function () { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); };
  U.initials = function (name) {
    var parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0][0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  };

  var clockOffset = 0;
  U.setServerTime = function (iso) { var t = Date.parse(iso); if (!isNaN(t)) clockOffset = t - Date.now(); };
  U.now = function () { return Date.now() + clockOffset; };
  U.fmtTime = function (iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };
  U.elapsed = function (iso) {
    var mins = Math.max(0, Math.floor((U.now() - Date.parse(iso)) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min';
    return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
  };

  /** Replaces innerHTML only when the markup changed, so focus/scroll/inputs survive polling. */
  U.setHtml = function (el, html) {
    if (!el) return;
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
  };

  U.copy = async function (text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through */ }
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  };

  function pagesUrl() {
    var url = new URL('.', location.href);
    if (!url.pathname.endsWith('/pages/')) url = new URL('pages/', url);
    return url.href;
  }
  U.publicUrl = function (token) { return pagesUrl() + 'session.html?session=' + encodeURIComponent(token); };
  U.adminUrl = function (sessionId) { return pagesUrl() + 'admin.html?session=' + encodeURIComponent(sessionId); };

  /* ---------- storage ---------- */
  U.store = {
    get: function (key, fallback) {
      try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set: function (key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ } },
    remove: function (key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
  };

  /* ---------- saved admin sessions ---------- */
  var SAVED_KEY = 'cq_admin_sessions';
  var auth = CQ.auth = { _current: null };
  auth.list = function () { return U.store.get(SAVED_KEY, []).filter(function (s) { return s && s.sessionId; }); };
  auth.save = function (entry) {
    var list = auth.list().filter(function (s) { return s.sessionId !== entry.sessionId; });
    list.unshift(Object.assign({ savedAt: Date.now() }, entry));
    U.store.set(SAVED_KEY, list.slice(0, 15));
  };
  auth.forget = function (sessionId) {
    U.store.set(SAVED_KEY, auth.list().filter(function (s) { return s.sessionId !== sessionId; }));
  };
  auth.find = function (sessionId) {
    return auth.list().filter(function (s) { return s.sessionId === sessionId; })[0] || null;
  };
  auth.use = function (entry) { auth._current = entry; };
  auth.current = function () {
    var a = auth._current;
    return a && a.adminToken && (!a.expiresAt || a.expiresAt > Date.now()) ? a : null;
  };

  /* ---------- errors ---------- */
  CQ.errors = {
    friendly: function (err) {
      var map = {
        NETWORK: 'Cannot reach the server. Check your connection — retrying automatically.',
        TIMEOUT: 'The server is slow to respond. Please try again.',
        NOT_CONFIGURED: 'The app is not connected to its backend yet (js/config.js).',
        BUSY: 'The server is busy. Please try again in a moment.'
      };
      return map[err && err.code] || (err && err.message) || 'Something went wrong.';
    }
  };

  /* ---------- UI ---------- */
  var ui = CQ.ui = {};

  function toastHost() {
    var h = document.getElementById('toasts');
    if (!h) {
      h = document.createElement('div');
      h.id = 'toasts'; h.className = 'toasts';
      h.setAttribute('role', 'status'); h.setAttribute('aria-live', 'polite');
      document.body.appendChild(h);
    }
    return h;
  }
  ui.toast = function (message, kind, ms) {
    var t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = message;
    toastHost().appendChild(t);
    setTimeout(function () { t.remove(); }, ms || (kind === 'error' ? 6000 : 3200));
  };
  ui.error = function (err) { ui.toast(CQ.errors.friendly(err), 'error'); };

  ui.banner = function (message, kind) {
    var el = document.getElementById('banner');
    if (!el) return;
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false; el.textContent = message;
    el.className = 'banner' + (kind === 'error' ? ' error' : '');
  };

  /** Runs fn while a button shows a busy state. */
  ui.busy = async function (btn, fn) {
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    try { return await fn(); }
    finally { if (btn && btn.isConnected) { btn.disabled = false; btn.classList.remove('is-busy'); } }
  };

  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /**
   * Modal dialog. opts: { title, body (html), actions:[{label, kind, onClick({close, root, btn})}], onOpen(root) }
   * onClick may be async; returning false keeps the modal open; throwing shows the error and keeps it open.
   */
  ui.modal = function (opts) {
    var previous = document.activeElement;
    var back = document.createElement('div');
    back.className = 'modal-backdrop';
    var id = 'm' + Math.random().toString(36).slice(2, 7);
    back.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="' + id + '">' +
      '<div class="modal-head"><h2 id="' + id + '">' + U.esc(opts.title) + '</h2>' +
      '<button type="button" class="icon-btn" data-close aria-label="Close dialog">&times;</button></div>' +
      '<div class="modal-body">' + (opts.body || '') + '</div><div class="modal-foot"></div></div>';
    var root = back.firstChild;
    var foot = root.querySelector('.modal-foot');

    function close() {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      if (previous && previous.focus) { try { previous.focus(); } catch (e) { /* ignore */ } }
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      var f = U.$$(FOCUSABLE, root).filter(function (x) { return x.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    (opts.actions || [{ label: 'Close', kind: 'primary' }]).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (a.kind || '');
      b.textContent = a.label;
      b.addEventListener('click', async function () {
        if (!a.onClick) { close(); return; }
        b.disabled = true;
        try {
          var r = await a.onClick({ close: close, root: root, btn: b });
          if (r !== false) close();
        } catch (err) { ui.error(err); }
        finally { if (b.isConnected) b.disabled = false; }
      });
      foot.appendChild(b);
    });

    back.addEventListener('click', function (e) { if (e.target === back || e.target.hasAttribute('data-close')) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    if (opts.onOpen) opts.onOpen(root);
    var target = root.querySelector('input:not([type=hidden]), select, textarea') || foot.querySelector('.btn.primary, .btn.warn, .btn') ;
    if (target) target.focus();
    return { root: root, close: close };
  };

  ui.confirm = function (opts) {
    return new Promise(function (resolve) {
      var answered = false;
      var m = ui.modal({
        title: opts.title,
        body: '<p>' + U.esc(opts.message) + '</p>',
        actions: [
          { label: 'Cancel', kind: 'ghost', onClick: function () { answered = true; resolve(false); } },
          { label: opts.confirmLabel || 'Confirm', kind: opts.danger ? 'danger' : 'primary', onClick: function () { answered = true; resolve(true); } }
        ]
      });
      // Resolve false if dismissed via Esc / backdrop / ×.
      var obs = new MutationObserver(function () {
        if (!m.root.isConnected) { obs.disconnect(); if (!answered) resolve(false); }
      });
      obs.observe(document.body, { childList: true });
    });
  };

  /** Accessible tabs: buttons[role=tab][data-tab] controlling panels[data-panel]. */
  ui.tabs = function (container, onChange) {
    var tabs = U.$$('[role=tab]', container);
    function select(name) {
      tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.tab === name)); t.tabIndex = t.dataset.tab === name ? 0 : -1; });
      U.$$('[data-panel]').forEach(function (p) { p.hidden = p.dataset.panel !== name; });
      if (onChange) onChange(name);
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t.dataset.tab); });
      t.addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        var n = tabs[(i + d + tabs.length) % tabs.length];
        n.focus(); select(n.dataset.tab);
      });
    });
    select((tabs[0] || {}).dataset ? tabs[0].dataset.tab : '');
    return select;
  };

  /* ---------- polling ---------- */
  /**
   * Repeats fn on an interval while the page is open. Slows down in background tabs,
   * backs off after errors, and polls immediately when the tab becomes visible again.
   */
  CQ.createPoller = function (fn, opts) {
    opts = opts || {};
    var timer = null, busy = false, stopped = true, failures = 0;
    var interval = function () {
      var base = document.hidden ? CQ.config.HIDDEN_POLL_INTERVAL_MS : (opts.interval || CQ.config.POLL_INTERVAL_MS);
      return base + Math.min(failures, 5) * 2000;
    };
    function schedule() { clearTimeout(timer); if (!stopped) timer = setTimeout(run, interval()); }
    async function run() {
      if (busy || stopped) return;
      busy = true;
      try {
        await fn();
        failures = 0;
        if (opts.onOk) opts.onOk();
      } catch (e) {
        failures++;
        if (opts.onError) opts.onError(e, failures);
      } finally { busy = false; schedule(); }
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden && !stopped) { clearTimeout(timer); run(); } });
    return {
      start: function () { stopped = false; run(); },
      stop: function () { stopped = true; clearTimeout(timer); },
      now: function () { clearTimeout(timer); return run(); },
      setInterval: function (ms) { opts.interval = ms; }
    };
  };

  /* logo helper */
  U.headerBrand = function () {
    return '<a class="brand" href="index.html" aria-label="MyCourtQueue home"><img src="assets/logo.svg" alt="" width="40" height="40">' +
      '<span><span class="brand-word">MyCourt<b>Queue</b></span><span class="brand-tag">Play • Queue • Connect</span></span></a>';
  };
})();
