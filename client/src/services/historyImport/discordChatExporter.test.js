import { describe, it, expect } from 'vitest';
import { downloadable, isExport, parseExport } from './discordChatExporter';

// A made-up export in the exporter's own shape (as its real files are).
const person = (id, name, nickname, extra = {}) => ({ id, name, discriminator: '0000', nickname, color: null, isBot: false, avatarUrl: `https://cdn.example/avatars/${id}.png`, ...extra });
const otto = person('100', 'ottoondisc', 'otto', { avatarUrl: 'export.json_Files/otto-ab12.png' });
const cj = person('200', 'weecj', 'CJ');
const joel = person('300', 'joel_x', 'Joel');
const bot = person('400', 'botto', 'Botto', { isBot: true });
const base = (id, author, timestamp, extra = {}) => ({
  id, type: 'Default', timestamp, timestampEdited: null, callEndedTimestamp: null, isPinned: false, content: '',
  author, attachments: [], embeds: [], stickers: [], reactions: [], mentions: [], inlineEmojis: [], ...extra,
});

const EXPORT = {
  guild: { id: '1', name: 'Old Crew' },
  channel: { id: '9', type: 'GuildTextChat', categoryId: '8', category: 'public', name: 'general', topic: null },
  messages: [
    base('1002', otto, '2024-06-20T19:45:46.251+01:00', {
      content: 'hey @CJ and @Joel, not @Jo :ooohhhhh:',
      mentions: [cj, joel],
      inlineEmojis: [{ id: '777', name: 'ooohhhhh', code: 'ooohhhhh', isAnimated: false, imageUrl: 'https://cdn.example/emojis/777.png' }],
      timestampEdited: '2024-06-20T19:50:00.000+01:00',
      isPinned: true,
      reactions: [
        { emoji: { id: '', name: '🤠', code: 'cowboy' }, count: 1, users: [cj] },
        { emoji: { id: '555', name: 'antiverified', code: 'antiverified' }, count: 1, users: [joel] },
      ],
    }),
    base('1001', cj, '2024-06-20T19:40:00.000+01:00', {
      content: 'https://www.youtube.com/watch?v=abc',
      embeds: [{ title: 'A video', url: 'https://www.youtube.com/watch?v=abc', description: 'x', images: [], fields: [] }],
      attachments: [
        { id: 'a1', url: 'https://cdn.example/attachments/9/1/image0.gif?ex=1&is=2', fileName: 'image0.gif', fileSizeBytes: 324843 },
        { id: 'a2', url: 'export.json_Files/cat%20pic-5F3A.png', fileName: 'cat pic.png', fileSizeBytes: 1234 },
      ],
    }),
    base('1003', cj, '2024-06-20T20:00:00.000+01:00', { type: 'Reply', content: 'yes', reference: { type: 'Default', messageId: '1002', channelId: '9' } }),
    base('1004', bot, '2024-06-20T20:01:00.000+01:00', {
      type: '20', content: "Harry's score is 8",
      interaction: { id: 'i1', name: 'score', user: otto },
      embeds: [{ title: 'Score', description: 'eight', color: '#FF0000', fields: [{ name: 'Total', value: '8', isInline: true }], images: [] }],
    }),
    base('1005', joel, '2024-06-20T20:02:00.000+01:00', {
      forwardedMessage: { timestamp: '2024-01-01T00:00:00.000+00:00', content: 'old news', attachments: [], embeds: [], stickers: [] },
      reference: { type: 'Forward', messageId: '55', channelId: '66' },
    }),
    base('1006', joel, '2024-06-20T20:03:00.000+01:00'), // the poll itself: exported empty
    base('1007', joel, '2024-06-20T21:03:00.000+01:00', {
      type: '46',
      reference: { type: 'Default', messageId: '1006', channelId: '9' },
      embeds: [{ fields: [
        { name: 'poll_question_text', value: 'Jackbox on Saturday?' },
        { name: 'victor_answer_votes', value: '4' },
        { name: 'total_votes', value: '5' },
        { name: 'victor_answer_text', value: 'Yes' },
      ] }],
    }),
    base('1008', joel, '2024-06-20T21:04:00.000+01:00', { type: 'GuildMemberJoin' }),
  ],
};

const pollText = ({ question, answer, votes, total }) => `POLL ${question} ${answer} ${votes}/${total}`;
const parse = () => parseExport(EXPORT, 'old/export.json', { pollText });

