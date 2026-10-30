# CourtQueue — Badminton Queue Management

**Play • Queue • Connect.** A doubles queue for badminton sessions. The queue master runs courts, players and results from a dashboard; everyone else opens one shareable link to see the live queue, who is next, their stats — and gets an in-page popup when their four are called to a court.

| Layer | Technology | Where it runs |
|---|---|---|
| Frontend | HTML5, CSS3, vanilla JavaScript | GitHub Pages |
| Backend / API | Google Apps Script web app | Google |
| Database | Google Sheets (`BadmintonQueueDB`) | Google Drive |

No React, Node server, Firebase or paid hosting is needed.

---

## 1. Architecture

```
 Browser (GitHub Pages)                    Google
 ┌────────────────────────┐   fetch   ┌──────────────────────┐  read/write  ┌──────────────────┐
 │ index / admin / session│ ───────▶ │ Apps Script web app   │ ───────────▶ │ BadmintonQueueDB │
 │ polls every 4 s        │ ◀─────── │ (the ONLY writer)     │ ◀─────────── │ (Google Sheet)   │
 └────────────────────────┘   JSON    └──────────────────────┘              └──────────────────┘
```

- **All logic is server-side.** Queue rotation, court assignment, validation, statistics and notifications live in Apps Script. Browsers only render what the server returns.
- **The sheet is private.** Browsers never touch the spreadsheet; only the script (running as you) does.
- **Public vs admin.** The public link carries an unguessable *view token* (read-only). Admin actions need a signed *admin token* obtained with the session password.

### Files

```
badminton-queue/
├── index.html            create a session / resume / join by link
├── pages/
│   ├── admin.html        queue master dashboard
│   └── session.html      public live page (queue, courts, popups, stats)
├── css/style.css         CourtQueue theme (near-black/emerald/amber palette)
├── js/
│   ├── config.js         ← paste your Apps Script URL here
│   ├── api.js            API communication (GET/POST, CORS-safe, error mapping)
│   ├── app.js            helpers, saved sessions + auth, toasts/modals/tabs, polling loop, error text
│   ├── views.js          courts, queue, statistics, results renderers (shared)
│   ├── notifications.js  notification polling input, ID de-duplication, popup
│   ├── session.js        public page controller
│   ├── admin.js          dashboard controller
│   └── home.js           index page controller
├── assets/               logo.svg, icon.svg, your original logo + theme reference
├── apps-script/
│   ├── Code.gs           doGet/doPost, routing, locking, state assembly
│   ├── Database.gs       sheet schema, setupDatabase(), read/insert/update helpers
│   ├── Auth.gs           password hashing, signed admin tokens, login throttling
│   ├── Queue.gs          sessions, players, courts, processAvailableCourts
│   ├── Matches.gs        start/complete/cancel/correct, manual swaps, derived stats
│   ├── Notifications.gs  create + retrieve assignment notifications
│   └── appsscript.json   manifest (web app: run as you, access: Anyone)
├── tests/                backend tests against an in-memory mock of Apps Script
└── README.md
```

---

## 2. Database (Google Sheet `BadmintonQueueDB`)

`setupDatabase()` creates every tab, header row and plain-text column format. Timestamps are ISO-8601 UTC strings. All ids are server-generated.

**Relationships**

```
Sessions 1──< Players         (session_id)
Sessions 1──< Courts          (session_id)
Sessions 1──< Matches         (session_id)
Sessions 1──< Notifications   (session_id)
Sessions 1──< SessionAdmins   (session_id)
Courts.current_match_id  →  Matches.match_id
Matches.court_id         →  Courts.court_id
Matches.player_1..4_id   →  Players.player_id   (1–2 = Team A, 3–4 = Team B)
Notifications.match_id   →  Matches.match_id
Notifications.player_ids →  comma-separated Players.player_id
```

### Sessions — one row per badminton session
| Column | Type | Rules |
|---|---|---|
| session_id | string `S_…` | unique, server-generated |
| session_name | string | 1–60 chars |
| public_token | string (32 alphanumerics) | unique, random; **view-only** credential |
| status | `ACTIVE` \| `CLOSED` | closed sessions are read-only |
| court_count | integer | 1–12 |
| next_queue_order | integer | counter used to place players at the end of the queue |
| created_at / updated_at | ISO string | |

