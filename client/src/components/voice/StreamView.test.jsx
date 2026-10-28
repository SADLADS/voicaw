// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const voice = vi.hoisted(() => ({ state: { watchingReady: false, selfDeaf: false } }));
vi.mock('../../hooks/useVoice', () => ({ useVoice: () => voice.state }));
vi.mock('../../voice/voiceClient', () => ({ attachStream: () => () => {}, setStreamError() {}, watchStream() {} }));
vi.mock('../../voice/streamWindow', () => ({ closeStreamWindow() {}, openStreamWindow() {} }));

import StreamView from './StreamView';
import { getStreamVolume, getUserVolume, setStreamVolume } from '../../voice/userVolumes';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setStreamVolume(7, 1);
  voice.state = { watchingReady: false, selfDeaf: false };
});

describe('StreamView volume', () => {
  it('sets the stream’s own volume, up to 200%', () => {
    vi.stubGlobal('AudioContext', class {});
    render(<StreamView userId={7} name="alice" />);
    const slider = screen.getByRole('slider', { name: 'Stream volume (just for you)' });
    expect(slider.value).toBe('100');
    fireEvent.change(slider, { target: { value: '150' } });
    expect(getStreamVolume(7)).toBe(1.5);
    expect(getUserVolume(7)).toBe(1);
    expect(slider.getAttribute('aria-valuetext')).toBe('150%');
    expect(slider.max).toBe('200');
  });

  it('stops at 100% where voices can’t be boosted', () => {
    setStreamVolume(7, 1.5);
    render(<StreamView userId={7} name="alice" />);
    const slider = screen.getByRole('slider', { name: 'Stream volume (just for you)' });
    expect(slider.max).toBe('100');
    expect(slider.getAttribute('aria-valuetext')).toBe('100%');
  });

  it('mutes, and unmuting goes back to the volume it had', () => {
    setStreamVolume(7, 0.6);
    render(<StreamView userId={7} name="alice" />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute the stream' }));
    expect(getStreamVolume(7)).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Unmute the stream' }));
    expect(getStreamVolume(7)).toBe(0.6);
  });

  it('is disabled while deafened', () => {
    voice.state = { watchingReady: false, selfDeaf: true };
    render(<StreamView userId={7} name="alice" />);
    expect(screen.getByRole('button', { name: 'Unmute the stream' }).disabled).toBe(true);
    expect(screen.getByRole('slider', { name: 'Stream volume (just for you)' }).disabled).toBe(true);
  });

  it('isn’t offered for our own stream', () => {
    render(<StreamView userId={7} name="alice" own />);
    expect(screen.queryByRole('slider', { name: 'Stream volume (just for you)' })).toBeNull();
  });
});

describe('StreamView watchers', () => {
  it('shows how many others watch, and lists them on a click', async () => {
    const { mergeProfiles } = await import('../../utils/profiles');
    mergeProfiles([{ id: 9, username: 'carol9', display_name: 'Carol' }]);
    voice.state = { watchingReady: true, selfDeaf: false, watchers: { 7: [{ id: '8', username: 'bob' }, { id: '9', username: 'carol9' }] } };
    render(<StreamView userId={7} name="alice" own />);
    const button = screen.getByRole('button', { name: '2 watching: bob, Carol' });
    expect(screen.queryByRole('list')).toBeNull();
    fireEvent.click(button);
    const list = screen.getByRole('list', { name: 'Watching' });
    expect(list.textContent).toContain('Carol');
  });

  it('shows nothing when nobody else watches', () => {
    voice.state = { watchingReady: true, selfDeaf: false, watchers: { 8: [{ id: '9', username: 'carol' }] } };
    render(<StreamView userId={7} name="alice" />);
    expect(screen.queryByRole('button', { name: /\d watching/ })).toBeNull();
  });
});

describe('StreamView quality', () => {
  it('picks which copy of others’ streams this device downloads, and shows the size arriving', async () => {
    const { getStreamViewQuality, setStreamViewQuality } = await import('../../voice/streamViewSettings');
    render(<StreamView userId={7} name="alice" />);
    const button = screen.getByRole('button', { name: 'Stream quality' });
    fireEvent.click(button);
    expect(screen.getByRole('menuitemradio', { name: /Auto/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Data saver/ }));
    expect(getStreamViewQuality()).toBe('low');
    expect(screen.queryByRole('menu')).toBeNull();

    const video = document.querySelector('video');
    Object.defineProperty(video, 'videoWidth', { value: 960, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 540, configurable: true });
    fireEvent(video, new Event('resize'));
    fireEvent.click(button);
    expect(screen.getByRole('menuitemradio', { name: /Data saver/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menu').textContent).toContain('Receiving 960 × 540');
    setStreamViewQuality('auto');
  });

  it('isn’t offered for our own stream or in the corner', () => {
    render(<StreamView userId={7} name="alice" own />);
    expect(screen.queryByRole('button', { name: 'Stream quality' })).toBeNull();
    cleanup();
    render(<StreamView userId={7} name="alice" corner />);
    expect(screen.queryByRole('button', { name: 'Stream quality' })).toBeNull();
  });
});

describe('StreamView zoom', () => {
  // jsdom lays nothing out: an 800 × 450 stage, and a video with no size of its own (so the
  // picture fills the stage).
  function sized() {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(450);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 450 });
  }
  const video = () => screen.getByLabelText("alice's screen");
  const slider = () => screen.getByRole('slider', { name: 'Zoom' });
  const offsetX = () => Number(video().style.transform.match(/translate\((-?[\d.]+)px/)[1]);

  afterEach(() => vi.restoreAllMocks());

  it('zooms in and out with the buttons, and the percentage fits it again', () => {
    sized();
    render(<StreamView userId={7} name="alice" />);
    expect(screen.getByRole('button', { name: 'Zoom out' }).disabled).toBe(true);
    expect(slider().getAttribute('aria-valuetext')).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(slider().getAttribute('aria-valuetext')).toBe('150%');
    expect(video().style.transform).toBe('translate(0px, 0px) scale(1.5)');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(slider().getAttribute('aria-valuetext')).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit the stream (back to 100%)' }));
    expect(video().style.transform).toBe('');
    expect(screen.queryByRole('button', { name: 'Fit the stream (back to 100%)' })).toBeNull();
  });

  it('moves in powers of two along the slider, up to 800%', () => {
    sized();
    render(<StreamView userId={7} name="alice" />);
    expect(slider().max).toBe('300');
    fireEvent.change(slider(), { target: { value: '100' } });
    expect(slider().getAttribute('aria-valuetext')).toBe('200%');
    fireEvent.change(slider(), { target: { value: '300' } });
    expect(slider().getAttribute('aria-valuetext')).toBe('800%');
    expect(screen.getByRole('button', { name: 'Zoom in' }).disabled).toBe(true);
  });

  it('zooms on the point under the wheel, and drags around inside the picture', () => {
    sized();
    const { container } = render(<StreamView userId={7} name="alice" />);
    const stage = container.querySelector('.stream-view');
    // Scrolling up over the right edge's middle keeps that point where it is.
    fireEvent.wheel(stage, { deltaY: -347, clientX: 800, clientY: 225 });
    const scale = Math.exp(347 * 0.002);
    expect(slider().getAttribute('aria-valuetext')).toBe(`${Math.round(scale * 100)}%`);
    expect(offsetX()).toBeCloseTo(-(400 * scale - 400), 0);
    // Dragging right shows more of the left, but never past the picture's edge.
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, pointerType: 'mouse', clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, pointerType: 'mouse', clientX: 5000, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: 'mouse' });
    expect(offsetX()).toBeCloseTo(400 * scale - 400, 0);
  });

  it('isn’t in the corner', () => {
    sized();
    const { container } = render(<StreamView userId={7} name="alice" corner />);
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull();
    fireEvent.wheel(container.querySelector('.stream-view'), { deltaY: -500, clientX: 10, clientY: 10 });
    expect(video().style.transform).toBe('');
  });
});
