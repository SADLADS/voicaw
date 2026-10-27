import { describe, expect, it } from 'vitest';
import { forwardMarkup, forwardSource, isForward, parseForward } from './forwardMarkup';
import { summarizeAttachments, uploadNamesIn } from './attachmentMarkup';
import { mentionsMe } from './mentions';

const ATTACHMENT = '![photo.jpg](https://s3.example/uploads/abc.bin#v=2&k=KEY&t=image/jpeg&s=10&n=AAAAAAAAAAAAAAAA)';

describe('forwardMarkup', () => {
  it('keeps the original text as it was, after a header line', () => {
    const text = forwardMarkup({ content: `hi\nthere ${ATTACHMENT}`, at: 1730000000 });
    expect(text).toBe(`fwd:v1:{"t":1730000000}\nhi\nthere ${ATTACHMENT}`);
    expect(parseForward(text)).toEqual({ at: 1730000000, content: `hi\nthere ${ATTACHMENT}` });
    // Its files are still listed for the server's upload registry.
    expect(uploadNamesIn(text)).toEqual(['abc.bin']);
  });

  it("isn't fooled by other text", () => {
    expect(parseForward('fwd:v1:{"t":1}')).toBeNull(); // no line for the content
    expect(parseForward('fwd:v1:{broken\nhi')).toBeNull();
    expect(parseForward('fwd:v1:[1]\nhi')).toBeNull();
    expect(parseForward('hello fwd:v1:{}\nhi')).toBeNull();
    expect(parseForward('fwd:v1:{"t":"soon"}\nhi')).toEqual({ at: null, content: 'hi' });
    expect(isForward(null)).toBe(false);
  });

  it('forwards what can be, and a forward as its original', () => {
    const msg = { id: 5, timestamp: 1700000000, plaintext: 'hello' };
    expect(forwardSource(msg)).toEqual({ content: 'hello', at: 1700000000 });
    const forwarded = { id: 6, timestamp: 1800000000, plaintext: forwardMarkup({ content: 'hello', at: 1700000000 }) };
    expect(forwardSource(forwarded)).toEqual({ content: 'hello', at: 1700000000 });
    expect(forwardSource({ ...msg, status: 'pending' })).toBeNull();
    expect(forwardSource({ ...msg, status: 'failed' })).toBeNull();
    expect(forwardSource({ ...msg, ephemeral: true })).toBeNull();
    expect(forwardSource({ ...msg, system: 'call' })).toBeNull();
    expect(forwardSource({ ...msg, id: 'pending-1' })).toBeNull();
    expect(forwardSource({ ...msg, plaintext: '' })).toBeNull();
    expect(forwardSource({ ...msg, plaintext: 'poll:v1:{"q":"Where?","o":[{"id":"aaaa1111","t":"Park"}]}' })).toBeNull();
  });

  it('reads as "Forwarded" in plain text, and its mentions never ping', () => {
    const text = forwardMarkup({ content: `hey <@3> ${ATTACHMENT}`, at: 1 });
    expect(summarizeAttachments(text)).toBe('↪ Forwarded: hey <@3> 📎 photo.jpg');
    expect(mentionsMe({ plaintext: text }, 3, [])).toBe(false);
    expect(mentionsMe({ plaintext: 'hey <@3>' }, 3, [])).toBe(true);
  });
});
