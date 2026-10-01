import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVoiceChain } from './voiceChain';

// A stand-in AudioContext that records how nodes are wired.
function fakeContext() {
  const links = [];
  const node = (name) => ({
    name,
    connect: vi.fn((to) => links.push(`${name}->${to.name}`)),
    disconnect: vi.fn(),
  });
  let outputs = 0;
  return {
    links,
    createMediaStreamSource: vi.fn(() => node('mic')),
    createMediaStreamDestination: vi.fn(() => {
      const track = { id: `out${++outputs}`, stop: vi.fn() };
      return { ...node('out'), stream: { getAudioTracks: () => [track] } };
    }),
  };
}

beforeEach(() => {
  globalThis.MediaStream = class {
    constructor(tracks) {
      this.tracks = tracks;
    }
  };
});

describe('createVoiceChain', () => {
  it('passes the mic straight through with no stages', async () => {
    const context = fakeContext();
    const chain = createVoiceChain();
    await chain.init({ track: {}, audioContext: context });
    expect(context.links).toEqual(['mic->out']);
    expect(chain.processedTrack.id).toBe('out1');
  });

  it('runs the mic through each stage in order', async () => {
    const context = fakeContext();
    const destroyed = vi.fn();
    const stage = (name) => () => {
      const n = { name, connect: vi.fn((to) => context.links.push(`${name}->${to.name}`)), disconnect: vi.fn() };
      return { input: n, output: n, destroy: destroyed };
    };
    const chain = createVoiceChain([stage('denoise'), stage('gain')]);
    await chain.init({ track: {}, audioContext: context });
    expect(context.links).toEqual(['mic->denoise', 'denoise->gain', 'gain->out']);
    await chain.destroy();
    expect(destroyed).toHaveBeenCalledTimes(2);
    expect(chain.processedTrack).toBeUndefined();
  });

  it('rebuilds on restart without being given the AudioContext again (LiveKit does that)', async () => {
    const context = fakeContext();
    const chain = createVoiceChain();
    await chain.init({ track: {}, audioContext: context });
    const first = chain.processedTrack;
    await chain.restart({ track: {} });
    expect(first.stop).toHaveBeenCalled();
    expect(chain.processedTrack.id).toBe('out2');
  });
});
