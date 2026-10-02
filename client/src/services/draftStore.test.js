import { describe, it, expect, beforeEach } from 'vitest';
import { clearDrafts, getDraft, saveDraft } from './draftStore';

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

  it("drops unsent attachments' placeholders but keeps sent ones and the text", () => {
    saveDraft(2, 'look ![cat.png](attachment:1) ![old.png](https://s3.test/uploads/x.bin#k=1)');

    expect(getDraft(2)).toBe('look  ![old.png](https://s3.test/uploads/x.bin#k=1)');
  });

  it('forgets everything on clearDrafts (logging out)', () => {
    saveDraft(2, 'hi');
    clearDrafts();

    expect(getDraft(2)).toBe('');
  });
});
