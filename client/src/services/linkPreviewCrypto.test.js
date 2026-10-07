import { describe, it, expect, beforeAll } from 'vitest';
import { generateUserKeys, importIdentityPrivateKey } from './encryptionService';
import { generateGroupKey, importGroupKey } from './groupCrypto';
import {
  checkedEmbed, dmPreviewsContext, groupPreviewsContext, groupPreviewsSignatureContext,
  openDmPreviews, openGroupPreviews, sealDmPreviews, sealGroupPreviews,
} from './linkPreviewCrypto';

const TEXT = 'look https://clips.test/a and https://news.test/b';
const CLIP = { type: 'video', url: 'https://clips.test/a', title: 'Clip', video: { url: 'https://cdn.test/a.mp4', width: 480, height: 270 }, image: { url: 'https://cdn.test/a.jpg' } };
const NEWS = { type: 'article', url: 'https://news.test/b', title: 'News', description: 'Something happened', color: 0xff8800, provider: { name: 'News' } };

let dmKey;
beforeAll(async () => {
  dmKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
});

describe('DM link previews', () => {
  const context = dmPreviewsContext(7, 1, 2);

  it('open for the message they were made for', async () => {
    const envelope = await sealDmPreviews([CLIP, NEWS], 'v1.message', dmKey, context);
    expect(envelope.startsWith('v1.')).toBe(true);
    expect(await openDmPreviews(envelope, 'v1.message', TEXT, dmKey, context)).toEqual([CLIP, NEWS]);
  });

  it("don't open on another message, after an edit or with another key", async () => {
    const envelope = await sealDmPreviews([CLIP], 'v1.message', dmKey, context);
    expect(await openDmPreviews(envelope, 'v1.message', TEXT, dmKey, dmPreviewsContext(8, 1, 2))).toBeNull();
    expect(await openDmPreviews(envelope, 'v1.edited', TEXT, dmKey, context)).toBeNull();
    const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    expect(await openDmPreviews(envelope, 'v1.message', TEXT, other, context)).toBeNull();
    expect(await openDmPreviews('v1.garbage', 'v1.message', TEXT, dmKey, context)).toBeNull();
  });

  it('only show previews for links in the text', async () => {
    const envelope = await sealDmPreviews([CLIP, { ...NEWS, url: 'https://elsewhere.test/' }], 'v1.message', dmKey, context);
    expect(await openDmPreviews(envelope, 'v1.message', TEXT, dmKey, context)).toEqual([CLIP]);
    expect(await openDmPreviews(envelope, 'v1.message', 'no links now', dmKey, context)).toBeNull();
  });

  it('keep as many as fit', async () => {
    const big = { ...NEWS, description: 'x'.repeat(350), title: 'y'.repeat(256) };
    const many = Array.from({ length: 30 }, (_, i) => ({ ...big, url: `https://news.test/${i}` }));
    const envelope = await sealDmPreviews(many, 'v1.message', dmKey, context);
    const text = many.map((e) => e.url).join(' ');
    expect((await openDmPreviews(envelope, 'v1.message', text, dmKey, context)).length).toBe(5);
    expect(await sealDmPreviews([], 'v1.message', dmKey, context)).toBeNull();
  });
});

describe('checkedEmbed', () => {
  it('keeps only what an embed may have', () => {
    expect(checkedEmbed({ ...NEWS, extra: 'x', provider: { name: 'News', url: 'javascript:alert(1)' } })).toEqual(NEWS);
    expect(checkedEmbed({ type: 'link', url: 'https://x.test/', title: 'T', image: { url: 'javascript:alert(1)' }, color: -1 }))
      .toEqual({ type: 'link', url: 'https://x.test/', title: 'T' });
    expect(checkedEmbed({ type: 'link', url: 'javascript:alert(1)', title: 'T' })).toBeNull();
    expect(checkedEmbed({ type: 'rich', url: 'https://x.test/', title: 'T' })).toBeNull();
    expect(checkedEmbed({ type: 'link', url: 'https://x.test/' })).toBeNull();
  });
});

describe('group link previews', () => {
  let ann;
  let bea;
  let epochKey;
  const at = ['group-1', 3, 42, 1];
  beforeAll(async () => {
    const make = async () => {
      const keys = await generateUserKeys();
      return { keys, sign: await importIdentityPrivateKey(keys.private.identityKey) };
    };
    ann = await make();
    bea = await make();
    epochKey = await importGroupKey(generateGroupKey());
  });

  it("open only when signed by the message's sender", async () => {
    const envelope = await sealGroupPreviews([CLIP], 'v2.message', epochKey, groupPreviewsContext(...at), ann.sign, groupPreviewsSignatureContext(...at));
    const open = (identityKey, content = 'v2.message', ctx = at) => openGroupPreviews(
      envelope, content, TEXT, epochKey, groupPreviewsContext(...ctx), identityKey, groupPreviewsSignatureContext(...ctx)
    );
    expect(await open(ann.keys.public.identityKey)).toEqual([CLIP]);
    expect(await open(bea.keys.public.identityKey)).toBeNull();
    expect(await open(null)).toBeNull();
    expect(await open(ann.keys.public.identityKey, 'v2.edited')).toBeNull();
    expect(await open(ann.keys.public.identityKey, 'v2.message', ['group-1', 3, 43, 1])).toBeNull();
  });
});
