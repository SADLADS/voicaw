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

On successful login/register, the server issues a JWT (`generateToken`, see `server/auth.js`)
which the client stores in `localStorage` and sends as `Authorization: Bearer <token>` (see
`client/src/utils/api.js`). `authenticateJWT` middleware protects all `/api/*` routes except
config/login/register.
- **Sessions last while the app is used:** a token is good for 30 days (`SESSION_SECONDS`), and
  any authenticated request with one older than a day (`RENEW_AFTER_SECONDS`) gets a new one in
  the `X-Voicaw-Token` response header (exposed by CORS). `api.js` stores it, only if it renews
  the token that request was sent with (not after a logout or another login). So only a device
  unused for 30 days has to log in again. Tokens can't be revoked (logout just forgets it on
  the device); a server-side sessions table would be the way to add that.
- On start, `AuthProvider` only drops the session when `/profile` answers 401/403/404. With no
  answer or a server error (no network yet after boot, an API restart) it keeps the token and
  asks again every 3 s, while `App` shows "Can't reach Voicaw. Trying again…".

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
  signs again). Then: calls and voice ended, the leaves stored (a group left empty is deleted),
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
  `SafetyNumberDialog`) and can mark contacts verified. That badge and dialog are
  hidden for now (`SHOW_SAFETY_NUMBERS` in `Dm.jsx`: too confusing for non-technical users); the
  pinning and the key-changed block still apply.
- **DMs:** `deriveConversationKey` (ECDH → HKDF → AES-GCM) uses the *pinned* contact key.
  `encryptMessage`/`decryptMessage` take `dmContext(senderId, recipientId)` as AES-GCM additional
  data, so the server can't re-attribute or move messages. Replies and edits use the original
  message's sender/recipient.
- **Reactions** (`dm_reactions`): the emoji is encrypted (`encryptReaction`) with the conversation
  key, zero-padded to `REACTION_PLAINTEXT_BYTES` (64) so every envelope is 127 chars (the server
  rejects any other length) and its size doesn't reveal the emoji. `reactionContext(messageId,
  reactorId, senderId, recipientId)` is the additional data, so a reaction can't be moved or
  re-attributed. Which message was reacted to, by whom and when is deliberately visible, like reply
  links: hiding it would mean syncing every reaction in a conversation on each device (the server
  couldn't look them up per message). `GET /api/dm-messages` returns each message's `reactions`
  (`withReactions`); `POST /api/dm-reactions` / `DELETE /api/dm-reactions/:id` (own only, max 20
  per person per message) push `reaction_add` / `reaction_remove`. Deleting a message deletes its
  reactions. No push notifications for reactions.
- **Notes** (`/dm/notes`, `Notes.jsx`): a DM to yourself (`direct_messages` with sender =
  recipient), first under the Direct Messages header in `DmSidebar`, with a line between it and
  the conversations, not scrolling with them (you aren't in `/dms-list`). The
  key is `deriveNotesKey`: ECDH of your own private and public encryption keys, HKDF with
  `voicaw/notes-key/v1` (so it's never a DM key), with your public key from `keyStore`, never
  the server. `useConversation({ notes: true })` skips the contact key check and marking
  read; the server never counts notes unread or pushes them, and sends each event once.
  Replies, edits, reactions, attachments and pins work as in any DM.

Never log plaintext, session keys, tokens or `OPAQUE_SERVER_SETUP`; server logs end up in pm2.
The server stores and relays only ciphertext. Message length limits (`MAX_MESSAGE_LENGTH`
server-side, `/api/config` client-side) are computed on the envelope length via
`getMaxEncryptedLength` (`v1.` + base64 of IV + ciphertext + tag).
