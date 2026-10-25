/**
 * Notification polling + de-duplication + popup display.
 *
 * Every poll returns the latest notifications for the session. This module:
 *  1. compares their IDs with the IDs this browser has already shown (localStorage),
 *  2. queues the unseen ones and shows them one at a time as a popup,
 *  3. never touches the database — dismissing only affects this device.
 *
 * Delayed polling (throttled background tab, flaky network): the server returns a
 * window of recent notifications, so anything missed in between is still unseen
 * here and is shown as soon as polling resumes. On the very first load, only
 * notifications newer than RECENT_NOTIFICATION_MS are announced so a late joiner
 * is not flooded with old assignments.
 */
(function () {
  var CQ = window.CQ, U = CQ.util, esc = U.esc;

  var BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

  function create(sessionKey, getMeId) {
    var storeKey = 'cq_seen_' + sessionKey;
    var seen = U.store.get(storeKey, []);
    var seenSet = {};
    seen.forEach(function (id) { seenSet[id] = true; });
    var pending = [];
    var queuedSet = {};
    var showing = null;
    var initialised = false;
    var baseTitle = document.title;
    var notificationSound = new Audio('../assets/notif_sound.mp3');
    var audioRetryHandler = null;
    notificationSound.preload = 'auto';
    notificationSound.volume = 0.5;

    function clearAudioRetry() {
      if (!audioRetryHandler) return;
      document.removeEventListener('pointerdown', audioRetryHandler);
      document.removeEventListener('keydown', audioRetryHandler);
      audioRetryHandler = null;
    }

    function playNotificationSound() {
      notificationSound.currentTime = 0;
      var playback = notificationSound.play();
      if (!playback || typeof playback.catch !== 'function') return;
      playback.catch(function (err) {
        if (err.name !== 'NotAllowedError') {
          console.error('Unable to play the notification sound.', err);
          return;
        }
        if (audioRetryHandler) return;
        audioRetryHandler = function () {
          clearAudioRetry();
          if (showing) playNotificationSound();
        };
        document.addEventListener('pointerdown', audioRetryHandler);
        document.addEventListener('keydown', audioRetryHandler);
      });
    }

    function markSeen(id) {
      if (seenSet[id]) return;
      seenSet[id] = true;
      seen.push(id);
      if (seen.length > 300) { var drop = seen.splice(0, seen.length - 300); drop.forEach(function (d) { delete seenSet[d]; }); }
      U.store.set(storeKey, seen);
    }

    /** Feed the latest notification list from the server. */
    function process(list) {
      var recentMs = CQ.config.RECENT_NOTIFICATION_MS;
      list.forEach(function (n) {
        if (seenSet[n.id] || queuedSet[n.id]) return;
        if (!initialised && U.now() - Date.parse(n.createdAt) > recentMs) { markSeen(n.id); return; }
        queuedSet[n.id] = true;
        pending.push(n);
      });
      initialised = true;
      showNext();
    }

    function showNext() {
      if (showing || !pending.length) return;
      var n = pending.shift();
      showing = n;
      markSeen(n.id);           // seen once displayed: a refresh will not repeat it
      render(n);
    }

    function render(n) {
      var meId = getMeId ? getMeId() : null;
      var isMe = !!(meId && n.playerIds.indexOf(meId) > -1);
      var names = (n.names || []).length ? n.names : namesFromMessage(n);
      var back = document.createElement('div');
      back.className = 'popup-backdrop';
      back.innerHTML =
        '<div class="popup' + (isMe ? ' me' : '') + '" role="alertdialog" aria-modal="true" aria-labelledby="pu-t" aria-describedby="pu-m">' +
        '<div class="popup-icon">' + BELL + '</div>' +
        '<h2 id="pu-t">You’re Up Next!</h2>' +
        (isMe ? '<div class="you">That’s you — head to the court!</div>' : '') +
        '<div class="court-badge" aria-hidden="true"><small>Court No.</small><b>' + esc(n.courtNumber) + '</b></div>' +
        '<div class="popup-names">' + names.map(function (nm) { return '<span class="chip">' + esc(nm) + '</span>'; }).join('') + '</div>' +
        '<p class="popup-msg" id="pu-m">' + esc(n.message) + '</p>' +
        '<button type="button" class="btn primary block" data-dismiss>Got it</button>' +
        (pending.length ? '<div class="popup-count">' + pending.length + ' more announcement' + (pending.length > 1 ? 's' : '') + ' waiting</div>' : '') +
        '</div>';
      document.body.appendChild(back);
      playNotificationSound();
      document.title = '🔔 Court ' + n.courtNumber + ' — ' + baseTitle;
      var btn = back.querySelector('[data-dismiss]');
      btn.focus();
      if (navigator.vibrate) { try { navigator.vibrate(isMe ? [200, 100, 200, 100, 200] : [150]); } catch (e) { /* ignore */ } }

      var timer = setTimeout(dismiss, CQ.config.POPUP_AUTO_DISMISS_MS);
      function dismiss() {
        clearTimeout(timer);
        document.removeEventListener('keydown', onKey);
        clearAudioRetry();
        back.remove();
        document.title = baseTitle;
        showing = null;
        showNext();
      }
      function onKey(e) { if (e.key === 'Escape') dismiss(); }
      btn.addEventListener('click', dismiss);
      back.addEventListener('click', function (e) { if (e.target === back) dismiss(); });
      document.addEventListener('keydown', onKey);
    }

    /** Fallback for notifications without a names array: parse the standard message. */
    function namesFromMessage(n) {
      var m = /^Players (.+), please proceed/.exec(n.message || '');
      if (!m) return [];
      return m[1].replace(/, and /, ', ').split(', ');
    }

    return { process: process };
  }

  CQ.notifications = { create: create };
})();
