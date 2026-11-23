# Auth and end-to-end encryption

## Auth: password-authenticated key exchange (OPAQUE), not plain password auth

Login/registration use `@serenity-kit/opaque` (OPAQUE PAKE protocol) on both client and server —
the server never sees the plaintext password. The flow is split into two round trips per
operation:
- Register: `POST /api/initiateregister` → `POST /api/finaliseregister`
- Login: `POST /api/initiatelogin` → `POST /api/finaliselogin`
- Change password (logged in, Settings): `/initiatelogin` with the current password, `GET
  /api/key-backup`, `/initiateregister` for the new one, then `POST /api/change-password` with the
  login's `finishLoginRequest` + session key (proof of the current password, checked by
  `checkLoginProof`) and the new record and re-encrypted backup. Every other device is logged
  out (`endSessions`; the answer's `loggedOutOthers` says how many, security audit 2026-11-19:
  changing the password is how people get someone out). A recovery-code reset logs out every
  session from before it too.
- Recovery code: see End-to-end encryption.

**Usernames are lower case** and ignore capitals everywhere (login, recovery, making an admin;
`server/usernames.js` `findUserByName`). Signing up as "Alice" makes the username `alice` with
"Alice" as the display name. OPAQUE binds a record to the name it was registered under (the
server derives each account's OPRF key from it), so migration 5, which lower-cased existing
accounts (copying the old spelling into an empty display name), keeps that spelling in
`users.opaque_id` for `startLogin`; `/initiateregister` always uses the lower-case name, so a
password change or recovery clears it. An old account whose lower-case name was already taken
kept its capitals (an exact match wins at login).

Server-side login state is stored transiently (5-minute expiry; expired rows are purged on each
login attempt). Since 2026-11-19 (security audit) the app sends `perAttempt: true` to
`/initiatelogin`, which keeps each login in `login_attempts` under a random `loginId` it answers
with; the app sends it back with `/finaliselogin` and with every password proof (change-password,
recovery code, two-factor, deleting the account), and each works once. So someone starting logins
for your name can't replace yours between its two steps. Apps from before send no `loginId` and
still get the old `login_states` row keyed by (lower-case) username (the latest start wins),
cleaned up on successful login.

Logged-out visitors must not be able to tell which usernames exist. `/api/initiatelogin` answers an
unknown username with OPAQUE's dummy response (`registrationRecord: null`), so it fails at the end
exactly like a wrong password. Logged-in users can see every user (intentional: the app is for groups
where everyone knows each other). The client must never send its `clientLoginState` to the server.

Password guessing can only happen online (through the server), so `routes/auth.js` rate limits
it (`rateLimit.js`, in memory): login starts per IP (30 / 15 min), per IP and username (10 / 15
min) and per username from anywhere (30 / 15 min, applied whether or not the account exists;
cleared by a successful login), registrations per IP, recovery attempts per IP and username.
Each login started is one guess (a wrong password fails on the guesser's device, never reaching
`/finaliselogin`), so the per-username cap has to count starts; it's three times what one
address may use, so locking someone out of logging in takes three or more addresses (before
2026-11-19 one address could: 20 per username against 30 per address).
Refusals are 429 with `Retry-After` and a message the login form shows. `req.ip` comes from
nginx's `X-Forwarded-For` (`trust proxy: 'loopback'`). A local `npm run dev` goes through vite's
proxy to the public API, so everyone using one shares its address there. The websocket `user_status`
broadcast only goes to identified sockets.

On successful login/register/recovery, the server starts a login session and issues a JWT for
it (`startSession`, see `server/auth.js`). On the built-in server the app keeps it in an
HttpOnly cookie the page can't read (The login cookie, below); logged in to another server, and
in older apps, the client stores it in `localStorage` and sends it as `Authorization: Bearer
<token>` (see `client/src/utils/api.js`). `authenticateJWT` middleware protects all `/api/*`
routes except config/login/register.
- **Sessions last while the app is used:** a token is good for 30 days (`SESSION_SECONDS`), and
  any authenticated request with one older than a day (`RENEW_AFTER_SECONDS`) gets a new one: a
  renewed cookie, or for Bearer requests the `X-Voicaw-Token` response header (exposed by CORS),
  which `api.js` stores only if it renews the token that request was sent with (not after a
  logout or another login). So only a device unused for 30 days has to log in again.

## The login cookie

Since 2026-11-20 (security audit follow-up): before, a script injected into the page (an XSS)
could read the token from localStorage and use the account from elsewhere until it was logged
out. Now the page never holds it.
- **Server** (`auth.js`): a login sent with `X-Voicaw-Login: cookie` (`sessionReply`) answers
  with `voicaw_session` (HttpOnly, Secure, `SameSite=None` (meant for the Android app's page,
  https://localhost, cross-site to the API, whose app keeps the login itself instead), `Path=/api`, 30 days, renewed like the token)
  and `login: { id, username, sid, iat }` instead of `token`. A request counts the cookie only
  when it also names its session in `X-Voicaw-Session: <sid>`: another site's form or link can't
  send headers, and a script on another origin can't without passing CORS, so the cookie alone
  never acts as anyone (CSRF). The header must match the session: otherwise 409
  `login_changed` (another tab logged out and in again, or logout's late requests), which the
  page takes as "reload onto the new login" (`loginReplaced`, `announceLoginReplaced`), never as
  a logout. The header without a cookie is 401 `no_session`; an invalid cookie is cleared with the
  403. `POST /logout` clears it. A request naming its session never gets a token back (`/profile`
  leaves it out). Bearer tokens still work everywhere (bots' owners' scripts, other servers,
  older apps), and a Bearer request naming its session (the desktop app) is checked and renewed
  the same way.
- **The websocket** is on another host than the API (`wss://api.voicaw.com`, the API at
  `app.voicaw.com/api`), so the cookie never reaches it: the page asks `POST /socket-ticket` for a
  random one-time ticket (a minute, in the API's memory) and identifies with `{ ticket }`. An
  unknown or expired ticket closes the socket with 4001 (not 1008, which the app takes as logged
  out): the page asks for another. The ticket request refused for the login is the logout.
- **The page** (`utils/loginToken.js`): `savedLogin()` is `{ id, username, sid, iat }` (cookie
  mode, localStorage `login`) or the same with `token` (another server: `cookieMode()` is
  `isBuiltInServer()`; browsers block cross-site cookies there). `loginHeaders`, `sameLogin`
  (same session) and `sameSaved` (exactly the saved one) replace comparing tokens; every axios
  request keeps the login it was sent as (`config.login`), which logout's requests set
  themselves. Logged out, requests ask for the cookie (`X-Voicaw-Login`) with credentials.
- **Moving over:** a device logged in before keeps its token until its next start, when
  `services/loginCookie.js` sends it to `POST /session-cookie` (the same session, set as the
  cookie) and forgets it. Out of reach, it tries again next time.
- **The desktop app** (`electron/apiLogin.js`, the user's choice): our voicaw:// pages are
  cross-site to the API, so the main process keeps the token (in `login.json`, below) rather than
  Chromium: it takes `voicaw_session` out of the API's answers (a login always; a renewal or a
  clearing only for the session saved now, not a late answer to an older one's request), strips
  it, and adds `Authorization: Bearer` to requests that name their session. The page gets only
  `{ known, login }` from `voicawDesktop.login.get()`. Only for the built-in API, whose address
  the build writes into `voicaw-api.json` (`client/vite.config.js`), never one the page names.
  One `onBeforeSendHeaders` listener per session, shared with YouTube's Referer (`youtube.js`).
- **Android** (the user's choice, 2026-11-23): the app's native side keeps the login and makes
  the page's API requests, as the desktop app's main process does. The page is in cookie mode
  like a browser's (`{ id, username, sid, iat }` only), but on Android `api.js` sends its
  requests through `utils/androidApi.js`'s axios adapter to the Voicaw plugin's `apiRequest`
  (the hidden notification page through `VoicawNotifyHost.apiRequest`), and `ApiLogin.java`
  makes them with `HttpURLConnection`: only to the build's API address (`voicaw-api.json`), the
  page's cookies never sent, `Authorization: Bearer` added to requests naming their session,
  `voicaw_session` taken out of answers into the app's private storage (a login always; a
  renewal or a logout only for the session saved now, as `electron/apiLogin.js`), the page's
  `navigator.userAgent` sent for Settings → Devices. Logging out without the server tells it to
  forget the token (`forgetApiLogin`). Capacitor's cookie plugin, always loaded though off,
  installs a `CookieHandler` sharing the WebView's cookies with every `HttpURLConnection`:
  `MainActivity` (and `ApiLogin` before each request) removes it, so the login never lands in
  the WebView's store. Why: the WebView never sends the API's cookie, cross-site to its page
  (https://localhost). android-v1.3.1 to 1.3.3 used it and logged out at every start (the API's
  access log showed a cookie set by `/session-cookie` missing from `/profile` a second later, in
  the same run, on WebView 157; `setAcceptThirdPartyCookies` before or after the page loaded,
  and a native copy of the cookie, changed nothing; WebView 133 in the emulator took the cookie
  but kept it only after its periodic save, and WebViews ignore `Partitioned`), and it only
  seemed to work because the next login came back as a token (below). 1.3.4 kept a Bearer token
  in the page meanwhile; this moves it into the app at the next start (`/session-cookie`).
- **Logging in is sent as logged out** (`authService.js` `postLoggingIn`: finishing a login,
  the two-factor step, signing up, recovering): a start that found the saved login dead only
  shows the login screen, and the next login sent with that session's name came back as a token
  (`sessionReply` gives the cookie only to `X-Voicaw-Login: cookie`).
- **Other servers** keep Bearer tokens in localStorage (the user's choice), with the known
  limit below for that case only.
- Still possible for an XSS: acting through the open page (it can't take the login away).

## Login sessions and Settings → Devices

Every login is a row in `sessions` (random id, user, created, last used, user agent, IP), and
the token carries its id (`sid`). `verifyToken` (every request and socket identify) refuses a
token whose row is gone, so a session can be ended on the server. The last use, user agent and
IP are saved at most every 5 minutes (`SESSION_TOUCH_SECONDS`), not on every request; rows unused
for longer than a token lasts are cleared at the user's next login. The IP is only kept while
the session exists, and only shown to the account itself.
- **Routes** (`routes/sessions.js`, `server/sessions.js`): `GET /api/sessions` (this one first,
  with `current` and `online`: has an open socket), `DELETE /api/sessions/:id` (one),
  `DELETE /api/sessions` (every other one), `POST /api/logout` (this one; the client's logout
  calls it before forgetting the token). Ending a session deletes its row and the push
  subscriptions saved under it (`push_subscriptions.session_id`, set on every
  `/save-subscription`, which the app sends at each start), and sends its open sockets
  `session_revoked` before closing them (1008). No password is asked: someone with a stolen token
  could log the owner out, but the owner logs back in with the password and logs them out.
- **The client** (`DeviceSettings.jsx`, Settings → Devices) lists them, names each from its user
  agent (`utils/deviceName.js`: "Chrome on Windows", "Voicaw desktop app on Linux"), and logs
  one, or every other one after a confirmation, out. `ws-client` calls `onLoggedOutElsewhere`
  listeners (App logs out) on `session_revoked`, `account_deleted`, or a socket closed with 1008
  (the token refused at identify, e.g. a device that was asleep when it was logged out); it
  doesn't reconnect then. Each socket keeps the token it was opened with: if the saved one is by
  then another session (`utils/loginToken.js` `sameLogin` compares `sid`s, so a renewed token
  is the same login), the page slept while another tab logged out and in again, and it calls
  `onLoginReplaced` instead (App reloads onto the new login). Before (2026-10-15) it logged out,
  and logout ends the *saved* token: the other tab's new login got 403s ("Invalid token") a few
  minutes after logging in (`e2e/stalelogout.mjs`).
- **Tokens from before sessions** (no `sid`) are refused (security audit, 2026-11-19). Until
  then they became a session on first use, which a logout on that device never really ended;
  tokens already lasted 30 days before sessions (2026-10-02), so none could still be valid.
  `users.sessions_reset_at`, which once refused them, is no longer read or written. Ending
  sessions from Settings still deletes the push subscriptions saved with no session.
- **The saved login** (`localStorage` `login`, or `token` for another server) is read and
  written only through `utils/loginToken.js` (`savedLogin`, `saveLogin`, `forgetSavedLogin`),
  which keeps the newest login this page saved in memory and never lets the saved one go back
  to an *older* one of the same account (it writes the newer one back, with a console warning). A Windows desktop
  app's storage did that on its own (2026-11-16): after every login it went back to a month-old,
  expired token, so the chats said "Invalid token" and the app logged out, while the server
  never refused the new login. Another account's token, a newer one (another tab logging in) or
  none (logged out) is taken as it is. That memory only lasts a page's life, and it wasn't
  enough there (2026-11-19): every reload (App reloads onto a replaced login, updates) and
  restart opened on the old token again. So **the desktop app keeps the login in its own
  file** (`electron/loginStore.js`, `login.json` in its data folder, written by Node: `{ v: 1,
  token }`, null for logged out), since 2026-11-20 filled by the main process from the API's
  answers (The login cookie, above); the page only reads what it says through the bridge
  (`voicawDesktop.login`) and wins over localStorage once the file holds one. A token an older
  version kept in localStorage is handed to it (`set(token)`) and forgotten there. Checked in
  the real app under Xvfb by `e2e/desktoplogin.mjs`.
  **Known limit, other servers only** (security audit, 2026-11-19): logged in to another server,
  a script injected into the page (an XSS) could read the token and use the account from
  elsewhere until it's logged out (Settings → Devices, or a password change, which logs out
  every other device). Private keys can't be copied (non-extractable CryptoKeys) and password,
  recovery-code, two-factor and deletion changes need the password.
- **The log** (pm2's, 2026-11-14): every session started (`Session started: user 1, session
  5LXenR, Voicaw/1.0.44`), ended (`Sessions ended (logout|from Settings): …`) and every token
  refused, with why (`Token refused: expired | not valid (invalid signature) | session ended |
  …; user, session, issued, route or websocket, app`), each token at most once a minute
  (`auth.js` `refused`). Never the token or IP. For telling apart why a device keeps being logged
  out (`pm2 logs voicaw-api | grep -E 'Token refused|Session'`); the privacy policy says so.
- Changing the password still leaves other devices logged in (Settings → Devices logs them out).
- Deleting an account deletes its sessions.
- On start, `AuthProvider` only drops the session when `/profile` answers 401/403/404. With no
  answer (given up on after 10 s: a stuck or restarting API takes connections and never
  answers) or a server error (no network yet after boot, an API restart) it keeps the token and
  asks again every 3 s, while `App` shows "Can't reach Voicaw. Trying again…" with "Log out on
  this device" (unless the offline copy has the account's profile: then the app opens in
  offline mode, see Offline copy in `docs/messages.md`), which forgets the login here without the server (`forgetLogin`). The session itself then
  stays on the server (Settings → Devices on another device ends it, or it expires), and so does
  a login cookie the page can't remove, which no longer counts: nothing names its session.
- **Logging out** (`services/logout.js`, 2026-10-13) gives the server 5 s
  (`LOGOUT_SERVER_MS`) to turn off this device's notifications, hang up and end the session,
  then forgets the token, keys, group keys, the search and offline copies, drafts, sessionStorage
  and the account's own localStorage entries (`ACCOUNT_KEYS`: last channel per guild, collapsed
  categories and tasks; this device's settings stay) whether it answered or not (unanswered
  requests go on with the old login; every one of them names it (`config.login`), and
  `utils/api.js` keeps the login a request names, since by then the saved one may be a new
  login's: with the cookie, the server answers such a late request 409). Contact pins
  (`voicaw-contacts`) stay: they're what warns of a changed key when the same account logs in
  here again. Only one logout runs at a time (ending the session tells this device's own socket
  `session_revoked`, which logs out too), and one finishing after a new login leaves it alone:
  before (2026-10-14), a second logout running late ended and forgot the new login (403s, then
  logged out on reload). A web push subscription is dropped in the
  browser either way, so a logged-out browser gets no more of the account's notifications even
  when the server never heard. Before, a server that didn't answer left logout waiting
  forever, still logged in.

## Two-factor authentication

Optional, off until someone turns it on (Settings → My Account → Two-factor authentication,
`TwoFactorSettings.jsx`; built 2026-10-09). As Discord's: an authenticator app's six-digit codes
(TOTP, RFC 6238: SHA-1, 30-second steps, which every app speaks) plus ten single-use backup codes
(`abcd-efgh`, no 0/o/1/l/i). `server/twoFactor.js` does it with node's crypto, no library.
- **Setting up:** the client makes the secret (20 random bytes, base32, `authService`
  `newTwoFactorSecret`) and shows it as a QR code of an `otpauth://` link (`qrcode-generator`,
  loaded only then, drawn as an SVG, dark on light in both themes: `--vc-qr-dark/-light`) and as
  text. `POST /api/two-factor/enable { finishLoginRequest, clientSessionKey, secret, code }`: a
  password proof (as change-password) and a code that matches the secret, so a typo'd set-up
  can't lock anyone out. The answer is the backup codes, shown once (copy, save as a file).
- **Kept:** `users.two_factor_secret` as is (the server has to compute codes; it guards logging
  in to this server and has nothing to do with the encryption keys),
  `two_factor_backup_codes` (a JSON array of SHA-256 hashes of the unused ones) and
  `two_factor_last_step`: each code works once (a step at or before the last one used is
  refused). Codes from one step either side of now count.
- **Logging in:** with it on, a right password at `/finaliselogin` answers only `{ twoFactor:
  true, ticket }`: no session and no key backup (someone with the password alone can't even get
  the backup it opens). `POST /api/login/two-factor { ticket, code }` (the app's code or a
  backup code, which is then used up) answers as `/finaliselogin` would have. Tickets live 5
  minutes in the server's memory (by hash) and die after 5 wrong codes (401 `code:
  'two_factor_expired'`: type the password again); a wrong code is 401 `two_factor_invalid`.
  The client keeps the login's exportKey in `logIn`'s closure meanwhile (`Login.jsx` asks for
  the code).
- **Wrong codes back off** (security audit, 2026-11-19), counted in the database so a restart
  doesn't forget them (`twoFactor.js` `checkCode` counts every code it checks, wherever it's
  typed: logging in, recovery, turning off, new backup codes): every 10 wrong codes since the last
  right one (`users.two_factor_failures`) lock code checking for 15 minutes, twice as long each
  time, up to a day (`two_factor_locked_until`; 429 with `Retry-After`, even for a right code).
  Someone who knows the password then gets about ten guesses a day. A right code starts the count
  again. Codes typed while turning it on are checked against the new secret, so they only have an
  in-memory limit (10 / 15 min, `twoFactorSetupPerUser`).
- **The owner is told:** every wrong code also adds to `two_factor_failures_unseen`, sent as
  `twoFactorFailures` in `/profile` and every login's answer. While it's above 0 the app shows a
  banner over every page (`TwoFactorAlert.jsx`: someone typed the password and N wrong codes,
  Change password), on every device, until it's dismissed or Change password is chosen
  (`POST /api/two-factor/failures/seen` clears it everywhere).
- **Recovery code:** resetting a forgotten password would otherwise get round it, so
  `/recover/start` says `twoFactor: true` and `/recover/finish` then needs `twoFactorCode` (401
  `two_factor_required` without one, before anything changes). The app asks for it last, after
  the new recovery code has been kept (the login's two-factor screen), so it's still fresh.
- **Turning off / new backup codes:** `POST /api/two-factor/disable` and `/two-factor/backup-codes`,
  each with a password proof and a code (or backup code). `GET /api/two-factor` says `{ enabled,
  backupCodesLeft }`. Changing the password, the recovery code and deleting the account still
  need only the password (as before), and turning it on doesn't log other devices out (Settings →
  Devices, or changing the password, does).
- **Lost everything** (app and backup codes): an admin on the host runs `cd server && npm run
  admin -- <username> --remove-two-factor`. Deleting an account clears all three columns.
- Bots never log in with a password, so it doesn't apply to them.

## Sign-ups (open, invite only, approval)

**Usernames** (security audit, 2026-11-18): a new one is 2 to 32 of a-z, 0-9, `_`, `-` and `.` (no
two dots running), after lower-casing (capitals typed become the display name, as before):
no spaces, invisible characters or look-alike letters to pass as someone else
(`usernames.js` `isValidNewUsername`, checked by `/initiateregister` with `signup: true`, so
before any keys are made, and again by `/finaliseregister`; 400 `code: 'username'`, which the
login screen words itself and also checks before sending). Only sign-ups: accounts from before
keep their names and log in as always.

Who can make an account is the app-wide setting `signupMode` (Settings → Admin; `SIGNUP_MODE`
in `server/.env` as the fallback, `open` when neither is set), handled by `server/signups.js`:
- **`open`**: anyone (as before). An invite sent along is ignored.
- **`invite`**: only with an app invite. `/initiateregister` with `signup: true` (only sign-ups
  send it: password changes and recovery use the same route) refuses without a working one
  (403 `code: 'invite_required'` / `'invalid_invite'`) before the client makes any keys;
  `/finaliseregister` checks again and uses the invite up in the transaction that makes the
  account. Both check the invite before whether the username is taken (409), so someone without
  an invite can't find out which usernames exist (security audit, 2026-11-19).
- **`request`**: anyone, but the account is made with `users.pending = 1` until an admin approves
  it. A working invite skips the wait.

**Why they want to join** (2026-10-22): while sign-ups are `request`, the form has a box "Tell
us why you want to join Voicaw" (`Login.jsx`, up to 1000 characters). The app-wide setting
`signupReason` (Settings → Admin, listed under Sign-ups only while they need approval; no `.env`
fallback) makes it `optional` (the default) or `required`; `/api/config` says which. Both
`/initiateregister` (before any keys are made) and `/finaliseregister` take `reason` and refuse
with 400 `code: 'reason_required'` / `'reason_too_long'` (`checkSignup`). A working invite skips
the question as it skips the wait (nothing is kept). The answer goes in the request's row,
`signup_requests` (`addRequest`, in the transaction that makes the account), and admins see it
under the name in Sign-up requests.

**History of requests** (2026-10-22): `signup_requests` outlives the decision: approving or
declining sets `status` ('approved' / 'declined'), `decided_at` and `decided_by` (the admin), and
a declined row loses its `user_id` (the account is gone) but keeps the name and answer. Settings →
Admin's Show history (`RequestHistory` in `AdminSettings.jsx`; `GET /admin/requests/history`,
newest decision first, 50 a page, `?before=<decided_at>:<id>`) lists them, each deletable
(`DELETE /admin/requests/history/:id`). Decisions over a year old are forgotten (`pruneHistory`,
daily and on every listing). A withdrawn request leaves nothing (the person asked for it all to
go), and deleting an account later takes its row with it (`accounts.js`). Migration 18 gave
accounts already waiting a row. The privacy policy says all this.

App invites (`app_invites`) are made by admins only (Settings → Admin → Invites; `POST
/admin/invites { maxAge, maxUses }`, `DELETE /admin/invites/:code`), shared as
`<origin>/join/<code>` (App.jsx's `/join/:code` opens sign-up with the code filled in; the form
also takes a pasted link, `authService` `inviteCode`). Only the use count is kept, not who used
an invite.

**Pending accounts** can log in (their keys are made and backed up as for anyone), but
`authenticateJWT` refuses them everywhere (403 `code: 'pending'`) except the routes that use
`authenticatePending`: `GET /profile` (with `pending: true`), devices and logout, the key backup,
password and recovery code changes, and deleting the account. So voice and call tokens, guilds,
DMs, applications (bots) and uploads are all closed to them without each route checking. They're
also hidden from everyone else: left out of `/dms-list`, and treated as unknown by `/dm-send`,
calls, group adds and mention previews; an admin can't make them admin. Their websocket waits in
`pendingClients` (`sockets.js`): no presence, no broadcasts (which would leak who's here), until
approved, when `account_approved` is sent and the same socket joins `clients`. The client shows
only `PendingApproval.jsx` while `user.pending` (whatever the address): it opens the app on
`account_approved`, or when a check of `/profile` every minute says so.

Admins see the requests in Settings → Admin (`GET /admin` `requests`, with each one's `reason`), and get `signup_requests
{ count }` on their sockets when one comes or is dealt with (the panel reloads). Approving is
`POST /admin/requests/:id/approve`; declining (`DELETE /admin/requests/:id`) removes the account
altogether, not as a "Deleted User" tombstone (it can't have written anything; the request stays
in the history, above): the row, its
sessions, push subscriptions and login state; its sockets get `account_deleted` and are closed,
so the app logs out, and the name is free again. Withdrawing a request (the waiting page, a
password proof through `DELETE /account`) does the same.

## Terms of use

People accept the terms of use (voicaw.com/terms/) before posting anything, as Google Play's
user-content rule wants (`server/terms.js`, 2026-10-05):
- **Registering** needs the tick under the form ("I agree to the terms of use and I'm 13 or
  over", `Login.jsx`): `/finaliseregister` takes `acceptedTerms`, which must be the current
  `TERMS_VERSION` (from `/api/config` `termsVersion`), else 400 `code: 'terms'` (an app too old
  to send it can't register until it updates).
- **Each account keeps** the version it accepted and when (`users.terms_version`,
  `terms_accepted_at`). `/profile`, `/finaliselogin` and `/recover/finish` say
  `termsAccepted`; when it's false (accounts from before the terms, or since they changed) `App`
  shows `TermsGate.jsx` instead of everything else: the terms and privacy links, the same tick,
  "Agree and continue" (`POST /terms/accept { version }`, 409 if they changed meanwhile) or Log
  out. It's the app that stops people, not the API (an old app version doesn't know to ask).
- **Changing the terms in substance:** change `website/src/legal/terms.html`, its date in
  `website/build.mjs` `LEGAL`, and `TERMS_VERSION` to the same date (a test checks they match):
  everyone is asked again. Bots never accept anything: they're their owners'.

## Deleting an account

Settings → Delete account (`DeleteAccountSettings.jsx`, `authService` `deleteAccount`), like
Discord's: the person goes, what they wrote stays under "Deleted User".
- **Server** (`server/accounts.js`, `DELETE /api/account` in `routes/auth.js`, with a login
  proof of the password like change-password): `checkDeletion` checks everything first, so a
  refusal doesn't use up the proof. Guilds you own block it (409 `code: 'owns_guilds'` with
  `guilds`; `GET /account/owned-guilds`) unless `deleteOwnedGuilds: true`, which deletes them
  (`guilds.js` `deleteGuild`). Group DMs: only you can sign leaving, so the client signs a
  `leave` entry for every group (`groupKeys.js` `leaveEntry`) and sends `groupLeaves: { groupId:
  entry }`; each is checked with `checkEntry` (missing or stale: 409 `groups_changed`, the client
  signs again). Then: calls and voice ended, their bot applications deleted (`bots.js`
  `deleteApplication`: out of every guild, tokens dead, the bot users kept as deleted
  accounts), the leaves stored (a group left empty is deleted),
  notes deleted (with their reactions and poll timers), unread counts, push subscriptions, GIF
  favourites and mentions of them deleted, every other guild left (`removeMember`), the picture
  removed, `user_profile` to everyone, `account_deleted` to their sockets, which are closed.
- **The `users` row stays as a tombstone** (messages, reactions and group logs point at it):
  `deleted_at` set, username `Deleted-User-<id>` (sign-ups are lower case, so nobody can take
  it, and the old name is free), display name "Deleted User", password, key backups, recovery
  code, profile and admin cleared. The public keys stay, so contacts can still open the DMs
  they had. `verifyToken` refuses deleted accounts (every request and socket identify looks
  them up), `findUserByName` skips them, `/dm-send` and calls to them are 404, and a group can't
  add them. `/dms-list` only lists them to people who had a conversation with them, with
  `deleted_at`; the client's profile store keeps it (`isDeleted`), so their DM is read-only (no
  composer, no call button) and the group pickers leave them out.
- Guild messages, DMs and group messages they sent, and their reactions, are kept (the server
  can't delete what others' devices already decrypted anyway).

## End-to-end encryption

The goal is that a server admin can't read messages, including by swapping keys. All crypto is
WebCrypto, in `client/src/services/encryptionService.js`. Every format is versioned: messages
are `v1.<base64>`, key backups are `{v:1,...}`, and derivations/signatures are bound to
`voicaw/<purpose>/v1` strings.
- **Keys per user** (`generateUserKeys`): an **identity** key (ECDSA P-256) that *is* the user
  (safety numbers come from it), and an **encryption** key (ECDH P-256) for DMs, signed by the
  identity key (`verifyEncryptionKey`). Public keys are base64 raw points in `users.identity_key` /
  `encryption_key` / `encryption_key_signature`. The server checks the signature at registration.
  Future per-device or group keys should also be signed by the identity key, so safety numbers
  don't change.
- **Key backup:** both private keys are stored server-side only inside `users.key_backup`,
  encrypted (`wrapKeyBackup`, HKDF → AES-GCM) with OPAQUE's `exportKey`. That is argon2id-stretched,
  stable across logins, and never seen by the server. There is no PBKDF2 and no second password
  derivation. The backup also contains the public keys. On login (`services/authService.js`) the client refuses
  to continue if the server publishes different ones. Changing the password re-encrypts it on the
  device (the current password is needed to open it; device keys are non-extractable).
- **Recovery code** (the only way back from a forgotten password; there's no email or admin
  reset): 25 random Crockford base32 characters (125 bits, `generateRecoveryCode`, shown as five
  groups; `normalizeRecoveryCode` accepts lower case, spaces, O/I/L). Made at registration and
  shown once (`RecoveryCodeDisplay`), or (re)made in Settings (`AccountSecuritySettings`, needs the
  password; `PUT /api/recovery-code` with a login proof; the old code stops working). HKDF from
  the code gives a key for a second backup (`users.recovery_backup`, `wrapRecoveryBackup`) and an
  auth value; the server stores only its SHA-256 (`recovery_verifier`). "Forgot password?" on the
  login page: `POST /api/recover/start {userIdentifier, recoveryAuth}` returns the recovery backup
  (unknown user, no code and wrong code all get the same 401), the client opens it and checks the
  published public keys (`startRecovery`, changing nothing). A used code is replaced (it may have
  been seen while typed): the app makes a new one and shows it (`RecoveryCodeDisplay`), and only
  once the user says they've kept it registers the new password and sends `POST
  /api/recover/finish` (auth again, new record + backup, and the new code's `recoveryVerifier` +
  `recoveryBackup`, written in one transaction), which logs in. Closing the page before then
  changes nothing: the old password and code keep working. The server refuses a finish without a
  new code (400 `new_recovery_code_required`, apps from before this) or with the same one. Rate
  limited per IP and username. The code is generated on the device. `hasRecoveryCode` comes with login/profile.
  Logging in to an account without one (made before codes existed) shows a new code first and
  stores it (`saveRecoveryCode`, a second login proof with the password just typed) only once the
  user confirms they've kept it; closing the page stores nothing, so the next login asks again.
  Sessions restored without a login get `RecoveryPrompt` (dismissible banner in the DM view). Without a code, a forgotten password means the history
  is lost, by design.
- **On the device** (`keyStore.js`): non-extractable private `CryptoKey`s plus the user's *own*
  public keys (from the backup, never from the server) in IndexedDB. `clearUserKeys` runs on
  logout.
- **Contacts** (`contactKeys.js`, IndexedDB, per logged-in account): trust on first use. Never
  use a contact key straight from the server. `checkContactKeys` verifies the signature, pins the
  identity key, and returns `'changed'` (the conversation is blocked until the user accepts,
  `ContactKeyWarning`) or `'invalid'`. Users compare 60-digit safety numbers (`safetyNumber.js`,
  `SafetyNumberDialog`) and can mark contacts verified. That badge and dialog show only with
  Settings → Privacy's "Show safety numbers in DMs" (`safetyNumbers` in `utils/privacy.js`, per
  device, off by default since 2026-10-17: too confusing for non-technical users; it was hidden
  for everyone before); the pinning and the key-changed block apply either way. A DM push also
  goes through `checkContactKeys` with the sender's published keys it carries (`senderKeys`,
  2026-11-19), so a device that never opened the chat pins them as opening it would and can
  show the text (see Push notifications in `docs/realtime.md`). Safety numbers
  come from public keys, so they aren't secret: comparing them catches a swapped key, not
  changed app code (the server delivering the web app's code stays the gap).
- **DMs:** `deriveConversationKey` (ECDH → HKDF → AES-GCM) uses the *pinned* contact key.
  `encryptMessage`/`decryptMessage` take `dmContext(senderId, recipientId)` as AES-GCM additional
  data, so the server can't re-attribute or move messages. Replies and edits use the original
  message's sender/recipient.
- **Message headers** (2026-11-19, after the security audit): binding to the two people alone
  let the server deliver an old message again as a new one, show a message as another's edit, or
  point a reply at a different message. DMs and notes are now `v2.` envelopes
  (`encryptDmMessage`/`openDmMessage`, the version in the additional data too), group messages
  `v3.` (`docs/group-dms.md`): the text follows a one-line JSON header made by the sender, `{ id
  (12 random bytes), at (their clock, Unix seconds), r (the replied-to message's id), e (the
  edited message's id, null for an original) }`. The reader checks it against the row
  (`messageMisplaced`): `r` must be the row's reply, `e` the row's own id exactly when it's edited,
  and `at` within 15 minutes of the server's time (the send's, the edit's, or now for a live
  edit); a header id seen on another row already shown (`markRepeatedMessages`) is a copy. A
  message that fails shows its text with "⚠ out of place" (not hidden: the words are still the
  sender's, and a device with a wrong clock would otherwise lose its messages). Older envelopes
  (`v1.`) are still read, unchecked; apps from before this can't read `v2.` messages until
  updated. What it can't catch: the server undoing an edit by serving the original (with the
  edited flag cleared), or a copy within 15 minutes when the first isn't loaded. The server leaves
  `MESSAGE_HEADER_BYTES` (160) for the header in its length limits. Link previews, reactions and
  call keys keep their own formats.
- **Reactions** (`dm_reactions`): the emoji is encrypted (`encryptReaction`) with the conversation
  key, zero-padded to `REACTION_PLAINTEXT_BYTES` (512, room for a 110-character answer added to
  an open poll, see Polls in `messages.md`) so every envelope is 723 chars (the server rejects any
  other length, except older apps' 383, 256 bytes from before answers were 110 characters, and
  127, 64 bytes from before open polls) and its size doesn't reveal whether
  it's an emoji, a vote or an added answer. `reactionContext(messageId,
  reactorId, senderId, recipientId)` is the additional data, so a reaction can't be moved or
  re-attributed. Which message was reacted to, by whom and when is deliberately visible, like reply
  links: hiding it would mean syncing every reaction in a conversation on each device (the server
  couldn't look them up per message). `GET /api/dm-messages` returns each message's `reactions`
  (`withReactions`); `POST /api/dm-reactions` / `DELETE /api/dm-reactions/:id` (own only, max 50
  per person per message, enough for a poll's votes and added answers) push `reaction_add` / `reaction_remove`. Deleting a message deletes its
  reactions. Reacting notifies the message's author only in the desktop and Android apps, which
  open the reaction and drop poll votes (see Reaction notifications in `docs/realtime.md`).
- **Notes** (`/dm/notes`, `Notes.jsx`): a DM to yourself (`direct_messages` with sender =
  recipient), first under the Direct Messages header in `DmSidebar`, with a line between it and
  the conversations, not scrolling with them (you aren't in `/dms-list`). The
  key is `deriveNotesKey`: ECDH of your own private and public encryption keys, HKDF with
  `voicaw/notes-key/v1` (so it's never a DM key), with your public key from `keyStore`, never
  the server. `useConversation({ notes: true })` skips the contact key check and marking
  read; the server never counts notes unread or pushes them, and sends each event once.
  Replies, edits, reactions, attachments and pins work as in any DM.
- **Spellcheck dictionary** (the words you Add to Dictionary; `client/src/spellcheck/
  personalDictionary.js`, `server/dictionary.js`): one envelope per account in
  `users.dictionary`, `v1.` AES-GCM like a message, under `deriveDictionaryKey` (ECDH of your own
  key pair, HKDF with `voicaw/dictionary-key/v1`, like notes but never the notes key) with
  `voicaw/dictionary/v1|<user id>` as additional data, so it can't be moved to another account.
  The plaintext is `{"v":1,"words":[…]}` padded with spaces to 1 KiB steps (48 KiB at most;
  the server takes envelopes up to 70,000 characters), so the server only learns roughly how
  many words. `GET /dictionary` → `{ dictionary, version }`; `PUT /dictionary { dictionary,
  version }` saves only over the version it was made from (else 409 with the current one: the
  device decrypts it, makes its change again on top and saves again), bumps the version and
  sends `dictionary` to your devices. A change shows at once and is saved in the background;
  loaded at login and after a reconnect, forgotten on logout. Deleting the account clears it.
- **Emoji usage** (the picker's Frequently Used, the quick reactions and the skin tone;
  `client/src/emoji/emojiUsage.js`, `server/emojiUsage.js`): per account, not per device, and
  encrypted, since which emoji you use says something about what you write in encrypted chats.
  The same scheme as the dictionary (`server/ownEnvelopes.js`): one envelope in
  `users.emoji_usage`, under `deriveEmojiUsageKey` (HKDF with `voicaw/emoji-usage-key/v1`) with
  `voicaw/emoji-usage/v1|<user id>` as additional data. The plaintext is
  `{"v":1,"counts":{"<emoji id>":uses},"reactions":{"<emoji id>":reactions added},"tone":0-5}`
  (custom emoji as `custom:<id>`; no `tone` until one is chosen) padded to exactly 8 KiB, the
  least used left out to fit (`reactions` keeps its top 64), so the server learns nothing from
  its size. `counts` is every use (picker, `:shortcode:`s, reactions) for Frequently Used;
  `reactions` is only reactions added (from anywhere, documents too) for the quick reactions, so
  emoji put in messages never reach those, and the defaults fill in until you've reacted enough
  (counting apart began 2026-11-06, with nothing carried over: `counts` can't tell which were
  reactions). A save from an app older than that drops `reactions`. `GET /emoji-usage` → `{ emojiUsage, version }`, `PUT
  /emoji-usage { emojiUsage, version }` with the dictionary's 409 on a stale version, and the
  `emoji_usage` event to your devices. A use counts at once and is saved 2 s later (one save
  for a burst; also when the page is hidden), so the server sees a save soon after you've used
  an emoji, not which. Before 2026-10-08 both were in localStorage (`emojiFrequent`,
  `emojiSkinTone`): at the next login on that device they're added to the account (the
  account's tone wins if it has one) and removed. In memory only, forgotten on logout; deleting
  the account clears it.

Never log plaintext, session keys, tokens or `OPAQUE_SERVER_SETUP`; server logs end up in pm2.
The server stores and relays only ciphertext. Message length limits (`MAX_MESSAGE_LENGTH`
server-side, `/api/config` client-side) are computed on the envelope length via
`getMaxEncryptedLength` (`v1.` + base64 of IV + ciphertext + tag).
