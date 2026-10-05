import './helpers/mockS3.js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const http = require('http');
const zlib = require('zlib');
const app = require('../index.js');
const linkPreviews = require('../linkPreviews.js');
const { safeFetch, isPublicAddress } = require('../safeFetch.js');
const { PERMISSIONS: P } = require('../permissions.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'lp-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-previews-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  patch: (user, url, body = {}) => request(app).patch(`/api${url}`).set(authed(user)).send(body),
};

function connect(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), presence: { at: Date.now() } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

async function setUp() {
  const owner = await makeUser('lp-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Previews' })).body;
  const member = await makeUser('lp-member');
  const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
  await api.post(member, `/invites/${invite.body.code}`);
  return { owner, member, guild, general: guild.channels[0], everyone: guild.roles.find((r) => r.is_everyone) };
}

const messagesIn = async (user, channel) => (await api.get(user, `/channels/${channel.id}/messages`)).body;

describe('linksIn', () => {
  it('finds links, not in code, spoilers, <…> or images, without trailing punctuation', () => {
    const text = 'see https://a.test/x_(y), and (https://b.test/z). `https://c.test` <https://d.test> '
      + '||https://e.test|| ![g](https://f.test/g.gif) ```\nhttps://g.test\n``` https://a.test/x_(y) http://h.test/p?q=1!';
    expect(linkPreviews.linksIn(text)).toEqual(['https://a.test/x_(y)', 'https://b.test/z', 'http://h.test/p?q=1']);
  });

  it('keeps at most five', () => {
    const text = Array.from({ length: 8 }, (_, i) => `https://site${i}.test/`).join(' ');
    expect(linkPreviews.linksIn(text)).toHaveLength(5);
  });
});

describe('embedFromHtml', () => {
  it("reads a page's OpenGraph and Twitter card", () => {
    const html = `<!doctype html><html><head><title>Fallback</title>
      <meta property="og:title" content="A &amp; B &#x2014; news">
      <meta name="description" content="  Plain
        description ">
      <meta property="og:site_name" content='Example'>
      <meta property="og:image" content="/pic.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
      <meta name="twitter:card" content="summary_large_image">
      <meta name="theme-color" content="#f80">
      </head><body><meta property="og:title" content="not this"></body></html>`;
    expect(linkPreviews.embedFromHtml(html, 'https://example.test/a', 'https://www.example.test/a')).toEqual({
      type: 'link',
      url: 'https://example.test/a',
      title: 'A & B — news',
      description: 'Plain description',
      color: 0xff8800,
      provider: { name: 'Example' },
      image: { url: 'https://www.example.test/pic.png', width: 1200, height: 630 },
    });
  });

  it('uses <title> and a small picture by default, and a video file when there is one', () => {
    expect(linkPreviews.embedFromHtml('<title>Just a title</title><meta property="og:image" content="https://x.test/i.jpg">', 'https://x.test/', 'https://x.test/'))
      .toEqual({ type: 'link', url: 'https://x.test/', title: 'Just a title', thumbnail: { url: 'https://x.test/i.jpg' } });
    const video = linkPreviews.embedFromHtml(`<meta property="og:title" content="Clip"><meta property="og:video" content="https://x.test/v.mp4">
      <meta property="og:video:type" content="video/mp4"><meta property="og:image" content="javascript:alert(1)">`, 'https://x.test/v', 'https://x.test/v');
    expect(video).toEqual({ type: 'video', url: 'https://x.test/v', title: 'Clip', video: { url: 'https://x.test/v.mp4' } });
  });

  it('gives nothing for a page that says nothing', () => {
    expect(linkPreviews.embedFromHtml('<html><body>hi</body></html>', 'https://x.test/', 'https://x.test/')).toBeNull();
  });

  it('cuts long text', () => {
    const embed = linkPreviews.embedFromHtml(`<meta name="description" content="${'word '.repeat(200)}">`, 'https://x.test/', 'https://x.test/');
    expect(embed.description.length).toBe(350);
    expect(embed.description.endsWith('…')).toBe(true);
  });
});

