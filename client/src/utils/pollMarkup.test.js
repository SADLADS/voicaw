import { describe, it, expect } from 'vitest';
import {
  pollResult, pollEndFits, endPoll, pollEnded, pollEndsAt, timeLeft, editedPoll, parsePoll, planVotes, myVotes, pollMarkup, tallyVotes, voteKey,
  answerKey, answerProblem, canRemoveAnswer, parseAnswer, pollWithAnswers, removalKey, MAX_POLL_OPTIONS,
} from './pollMarkup';
import { summarizeAttachments } from './attachmentMarkup';
import { groupReactions } from './reactions';

const poll = (multi = false) => ({
  question: 'Lunch?',
  multi,
  open: false,
  round: null,
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
      question: 'Lunch?',
      options: [{ id: 'aaaa1111', text: 'Pizza', emoji: '🍕' }, { id: 'bbbb2222', text: 'Stew' }, { id: null, text: 'Curry' }],
    });
    expect(next.question).toBe('Lunch?');
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
    expect(tally.cast).toBe(2);
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
    expect(pollResult(three, [])).toMatchObject({ cast: 0, winners: [] });
    const won = pollResult(three, [vote(1, 1, 'aaaa1111'), vote(2, 2, 'aaaa1111'), vote(3, 3, 'bbbb2222'), vote(4, 1, 'cccc3333')]);
    // Person 1 voted twice (it's multiple choice): 4 votes cast, Pizza has 2 of them.
    expect(won).toMatchObject({ cast: 4, votes: 2, share: 50 });
    expect(won.winners.map((o) => o.text)).toEqual(['Pizza']);
    const draw = pollResult(three, [vote(1, 1, 'aaaa1111'), vote(2, 2, 'bbbb2222')]);
    expect(draw.winners.map((o) => o.text)).toEqual(['Pizza', 'Soup']);
    expect(draw.share).toBe(50);
    // Votes after the end don't count.
    expect(pollResult(three, [{ ...vote(1, 1, 'aaaa1111'), timestamp: 50 }], 40).cast).toBe(0);
    // One person picking two of three answers: a draw at 50% each, not 100%.
    const both = pollResult(three, [vote(1, 1, 'aaaa1111'), vote(2, 1, 'cccc3333')]);
    expect(both.winners.map((o) => o.text)).toEqual(['Pizza', 'Salad']);
    expect(both).toMatchObject({ cast: 2, votes: 1, share: 50 });
  });

  it("only fits a row posted once the poll had closed", () => {
    expect(pollEndFits(poll(), 1000, 4600)).toBe(true);
    expect(pollEndFits(poll(), 1000, 4550)).toBe(true); // a minute's leeway
    expect(pollEndFits(poll(), 1000, 3000)).toBe(false); // still running
    expect(pollEndFits(endPoll(poll(), 2000), 1000, 2001)).toBe(true);
    expect(pollEndFits({ ...poll(), duration: null }, 1000, 1e9)).toBe(false);
  });
});

