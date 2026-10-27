// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const state = vi.hoisted(() => ({ voice: {}, phone: false }));
vi.mock('../../hooks/useVoice', () => ({ useVoice: () => state.voice }));
vi.mock('../../utils/presence', () => ({ isMobileDevice: () => state.phone }));
const client = vi.hoisted(() => ({ startCamera: vi.fn(), stopCamera: vi.fn(), switchCamera: vi.fn() }));
vi.mock('../../voice/voiceClient', () => client);

import CameraButton from './CameraButton';

const connected = { status: 'connected', canCamera: true, cameraOn: false };

describe('CameraButton', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('turns the camera on and off', () => {
    state.voice = connected;
    render(<CameraButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on camera' }));
    expect(client.startCamera).toHaveBeenCalled();
  });

  it("switches a phone's camera only while it's on", () => {
    state.phone = true;
    state.voice = connected;
    const { rerender } = render(<CameraButton />);
    expect(screen.queryByRole('button', { name: 'Switch camera' })).toBeNull();
    state.voice = { ...connected, cameraOn: true };
    rerender(<CameraButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }));
    expect(client.switchCamera).toHaveBeenCalled();
  });

  it('has no switch on a computer', () => {
    state.phone = false;
    state.voice = { ...connected, cameraOn: true };
    render(<CameraButton />);
    expect(screen.getByRole('button', { name: 'Turn off camera' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Switch camera' })).toBeNull();
  });
});
