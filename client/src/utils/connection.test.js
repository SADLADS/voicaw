import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectionTrouble, getConnection, noteRequestAnswered, noteRequestUnanswered, noteSocketState, resetConnection,
} from './connection';

describe('connection', () => {
  beforeEach(() => resetConnection());

  it("doesn't count the socket until it has been online (the app starting)", () => {
    noteSocketState('connecting');
    expect(connectionTrouble()).toBe(false);
    noteSocketState('online');
    expect(connectionTrouble()).toBe(false);
    noteSocketState('connecting', 1234);
    expect(connectionTrouble()).toBe(true);
    expect(getConnection().nextAttemptAt).toBe(1234);
    noteSocketState('online');
    expect(connectionTrouble()).toBe(false);
  });

  it('counts a request without an answer until one gets an answer, or the socket opens', () => {
    noteRequestUnanswered();
    expect(connectionTrouble()).toBe(true);
    noteRequestAnswered();
    expect(connectionTrouble()).toBe(false);
    noteRequestUnanswered();
    noteSocketState('online');
    expect(connectionTrouble()).toBe(false);
  });
});