describe('open polls', () => {
  const open = (multi = false) => ({ ...poll(multi), open: true, round: 'round111' });
  const added = (id, userId, answerId, text, extra = {}) =>
    ({ id, user_id: userId, emoji: answerKey({ id: answerId, round: 'round111', text }), timestamp: id, ...extra });
  const AUTHOR = 9;

  it('round-trips as open, and an edit keeps it so', () => {
    const text = pollMarkup(open());
    expect(parsePoll(text)).toMatchObject({ open: true, round: 'round111' });
    // Open without a round isn't open.
    expect(parsePoll(text.replace('"r":"round111"', '"r":"BAD"')).open).toBe(false);
    expect(editedPoll(open(), { question: 'Lunch?', options: open().options })).toMatchObject({ open: true, round: 'round111' });
  });

  it('only reads answers made exactly as the app makes them', () => {
    expect(parseAnswer(answerKey({ id: 'cccc3333', round: 'round111', text: 'Curry' }))).toEqual({ id: 'cccc3333', round: 'round111', text: 'Curry' });
    expect(parseAnswer('poll:+{"i":"cccc3333","r":"round111","t":" Curry"}')).toBeNull();
    expect(parseAnswer('poll:+{"i":"cccc3333","r":"round111","t":"Cur\\nry"}')).toBeNull();
    expect(parseAnswer('poll:+{"i":"cccc3333","r":"round111","t":"Curry","e":"🍛"}')).toBeNull();
    expect(parseAnswer(`poll:+{"i":"cccc3333","r":"round111","t":"${'x'.repeat(56)}"}`)).toBeNull();
    expect(parseAnswer('poll:+[1,2,3]')).toBeNull();
    expect(parseAnswer('poll:cccc3333')).toBeNull();
    // The longest fits an encrypted reaction (256 bytes), whatever the characters.
    for (const text of ['"'.repeat(55), '\\'.repeat(55), '€'.repeat(55), 'ü'.repeat(55), '😀'.repeat(27)]) {
      expect(new TextEncoder().encode(answerKey({ id: 'cccc3333', round: 'round111', text })).length).toBeLessThanOrEqual(256);
    }
  });

  it('adds answers in the order the server got them, without repeats, other rounds or late ones', () => {
    const reactions = [
      added(3, 2, 'dddd4444', 'Stew'),
      added(1, 1, 'cccc3333', 'Curry'),
      added(4, 3, 'eeee5555', 'curry'), // a repeat, ignoring case
      added(5, 3, 'ffff6666', 'pizza'), // the author's answer
      { ...added(6, 3, 'gggg7777', 'Pasta'), emoji: answerKey({ id: 'gggg7777', round: 'other111', text: 'Pasta' }) },
      added(7, 3, 'hhhh8888', 'Late', { timestamp: 5000 }),
    ];
    const full = pollWithAnswers(open(), reactions, AUTHOR, 4000);
    expect(full.options.map((o) => [o.text, o.addedBy])).toEqual([['Pizza', null], ['Soup', null], ['Curry', 1], ['Stew', 2]]);
    // Votes for them count like any other.
    expect(tallyVotes(full, [vote(10, 4, 'cccc3333')]).voters.cccc3333).toEqual([4]);
    // A poll that isn't open ignores them.
    expect(pollWithAnswers(poll(), reactions, AUTHOR).options).toHaveLength(2);
  });

  it('stops at MAX_POLL_OPTIONS answers', () => {
    const reactions = Array.from({ length: 25 }, (_, i) => added(i + 1, 1, `cccc${String(i).padStart(4, '0')}`, `Answer ${i}`));
    const full = pollWithAnswers(open(), reactions, AUTHOR);
    expect(full.options).toHaveLength(MAX_POLL_OPTIONS);
    expect(answerProblem(full, 'Another')).toMatch(/already has 20/);
  });

  it("says why an answer can't be added", () => {
    const full = pollWithAnswers(open(), [added(1, 1, 'cccc3333', 'Curry')], AUTHOR);
    expect(answerProblem(full, '   ')).toBeTruthy();
    expect(answerProblem(full, 'CURRY')).toMatch(/already/);
    expect(answerProblem(full, ' soup ')).toMatch(/already/);
    expect(answerProblem(full, 'Noodles')).toBeNull();
  });

  it("drops answers its author removed, but nobody else's removals", () => {
    const reactions = [
      added(1, 1, 'cccc3333', 'Curry'),
      added(2, 2, 'dddd4444', 'Stew'),
      { id: 3, user_id: AUTHOR, emoji: removalKey('cccc3333'), timestamp: 3 },
      { id: 4, user_id: 2, emoji: removalKey('dddd4444'), timestamp: 4 },
    ];
    expect(pollWithAnswers(open(), reactions, AUTHOR).options.map((o) => o.text)).toEqual(['Pizza', 'Soup', 'Stew']);
    expect(groupReactions(reactions)).toEqual([]); // none of them are chips
  });

  it("lets its creator, the author or a moderator remove one others haven't voted for", () => {
    const full = pollWithAnswers(open(), [added(1, 1, 'cccc3333', 'Curry'), added(2, AUTHOR, 'dddd4444', 'Stew')], AUTHOR);
    const [pizza, , curry, stew] = full.options;
    const can = (option, userId, votes = [], canModerate = false) =>
      canRemoveAnswer(option, { userId, authorId: AUTHOR, canModerate, voters: tallyVotes(full, votes).voters });
    expect(can(curry, 1)).toBe(true);
    expect(can(curry, 1, [vote(5, 1, 'cccc3333')])).toBe(true); // its creator's own vote
    expect(can(curry, 1, [vote(5, 2, 'cccc3333')])).toBe(false);
    expect(can(curry, AUTHOR)).toBe(true);
    expect(can(curry, 2)).toBe(false);
    expect(can(curry, 2, [], true)).toBe(true);
    expect(can(stew, 2, [], true)).toBe(false); // the author's
    expect(can(pizza, AUTHOR)).toBe(false); // the poll's own answers are edited instead
  });

  it('drops every vote and added answer when the question changes', () => {
    const next = editedPoll(open(), { question: 'Dinner?', options: open().options });
    expect(next.round).not.toBe('round111');
    expect(next.options.map((o) => o.id)).not.toContain('aaaa1111');
    const reactions = [added(1, 1, 'cccc3333', 'Curry'), vote(2, 2, 'aaaa1111'), vote(3, 2, 'cccc3333')];
    const full = pollWithAnswers(next, reactions, AUTHOR);
    expect(full.options).toHaveLength(2);
    expect(tallyVotes(full, reactions).cast).toBe(0);
    // Voting again clears your answers from before, as well as stale votes.
    const { remove } = planVotes(full, reactions, 1, [next.options[0].id]);
    expect(remove.map((r) => r.id)).toEqual([1]);
    // A poll that isn't open loses its votes on a new question too.
    expect(editedPoll(poll(), { question: 'Dinner?', options: poll().options }).options[0].id).not.toBe('aaaa1111');
  });
});
