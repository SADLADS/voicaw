// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import PageMenus from './PageMenus';
import SafetyDialogs from './SafetyDialogs';
import { InteractionContext } from '../contexts';
import { AuthContext } from '../hooks/useAuth';
import api from '../utils/api';
import { applyBlocked } from '../utils/blocks';
import { addWord } from '../spellcheck/personalDictionary';
import { isSpellcheckEnabled } from '../utils/spellcheck';

vi.mock('../utils/api', () => ({ default: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
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
  applyBlocked([]);
  cleanup();
  document.body.innerHTML = '';
});

// `meId`: logged in as that user (Block and Report need it).
function page(html, { isMobile = false, meId = null } = {}) {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  render(
    <AuthContext.Provider value={{ user: meId == null ? null : { id: meId } }}>
      <InteractionContext.Provider value={{ isMobile }}><PageMenus /><SafetyDialogs /></InteractionContext.Provider>
    </AuthContext.Provider>
  );
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
    await screen.findByRole('menuitem', { name: 'Copy User ID' });
    expect(menuItems()).toEqual(['Copy User ID']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy User ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('42'));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('on someone else: Block (asking first) and Report, then Copy User ID; none of those on yourself', async () => {
    api.put.mockResolvedValue({ data: { blocked: [42], webhooks: [] } });
    const $ = page('<span data-user-id="42"><b id="name">bob</b></span><span data-user-id="1"><b id="me">me</b></span>', { meId: 1 });
    fireEvent.contextMenu($('#name'));
    await screen.findByRole('menuitem', { name: 'Block' });
    expect(menuItems()).toEqual(['Block', 'Report', 'Copy User ID']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Block' }));
    const dialog = await screen.findByRole('dialog', { name: 'Block User?' });
    expect(api.put).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/blocks/42'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Blocked now: Unblock instead, straight away.
    api.delete.mockResolvedValue({ data: { blocked: [], webhooks: [] } });
    fireEvent.contextMenu($('#name'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unblock' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/blocks/42'));

    fireEvent.contextMenu($('#name'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Report' }));
    expect(await screen.findByRole('dialog', { name: 'Report User' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.contextMenu($('#me'));
    await screen.findByRole('menuitem', { name: 'Copy User ID' });
    expect(menuItems()).toEqual(['Copy User ID']);
  });

  it("on a webhook's name: Block Webhook (asking first) and Copy Webhook ID", async () => {
    api.put.mockResolvedValue({ data: { blocked: [], webhooks: [{ id: 7, name: 'Spam Bot', guild_id: 1, guild_name: 'Place' }] } });
    const $ = page('<strong id="hook" data-webhook-id="7" data-webhook-name="Spam Bot">Spam Bot</strong>', { meId: 1 });
    fireEvent.contextMenu($('#hook'));
    await screen.findByRole('menuitem', { name: 'Block Webhook' });
    expect(menuItems()).toEqual(['Block Webhook', 'Copy Webhook ID']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Block Webhook' }));
    const dialog = await screen.findByRole('dialog', { name: 'Block Spam Bot?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block Webhook' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/blocks/webhooks/7'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.contextMenu($('#hook'));
    expect(await screen.findByRole('menuitem', { name: 'Unblock Webhook' })).toBeInTheDocument();
  });
});
