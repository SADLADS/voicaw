// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { browserImageLink, fileNameOf, imageLinkIn, placeOf, withoutImageLink } from './imageLink';

const item = {
  src: 'https://media.test/uploads/0f9e.bin#v=2&k=SECRET&t=image/png',
  name: 'photo.png',
  meta: { kind: 'image' },
  place: { chatId: '12', messageId: '345' },
};

describe('links to pictures in chats', () => {
  it('names the chat, message, file and account, never the key, and replaces an earlier link', () => {
    const link = browserImageLink(item, 7, { pathname: '/dm/12', search: '?in=x&message=1&image=y&as=2&chat=1' });
    expect(link).toBe(`${window.location.origin}/dm/12?chat=1&in=12&message=345&image=0f9e.bin&as=7`);
    expect(link).not.toContain('SECRET');
  });

  it('has none for a picture outside a chat, a plain one, or without an account', () => {
    const at = { pathname: '/dm/12', search: '' };
    expect(browserImageLink({ ...item, place: undefined }, 7, at)).toBe(null);
    expect(browserImageLink({ ...item, meta: undefined }, 7, at)).toBe(null);
    expect(browserImageLink(item, null, at)).toBe(null);
  });

  it('reads a link back, refusing ids that aren\'t numbers', () => {
    expect(imageLinkIn('?chat=1&in=group-4&message=345&image=0f9e.bin&as=7'))
      .toEqual({ chatId: 'group-4', messageId: '345', file: '0f9e.bin', as: '7' });
    expect(imageLinkIn('?in=group-4&message=3"]&image=0f9e.bin&as=7')).toBe(null);
    expect(imageLinkIn('?in=group-4&message=345&image=0f9e.bin')).toBe(null);
    expect(imageLinkIn('?thread=9')).toBe(null);
    expect(withoutImageLink('?thread=9&in=group-4&message=345&image=0f9e.bin&as=7')).toBe('?thread=9');
    expect(withoutImageLink('?in=group-4&message=345&image=0f9e.bin&as=7')).toBe('');
  });

  it('finds where a picture is from the page: its chat and message', () => {
    document.body.innerHTML = '<div data-chat-id="channel-3"><div data-msg-id="88"><img id="pic"></div></div><img id="loose">';
    expect(placeOf(document.getElementById('pic'))).toEqual({ chatId: 'channel-3', messageId: '88' });
    expect(placeOf(document.getElementById('loose'))).toBe(null);
    expect(fileNameOf(item.src)).toBe('0f9e.bin');
    expect(fileNameOf('not a url')).toBe(null);
  });
});
