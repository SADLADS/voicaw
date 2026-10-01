import { describe, it, expect, beforeAll } from 'vitest';

// db.js alone (in-memory database from setupEnv.js): the query helpers and transactions.
const db = require('../db');

const values = async () => (await db.all('SELECT v FROM db_test ORDER BY v')).map((r) => r.v);

describe('db', () => {
  beforeAll(async () => {
    await db.run('CREATE TABLE db_test (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT UNIQUE)');
  });

  it('runs queries like the old driver did', async () => {
    const { lastID, changes } = await db.run('INSERT INTO db_test (v) VALUES (?)', ['a']);
    expect(changes).toBe(1);
    expect(await db.get('SELECT v FROM db_test WHERE id = ?', [lastID])).toEqual({ v: 'a' });
    // Rows are plain objects; undefined binds as NULL, booleans as 1/0.
    expect(Object.getPrototypeOf(await db.get('SELECT 1 AS x'))).toBe(Object.prototype);
    expect(await db.get('SELECT ? AS u, ? AS t, ? AS f', [undefined, true, false])).toEqual({ u: null, t: 1, f: 0 });
    await db.run('DELETE FROM db_test');
  });

  it('keeps all of a transaction, or none of it', async () => {
    await db.transaction(async () => {
      await db.run('INSERT INTO db_test (v) VALUES (?)', ['kept1']);
      await db.run('INSERT INTO db_test (v) VALUES (?)', ['kept2']);
    });
    await expect(db.transaction(async () => {
      await db.run('INSERT INTO db_test (v) VALUES (?)', ['lost']);
      await db.run('INSERT INTO db_test (v) VALUES (?)', ['kept1']); // UNIQUE
    })).rejects.toThrow(/UNIQUE/);
    expect(await values()).toEqual(['kept1', 'kept2']);
    await db.run('DELETE FROM db_test');
  });

  it('undoes only a failed nested transaction', async () => {
    await db.transaction(async () => {
      await db.run('INSERT INTO db_test (v) VALUES (?)', ['outer']);
      await db.transaction(async () => {
        await db.run('INSERT INTO db_test (v) VALUES (?)', ['inner']);
        throw new Error('inner failed');
      }).catch(() => {});
      await db.transaction(() => db.run('INSERT INTO db_test (v) VALUES (?)', ['inner2']));
    });
    expect(await values()).toEqual(['inner2', 'outer']);
    await db.run('DELETE FROM db_test');
  });

  it('makes other queries wait for an open transaction', async () => {
    const seen = [];
    const tx = db.transaction(async () => {
      await db.run('INSERT INTO db_test (v) VALUES (?)', ['x']);
      await new Promise((resolve) => setTimeout(resolve, 30)); // something slow mid-transaction
      await db.run('UPDATE db_test SET v = ? WHERE v = ?', ['y', 'x']);
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const outside = db.get('SELECT v FROM db_test').then((row) => seen.push(row.v));
    const second = db.transaction(() => db.run('UPDATE db_test SET v = ? WHERE v = ?', ['z', 'y']));
    await Promise.all([tx, outside, second]);
    expect(seen).toEqual(['y']); // never the half-done 'x'
    expect(await values()).toEqual(['z']);
    await db.run('DELETE FROM db_test');
  });
});
