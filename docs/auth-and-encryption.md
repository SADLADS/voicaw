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
  `checkLoginProof`) and the new record and re-encrypted backup. Other devices stay logged in.
- Recovery code: see End-to-end encryption.

**Usernames are lower case** and ignore capitals everywhere (login, recovery, making an admin;
`server/usernames.js` `findUserByName`). Signing up as "Alice" makes the username `alice` with
"Alice" as the display name. OPAQUE binds a record to the name it was registered under (the
server derives each account's OPRF key from it), so migration 5, which lower-cased existing
accounts (copying the old spelling into an empty display name), keeps that spelling in
`users.opaque_id` for `startLogin`; `/initiateregister` always uses the lower-case name, so a
password change or recovery clears it. An old account whose lower-case name was already taken
kept its capitals (an exact match wins at login).

Server-side login state is stored transiently in the `login_states` table (5-minute expiry) keyed
by (lower-case) username, cleaned up on successful login (expired rows are purged on each login attempt).

Logged-out visitors must not be able to tell which usernames exist. `/api/initiatelogin` answers an
unknown username with OPAQUE's dummy response (`registrationRecord: null`), so it fails at the end
exactly like a wrong password. Logged-in users can see every user (intentional: the app is for groups
where everyone knows each other). The client must never send its `clientLoginState` to the server.

Password guessing can only happen online (through the server), so `routes/auth.js` rate limits
it (`rateLimit.js`, in memory): login starts per IP (30 / 15 min) and per username (20 / 15 min,
applied whether or not the account exists; cleared by a successful login), registrations per IP,
recovery attempts per IP and username.
Refusals are 429 with `Retry-After` and a message the login form shows. `req.ip` comes from
nginx's `X-Forwarded-For` (`trust proxy: 'loopback'`). A local `npm run dev` goes through vite's
proxy to the public API, so everyone using one shares its address there. The websocket `user_status`
broadcast only goes to identified sockets.

On successful login/register/recovery, the server starts a login session and issues a JWT for
it (`startSession`, see `server/auth.js`), which the client stores in `localStorage` and sends
as `Authorization: Bearer <token>` (see `client/src/utils/api.js`). `authenticateJWT`
middleware protects all `/api/*` routes except config/login/register.
- **Sessions last while the app is used:** a token is good for 30 days (`SESSION_SECONDS`), and
  any authenticated request with one older than a day (`RENEW_AFTER_SECONDS`) gets a new one in
  the `X-Voicaw-Token` response header (exposed by CORS). `api.js` stores it, only if it renews
  the token that request was sent with (not after a logout or another login). So only a device
  unused for 30 days has to log in again.

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
- **Tokens from before sessions** (no `sid`) still work: on first use they become a session
  named after the token's hash (so the requests a device sends at once share one row) and are
  renewed with a `sid` straight away. Ending any session from Settings sets
  `users.sessions_reset_at`, which refuses the old tokens issued before it (devices not opened
  since sessions began then have to log in again) and deletes push subscriptions with no session.
- Changing the password still leaves other devices logged in (Settings → Devices logs them out).
- Deleting an account deletes its sessions.
- On start, `AuthProvider` only drops the session when `/profile` answers 401/403/404. With no
  answer (given up on after 10 s: a stuck or restarting API takes connections and never
  answers) or a server error (no network yet after boot, an API restart) it keeps the token and
  asks again every 3 s, while `App` shows "Can't reach Voicaw. Trying again…" with "Log out on
  this device" (unless the offline copy has the account's profile: then the app opens in
  offline mode, see Offline copy in `docs/messages.md`), which forgets the login here without the server (`forgetLogin`; the login is
  in `localStorage`, so clearing cookies doesn't). The session itself then stays on the server
  (Settings → Devices on another device ends it, or it expires).
- **Logging out** (`services/logout.js`, 2026-10-13) gives the server 5 s
  (`LOGOUT_SERVER_MS`) to turn off this device's notifications, hang up and end the session,
  then forgets the token, keys, group keys, the search and offline copies, drafts, sessionStorage
  and the account's own localStorage entries (`ACCOUNT_KEYS`: last channel per guild, collapsed
  categories and tasks; this device's settings stay) whether it answered or not (unanswered
  requests go on with the old token; every one of them names it, and `utils/api.js` keeps a
  token a request names, since by then the saved one may be a new login's). Contact pins
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
  Codes are also limited per account (10 / 15 min, `twoFactorPerUser`). The client keeps the
  login's exportKey in `logIn`'s closure meanwhile (`Login.jsx` asks for the code).
- **Recovery code:** resetting a forgotten password would otherwise get round it, so
  `/recover/start` says `twoFactor: true` and `/recover/finish` then needs `twoFactorCode` (401
  `two_factor_required` without one, before anything changes). The recovery form shows a code
  field once asked.
- **Turning off / new backup codes:** `POST /api/two-factor/disable` and `/two-factor/backup-codes`,
  each with a password proof and a code (or backup code). `GET /api/two-factor` says `{ enabled,
  backupCodesLeft }`. Changing the password, the recovery code and deleting the account still
  need only the password (as before), and turning it on doesn't log other devices out (Settings →
  Devices does).
