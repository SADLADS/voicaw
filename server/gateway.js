const crypto = require('crypto');
const zlib = require('zlib');
const WebSocket = require('ws');
const db = require('./db');
const { clients, refreshStatus, getStatus } = require('./sockets');
const { getGuildLayout } = require('./guilds');
const bots = require('./bots');
const D = require('./discord');

// The bot gateway: Discord's (https://discord.com/developers/docs/events/gateway) at
// wss://<api>/api/gateway (GET /gateway/bot says where), so Discord's libraries connect to it
// unchanged. docs/bots.md.
// - Hello, Identify, Heartbeat, Resume (sessions wait RESUME_MS after a dropped connection,
//   keeping what happened meanwhile), Presence Update, Request Guild Members; JSON only, with
//   or without zlib-stream compression. Intents choose which events come; none is privileged
//   (members, presences and message content need no approval).
// - Each session is one of the bot's "sockets" in sockets.js `clients`, so it hears whatever the
//   app's sockets would (everything about its guilds, only channels it can see), and turns those
//   events into Discord's. Guild changes come as a whole new guild (`guild_update`): the session
//   keeps what it last sent of each guild and sends the differences (CHANNEL_*, GUILD_ROLE_*,
//   GUILD_UPDATE).

const OP = {
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, PRESENCE_UPDATE: 3, VOICE_STATE_UPDATE: 4, RESUME: 6,
  RECONNECT: 7, REQUEST_GUILD_MEMBERS: 8, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11,
};
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MODERATION: 1 << 2,
  GUILD_EXPRESSIONS: 1 << 3,
  GUILD_INTEGRATIONS: 1 << 4,
  GUILD_WEBHOOKS: 1 << 5,
  GUILD_INVITES: 1 << 6,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15,
  GUILD_SCHEDULED_EVENTS: 1 << 16,
  AUTO_MODERATION_CONFIGURATION: 1 << 20,
  AUTO_MODERATION_EXECUTION: 1 << 21,
  GUILD_MESSAGE_POLLS: 1 << 24,
  DIRECT_MESSAGE_POLLS: 1 << 25,
};
const ALL_INTENTS = Object.values(INTENTS).reduce((all, bit) => all | bit, 0);

const HEARTBEAT_MS = 41250;
const IDENTIFY_TIMEOUT_MS = 30000;
const RESUME_MS = 2 * 60 * 1000;
const BUFFER_SIZE = 1000; // events kept for resuming
const MAX_SESSIONS_PER_BOT = 16;
const MAX_SENDS_PER_MINUTE = 120; // from the bot, as in Discord
const MEMBER_CHUNK = 1000;

const sessions = new Map(); // session id -> Session

// Discord's shard formula, on our ids.
const shardOf = (guildId, count) => Number((BigInt(guildId) >> 22n) % BigInt(count));

// Our statuses as Discord's (a phone is still "online").
const discordStatus = (status) => (status === 'mobile' ? 'online' : status);

function presenceObject(userId, guildId, status = getStatus(userId)) {
  const s = discordStatus(status);
  return {
    user: { id: String(userId) },
    guild_id: String(guildId),
    status: s,
    activities: [],
    client_status: s === 'offline' ? {} : { [status === 'mobile' ? 'mobile' : 'web']: s },
  };
}

class Session {
  constructor(bot, { intents, shard }) {
    this.id = crypto.randomBytes(16).toString('hex');
    this.bot = bot;
    this.intents = intents;
    this.shard = shard;
    this.seq = 0;
    this.buffer = [];
    this.ws = null;
    this.guilds = new Map(); // guild id -> what was last sent ({ guild, roles, channels, threads })
    this.queue = Promise.resolve();
    this.closed = false;
    this.resumeTimer = null;
    // Our side: one of the bot's sockets in sockets.js (it hears the app's events).
    const session = this;
    this.socket = {
      get readyState() { return session.closed ? WebSocket.CLOSED : WebSocket.OPEN; },
      presence: { visible: false, mobile: false, activeUntil: Infinity, at: Date.now() },
      send(message) { session.enqueue(() => session.handleEvent(JSON.parse(message))); },
      close(code = 4000, reason = 'Session ended') { session.end(code, reason); },
    };
    sessions.set(this.id, this);
    const key = String(bot.id);
    clients.set(key, [...(clients.get(key) ?? []), this.socket]);
    refreshStatus(bot.id);
  }

