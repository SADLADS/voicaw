// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/android', () => ({ android: null, readMedia: vi.fn() }));
vi.mock('./toasts', () => ({ showErrorToast: vi.fn() }));

const { keyboardFileName, receiveKeyboardContent } = await import('./keyboardContent');
const { showErrorToast } = await import('./toasts');

describe('keyboardFileName', () => {
  it('adds the extension of its type when the name has none', () => {
    expect(keyboardFileName('tenor_123', 'image/gif')).toBe('tenor_123.gif');
    expect(keyboardFileName('', 'image/webp')).toBe('image.webp');
    expect(keyboardFileName(null, 'image/jpeg')).toBe('image.jpg');
    expect(keyboardFileName('x', 'image/heic')).toBe('x.heic');
  });

  it('keeps a name that has one', () => {
    expect(keyboardFileName('sticker.png', 'image/png')).toBe('sticker.png');
    expect(keyboardFileName('funny.gif', '')).toBe('funny.gif');
  });
});

describe('receiveKeyboardContent', () => {
  let box;
  const content = { id: '7', uri: 'content://keyboard/1', name: 'tenor', type: 'image/gif', size: 10 };
  const plugin = () => ({ releaseKeyboardContent: vi.fn(() => Promise.resolve()) });

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    box = document.createElement('div');
    box.contentEditable = 'true';
    box.tabIndex = 0;
    document.body.appendChild(box);
    box.focus();
  });

  it('reads the file, pastes it into the focused box and lets the keyboard go', async () => {
    const file = new File(['gif'], 'tenor.gif', { type: 'image/gif' });
    const read = vi.fn(async () => file);
    const paste = vi.fn(() => true);
    const native = plugin();
    expect(await receiveKeyboardContent(content, { plugin: native, read, paste })).toBe(true);
    expect(read).toHaveBeenCalledWith({ uri: content.uri, name: 'tenor.gif', type: 'image/gif' });
    expect(paste).toHaveBeenCalledWith(box, file);
    expect(native.releaseKeyboardContent).toHaveBeenCalledWith({ id: '7' });
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it('says so when the box takes no pictures', async () => {
    const native = plugin();
    const ok = await receiveKeyboardContent(content, { plugin: native, read: async () => new File([], 'a.gif'), paste: () => false });
    expect(ok).toBe(false);
    expect(showErrorToast).toHaveBeenCalledWith("Couldn't add the picture from your keyboard", 'Only the message box and documents take pictures.');
    expect(native.releaseKeyboardContent).toHaveBeenCalled();
  });

  it('lets the keyboard go when the file can\'t be read', async () => {
    const native = plugin();
    const paste = vi.fn();
    const err = new Error('gone');
    const ok = await receiveKeyboardContent(content, { plugin: native, read: async () => { throw err; }, paste });
    expect(ok).toBe(false);
    expect(paste).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith("Couldn't add the picture from your keyboard", err);
    expect(native.releaseKeyboardContent).toHaveBeenCalledWith({ id: '7' });
  });
});
