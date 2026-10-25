// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./imageGallery', () => ({
  readyImageSrc: vi.fn(() => null),
  loadImageSrc: vi.fn(async (item) => (item.meta ? 'blob:decrypted' : item.src)),
}));
vi.mock('./saveFile', () => ({ saveUrlAs: vi.fn(), openInNewTab: vi.fn() }));

import { copyImage, imageAt, imageLink, imageMenuItems } from './imageActions';
import { openInNewTab, saveUrlAs } from './saveFile';

const plain = { src: 'https://static.klipy.com/cat.webp', name: 'GIF' };
const encrypted = { src: 'https://media.test/uploads/a.bin#v=1&k=KEY', name: 'photo.jpg', meta: { kind: 'image' } };
const labels = (items) => items.filter((i) => !i.separator).map((i) => i.label);

beforeEach(() => vi.clearAllMocks());

describe('picture menus', () => {
  it('offers the link of a plain picture, but never an encrypted attachment\'s (its key)', () => {
    expect(imageLink(plain)).toBe(plain.src);
    expect(imageLink(encrypted)).toBe(null);
    expect(labels(imageMenuItems(plain))).toEqual(['Copy Image', 'Save Image', 'Copy Link', 'Open Link']);
    expect(labels(imageMenuItems(encrypted))).toEqual(['Copy Image', 'Save Image', 'Open Image']);
  });

  it('offers no link for a picture on this device (an attachment being written)', () => {
    const local = { src: 'blob:http://localhost/1', name: 'photo.png' };
    expect(imageLink(local)).toBe(null);
    expect(labels(imageMenuItems(local))).toEqual(['Copy Image', 'Save Image', 'Open Image']);
  });

  it('saves and opens the decrypted copy of an encrypted picture, and copies and opens a plain one\'s link', async () => {
    const find = (items, label) => items.find((i) => i.label === label);
    await find(imageMenuItems(encrypted), 'Save Image').onSelect();
    expect(saveUrlAs).toHaveBeenCalledWith('blob:decrypted', 'photo.jpg');
    await find(imageMenuItems(encrypted), 'Open Image').onSelect();
    expect(openInNewTab).toHaveBeenCalledWith('blob:decrypted', 'photo.jpg');

    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await find(imageMenuItems(plain), 'Copy Link').onSelect();
    expect(writeText).toHaveBeenCalledWith(plain.src);
    find(imageMenuItems(plain), 'Open Link').onSelect();
    expect(openInNewTab).toHaveBeenCalledWith(plain.src);
  });

  it('copies a PNG to the clipboard, and says so when the browser can\'t', async () => {
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });
    const png = new Blob(['x'], { type: 'image/png' });
    globalThis.fetch = vi.fn(async () => ({ ok: true, blob: async () => png }));
    globalThis.ClipboardItem = class { constructor(data) { this.data = data; } };
    await copyImage(plain);
    const [[[item]]] = write.mock.calls;
    expect(await item.data['image/png']).toBe(png);
    expect(fetch).toHaveBeenCalledWith(plain.src, { referrerPolicy: 'no-referrer' });

    delete globalThis.ClipboardItem;
    await expect(copyImage(plain)).rejects.toThrow(/can't copy images/);
  });

  it('finds the picture under a right-click: attachments, embed and file images, not emoji or icons', () => {
    document.body.innerHTML = `
      <div class="dm-message-content"><img id="att" data-gallery-item=""><img id="emoji" class="emoji" src="/e.svg"></div>
      <div class="message-embeds"><img id="embed" src="https://site.test/pics/sun%20set.png"><img id="icon" class="embed-author-icon" src="https://site.test/i.png"></div>
      <div class="message-files"><a href="https://media.test/f.png"><img id="file" src="https://media.test/f.png" alt="f.png"></a></div>
      <div class="image-viewer"><img id="viewer" src="blob:x"></div>
      <img id="avatar" src="https://media.test/a.webp">`;
    const $ = (id) => document.getElementById(id);
    const registered = new Map([[$('att'), encrypted]]);
    const at = (id) => imageAt($(id), (el) => registered.get(el));
    expect(at('att')).toBe(encrypted);
    expect(at('embed')).toEqual({ src: 'https://site.test/pics/sun%20set.png', name: 'sun set.png' });
    expect(at('file')).toEqual({ src: 'https://media.test/f.png', name: 'f.png' });
    for (const id of ['emoji', 'icon', 'viewer', 'avatar']) expect(at(id), id).toBe(null);
  });
});