  wants(intent) {
    return (this.intents & intent) === intent;
  }

  inShard(guildId) {
    return !this.shard || shardOf(guildId, this.shard[1]) === this.shard[0];
  }

  // Runs translations one at a time, so events go out in the order they happened.
  enqueue(fn) {
    this.queue = this.queue.then(fn).catch((err) => console.error('Gateway event failed:', err.message));
    return this.queue;
  }

  dispatch(t, d) {
    if (this.closed) return;
    const payload = { op: OP.DISPATCH, t, s: ++this.seq, d };
    this.buffer.push(payload);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
    this.ws?.sendPayload(payload);
  }

  attach(ws) {
    clearTimeout(this.resumeTimer);
    this.ws = ws;
    ws.session = this;
  }

  // The connection dropped: wait for a resume, or end.
  detach(ws, resumable) {
    if (this.ws !== ws) return;
    this.ws = null;
    if (!resumable) return this.end();
    this.resumeTimer = setTimeout(() => this.end(), RESUME_MS);
    this.resumeTimer.unref?.();
  }

  end(code = null, reason = '') {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.resumeTimer);
    sessions.delete(this.id);
    const key = String(this.bot.id);
    const rest = (clients.get(key) ?? []).filter((s) => s !== this.socket);
    if (rest.length) clients.set(key, rest);
    else clients.delete(key);
    refreshStatus(this.bot.id);
    if (this.ws && code) this.ws.close(code, reason);
    this.ws = null;
  }

  // ---- What the bot is told when it starts ----

  async ready(ws) {
    const user = await db.get(`SELECT ${D.USER_COLUMNS} FROM users u WHERE u.id = ?`, [this.bot.id]);
    const guildIds = (await bots.botGuildIds(this.bot.id)).filter((id) => this.inShard(id));
    this.dispatch('READY', {
      v: 10,
      user: { ...D.userObject(user), verified: true, mfa_enabled: false, email: null },
      guilds: guildIds.map((id) => ({ id: String(id), unavailable: true })),
      session_id: this.id,
      resume_gateway_url: ws.gatewayUrl,
      ...(this.shard ? { shard: this.shard } : {}),
      application: { id: String(this.bot.id), flags: 0 },
      private_channels: [],
      relationships: [],
      presences: [],
      guild_join_requests: [],
      geo_ordered_rtc_regions: [],
      auth: {},
      user_settings: {},
      session_type: 'normal',
    });
    for (const guildId of guildIds) await this.guildCreate(guildId);
  }

  // The guild as the bot sees it now: fields, roles, channels and threads (by id).
  async snapshot(guildId) {
    const { guildObject, guildChannels, channelOf } = require('./routes/botApi');
    const guild = await guildObject(guildId);
    const channels = await guildChannels(guildId, this.bot.id);
    const layout = await getGuildLayout(guildId, this.bot.id);
    const threads = [];
    for (const thread of layout?.threads ?? []) threads.push(await channelOf({ ...thread, type: 'thread' }));
    const { roles, emojis, ...fields } = guild;
    return { guild, fields, roles: new Map(roles.map((r) => [r.id, r])), emojis, channels: new Map(channels.map((c) => [c.id, c])), threads };
  }

  async guildCreate(guildId) {
    const snap = await this.snapshot(guildId);
    this.guilds.set(guildId, snap);
    if (!this.wants(INTENTS.GUILDS)) return;
    const members = await D.guildMembers(guildId, { limit: 100000 });
    const me = await db.get('SELECT joined_at FROM guild_members WHERE guild_id = ? AND user_id = ?', [guildId, this.bot.id]);
    this.dispatch('GUILD_CREATE', {
      ...snap.guild,
      joined_at: D.iso(me?.joined_at),
      large: false,
      unavailable: false,
      member_count: members.length,
      members,
      channels: [...snap.channels.values()],
      threads: snap.threads,
      presences: this.wants(INTENTS.GUILD_PRESENCES)
        ? members.filter((m) => getStatus(m.user.id) !== 'offline').map((m) => presenceObject(m.user.id, guildId))
        : [],
      // Who's in the voice channels it can see (voice.js).
      voice_states: [...snap.channels.values()].filter((c) => c.type === D.CHANNEL_TYPES.voice)
        .flatMap((c) => require('./voice').membersOf(Number(c.id))
          .map((state) => D.voiceStateObject({ guildId, channelId: c.id, userId: state.user_id, state }))),
      stage_instances: [],
      guild_scheduled_events: await this.scheduledEvents(guildId),
      soundboard_sounds: [],
    });
  }

  // A guild changed: send what's different from last time.
  async guildChanged(guildId) {
    const before = this.guilds.get(guildId);
    if (!before) return this.guildCreate(guildId);
    const after = await this.snapshot(guildId);
    this.guilds.set(guildId, after);
    if (!this.wants(INTENTS.GUILDS)) return;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const g = String(guildId);
    for (const [id, role] of after.roles) {
      if (!before.roles.has(id)) this.dispatch('GUILD_ROLE_CREATE', { guild_id: g, role });
      else if (!same(before.roles.get(id), role)) this.dispatch('GUILD_ROLE_UPDATE', { guild_id: g, role });
    }
    for (const id of before.roles.keys()) if (!after.roles.has(id)) this.dispatch('GUILD_ROLE_DELETE', { guild_id: g, role_id: id });
    for (const [id, channel] of after.channels) {
      if (!before.channels.has(id)) this.dispatch('CHANNEL_CREATE', channel);
      else if (!same(before.channels.get(id), { ...channel, last_message_id: before.channels.get(id).last_message_id })) {
        this.dispatch('CHANNEL_UPDATE', channel);
      }
    }
    for (const [id, channel] of before.channels) if (!after.channels.has(id)) this.dispatch('CHANNEL_DELETE', channel);
    if (!same(before.fields, after.fields)) this.dispatch('GUILD_UPDATE', after.guild);
  }

  // ---- The app's events, as Discord's ----

  async handleEvent(event) {
    const guildId = event.guildId ?? event.guild?.id;
    if (guildId != null && !this.inShard(guildId)) return;
    const g = guildId != null ? String(guildId) : null;
    switch (event.type) {
      case 'guild_add':
        return this.guildCreate(guildId);
      case 'guild_update':
        return this.guildChanged(guildId);
      case 'guild_remove':
        this.guilds.delete(guildId);
        if (this.wants(INTENTS.GUILDS)) this.dispatch('GUILD_DELETE', { id: g });
        return;
      case 'guild_emojis_update':
        if (this.wants(INTENTS.GUILD_EXPRESSIONS)) this.dispatch('GUILD_EMOJIS_UPDATE', { guild_id: g, emojis: event.emojis.map(D.emojiObject) });
        return;
      case 'guild_member_add': {
        if (event.member.id === this.bot.id || !this.wants(INTENTS.GUILD_MEMBERS)) return;
        const [member] = await D.guildMembers(guildId, { userIds: [event.member.id] });
        if (member) this.dispatch('GUILD_MEMBER_ADD', { ...member, guild_id: g });
        return;
      }
      case 'guild_member_remove': {
        if (!this.wants(INTENTS.GUILD_MEMBERS)) return;
        const user = await db.get(`SELECT ${D.USER_COLUMNS} FROM users u WHERE u.id = ?`, [event.userId]);
        if (user) this.dispatch('GUILD_MEMBER_REMOVE', { guild_id: g, user: D.userObject(user) });
        return;
      }
      case 'guild_member_update':
        return this.memberUpdate(guildId, event.userId);
      case 'user_profile':
        return this.profileChanged(event.user);
      case 'user_status':
        return this.statusChanged(Number(event.userId), event.status);
      case 'guild_message_new':
        return this.messageEvent('MESSAGE_CREATE', guildId, event.message.id);
      case 'guild_message_edit':
      case 'guild_message_embeds':
        return this.messageEvent('MESSAGE_UPDATE', guildId, event.messageId);
      case 'guild_message_delete':
        if (this.wants(INTENTS.GUILD_MESSAGES)) {
          this.dispatch('MESSAGE_DELETE', { id: String(event.messageId), channel_id: String(event.channelId), guild_id: g });
        }
        return;
      case 'guild_message_pin':
        if (this.wants(INTENTS.GUILDS)) {
          const last = await db.get('SELECT MAX(pinned_at) AS at FROM guild_messages WHERE channel_id = ?', [event.channelId]);
          this.dispatch('CHANNEL_PINS_UPDATE', { guild_id: g, channel_id: String(event.channelId), last_pin_timestamp: D.iso(last?.at) });
        }
        return;
      case 'guild_reaction_add':
        return this.reactionEvent('MESSAGE_REACTION_ADD', g, event.channelId, event.reaction.message_id, event.reaction.user_id, event.reaction.emoji);
      case 'guild_reaction_remove':
        return this.reactionEvent('MESSAGE_REACTION_REMOVE', g, event.channelId, event.messageId, event.userId, event.emoji);
      case 'guild_thread_update':
        return this.threadEvent(guildId, event.thread);
      case 'guild_thread_delete':
        if (this.wants(INTENTS.GUILDS)) {
          this.dispatch('THREAD_DELETE', { id: String(event.threadId), guild_id: g, parent_id: String(event.channelId), type: D.CHANNEL_TYPES.thread });
        }
        return;
      case 'typing':
        return this.typingEvent(event);
      case 'guild_voice_state':
        return this.voiceStateEvent(guildId, event);
      case 'guild_event_create':
      case 'guild_event_update':
      case 'guild_event_delete':
        return this.scheduledEventEvent(event);
      case 'guild_event_interest':
        if (this.wants(INTENTS.GUILD_SCHEDULED_EVENTS)) {
          this.dispatch(event.interested ? 'GUILD_SCHEDULED_EVENT_USER_ADD' : 'GUILD_SCHEDULED_EVENT_USER_REMOVE', {
            guild_scheduled_event_id: String(event.eventId), user_id: String(event.userId), guild_id: g,
          });
        }
        return;
      default:
        // Everything else (DMs never reach a bot; reading state, mutes...) has no Discord event.
    }
  }

  async memberUpdate(guildId, userId) {
    if (!this.wants(INTENTS.GUILD_MEMBERS) && userId !== this.bot.id) return;
    const [member] = await D.guildMembers(guildId, { userIds: [userId] });
    if (member) this.dispatch('GUILD_MEMBER_UPDATE', { ...member, guild_id: String(guildId) });
  }

  // Someone's name or picture changed: in each guild shared with them (the bot itself: USER_UPDATE).
  async profileChanged(user) {
    if (!user) return;
    if (user.id === this.bot.id) {
      const row = await db.get(`SELECT ${D.USER_COLUMNS} FROM users u WHERE u.id = ?`, [user.id]);
      this.dispatch('USER_UPDATE', D.userObject(row));
    }
    for (const guildId of await this.sharedGuilds(user.id)) await this.memberUpdate(guildId, user.id);
  }

  async statusChanged(userId, status) {
    if (!this.wants(INTENTS.GUILD_PRESENCES)) return;
    for (const guildId of await this.sharedGuilds(userId)) this.dispatch('PRESENCE_UPDATE', presenceObject(userId, guildId, status));
  }

  async sharedGuilds(userId) {
    const rows = await db.all(
      'SELECT a.guild_id FROM guild_members a JOIN guild_members b ON a.guild_id = b.guild_id WHERE a.user_id = ? AND b.user_id = ?',
      [this.bot.id, userId]
    );
    return rows.map((r) => r.guild_id).filter((id) => this.inShard(id));
  }

  async messageEvent(t, guildId, messageId) {
    if (!this.wants(INTENTS.GUILD_MESSAGES)) return;
    const { MESSAGE_SELECT, withReactions } = require('./routes/guildMessages');
    const row = await db.get(
      `${MESSAGE_SELECT} JOIN guild_channels c ON c.id = m.channel_id WHERE m.id = ? AND m.document_id IS NULL AND c.type IN ('text', 'thread', 'voice')`,
      [messageId]
    );
    if (!row) return;
    const [message] = await D.messageObjects(await withReactions([row]), { botId: this.bot.id, guildId });
    this.dispatch(t, message);
  }

  async reactionEvent(t, guildId, channelId, messageId, userId, emoji) {
    if (!this.wants(INTENTS.GUILD_MESSAGE_REACTIONS) || userId == null || !emoji) return;
    const author = await db.get('SELECT sender_id, webhook_id FROM guild_messages WHERE id = ?', [messageId]);
    const data = {
      user_id: String(userId),
      channel_id: String(channelId),
      message_id: String(messageId),
      guild_id: guildId,
      emoji: D.reactionEmoji(emoji),
      burst: false,
      type: 0,
    };
    if (t === 'MESSAGE_REACTION_ADD') {
      const [member] = await D.guildMembers(Number(guildId), { userIds: [userId] });
      if (member) data.member = member;
      if (author) data.message_author_id = String(author.webhook_id ?? author.sender_id);
      data.burst_colors = [];
    }
    this.dispatch(t, data);
  }

  async threadEvent(guildId, thread) {
    const snap = this.guilds.get(guildId);
    if (!snap || !this.wants(INTENTS.GUILDS)) return;
    const { channelOf } = require('./routes/botApi');
    const object = await channelOf({ ...thread, type: 'thread' });
    const known = snap.threads.some((t) => t.id === object.id);
    snap.threads = [...snap.threads.filter((t) => t.id !== object.id), object];
    this.dispatch(known ? 'THREAD_UPDATE' : 'THREAD_CREATE', known ? object : { ...object, newly_created: true });
  }

  async typingEvent(event) {
    if (!this.wants(INTENTS.GUILD_MESSAGE_TYPING)) return;
    const [, id] = /^channel-(\d+)$/.exec(event.chatId ?? '') ?? [];
    if (!id) return;
    const channel = await db.get('SELECT id, guild_id FROM guild_channels WHERE id = ?', [Number(id)]);
    if (!channel || !this.inShard(channel.guild_id)) return;
    const [member] = await D.guildMembers(channel.guild_id, { userIds: [event.userId] });
    this.dispatch('TYPING_START', {
      channel_id: String(channel.id),
      guild_id: String(channel.guild_id),
      user_id: String(event.userId),
      timestamp: Math.floor(Date.now() / 1000),
      ...(member ? { member } : {}),
    });
  }

  // The guild's scheduled events the bot can see (GUILD_CREATE).
  async scheduledEvents(guildId) {
    const member = await require('./guilds').getMember(guildId, this.bot.id);
    if (!member) return [];
    const { scheduledEventOf } = require('./routes/botApi');
    const events = [];
    for (const event of await require('./guildEvents').listEvents(member)) events.push(await scheduledEventOf(event));
    return events;
  }

  async scheduledEventEvent(event) {
    if (!this.wants(INTENTS.GUILD_SCHEDULED_EVENTS)) return;
    const { scheduledEventOf } = require('./routes/botApi');
    const t = { guild_event_create: 'GUILD_SCHEDULED_EVENT_CREATE', guild_event_update: 'GUILD_SCHEDULED_EVENT_UPDATE', guild_event_delete: 'GUILD_SCHEDULED_EVENT_DELETE' }[event.type];
    this.dispatch(t, await scheduledEventOf(event.event));
  }

  async voiceStateEvent(guildId, event) {
    if (!this.wants(INTENTS.GUILD_VOICE_STATES)) return;
    const [member] = await D.guildMembers(guildId, { userIds: [event.userId] });
    this.dispatch('VOICE_STATE_UPDATE', D.voiceStateObject({ guildId, channelId: event.channelId, userId: event.userId, state: event.state, member }));
  }

  // ---- What the bot asks for ----

  setPresence(d) {
    const status = d?.status ?? 'online';
    // Online and Do Not Disturb show as online; Invisible as offline.
    this.socket.presence = {
      ...this.socket.presence,
      activeUntil: status === 'idle' ? 0 : Infinity,
      invisible: status === 'invisible' || status === 'offline',
      at: Date.now(),
    };
    refreshStatus(this.bot.id);
  }

  async requestMembers(d) {
    const guildIds = (Array.isArray(d?.guild_id) ? d.guild_id : [d?.guild_id]).map((id) => D.ourId(id)).filter((id) => id != null);
    for (const guildId of guildIds) {
      if (!this.guilds.has(guildId)) continue;
      const max = Number(d.limit) > 0 ? Number(d.limit) : 100000;
      let members;
      let notFound = [];
      if (Array.isArray(d.user_ids)) {
        const ids = d.user_ids.map((id) => D.ourId(id)).filter((id) => id != null).slice(0, 100);
        members = await D.guildMembers(guildId, { userIds: ids });
        const found = new Set(members.map((m) => m.user.id));
        notFound = ids.map(String).filter((id) => !found.has(id));
      } else {
        members = await D.guildMembers(guildId, { query: d.query || null, limit: d.query ? Math.min(max, 100) : max });
      }
      const count = Math.max(1, Math.ceil(members.length / MEMBER_CHUNK));
      for (let i = 0; i < count; i++) {
        const chunk = members.slice(i * MEMBER_CHUNK, (i + 1) * MEMBER_CHUNK);
        this.dispatch('GUILD_MEMBERS_CHUNK', {
          guild_id: String(guildId),
          members: chunk,
          chunk_index: i,
          chunk_count: count,
          ...(i === 0 && notFound.length ? { not_found: notFound } : {}),
          ...(d.presences ? { presences: chunk.filter((m) => getStatus(m.user.id) !== 'offline').map((m) => presenceObject(m.user.id, guildId)) } : {}),
          ...(d.nonce != null ? { nonce: String(d.nonce).slice(0, 32) } : {}),
        });
      }
    }
  }
}

