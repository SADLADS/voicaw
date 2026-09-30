import { describe, it, expect } from 'vitest';
import { editedPoll, parsePoll, planVote, pollMarkup, tallyVotes, voteKey } from './pollMarkup';
import { summarizeAttachments } from './attachmentMarkup';
import { groupReactions } from './reactions';

const poll = (multi = false) => ({
  question: 'Lunch?',
  multi,
  options: [{ id: 'aaaa1111', text: 'Pizza', emoji: '🍕' }, { id: 'bbbb2222', text: 'Soup', emoji: null }],
});
const vote = (id, userId, optionId) => ({ id, user_id: userId, emoji: voteKey(optionId) });

describe('poll markup', () => {
  it('round-trips, and rejects anything malformed', () => {
    expect(parsePoll(pollMarkup(poll(true)))).toEqual(poll(true));
    expect(parsePoll(pollMarkup({ question: 'One?', multi: false, options: [{ id: 'cccc3333', text: 'Only' }] })).options).toHaveLength(1);
    expect(parsePoll('hello')).toBeNull();
    expect(parsePoll('poll:v1:{nope')).toBeNull();
    expect(parsePoll('poll:v1:{"q":"x","o":[]}')).toBeNull();
    expect(parsePoll('poll:v1:{"q":"x","o":[{"id":"BAD","t":"a"}]}')).toBeNull();
    expect(parsePoll('poll:v1:{"q":"x","o":[{"id":"aaaa1111","t":"a"},{"id":"aaaa1111","t":"b"}]}')).toBeNull();
    // An emoji that isn't one is dropped, not the poll.
    expect(parsePoll('poll:v1:{"q":"x","o":[{"id":"aaaa1111","t":"a","e":"not an emoji"}]}').options[0].emoji).toBeNull();
    expect(parsePoll(pollMarkup({ question: 'x', options: [{ id: 'aaaa1111', text: 'a', emoji: '<:blob:12>' }] })).options[0].emoji).toBe('<:blob:12>');
  });

  it('summarises as its question and hides votes from reaction chips', () => {
    expect(summarizeAttachments(pollMarkup(poll()))).toBe('📊 Poll: Lunch?');
    expect(groupReactions([vote(1, 1, 'aaaa1111'), { id: 2, user_id: 1, emoji: '👍' }])).toEqual([{ emoji: '👍', userIds: [1] }]);
  });

  it('gives edited answers new ids (dropping their votes) and keeps the kind', () => {
    const next = editedPoll(poll(true), {
      question: 'Dinner?',
      options: [{ id: 'aaaa1111', text: 'Pizza', emoji: '🍕' }, { id: 'bbbb2222', text: 'Stew' }, { id: null, text: 'Curry' }],
    });
    expect(next.question).toBe('Dinner?');
    expect(next.multi).toBe(true);
    expect(next.options[0]).toEqual({ id: 'aaaa1111', text: 'Pizza', emoji: '🍕' });
    expect(next.options[1].id).not.toBe('bbbb2222');
    // Changing only the emoji is an edit too.
    const reEmojied = editedPoll(poll(), { question: 'Lunch?', options: [{ id: 'aaaa1111', text: 'Pizza', emoji: '🍔' }, { id: 'bbbb2222', text: 'Soup' }] });
    expect(reEmojied.options[0].id).not.toBe('aaaa1111');
    expect(reEmojied.options[1].id).toBe('bbbb2222');
    expect(next.options[2].id).toMatch(/^[a-z0-9]{8}$/);
    const { voters } = tallyVotes(next, [vote(1, 1, 'aaaa1111'), vote(2, 2, 'bbbb2222')]);
    expect(voters.aaaa1111).toEqual([1]);
    expect(Object.values(voters).flat()).toEqual([1]);
  });
});

describe('voting', () => {
  it('counts only the latest vote per person in a single-choice poll', () => {
    const tally = tallyVotes(poll(), [vote(1, 1, 'aaaa1111'), vote(2, 1, 'bbbb2222'), vote(3, 2, 'bbbb2222')]);
    expect(tally.voters).toEqual({ aaaa1111: [], bbbb2222: [1, 2] });
    expect(tally.total).toBe(2);
  });

  it('counts every answer in a multiple-choice poll', () => {
    const tally = tallyVotes(poll(true), [vote(1, 1, 'aaaa1111'), vote(2, 1, 'bbbb2222')]);
    expect(tally.voters).toEqual({ aaaa1111: [1], bbbb2222: [1] });
    expect(tally.total).toBe(1);
  });

  it('replaces a single-choice vote, toggles a multiple-choice one, and clears stale votes', () => {
    const stale = vote(9, 1, 'zzzz9999');
    const mine = vote(1, 1, 'aaaa1111');
    expect(planVote(poll(), [mine, stale], 1, 'bbbb2222')).toEqual({ remove: [stale, mine], add: true });
    expect(planVote(poll(), [mine], 1, 'aaaa1111')).toEqual({ remove: [mine], add: false });
    expect(planVote(poll(true), [mine], 1, 'bbbb2222')).toEqual({ remove: [], add: true });
    expect(planVote(poll(true), [mine, vote(2, 2, 'bbbb2222')], 1, 'bbbb2222')).toEqual({ remove: [], add: true });
  });
});