describe('DiscordChatExporter exports', () => {
  it('recognises one', () => {
    expect(isExport(EXPORT)).toBe(true);
    expect(isExport({ messages: [] })).toBe(false);
  });

  it('reads the channel and its messages oldest first, leaving out system messages', () => {
    const { guildName, channel, messages, skipped } = parse();
    expect(guildName).toBe('Old Crew');
    expect(channel).toEqual({ sourceId: '9', name: 'general', category: 'public', thread: false });
    expect(messages.map((m) => m.sourceId)).toEqual(['1001', '1002', '1003', '1004', '1005', '1006', '1007']);
    expect(skipped).toEqual({ system: 1 });
  });

  it('makes mentions and custom emoji tokens the server maps, longest names first', () => {
    const m = parse().messages.find((x) => x.sourceId === '1002');
    expect(m.content).toBe('hey <@200> and <@300>, not @Jo <:ooohhhhh:777>');
    expect(m.pinned).toBe(true);
    expect(m.editedTimestamp).toBe(Date.parse('2024-06-20T19:50:00.000+01:00'));
    expect(m.reactions).toEqual([
      { emoji: '🤠', count: 1, userSourceIds: ['200'] },
      { customName: 'antiverified', customId: '555', count: 1, userSourceIds: ['300'] },
    ]);
  });

  it('keeps media files by their path, and links elsewhere as not included; drops link previews', () => {
    const m = parse().messages.find((x) => x.sourceId === '1001');
    expect(m.attachments).toEqual([
      { filename: 'image0.gif', size: 324843, mediaPath: null, remoteUrl: null, expired: false },
      { filename: 'cat pic.png', size: 1234, mediaPath: 'old/export.json_Files/cat pic-5F3A.png', remoteUrl: null, expired: false },
    ]);
    expect(m.embeds).toEqual([]);
  });

  it('keeps replies, commands (with who ran them), bots\' rich embeds and forwards', () => {
    const { messages, authors } = parse();
    expect(messages.find((x) => x.sourceId === '1003').replyToSourceId).toBe('1002');
    const answer = messages.find((x) => x.sourceId === '1004');
    expect(answer.interaction).toEqual({ name: 'score', userSourceId: '100' });
    expect(answer.embeds).toEqual([expect.objectContaining({ title: 'Score', description: 'eight', color: 0xff0000, fields: [{ name: 'Total', value: '8', inline: true }] })]);
    const forward = messages.find((x) => x.sourceId === '1005');
    expect(forward.content).toBe(`fwd:v1:{"t":${Date.parse('2024-01-01T00:00:00Z') / 1000}}\nold news`);
    expect(forward.replyToSourceId).toBeUndefined();
    expect(authors.get('100')).toMatchObject({ name: 'otto', names: ['ottoondisc', 'otto'], avatarPath: 'old/export.json_Files/otto-ab12.png', messageCount: 1 });
    expect(authors.get('400')).toMatchObject({ isBot: true, avatarPath: null });
  });

  it("writes a poll's question into its empty message, and its result as text", () => {
    const { messages } = parse();
    expect(messages.find((x) => x.sourceId === '1006').content).toBe('📊 Jackbox on Saturday?');
    const result = messages.find((x) => x.sourceId === '1007');
    expect(result.content).toBe('POLL Jackbox on Saturday? Yes 4/5');
    expect(result.replyToSourceId).toBeUndefined();
  });

  it('lists the custom emoji used in messages and reactions, with their pictures', () => {
    const { emojis } = parse();
    expect([...emojis.values()]).toEqual([
      { sourceId: '777', name: 'ooohhhhh', animated: false, imagePath: null, imageUrl: null, uses: 1 },
      { sourceId: '555', name: 'antiverified', animated: false, imagePath: null, imageUrl: null, uses: 1 },
    ]);
    const withPictures = parseExport({
      ...EXPORT,
      messages: [base('2001', otto, '2024-06-20T19:45:46Z', {
        content: ':wave: :wave:',
        inlineEmojis: [{ id: '42', name: 'wave', code: 'wave', isAnimated: true, imageUrl: 'https://cdn.discordapp.com/emojis/42.gif' }],
        reactions: [{ emoji: { id: '43', name: 'pog', code: 'pog', imageUrl: 'export.json_Files/43-AB.png' }, count: 3, users: [] }],
      })],
    }, 'old/export.json', { pollText });
    expect(withPictures.emojis.get('42')).toMatchObject({ animated: true, imageUrl: 'https://cdn.discordapp.com/emojis/42.gif', imagePath: null });
    expect(withPictures.emojis.get('43')).toMatchObject({ imagePath: 'old/export.json_Files/43-AB.png', imageUrl: null });
  });

  it("downloads only from the archive's CDN, and not attachments whose links have expired", () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    const hex = (iso) => Math.floor(Date.parse(iso) / 1000).toString(16);
    const attachment = (ex) => `https://cdn.discordapp.com/attachments/9/1/a.png?ex=${ex}&is=0&hm=ff`;
    expect(downloadable(attachment(hex('2026-11-20T00:00:00Z')), { now })).toEqual({ url: attachment(hex('2026-11-20T00:00:00Z')), expired: false });
    expect(downloadable(attachment(hex('2026-11-18T00:00:00Z')), { now })).toEqual({ url: null, expired: true });
    expect(downloadable('https://cdn.discordapp.com/attachments/9/1/a.png', { now })).toEqual({ url: null, expired: true });
    expect(downloadable('https://cdn.discordapp.com/avatars/1/abc.png', { now }).url).toBe('https://cdn.discordapp.com/avatars/1/abc.png');
    expect(downloadable('https://media.discordapp.net/stickers/5.png', { now }).url).toBe('https://media.discordapp.net/stickers/5.png');
    expect(downloadable('https://tracker.example/a.png', { now })).toEqual({ url: null, expired: false });
    expect(downloadable('http://cdn.discordapp.com/emojis/1.png', { now }).url).toBeNull();
    expect(downloadable('export.json_Files/a.png', { now }).url).toBeNull();
  });

  it('notes threads', () => {
    const thread = parseExport({ ...EXPORT, channel: { ...EXPORT.channel, type: 'GuildPublicThread', category: 'general' } }, 'x.json', { pollText });
    expect(thread.channel.thread).toBe(true);
  });
});
