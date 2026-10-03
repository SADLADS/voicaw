# Group DMs

## Group DMs

End-to-end encrypted chats of up to 10 people (`MAX_MEMBERS`), with calls (see DM calls). Anyone
in a group adds people; only the owner (the creator) removes them; anyone leaves; an owner who
leaves leaves the group without an owner (nobody can remove anyone then); the last one out
deletes it. Messages, reactions, edits, call keys and the group's name are encrypted (see Group
names).
- **Membership log** (`group_dm_log`): every change is a record (`makeRecord`: `{ v, group, seq,
  prev, type, actor, target, targetIdentityKey, at }`, JSON in a fixed order) that its author
  signs with their identity key (`voicaw/group-log/v1`); `prev` is the previous entry's hash, so
  it's a chain. Types: `create` (seq 0, the creator's own identity key), `add` (the added
  person's identity key), `remove` (owner only), `leave` (yourself). Group ids are UUIDs made by
  the creator. The server checks every record like a client would (sequence, chain, rules,
  identity key = the user's, signature) before storing it; clients check the whole log again
  (`verifyGroupLog` in `services/groupCrypto.js`), and each current member's log identity key
  against the key this device pinned for them (`checkContactKeys`, as for DMs). A mismatch
  blocks sending in the group (a changed key can be accepted, like in a DM; a key that doesn't
  match the log needs the person removed and re-added).
- **Epochs** (`group_dm_epochs`, `group_dm_epoch_keys`): a key period, for the members after log
  entry `log_seq`. Its key is 32 random bytes, wrapped for each member (`wrapGroupKey`: ECDH
  between the creator's and the member's encryption keys, HKDF `voicaw/group-key-wrap/v1`,
  bound to group, epoch, `log_seq`, creator and member). Clients only wrap for members from the
  checked log, with the encryption key their log identity key signed, and only open epochs whose
  creator was a member at `log_seq`. A new epoch is needed after every membership change; the
  person adding or removing makes it with the change, otherwise (after a leave) the next member
  to send one does (`currentEpoch` in `services/groupKeys.js`). An add must come with its epoch
  (400 without; if the epoch loses a race the add fails with 409 too, and is retried), so the
  person added can read the name. The server only takes a message
  for the newest epoch when that's for the current membership (else 409 `stale_epoch`), and only
  one epoch per number (the loser of a race gets 409 and uses the winner's).
- **Who reads what:** the server only returns messages (and reply previews) of epochs you have a
  key for, and unread counts only count those. So someone added never sees what was said before
  (they never get those keys), someone removed never gets new keys, and someone re-added keeps
  their old keys: they see the times they were a member, not the gap (decided 2026-09-30;
  "fresh start on rejoin" would be deleting their old `group_dm_epoch_keys` rows on re-add).
- **Messages** (`group_dm_messages`, `_reactions`, `_reads`): encrypted with the epoch key,
  additional data `groupMessageContext(groupId, epoch, senderId)` (reactions:
  `groupReactionContext(groupId, messageId, reactorId)`); edits keep the message's epoch.
- **Signed** (since 2026-09-30): everyone in a group has the epoch key, so messages, edits and
  reactions are also signed with the sender's identity key, or a member working with the server
  could post as someone else. The signature is inside the encryption (only members see it; the
  server learns nothing new): a `v2.` envelope, "v2." + base64(IV || AES-GCM(64-byte ECDSA
  signature || content)) (`encryptGroupMessage` / `encryptGroupReaction` in groupCrypto.js;
  reactions padded to 64 bytes, so every one is the same size). It covers
  `messageSignatureContext({ groupId, epoch, senderId, replyTo, editOf })` (so a reply can't be
  moved to another parent, nor an edit to another message) or `reactionSignatureContext`.
  `useGroupConversation` checks it against the sender's identity key from the checked log: a
  mismatch isn't shown ("⚠ unverified sender"), a reaction that doesn't match is dropped, and
  `v1.` messages from before signing show as "not signed" (a signature can't be told apart
  from one the server removed). The server takes only `v2.` for anything new (an older app gets
  "Please update the app"). A reply's preview isn't checked (the server doesn't send the
  parent's own signed context; the parent is checked where it's shown). Group call keys are
  signed the same way (since 2026-10-03, see Group calls in `voice-and-calls.md`). DMs aren't signed on purpose: only the
  two people hold the key, so a message can only be from the other one, and unsigned messages
  stay deniable. Pushes are decrypted on the device (see Group names).
- **API** (`routes/groupDms.js`): `GET/POST /group-dms`, `GET /group-dms/:id` (summary, the
  whole log, everyone's public keys, your epoch keys, `latest_epoch`, the group's `call`),
  `PATCH { name, epoch, version, initial? }` (rename), `POST /:id/log { entry, epoch }` (`epoch`
  optional for a remove or leave), `POST /:id/epochs`, `GET/POST
  /:id/messages`, `PUT/DELETE /group-dm-messages/:id` (author), `POST
  /group-dm-messages/:id/reactions`, `DELETE /group-dm-reactions/:id`, `POST /:id/read`,
  pins (see Pinned messages).
  Non-members get 404 for everything.
- **Client:** route `/dm/g/:groupId` (`group/GroupDm.jsx`: header with call and members
  buttons, `GroupCallPanel`, key warnings, `ChatPane`, `GroupMembers`: add people, remove
  (owner), rename, leave). `hooks/useGroupConversation.js` is `useConversation` for a group
  (decrypting with each message's epoch key; membership changes as `system` rows in the
  timeline, which `MessageList` draws as centred lines, from the time you joined).
  `hooks/useGroupList.js` (in `Layout`, `LayoutContext.groupList`) feeds `DmSidebar`, which
  mixes groups in with people by latest message and has the "New group" button
  (`group/NewGroupDialog.jsx`).

## Group names

End-to-end encrypted since 2026-10-02, like the messages (the server stored them in plaintext
before).
- **Format** (`groupCrypto.js`): the renamer signs a record `{ v, group, version, renamer, name,
  initial, at }` with their identity key (`voicaw/group-name-sig/v1`), padded with zeros to 512
  bytes so every name is the same size (`MAX_GROUP_NAME` 100 characters, control characters
  removed). It's encrypted with an epoch key, bound to group and epoch (`voicaw/group-name/v1`):
  "v1." + base64(IV || AES-GCM(signature || record)), always 811 characters (the server checks).
  `version` counts renames from 1 (the name given at creation, possibly '' for none, is version 1
  and `initial`). Clients check the group, and the signature against the renamer's identity key
  from the checked log.
- **Always under the latest epoch** (`group_dms.name_ciphertext`, `name_epoch`, `name_version`).
  Every new epoch (creation, add, remove, after a leave) carries the current name sealed again
  with the new key: the same signed record, so it stays the renamer's words. That needs whoever
  makes an epoch to read the name: only members holding the latest key make epochs, and adds
  always come with theirs, so every current member always has it. Someone added reads the name
  at once; someone removed keeps knowing the name they saw but not later ones. The server refuses
  an epoch without the name, or for an older version (409 if renamed meanwhile).
- **Renaming** (`renameGroup` in groupKeys.js): any member; first `currentEpoch` (so after a leave
  the leaver can't read the new name), then `PATCH` with version + 1. The server takes it only
  for the latest epoch of the current members and the next version (409 otherwise; retried).
  Each rename is also a row in the timeline (`group_dm_messages.system` = 'group_name', the
  same encrypted name as content, in its epoch: people added later don't see it, like any
  message): "Cal renamed the group to “Plans”." It can't be replied to, reacted to, pinned or
  deleted, and counts as unread like a message.
- **Rollback:** each device keeps the newest name it has seen (version) and ignores an older one
  the server sends.
- **Groups from before:** `name_version` 0, the plaintext `name`. The first member to open one
  (with no key problems) encrypts it (`initial: true`: no rename row) and the server clears the
  plaintext; until then epochs carry no name. Old apps get "Please update the app" for creating or
  renaming.
- **On the device** (`services/groupCache.js`, IndexedDB `voicaw-groups`): `openGroup` saves what
  it checked (epoch keys as non-extractable CryptoKeys, the log's identity keys, current members'
  names, the newest name). The conversation list (`useGroupList`) decrypts names with it
  (`groupNameOf`, opening the group when it lacks a key) and opens a group whenever it gets a
  new epoch, so it stays current while the app is open. Logging out forgets it; the private key
  next to it in `keyStore` opens every one of those keys anyway.
- **Notifications:** group message pushes carry the encrypted name (`nameCiphertext`,
  `nameEpoch`) and, when it fits (1800 characters), the signed message; call pushes the name.
  `pushNotifications.js` opens them with the saved keys (never a key from the push): the title is
  the name (or the members' names), the body "Ann: text" when previews are on and the signature
  is the sender's, otherwise "New message from Ann" (as for a group never opened on this device,
  or a key made while the app was closed). The desktop app does the same in the page.