describe('safeFetch', () => {
  let server;
  let base;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') return res.writeHead(302, { Location: '/page' }).end();
      if (req.url === '/to-private') return res.writeHead(302, { Location: 'http://127.0.0.1:1/x' }).end();
      if (req.url === '/gzip') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip' });
        return res.end(zlib.gzipSync('<title>Zipped</title>'));
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('x'.repeat(100000));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=ISO-8859-1' });
      res.end('<title>Page</title>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => server.close());
  afterEach(() => {
    delete process.env.LINK_PREVIEWS_ALLOW_PRIVATE;
  });

  it('refuses private, loopback and link-local addresses, other ports and other schemes', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
    for (const url of [`${base}/page`, 'http://127.0.0.1/', 'http://2130706433/', 'http://[::1]/', 'http://localhost/', 'ftp://example.test/']) {
      await expect(safeFetch(url), url).rejects.toThrow();
    }
  });

  it('reads pages (redirects, compression, a size limit) where allowed', async () => {
    process.env.LINK_PREVIEWS_ALLOW_PRIVATE = '1';
    const page = await safeFetch(`${base}/redirect`);
    expect(page).toMatchObject({ url: `${base}/page`, status: 200, contentType: 'text/html', charset: 'iso-8859-1' });
    expect(page.body.toString()).toBe('<title>Page</title>');
    expect((await safeFetch(`${base}/gzip`)).body.toString()).toBe('<title>Zipped</title>');
    const big = await safeFetch(`${base}/big`, { maxBytes: 1000 });
    expect(big.body.length).toBe(1000);
    expect(big.truncated).toBe(true);
  });

  it('checks every redirect again', async () => {
    process.env.LINK_PREVIEWS_ALLOW_PRIVATE = '1';
    const first = safeFetch(`${base}/to-private`);
    // The redirect itself is read with the check lifted; the check then applies to where it goes.
    delete process.env.LINK_PREVIEWS_ALLOW_PRIVATE;
    await expect(first).rejects.toThrow();
  });
});

describe('link previews in guild messages', () => {
  const realFetch = linkPreviews.fetchPreview;
  const fetched = [];
  beforeAll(() => {
    process.env.LINK_PREVIEWS = 'on';
    linkPreviews.fetchPreview = async (link) => {
      fetched.push(link);
      if (link.includes('nothing')) return null;
      return { type: 'link', url: link, title: `Title of ${new URL(link).hostname}` };
    };
  });
  afterAll(() => {
    process.env.LINK_PREVIEWS = 'off';
    linkPreviews.fetchPreview = realFetch;
  });
  afterEach(() => {
    fetched.length = 0;
    linkPreviews.clearCache();
  });

  it('adds previews after a message is sent and tells the channel', async () => {
    const { owner, member, guild, general } = await setUp();
    const events = connect(member);
    const sent = await api.post(owner, `/channels/${general.id}/messages`, { content: 'look https://one.test/a and https://nothing.test/' });
    expect(sent.status).toBe(201);
    expect(sent.body.link_embeds).toEqual([]);
    await linkPreviews.settled();

    expect(fetched).toEqual(['https://one.test/a', 'https://nothing.test/']);
    const [message] = await messagesIn(member, general);
    expect(message.link_embeds).toEqual([{ type: 'link', url: 'https://one.test/a', title: 'Title of one.test' }]);
    expect(events).toContainEqual({
      type: 'guild_message_embeds',
      guildId: guild.id,
      channelId: general.id,
      messageId: sent.body.id,
      link_embeds: message.link_embeds,
    });
  });

  it('fetches again only when an edit changes the links', async () => {
    const { owner, general } = await setUp();
    const { id } = (await api.post(owner, `/channels/${general.id}/messages`, { content: 'https://two.test/' })).body;
    await linkPreviews.settled();
    fetched.length = 0;

    await api.put(owner, `/guild-messages/${id}`, { content: 'https://two.test/ (edited)' });
    await linkPreviews.settled();
    expect(fetched).toEqual([]);

    await api.put(owner, `/guild-messages/${id}`, { content: 'now <https://two.test/> and https://three.test/' });
    await linkPreviews.settled();
    expect((await messagesIn(owner, general))[0].link_embeds.map((e) => e.url)).toEqual(['https://three.test/']);

    await api.put(owner, `/guild-messages/${id}`, { content: 'no links' });
    await linkPreviews.settled();
    expect((await messagesIn(owner, general))[0].link_embeds).toEqual([]);
  });

  it('does nothing with Link previews off', async () => {
    const { owner, general } = await setUp();
    process.env.LINK_PREVIEWS = 'off';
    try {
      await api.post(owner, `/channels/${general.id}/messages`, { content: 'https://four.test/' });
      await linkPreviews.settled();
    } finally {
      process.env.LINK_PREVIEWS = 'on';
    }
    expect(fetched).toEqual([]);
  });

  it('lets the author or Manage Messages remove previews', async () => {
    const { owner, member, guild, general, everyone } = await setUp();
    const { id } = (await api.post(owner, `/channels/${general.id}/messages`, { content: 'https://five.test/' })).body;
    await linkPreviews.settled();
    const events = connect(owner);

    expect((await api.put(member, `/guild-messages/${id}/suppress-embeds`)).status).toBe(403);
    const removed = await api.put(owner, `/guild-messages/${id}/suppress-embeds`);
    expect(removed.body).toEqual({ success: true, messageId: id, flags: 4 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'guild_message_embeds', messageId: id, flags: 4 }));
    expect((await messagesIn(owner, general))[0].flags).toBe(4);

    const changed = await api.patch(owner, `/guilds/${guild.id}/roles/${everyone.id}`, { permissions: everyone.permissions | P.MANAGE_MESSAGES });
    expect(changed.status).toBe(200);
    expect((await api.put(member, `/guild-messages/${id}/suppress-embeds`, { suppress: false })).body.flags).toBe(0);
  });
});
