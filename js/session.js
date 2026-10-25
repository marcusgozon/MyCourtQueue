/** Public live session page: read-only view, polling, popups. */
(function () {
  var CQ = window.CQ, U = CQ.util, V = CQ.views, $ = U.$;
  var token = new URLSearchParams(location.search).get('session') || '';
  var meKey = 'cq_me_' + token;
  var state = null;
  var poller = null;
  var firstLoad = true;
  var lastPlayerSig = '';

  var notifier = CQ.notifications.create(token || 'none', function () { return U.store.get(meKey, null); });

  function showInvalid(msg) {
    $('#content').classList.add('hidden');
    $('#invalid').classList.remove('hidden');
    if (msg) $('#invalid-msg').textContent = msg;
    $('#live-text').textContent = 'Offline';
    if (poller) poller.stop();
  }

  function renderMeSelect() {
    var sel = $('#me');
    var sig = state.stats.map(function (s) { return s.playerId + ':' + s.name; }).join('|');
    if (sig !== lastPlayerSig) {
      lastPlayerSig = sig;
      var opts = '<option value="">— Not selected —</option>' + state.stats
        .filter(function (s) { return s.status !== 'LEFT'; })
        .slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
        .map(function (s) { return '<option value="' + U.esc(s.playerId) + '">' + U.esc(s.name) + '</option>'; }).join('');
      sel.innerHTML = opts;
      sel.value = U.store.get(meKey, '') || '';
    }
  }

  function render() {
    var s = state, meId = U.store.get(meKey, null);
    var closed = s.session.status !== 'ACTIVE';
    $('#session-name').textContent = s.session.name;
    document.title = s.session.name + ' — MyCourtQueue';
    var pill = $('#session-status');
    pill.textContent = closed ? 'ENDED' : 'LIVE';
    pill.className = 'pill ' + (closed ? 'pill-gray' : 'pill-green');
    CQ.ui.banner(closed ? 'This session has ended. Final results are shown below.' : '', 'info');

    renderMeSelect();
    U.setHtml($('#courts'), V.courts(s, { meId: meId }));
    U.setHtml($('#counts'), V.counts(s));
    U.setHtml($('#queue'), V.queue(s, { meId: meId }));
    U.setHtml($('#announce'), V.announcements(s, 6));
    U.setHtml($('#stats'), V.stats(s, { meId: meId }));
    U.setHtml($('#results'), V.results(s));
  }

  async function load() {
    var s = await CQ.api.getPublicSession(token);
    U.setServerTime(s.serverTime);
    state = s;
    if (firstLoad) {
      firstLoad = false;
      $('#content').classList.remove('hidden');
      if (s.session.status !== 'ACTIVE') poller.setInterval(15000);
    }
    render();
    notifier.process(s.notifications);
  }

  function init() {
    if (!token) { showInvalid('This link is missing its session code. Ask the queue master for the full link.'); return; }
    if (!CQ.api.isConfigured()) { showInvalid('The app is not connected to its backend yet (js/config.js).'); return; }

    CQ.ui.tabs($('#tabs'));
    V.bindDetails($('#stats'));
    $('#me').addEventListener('change', function (e) {
      if (e.target.value) U.store.set(meKey, e.target.value); else U.store.remove(meKey);
      if (state) render();
    });

    poller = CQ.createPoller(load, {
      onOk: function () {
        $('#live-dot').classList.remove('off');
        $('#live-text').textContent = 'Live · ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
        if (state && state.session.status === 'ACTIVE') CQ.ui.banner('');
      },
      onError: function (err, failures) {
        if (err.code === 'NOT_FOUND' || err.code === 'INVALID_TOKEN') { showInvalid('This session link is not valid or has been removed.'); return; }
        $('#live-dot').classList.add('off');
        $('#live-text').textContent = 'Reconnecting…';
        if (failures >= 2 || firstLoad) CQ.ui.banner(CQ.errors.friendly(err), 'error');
      }
    });
    poller.start();
  }

  init();
})();