// ---- Connections ----

// A connection's sending, as text or (zlib-stream) one deflate stream flushed per message.
function setUpSending(ws, compress) {
  if (!compress) {
    ws.sendPayload = (payload) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };
    return;
  }
  const deflate = zlib.createDeflate({ chunkSize: 65536 });
  const chunks = [];
  deflate.on('data', (chunk) => chunks.push(chunk));
  let sending = Promise.resolve();
  ws.sendPayload = (payload) => {
    sending = sending.then(() => new Promise((resolve) => {
      deflate.write(JSON.stringify(payload));
      deflate.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        const data = Buffer.concat(chunks.splice(0));
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
        resolve();
      });
    }));
  };
  ws.on('close', () => deflate.close());
}

function onConnection(ws, req) {
  const url = new URL(req.url, 'http://localhost');
  const encoding = url.searchParams.get('encoding') ?? 'json';
  const compress = url.searchParams.get('compress');
  const host = req.headers.host ?? '';
  const secure = req.headers['x-forwarded-proto'] === 'https' || !/^(localhost|127\.|\[::1\])/.test(host);
  ws.gatewayUrl = `${secure ? 'wss' : 'ws'}://${host}/api/gateway`;
  setUpSending(ws, compress === 'zlib-stream');
  if (encoding !== 'json') return ws.close(4002, 'Only JSON encoding is supported.');
  if (compress && compress !== 'zlib-stream') return ws.close(4002, 'Unsupported compression.');

  let lastHeartbeat = Date.now();
  let sent = [];
  ws.sendPayload({ op: OP.HELLO, d: { heartbeat_interval: HEARTBEAT_MS } });
  const identifyTimer = setTimeout(() => { if (!ws.session) ws.close(4003, 'Not authenticated.'); }, IDENTIFY_TIMEOUT_MS);
  const heartbeatCheck = setInterval(() => {
    if (Date.now() - lastHeartbeat > HEARTBEAT_MS * 1.5 + 5000) ws.close(4009, 'Session timed out.');
  }, HEARTBEAT_MS);

  ws.on('message', async (raw) => {
    const t = Date.now();
    sent = sent.filter((at) => t - at < 60000);
    sent.push(t);
    if (sent.length > MAX_SENDS_PER_MINUTE) return ws.close(4008, 'Rate limited.');
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return ws.close(4002, 'Error while decoding payload.');
    }
    const { op, d } = payload ?? {};
    try {
      switch (op) {
        case OP.HEARTBEAT:
          lastHeartbeat = Date.now();
          return ws.sendPayload({ op: OP.HEARTBEAT_ACK });
        case OP.IDENTIFY:
          return await identify(ws, d);
        case OP.RESUME:
          return await resume(ws, d);
        case OP.PRESENCE_UPDATE:
          if (!ws.session) return ws.close(4003, 'Not authenticated.');
          return ws.session.setPresence(d);
        case OP.REQUEST_GUILD_MEMBERS:
          if (!ws.session) return ws.close(4003, 'Not authenticated.');
          return ws.session.enqueue(() => ws.session.requestMembers(d));
        case OP.VOICE_STATE_UPDATE:
          // Voice is LiveKit's, not Discord's: bots can't join voice channels (yet).
          return;
        default:
          return ws.close(4001, 'Unknown opcode.');
      }
    } catch (err) {
      console.error('Gateway message failed:', err.message);
      ws.close(4000, 'Unknown error.');
    }
  });

  ws.on('close', (code) => {
    clearTimeout(identifyTimer);
    clearInterval(heartbeatCheck);
    // A clean close (1000/1001) ends the session, as in Discord; anything else can be resumed.
    ws.session?.detach(ws, code !== 1000 && code !== 1001);
  });
  ws.on('error', (err) => console.error('Gateway socket error:', err.message));
}