### Players
| Column | Type | Rules |
|---|---|---|
| player_id | string `P_…` | unique |
| session_id | string | FK |
| player_name | string | 1–40 chars; unique (case-insensitive) among non-LEFT players in a session. Pasted list numbering (`1.`, `2)`), bullets, emoji, digits and other symbols are stripped on the server before saving, so only the name is stored |
| queue_order | number | lower = earlier. Only meaningful while `WAITING` |
| status | `WAITING` \| `PLAYING` \| `UNAVAILABLE` \| `LEFT` | |
| leave_after_match | boolean | set when a player is removed mid-match |
| target_games | integer | 0 = normal rotation. Above 0, a catch-up player is placed in the **third group** of the queue (rests the next two games, then takes their turn) until they have played that many games |
| joined_at / updated_at | ISO string | |

Queue position is *derived*: WAITING players sorted by `queue_order`.

### Courts
| Column | Type | Rules |
|---|---|---|
| court_id | string `C_…` | |
| session_id | string | FK |
| court_number | integer | 1…court_count |
| status | `AVAILABLE` \| `IN_PROGRESS` | |
| current_match_id | string | set only while `IN_PROGRESS` |

### Matches
| Column | Type | Rules |
|---|---|---|
| match_id | string `M_…` | |
| session_id, court_id | string | FKs |
| player_1_id … player_4_id | string | four distinct players; 1–2 Team A, 3–4 Team B |
| winning_team | `A` \| `B` \| empty | set on completion |
| score | string `A-B`, e.g. `21-15` | optional; must not be tied and must agree with the winner |
| status | `IN_PROGRESS` \| `COMPLETED` \| `CANCELLED` | |
| started_at / completed_at | ISO string | |

### Notifications
| Column | Type | Rules |
|---|---|---|
| notification_id | string `N_…` | unique; clients de-duplicate on this |
| session_id, match_id | string | FKs |
| court_number | integer | |
| player_ids | string | the four assigned players, comma-separated |
| notification_message | string | `Players A, B, C, and D, please proceed to Court No. N.` |
| notification_type | `ASSIGNMENT` \| `ASSIGNMENT_UPDATE` | update = queue master swapped a player |
| created_at | ISO string | |

Rows are never deleted when a popup is dismissed.

### SessionAdmins
| Column | Type | Rules |
|---|---|---|
| session_id | string | FK |
| admin_id | string `A_…` | |
| credential_hash | string `v1$salt$hash` | salted, 1000× iterated SHA-256. **Never plaintext.** |
| role | `OWNER` | |
| created_at | ISO string | |

### Statistics
There is **no stats sheet.** Games, wins, losses, win rate and history are computed from `COMPLETED` matches on every read, so corrections and voids can never leave stale numbers.
`win rate = wins ÷ games × 100` (0% with no games).

---

## 3. Queue & court algorithm

`processAvailableCourts(ctx)` (Queue.gs) runs under a script lock after anything that can free a court or add a player (match finished, player added/rejoined, court added, manual fill, session creation):

1. Take courts with `status = AVAILABLE`, ascending `court_number`.
2. For each, take the first four **eligible** players: `status = WAITING`, in no `IN_PROGRESS` match, in `queue_order`. Catch-up players are not pulled forward — they are *placed* two groups back (see below), so the queue position alone decides who plays.

**Catch-up players** (`addPlayers` with `catchUp` / `targetGames`, `setPlayerTarget`, or coming back off a break): a player who still owes games is moved to the **start of the third group of four** (queue position 9). They are not in the next game or the one after it, so they get rest, and their place in the queue guarantees their turn. With fewer than eight players waiting there is nothing to rest behind, so they simply take the newest end-of-queue position. Nothing else changes: once they reach the front they play normally, and priority ends when the target is met.
3. If fewer than four are eligible → stop. The court stays `AVAILABLE`, shows *"Court No. N is available. Waiting for more players."*, and **no notification is created**.
4. Otherwise create the match (`IN_PROGRESS`), set the four players `PLAYING`, reserve the court, write one notification, and continue to the next court.

