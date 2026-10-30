/** index.html: create a session, resume saved sessions, join via link. */
(function () {
  var CQ = window.CQ, U = CQ.util, $ = U.$, ui = CQ.ui;

  if (!CQ.api.isConfigured()) {
    ui.banner('Setup needed: paste your Apps Script web app URL into js/config.js (see README).', 'error');
  }

  function names() {
    // Pasted lists keep their numbering/bullets/emoji out of the queue: only the name survives.
    return $('#s-players').value.split(/[\n,]+/).map(U.cleanName).filter(Boolean);
  }
  function updateCount() { $('#p-count').textContent = '(' + names().length + ')'; }
  $('#s-players').addEventListener('input', updateCount);

  function setCourts(n) { $('#s-courts').value = Math.min(12, Math.max(1, n || 1)); }
  $('#c-minus').addEventListener('click', function () { setCourts(Number($('#s-courts').value) - 1); });
  $('#c-plus').addEventListener('click', function () { setCourts(Number($('#s-courts').value) + 1); });

  function renderSaved() {
    var list = CQ.auth.list();
    var el = $('#saved');
    if (!list.length) { el.innerHTML = '<div class="empty">Sessions you create on this device show up here.</div>'; return; }
    el.innerHTML = '<div class="plist">' + list.map(function (s) {
      return '<div class="prow"><div class="session-summary"><b>' + U.esc(s.name || 'Session') + '</b>' +
        '<div class="muted small">' + new Date(s.savedAt || Date.now()).toLocaleDateString() + '</div></div>' +
        '<div class="session-actions">' +
        '<a class="btn sm primary" href="pages/admin.html?session=' + encodeURIComponent(s.sessionId) + '">Dashboard</a>' +
        '<a class="btn sm" href="pages/session.html?session=' + encodeURIComponent(s.publicToken) + '">Player view</a>' +
        '<button class="btn sm danger" data-delete="' + U.esc(s.sessionId) + '" aria-label="Delete ' + U.esc(s.name) + '">Delete</button></div></div>';
    }).join('') + '</div>';
  }
  $('#saved').addEventListener('click', async function (e) {
    var btn = e.target.closest && e.target.closest('[data-delete]');
    if (!btn) return;
    var id = btn.getAttribute('data-delete');
    var entry = CQ.auth.find(id);
    var name = entry && entry.name ? entry.name : 'this session';
    var ok = await ui.confirm({
      title: 'Delete ' + name + '?',
      message: 'This permanently deletes the session, its players, matches and results from the database. Shared links stop working and it cannot be undone.',
      confirmLabel: 'Delete forever', danger: true
    });
    if (!ok) return;
    await ui.busy(btn, async function () {
      try {
        if (entry && entry.adminToken && entry.expiresAt > Date.now()) {
          CQ.auth.use(entry);
          await CQ.api.admin('deleteSession');
          ui.toast('Session deleted.');
        } else {
          ui.toast('Sign-in for this session expired — removed from this device only.', 'warn');
        }
      } catch (err) {
        if (err.code !== 'UNAUTHORIZED' && err.code !== 'NOT_FOUND') { ui.error(err); return; }
        ui.toast(err.code === 'NOT_FOUND' ? 'Session was already deleted.' : 'Removed from this device only.');
      }
      CQ.auth.forget(id);
      renderSaved();
    });
  });
  renderSaved();

  $('#create-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var name = $('#s-name').value.trim();
    var pass = $('#s-pass').value;
    if (!name) { ui.toast('Enter a session name.', 'warn'); $('#s-name').focus(); return; }
    if (pass.length < 6) { ui.toast('Password must be at least 6 characters.', 'warn'); $('#s-pass').focus(); return; }
    var list = names();
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var k = list[i].toLowerCase();
      if (seen[k]) { ui.toast('Duplicate player name: ' + list[i], 'warn'); return; }
      seen[k] = true;
    }
    await ui.busy($('#create-btn'), async function () {
      try {
        var r = await CQ.api.createSession({ name: name, courtCount: Number($('#s-courts').value), players: list, password: pass });
        CQ.auth.save({ sessionId: r.sessionId, name: r.name, publicToken: r.publicToken, adminToken: r.adminToken, expiresAt: r.expiresAt });
        var pub = U.publicUrl(r.publicToken), adm = U.adminUrl(r.sessionId);
        $('#out-public').value = pub;
        $('#out-admin').value = adm;
        $('#go-public').href = pub;
        $('#go-admin').href = adm;
        $('#create-form').classList.add('hidden');
        $('#created').classList.remove('hidden');
        renderSaved();
      } catch (err) { ui.error(err); }
    });
  });

  $('#new-session').addEventListener('click', function () {
    $('#create-form').reset(); updateCount();
    $('#created').classList.add('hidden');
    $('#create-form').classList.remove('hidden');
    $('#s-name').focus();
  });

  document.addEventListener('click', async function (e) {
    var id = e.target.getAttribute && e.target.getAttribute('data-copy');
    if (!id) return;
    var ok = await U.copy($('#' + id).value);
    ui.toast(ok ? 'Link copied.' : 'Copy failed — select the link and copy it manually.', ok ? '' : 'warn');
  });

  $('#login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = $('#l-id').value.trim(), pw = $('#l-pass').value;
    if (!id || !pw) { ui.toast('Enter the session ID and password.', 'warn'); return; }
    await ui.busy(e.submitter, async function () {
      try {
        var r = await CQ.api.adminLogin(id, pw);
        CQ.auth.save({ sessionId: r.sessionId, name: r.name, publicToken: r.publicToken, adminToken: r.adminToken, expiresAt: r.expiresAt });
        location.href = 'pages/admin.html?session=' + encodeURIComponent(r.sessionId);
      } catch (err) { ui.error(err); }
    });
  });

  $('#join-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('#j-link').value.trim();
    var m = /[?&]session=([A-Za-z0-9]+)/.exec(v) || /^([A-Za-z0-9]{20,64})$/.exec(v);
    if (!m) { ui.toast('That doesn’t look like a player link.', 'warn'); return; }
    location.href = 'pages/session.html?session=' + encodeURIComponent(m[1]);
  });
})();
