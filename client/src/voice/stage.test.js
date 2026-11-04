import { describe, it, expect } from 'vitest';
import { cornerOf, stageOf } from './stage';

describe('stageOf', () => {
  it('shows the focused camera over a watched stream, else the stream', () => {
    expect(stageOf({ focusedCamera: '2', watching: '3' })).toEqual({ kind: 'camera', id: '2' });
    expect(stageOf({ focusedCamera: null, watching: '3' })).toEqual({ kind: 'screen', id: '3' });
    expect(stageOf({ focusedCamera: null, watching: null })).toBeNull();
  });
});

describe('cornerOf', () => {
  it('never shows your own, falling back to a stream you watch', () => {
    expect(cornerOf({ identity: '1', focusedCamera: '2', watching: '3' })).toEqual({ kind: 'camera', id: '2' });
    expect(cornerOf({ identity: '1', focusedCamera: '1', watching: '3' })).toEqual({ kind: 'screen', id: '3' });
    expect(cornerOf({ identity: '1', focusedCamera: '1', watching: '1' })).toBeNull();
    expect(cornerOf({ identity: '1', focusedCamera: null, watching: null })).toBeNull();
  });
});
