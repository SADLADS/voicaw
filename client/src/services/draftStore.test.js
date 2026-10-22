import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearDrafts, getDraft, keepAttachments, saveDraft, takeAttachments } from './draftStore';

beforeEach(clearDrafts);

describe('draftStore', () => {
  it('keeps text per conversation', () => {
    saveDraft(2, 'hi bob');
    saveDraft('channel-5', 'hi all');

    expect(getDraft('2')).toBe('hi bob');
    expect(getDraft('channel-5')).toBe('hi all');
    expect(getDraft('group-1')).toBe('');
  });

  it('forgets a draft emptied or left blank', () => {
    saveDraft(2, 'hi');
    saveDraft(2, '  \n');

    expect(getDraft(2)).toBe('');
  });

  it("keeps the placeholders of attachments still there, drops the others' and keeps links", () => {
    saveDraft(2, 'look ![cat.png](attachment:1) ![dog.png](attachment:2) ![old.png](https://s3.test/uploads/x.bin#k=1)');

    expect(getDraft(2, new Set([2]))).toBe('look  ![dog.png](attachment:2) ![old.png](https://s3.test/uploads/x.bin#k=1)');
    expect(getDraft(2)).toBe('look   ![old.png](https://s3.test/uploads/x.bin#k=1)');
  });

  it('keeps attachments per conversation until they are taken back', () => {
    const drafts = [{ id: 1, previewUrl: 'blob:1' }];
    keepAttachments(2, { drafts, mediaInfo: [] });
    expect(takeAttachments('group-1')).toBeNull();
    expect(takeAttachments('2')).toEqual({ drafts, mediaInfo: [] });
    expect(takeAttachments(2)).toBeNull();
  });

  it('forgets everything on clearDrafts (logging out), freeing the files', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    saveDraft(2, 'hi');
    keepAttachments(2, { drafts: [{ id: 1, previewUrl: 'blob:1' }], mediaInfo: [] });
    clearDrafts();

    expect(getDraft(2)).toBe('');
    expect(takeAttachments(2)).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:1');
    revoke.mockRestore();
  });
});
