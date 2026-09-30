import { describe, it, expect } from 'vitest';
import { pollResult, pollEndFits, endPoll, pollEnded, pollEndsAt, timeLeft, editedPoll, parsePoll, planVotes, myVotes, pollMarkup, tallyVotes, voteKey } from './pollMarkup';
import { summarizeAttachments } from './attachmentMarkup';
import { groupReactions } from './reactions';

const poll = (multi = false) => ({
  question: 'Lunch?',
  multi,
  duration: 3600,
  endedAt: null,
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

  it('sets your votes to exactly your choice, and clears stale ones', () => {
    const stale = vote(9, 1, 'zzzz9999');
    const mine = vote(1, 1, 'aaaa1111');
    const bobs = vote(2, 2, 'bbbb2222');
    expect(planVotes(poll(), [mine, stale, bobs], 1, ['bbbb2222'])).toEqual({ remove: [mine, stale], add: ['bbbb2222'] });
    expect(planVotes(poll(), [mine], 1, [])).toEqual({ remove: [mine], add: [] });
    // A single-choice poll takes one answer.
    expect(planVotes(poll(), [], 1, ['aaaa1111', 'bbbb2222'])).toEqual({ remove: [], add: ['aaaa1111'] });
    expect(planVotes(poll(true), [mine], 1, ['aaaa1111', 'bbbb2222'])).toEqual({ remove: [], add: ['bbbb2222'] });
    expect(planVotes(poll(true), [mine, vote(3, 1, 'aaaa1111')], 1, ['aaaa1111'])).toEqual({ remove: [vote(3, 1, 'aaaa1111')], add: [] });
    expect(myVotes(poll(true), [mine, stale, bobs], 1)).toEqual(['aaaa1111']);
  });
});

describe('duration', () => {
  it('closes after its duration from the message time, or when its author ends it', () => {
    const sentAt = 1000;
    expect(pollEndsAt(poll(), sentAt)).toBe(4600);
    expect(pollEnded(poll(), sentAt, 4599)).toBe(false);
    expect(pollEnded(poll(), sentAt, 4600)).toBe(true);
    const ended = endPoll(poll(), 2000);
    expect(pollEndsAt(ended, sentAt)).toBe(2000);
    expect(parsePoll(pollMarkup(ended))).toMatchObject({ duration: 3600, endedAt: 2000 });
    // A poll from before durations never ends by itself.
    const old = parsePoll('poll:v1:{"q":"x","o":[{"id":"aaaa1111","t":"a"}]}');
    expect(old.duration).toBeNull();
    expect(pollEnded(old, sentAt, 1e12)).toBe(false);
    // An edit keeps the duration and an early end.
    expect(editedPoll(ended, { question: 'y', options: [] })).toMatchObject({ duration: 3600, endedAt: 2000 });
  });

  it("doesn't count votes made after the end", () => {
    const votes = [{ ...vote(1, 1, 'aaaa1111'), timestamp: 1500 }, { ...vote(2, 2, 'aaaa1111'), timestamp: 2500 }, vote(3, 3, 'aaaa1111')];
    expect(tallyVotes(poll(), votes, 2000).voters.aaaa1111).toEqual([1, 3]);
    expect(tallyVotes(poll(), votes).voters.aaaa1111).toEqual([1, 2, 3]);
  });

  it('says how long is left', () => {
    expect(timeLeft(2 * 86400 + 5)).toBe('2 days left');
    expect(timeLeft(3600)).toBe('1 hour left');
    expect(timeLeft(125)).toBe('2 minutes left');
    expect(timeLeft(30)).toBe('less than a minute left');
  });
});

describe('result', () => {
  it('gives the winner and its share of the voters, a draw, or nobody', () => {
    const three = { ...poll(true), options: [...poll().options, { id: 'cccc3333', text: 'Salad', emoji: null }] };
    expect(pollResult(three, [])).toMatchObject({ total: 0, winners: [] });
    const won = pollResult(three, [vote(1, 1, 'aaaa1111'), vote(2, 2, 'aaaa1111'), vote(3, 3, 'bbbb2222'), vote(4, 1, 'cccc3333')]);
    expect(won).toMatchObject({ total: 3, votes: 2, share: 67 });
    expect(won.winners.map((o) => o.text)).toEqual(['Pizza']);
    const draw = pollResult(three, [vote(1, 1, 'aaaa1111'), vote(2, 2, 'bbbb2222')]);
    expect(draw.winners.map((o) => o.text)).toEqual(['Pizza', 'Soup']);
    expect(draw.share).toBe(50);
    // Votes after the end don't count.
    expect(pollResult(three, [{ ...vote(1, 1, 'aaaa1111'), timestamp: 50 }], 40).total).toBe(0);
  });

  it("only fits a row posted once the poll had closed", () => {
    expect(pollEndFits(poll(), 1000, 4600)).toBe(true);
    expect(pollEndFits(poll(), 1000, 4550)).toBe(true); // a minute's leeway
    expect(pollEndFits(poll(), 1000, 3000)).toBe(false); // still running
    expect(pollEndFits(endPoll(poll(), 2000), 1000, 2001)).toBe(true);
    expect(pollEndFits({ ...poll(), duration: null }, 1000, 1e9)).toBe(false);
  });
});