- **Lost everything** (app and backup codes): an admin on the host runs `cd server && npm run
  admin -- <username> --remove-two-factor`. Deleting an account clears all three columns.
- Bots never log in with a password, so it doesn't apply to them.

## Sign-ups (open, invite only, approval)

Who can make an account is the app-wide setting `signupMode` (Settings → Admin; `SIGNUP_MODE`
in `server/.env` as the fallback, `open` when neither is set), handled by `server/signups.js`:
- **`open`**: anyone (as before). An invite sent along is ignored.
- **`invite`**: only with an app invite. `/initiateregister` with `signup: true` (only sign-ups
  send it: password changes and recovery use the same route) refuses without a working one
  (403 `code: 'invite_required'` / `'invalid_invite'`) before the client makes any keys;
  `/finaliseregister` checks again and uses the invite up in the transaction that makes the
  account.
- **`request`**: anyone, but the account is made with `users.pending = 1` until an admin approves
  it. A working invite skips the wait.

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

Admins see the requests in Settings → Admin (`GET /admin` `requests`), and get `signup_requests
{ count }` on their sockets when one comes or is dealt with (the panel reloads). Approving is
`POST /admin/requests/:id/approve`; declining (`DELETE /admin/requests/:id`) removes the account
altogether, not as a "Deleted User" tombstone (it can't have written anything): the row, its
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
  (unknown user, no code and wrong code all get the same 401), the client opens it, checks the
  published public keys, registers the new password and sends `POST /api/recover/finish` (auth
  again, new record + backup), which logs in. The code keeps working. Rate limited per IP and
  username. The code is generated on the device. `hasRecoveryCode` comes with login/profile.
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
  for everyone before); the pinning and the key-changed block apply either way. Safety numbers
  come from public keys, so they aren't secret: comparing them catches a swapped key, not
  changed app code (the server delivering the web app's code stays the gap).
- **DMs:** `deriveConversationKey` (ECDH → HKDF → AES-GCM) uses the *pinned* contact key.
  `encryptMessage`/`decryptMessage` take `dmContext(senderId, recipientId)` as AES-GCM additional
  data, so the server can't re-attribute or move messages. Replies and edits use the original
  message's sender/recipient.
- **Reactions** (`dm_reactions`): the emoji is encrypted (`encryptReaction`) with the conversation
  key, zero-padded to `REACTION_PLAINTEXT_BYTES` (256, room for an answer added to an open
  poll, see Polls in `messages.md`) so every envelope is 383 chars (the server rejects any other
  length, except 127: 64 bytes, from apps before open polls) and its size doesn't reveal whether
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
  `{"v":1,"counts":{"<emoji id>":uses},"tone":0-5}` (custom emoji as `custom:<id>`; no `tone`
  until one is chosen) padded to exactly 8 KiB, the least used left out to fit, so the server
  learns nothing from its size. `GET /emoji-usage` → `{ emojiUsage, version }`, `PUT
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
