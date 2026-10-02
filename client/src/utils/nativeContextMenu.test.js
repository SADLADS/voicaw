// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { allowsNativeMenu, blockNativeContextMenu } from './nativeContextMenu';

function build(html) {
  document.body.innerHTML = html;
  return (selector) => document.querySelector(selector);
}

describe('the browser right-click menu', () => {
  it('is kept in text boxes, on selected text, and on links and pictures in messages', () => {
    const $ = build(`
      <input id="field"><textarea id="area"></textarea><div contenteditable="true"><p id="editor">hi</p></div>
      <div class="dm-message-content"><p id="text">hello <a id="link" href="https://x.test">x</a></p><img id="pic"></div>
      <div class="message-embeds"><a id="embed-link" href="https://y.test">y</a></div>
      <a id="nav" href="/guild/1/2"><span id="nav-name">general</span></a>
      <div id="plain">nothing</div>`);
    for (const id of ['field', 'area', 'editor', 'link', 'pic', 'embed-link']) expect(allowsNativeMenu($(`#${id}`)), id).toBe(true);
    for (const id of ['text', 'nav', 'nav-name', 'plain']) expect(allowsNativeMenu($(`#${id}`)), id).toBe(false);
    expect(allowsNativeMenu($('#text'), 'hello')).toBe(true);
    expect(allowsNativeMenu($('#text').firstChild)).toBe(false); // a text node
    expect(allowsNativeMenu(null)).toBe(false);
  });

  it('is prevented elsewhere, and left alone where a menu of ours already handled it', () => {
    const $ = build('<div id="plain">x</div><input id="field"><div id="ours">y</div>');
    blockNativeContextMenu(document);
    const fire = (el) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fire($('#plain'))).toBe(true);
    expect(fire($('#field'))).toBe(false);
    $('#ours').addEventListener('contextmenu', (e) => e.preventDefault());
    expect(fire($('#ours'))).toBe(true);
  });
});
