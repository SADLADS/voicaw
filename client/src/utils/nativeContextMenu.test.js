// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { allowsNativeMenu, blockNativeContextMenu } from './nativeContextMenu';

function build(html) {
  document.body.innerHTML = html;
  return (selector) => document.querySelector(selector);
}

describe('the browser right-click menu', () => {
  it('is replaced everywhere, text boxes and links included, unless Shift is held', () => {
    const $ = build(`
      <input id="field"><textarea id="area"></textarea><div contenteditable="true"><p id="editor">hi</p></div>
      <div class="dm-message-content"><p id="text">hello <a id="link" href="https://x.test">x</a></p><img id="pic"></div>
      <div id="plain">nothing</div>`);
    for (const id of ['field', 'area', 'editor', 'link', 'text', 'pic', 'plain']) {
      expect(allowsNativeMenu($(`#${id}`)), id).toBe(false);
      expect(allowsNativeMenu($(`#${id}`), { shiftKey: true }), id).toBe(true);
    }
    expect(allowsNativeMenu($('#text').firstChild)).toBe(false); // a text node
    expect(allowsNativeMenu(null)).toBe(false);
  });

  it("is kept in a phone's text boxes, for its own selection and paste", () => {
    const $ = build('<input id="field"><div contenteditable="true"><p id="editor">hi</p></div><div id="plain">x</div>');
    expect(allowsNativeMenu($('#field'), { phone: true })).toBe(true);
    expect(allowsNativeMenu($('#editor'), { phone: true })).toBe(true);
    expect(allowsNativeMenu($('#plain'), { phone: true })).toBe(false);
  });

  it('is prevented elsewhere, and left alone where a menu of ours already handled it', () => {
    const $ = build('<div id="plain">x</div><input id="field"><div id="ours">y</div>');
    blockNativeContextMenu(window);
    const fire = (el, init = {}) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...init });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fire($('#plain'))).toBe(true);
    expect(fire($('#field'))).toBe(true);
    expect(fire($('#field'), { shiftKey: true })).toBe(false);
    document.body.classList.add('mobile-mode');
    expect(fire($('#field'))).toBe(false);
    document.body.classList.remove('mobile-mode');
    $('#ours').addEventListener('contextmenu', (e) => e.preventDefault());
    expect(fire($('#ours'))).toBe(true);
  });
});
