# Group DMs

## Group DMs

End-to-end encrypted chats of up to 10 people (`MAX_MEMBERS`), with calls (see DM calls). Anyone
in a group adds people; only the owner (the creator) removes them; anyone leaves; an owner who
leaves leaves the group without an owner (nobody can remove anyone then); the last one out
deletes it. The group name isn't encrypted (like guild names); messages, reactions, edits and
call keys are.
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
  to send one does (`currentEpoch` in `services/groupKeys.js`). The server only takes a message
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
  parent's own signed context; the parent is checked where it's shown). Not signed: the group
  call key (the caller's name comes from the server). DMs aren't signed on purpose: only the
  two people hold the key, so a message can only be from the other one, and unsigned messages
  stay deniable. Pushes say "New message from <name>" (no preview: the service worker has no
  epoch keys).
- **API** (`routes/groupDms.js`): `GET/POST /group-dms`, `GET /group-dms/:id` (summary, the
  whole log, everyone's public keys, your epoch keys, `latest_epoch`, the group's `call`),
  `PATCH` (rename), `POST /:id/log { entry, epoch? }`, `POST /:id/epochs`, `GET/POST
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