**Completing a match** (`completeMatch`):
1. Verify admin token → confirm match is `IN_PROGRESS` → validate winner/score.
2. Save result, release the court.
3. Return each player to the **end of the queue in a random order** (new `queue_order` values from the session counter, shuffled), so the same four don't line up with the same partners and opponents in their next game. Anyone with `leave_after_match` becomes `LEFT` instead.
4. Run `processAvailableCourts` → new matches + notifications.
5. Return the fresh session state.

Other rules:
- **No double assignment:** every assignment checks the set of players in active matches; a second check inside `createMatchOnCourt_` throws `PLAYER_BUSY`.
- **Courts are independent:** completing one never touches the others.
- **Leaving mid-match:** the player keeps playing; `leave_after_match` makes them `LEFT` afterwards. History is kept.
- **Cancel (in progress):** nothing is counted; the four go to the *front* of the queue in order, and that court is *not* refilled in the same request (so the same four aren't re-announced). Use "Fill empty courts" or "Start next four".
- **Void (completed):** marks the match `CANCELLED`; stats update automatically.
- **Manual control:** reorder queue, pick any four waiting players for a court, swap players in a live match. A swapped-out player takes the replacement's queue spot; a notification is created for the changed court.
- **Idempotency:** mutating requests carry a `requestId` — a retry replays the first response. Completing an already-completed match with the *same* result is a no-op; with a *different* result it is rejected (use *Correct result*).
- **Concurrency:** all mutations run inside `LockService.getScriptLock()`.

---

## 4. Popup notifications

**Server:** each new assignment writes a `Notifications` row (unique `N_…` id) with the exact message pattern. Only players actually assigned are named — never the four who just finished unless they are also the next four.

**Client (`notifications.js`):**
1. Every poll (~4 s) returns the latest 40 notifications for *this session only*.
2. IDs are compared with the set this browser has already shown (`localStorage`, per session). Text is never used for de-duplication.
3. Unseen notifications are queued and shown one at a time: bell icon, **You're Up Next!**, big court number, four name chips, the message, **Got it** button, entrance animation, and the `assets/notif_sound.mp3` alert sound. If browser autoplay is blocked, sound retries after the next user interaction. Esc, backdrop click, or a 45 s timeout also close it, so it never blocks the queue permanently.
4. Dismissing only marks the ID seen locally. The database row is untouched.
5. **Delayed polling:** background tabs poll every 15 s and poll immediately when the tab becomes visible; because the server returns a window of recent notifications, nothing in between is lost. On the very first load only notifications from the last 60 s are announced.
6. Players can pick *"I'm playing as…"* on the public page; their name is highlighted and the popup says *That's you!*.

> Popups appear **only while the page is open.** There are no push notifications — if the page is closed, nothing is delivered.

---

## 5. Authentication & security

**Why not Google sign-in?** Players are anonymous, so the web app must be deployed *Execute as: Me, Who has access: Anyone*. A "sign in with Google" web app can't serve anonymous public links. Instead:

- The queue master chooses a **session password** (≥6 chars) when creating a session.
- The server stores only a salted, iterated hash (`SessionAdmins`).
- `adminLogin` returns an **HMAC-signed token** `sessionId.expiry.signature` (24 h). The signing secret lives in Script Properties, not in code or the sheet.
- Every admin action re-verifies the token **and** that it belongs to that session. Wrong/expired → `UNAUTHORIZED`.
- Failed logins are throttled (5 attempts → 5-minute lock per session).
- The public token is 32 random characters and grants read access only. Public responses omit session id, public token, match ids and admin data.
- All input is validated server-side (lengths, counts, enums, score format, duplicate names, queue set equality).
- The frontend escapes all names before rendering (no HTML injection).
- Sheet access is only via the script; nothing in the frontend can write to it.

**Caveats:** the admin password can't be recovered (create a new session if lost). Anyone with *edit* access to the spreadsheet or script can read the sheet; keep both private. The admin token is stored in the queue master's `localStorage` — use "Sign out" on shared devices.

---

## 6. API contract

All responses: `{ "ok": true, "data": … }` or `{ "ok": false, "error": { "code", "message" } }`.

| Method | Action | Auth | Body / params |
|---|---|---|---|
| GET | `ping` | – | – |
| GET | `getPublicSession` | public token | `token` |
| POST | `createSession` | – | `name, courtCount, players[], password` |
| POST | `adminLogin` | – | `sessionId, password` |
| POST | `getAdminSession` | admin | `sessionId, adminToken` |
| POST | `addPlayers` · `editPlayer` · `removePlayer` · `setPlayerStatus` · `setPlayerTarget` | admin | names / `playerId`, `name`, `status`, `targetGames` |
| POST | `addPlayers` (priority) | admin | `names[]`, optional `targetGames` (applies to all names) or `catchUp: true` (= most games anyone has played) |
| POST | `reorderQueue` | admin | `playerIds[]` (exactly the waiting set) |
| POST | `setCourtCount` · `fillCourts` · `updateSession` | admin | `courtCount` / `name` |
| POST | `startMatch` | admin | `courtId`, optional `playerIds[4]` |
| POST | `completeMatch` · `correctMatch` | admin | `matchId, winningTeam, score` |
| POST | `cancelMatch` | admin | `matchId` |
| POST | `setMatchPlayers` | admin | `matchId, playerIds[4]` |
| POST | `closeSession` | admin | – |
| POST | `deleteSession` | admin | – (permanently removes the session and all of its rows from every tab, clears its cached public read; returns `{ result }`, no `state`) |

Admin calls also send `sessionId`, `adminToken` and (mutations) `requestId`; they return `{ state, result }` so the UI updates immediately. `deleteSession` is the exception: the session row is gone, so it returns only `{ result }`.

**CORS:** Apps Script can't answer preflight requests. The frontend therefore (a) uses plain GETs and (b) sends POST bodies as `Content-Type: text/plain` (a "simple" request, no preflight) and (c) follows redirects (`redirect: 'follow'`). Google serves the redirected response with `Access-Control-Allow-Origin: *`. **Test the deployed URL early** (step 6 below).

---

## 7. Deployment

### Step 1 — Create the spreadsheet
1. Go to <https://sheets.new> and name it **BadmintonQueueDB**.
2. Open **Extensions → Apps Script** (this creates a script bound to the sheet).

### Step 2 — Add the backend code
1. In the Apps Script editor, create files named exactly `Code`, `Database`, `Auth`, `Queue`, `Matches`, `Notifications` (the editor adds `.gs`) and paste the contents of each file from `apps-script/`.
2. Open **Project Settings ⚙ → Show "appsscript.json" manifest file**, then replace its contents with `apps-script/appsscript.json`.

### Step 3 — Initialise the database
1. Select the function **`setupDatabase`** and click **Run**.
2. Approve the permission prompt (Advanced → Go to project → Allow). It needs access to your spreadsheet.
3. Check the sheet: it now has the six tabs with headers. A secret for signing admin tokens is generated automatically.

> **Updating an existing deployment?** Deploy the new backend version and the sheet is repaired automatically on the first request (new columns such as `target_games` are added at the end). Running `setupDatabase` by hand also works.

### Step 4 — Deploy the web app
1. **Deploy → New deployment → ⚙ Web app**.
2. **Execute as:** *Me*. **Who has access:** *Anyone*.
3. **Deploy**, then copy the **Web app URL** (ends in `/exec`).
4. After editing backend code later: **Deploy → Manage deployments → ✏ → Version: New version → Deploy** (the URL stays the same).

### Step 5 — Configure the frontend
Edit `js/config.js`:
```js
API_URL: 'https://script.google.com/macros/s/XXXXXXXX/exec',
```

### Step 6 — Test the API before publishing
- Open `<web app URL>?action=ping` in a browser. Expect `{"ok":true,"data":{"pong":true,…}}`.
- If you see a Google sign-in page or HTML, the deployment access isn't set to **Anyone**.
- From your site's browser console (after step 7): `fetch(CQ.config.API_URL + '?action=ping').then(r => r.json()).then(console.log)` — this confirms cross-origin GET works from GitHub Pages.

### Step 7 — Publish on GitHub Pages
1. Create a repository (e.g. `courtqueue`) and push this folder. (`apps-script/` and `tests/` can stay in the repo — GitHub Pages only serves them as static files; they don't run.)
2. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save.**
3. Your site appears at `https://YOUR_USERNAME.github.io/YOUR_REPOSITORY/`.
4. Share links look like `https://YOUR_USERNAME.github.io/YOUR_REPOSITORY/pages/session.html?session=PUBLIC_TOKEN`. The app builds these automatically.

### Step 8 — Smoke test the deployed app
Create a session on `index.html` with 2 courts and 9 players, open the player link in a second browser/phone, finish a match in the dashboard, and confirm the popup appears on the player device within ~5 s.

---

## 8. Testing checklist

**Automated (included):** `node tests/backend.test.js` runs 20 backend scenarios against an in-memory mock of the Apps Script services: court fill order, exact notification text, rotation, duplicate/retry handling, corrections, voids, leave-after-match, insufficient players, queue validation, manual swaps, court count, closing, session isolation, auth failures, no plaintext password, public data leaks. (It validates the logic, not the live Google services.)

**Manual (on the deployed app):**
- [ ] One court, then two or three courts: each fills in ascending order.
- [ ] Fewer than four waiting: court shows "Waiting for more players", no popup.
- [ ] Adding the 4th player to an empty court fires exactly one popup.
- [ ] Finish a match: finished four go to the end of the queue in a random order; next four are called; only the *new* four are named.
- [ ] Add a player with *Catch up* ticked: they show a catch-up badge, land at the start of the third queue group (position 9), sit out the next two games, then play.
- [ ] Finish two courts within a few seconds: no player appears on both courts.
- [ ] Remove a waiting player; remove a playing player (leaves after match, not re-queued, history kept).
- [ ] Mark unavailable / rejoin; rename; duplicate-name rejection.
- [ ] Reorder queue (↑ ↓ ⤒); change players on a live court.
- [ ] Correct a result: wins/losses/games stay consistent (no double counting). Void a result: stats drop it.
- [ ] Double-click *Save result*: one result, one set of notifications.
- [ ] Two browsers + one phone on the player link: all show the same popup once; refresh doesn't repeat it; dismiss doesn't affect other devices.
- [ ] Background a phone tab for ~1 min, return: missed announcement still appears.
- [ ] Open `pages/admin.html` without signing in → login; wrong password → error; player link never shows admin controls.
- [ ] Invalid link (`pages/session.html?session=abc`) → friendly "Link not valid".
- [ ] End session: players see "ended", controls are disabled, results still correctable.
- [ ] Delete session (after ending it): its rows disappear from every spreadsheet tab and the player link stops working.
- [ ] Paste a numbered/bulleted list into Add players: only the names appear in the queue.
- [ ] Turn off Wi-Fi briefly: "Reconnecting…" banner, recovers by itself.

---

## 9. Limits & notes

- **Latency:** Apps Script calls take ~0.5–2 s. Admin buttons show a busy state; players may see changes up to ~4 s later.
- **Quotas:** a typical session (≈20–30 viewers polling every 4 s) is well within Apps Script's free limits, and public reads are cached for 3 s. For very large audiences, increase `POLL_INTERVAL_MS`.
- **Growth:** the sheet grows by a few rows per match. Sessions can be removed permanently with **Delete session** on the dashboard (once ended) or **Delete** in *Your sessions* on the home page. Both delete that session's rows from Sessions, Players, Courts, Matches, Notifications and SessionAdmins and invalidate its public link; the home-page button falls back to removing it from the device only when the saved sign-in has expired.
- **Time zones:** timestamps are UTC; the browser displays local time.
- **Logo:** `assets/logo.svg` / `icon.svg` are vector recreations of your shuttlecock mark so it sits cleanly on the dark theme. Your original files are in `assets/` — swap them in if you prefer the exact artwork.
