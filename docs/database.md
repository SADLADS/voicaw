# Database

## Database

SQLite through Node's built-in `node:sqlite` (synchronous; it replaced the `sqlite3` package on
2026-09-30), single file `server/voicaw.db` (overridable with `DB_PATH`) in WAL mode (reads never
wait for a write; `voicaw.db-wal` / `-shm` sit next to it and belong with it). Plenty for this
app's size: SQLite takes thousands of writes a second, and the move to Postgres was considered and
dropped (2026-09-30) until there's a real need (several API processes). Foreign keys are not
enforced (they never were). The schema is created idempotently (`CREATE TABLE IF NOT EXISTS`) in
`server/db.js` on require, in order, before anything else runs (no ORM: a new column on an
existing table goes through `addColumn`, which ignores "duplicate column"). Changes to existing
data that must run exactly once are `MIGRATIONS` at the end of `db.js`, numbered with SQLite's
`PRAGMA user_version`, each in its own transaction (1: @everyone gets Connect and Speak; 2: clear
`users.last_online`, which had only ever held the sign-up time; 3: roles and channel overrides
that allow or deny Manage Messages do the same for Pin Messages; 4: index existing guild messages
for search; 5: lower-case usernames, see Auth; 6: `guild_channels`' type CHECK gains `'list'`
(the table is copied into a new one, keeping its id counter) and @everyone gets Edit Tasks; 7: @everyone gets Video, for
screen sharing; 8: the type CHECK gains `'doc'` (`allowEveryChannelType`, as 6 did) and @everyone gets
Create Documents); add the next one at the end.
- Queries: `db.get` / `db.all` / `db.run` return promises, as with the old driver (rows are plain
  objects; `undefined` binds as NULL, booleans as 1/0). Prepared statements are cached.
- **Transactions:** anything that writes more than one row (or one row that depends on another)
  goes in `await db.transaction(async () => { ... })`: its writes are all kept, or all undone if it
  throws. While one is open, other requests' queries wait (the transaction's own code is told
  apart with `AsyncLocalStorage`), so keep it to database work: no S3, LiveKit, pushes or socket
  sends inside. A nested call is a savepoint (a failure inside undoes only its own writes, so the
  outer one can catch it and carry on, as posting a group log entry does with its epoch).
- Guild tables are `guilds` plus `guild_*`. An earlier sketch left unused, empty tables in old databases
(`roles`, `user_roles`, `categories`, `channels`, `channel_permissions`, `messages`); nothing
creates or reads them any more, and they can be dropped.