async function identify(ws, d) {
  if (ws.session) return ws.close(4005, 'Already authenticated.');
  const bot = await bots.botForToken(d?.token);
  if (!bot) return ws.close(4004, 'Authentication failed.');
  const intents = Number(d?.intents);
  if (!Number.isSafeInteger(intents) || intents < 0 || (intents & ~ALL_INTENTS)) return ws.close(4013, 'Invalid intent(s).');
  let shard = null;
  if (d.shard != null) {
    const [id, count] = Array.isArray(d.shard) ? d.shard.map(Number) : [];
    if (!Number.isInteger(id) || !Number.isInteger(count) || count < 1 || id < 0 || id >= count) return ws.close(4010, 'Invalid shard.');
    shard = [id, count];
  }
  if ([...sessions.values()].filter((s) => s.bot.id === bot.id).length >= MAX_SESSIONS_PER_BOT) {
    return ws.close(4008, 'Rate limited.');
  }
  if (ws.readyState !== WebSocket.OPEN) return;
  const session = new Session(bot, { intents, shard });
  session.attach(ws);
  if (d.presence) session.setPresence(d.presence);
  await session.enqueue(() => session.ready(ws));
}

async function resume(ws, d) {
  if (ws.session) return ws.close(4005, 'Already authenticated.');
  const session = sessions.get(String(d?.session_id ?? ''));
  const bot = await bots.botForToken(d?.token);
  const seq = Number(d?.seq);
  const oldest = session?.buffer[0]?.s ?? (session ? session.seq + 1 : 0);
  if (!session || !bot || bot.id !== session.bot.id || !Number.isInteger(seq) || seq < oldest - 1 || seq > session.seq) {
    return ws.sendPayload({ op: OP.INVALID_SESSION, d: false });
  }
  // Another connection still has it: that one goes.
  if (session.ws && session.ws !== ws) {
    const old = session.ws;
    session.ws = null;
    old.close(4000, 'Session resumed elsewhere.');
  }
  session.attach(ws);
  for (const payload of session.buffer) if (payload.s > seq) ws.sendPayload(payload);
  session.dispatch('RESUMED', {});
}

// Sends INTERACTION_CREATE (no intent needed) to one session of bot `botId` that has guild
// `guildId` (its shard), preferring one that's connected. Returns whether any had it.
function deliverInteraction(botId, guildId, payload) {
  const candidates = [...sessions.values()].filter((s) => s.bot.id === botId && !s.closed && s.inShard(guildId));
  const session = candidates.find((s) => s.ws) ?? candidates[0];
  if (!session) return false;
  session.dispatch('INTERACTION_CREATE', payload);
  return true;
}

// Ends every session of bot `botId` (its token was reset, or it was deleted).
function closeBotSessions(botId, code, reason) {
  for (const session of [...sessions.values()]) if (session.bot.id === botId) session.end(code, reason);
}

// The gateway's websocket server; sockets.js hands it upgrades to /api/gateway.
function createGatewayServer() {
  const wss = new WebSocket.Server({ noServer: true });
  wss.on('connection', onConnection);
  return wss;
}

module.exports = { OP, INTENTS, createGatewayServer, closeBotSessions, deliverInteraction, sessions };
