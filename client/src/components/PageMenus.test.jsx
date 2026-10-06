// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import PageMenus from './PageMenus';
import { InteractionContext } from '../contexts';
import { addWord } from '../spellcheck/personalDictionary';
import { isSpellcheckEnabled } from '../utils/spellcheck';

vi.mock('../spellcheck/personalDictionary', () => ({
  addWord: vi.fn(),
  hasWord: () => false,
  subscribeDictionary: () => () => {},
}));
vi.mock('../spellcheck/checker', () => ({
  checkWord: async (word) => word === 'wrold',
  suggestions: async () => ['world', 'wold'],
  misspelled: () => false,
  subscribeChecker: () => () => {},
}));
vi.mock('../utils/spellcheck', async (importOriginal) => ({
  ...(await importOriginal()),
  spellcheckLanguage: () => 'en-GB',
}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function page(html, { isMobile = false } = {}) {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  render(<InteractionContext.Provider value={{ isMobile }}><PageMenus /></InteractionContext.Provider>);
  return (selector) => host.querySelector(selector);
}

const menuItems = () => [...document.querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent);

describe('our right-click menus', () => {
  it('in a text box: spelling fixes for the word clicked, then the usual edit items', async () => {
    const $ = page('<input id="box" value="hello wrold">');
    const box = $('#box');
    box.setSelectionRange(8, 8);
    const notPrevented = fireEvent.contextMenu(box, { clientX: 10, clientY: 10 });
    expect(notPrevented).toBe(false);
    await screen.findByRole('menuitem', { name: 'world' });
    expect(menuItems()).toEqual(['world', 'wold', 'Add to Dictionary', 'Paste', 'Select All', 'Spellcheck']);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to Dictionary' }));
    expect(addWord).toHaveBeenCalledWith('wrold');
  });

  it('turns spellcheck off and on from the menu', async () => {
    const $ = page('<textarea id="box">fine</textarea>');
    fireEvent.contextMenu($('#box'));
    const toggle = await screen.findByRole('menuitemradio', { name: 'Spellcheck' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await act(async () => { fireEvent.click(toggle); });
    expect(isSpellcheckEnabled()).toBe(false);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await act(async () => { fireEvent.contextMenu($('#box')); });
    await act(async () => { fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Spellcheck' })); });
    expect(isSpellcheckEnabled()).toBe(true);
  });

  it('offers Cut and Copy only with something selected, and neither in a password', async () => {
    const $ = page('<input id="box" value="some text"><input id="pw" type="password" value="secret">');
    $('#box').setSelectionRange(0, 4);
    fireEvent.contextMenu($('#box'));
    await screen.findByRole('menuitem', { name: 'Cut' });
    expect(menuItems()).toEqual(['Cut', 'Copy', 'Paste', 'Select All', 'Spellcheck']);
    fireEvent.keyDown(window, { key: 'Escape' });
    $('#pw').setSelectionRange(0, 6);
    fireEvent.contextMenu($('#pw'));
    await screen.findByRole('menuitem', { name: 'Paste' });
    expect(menuItems()).toEqual(['Paste', 'Select All']);
  });

  it("on another site's link: Copy Link and Open Link", async () => {
    const $ = page('<p><a id="out" href="https://example.com/x">site</a> <a id="in" href="/guild/1/2">general</a></p>');
    fireEvent.contextMenu($('#out'));
    await screen.findByRole('menuitem', { name: 'Copy Link' });
    expect(menuItems()).toEqual(['Copy Link', 'Open Link']);
    fireEvent.keyDown(window, { key: 'Escape' });
    // The app's own links have nothing to add.
    expect(fireEvent.contextMenu($('#in'))).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('leaves Shift+right-click, and phones, to the browser', () => {
    const $ = page('<input id="box" value="x">');
    expect(fireEvent.contextMenu($('#box'), { shiftKey: true })).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    cleanup();
    const $$ = page('<input id="phone-box" value="x">', { isMobile: true });
    expect(fireEvent.contextMenu($$('#phone-box'))).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it("on a person (a message's author, a mention...): Copy User ID", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const $ = page('<span data-user-id="42"><b id="name">bob</b></span>');
    fireEvent.contextMenu($('#name'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy User ID' }));
    expect(menuItems()).toEqual(['Copy User ID']);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('42'));
    expect(await screen.findByText('ID copied')).toBeInTheDocument();
  });
});
