/**
 * CourtQueue front-end configuration.
 * After deploying the Apps Script web app, paste its URL (ending in /exec) below.
 */
window.CQ = window.CQ || {};
CQ.config = {
  API_URL: 'https://script.google.com/macros/s/AKfycbwBaIyDrUIWhhBCs_wCXy5LkBq4C8rYMCTfy2PqvtWh0KPU0NFiVvd758VUEv6cvhwYNQ/exec',
  POLL_INTERVAL_MS: 4000,          // spec: poll every 3–5 s while the page is active
  HIDDEN_POLL_INTERVAL_MS: 15000,  // slower polling while the tab is in the background
  RECENT_NOTIFICATION_MS: 60000,   // on first load, still announce notifications newer than this
  POPUP_AUTO_DISMISS_MS: 45000     // popups never block the queue permanently
};
