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

  it('runs transactions started together one after another', async () => {
    const slow = (v) => db.transaction(async () => {
      await db.run('INSERT INTO db_test (v) VALUES (?)', [v]);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // Three at once: before, the second failed ("within a transaction") and cleared the first's
    // turn, so the third and a plain insert ran inside the first, which then rolled back.
    const failing = db.transaction(async () => {
      await db.run('INSERT INTO db_test (v) VALUES (?)', ['rolled back']);
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error('undo');
    });
    const results = await Promise.allSettled([failing, slow('t2'), slow('t3'), db.run('INSERT INTO db_test (v) VALUES (?)', ['plain'])]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(await values()).toEqual(['plain', 't2', 't3']);
    await db.run('DELETE FROM db_test');
  });

  it('never runs a plain query inside a transaction that started meanwhile', async () => {
    const plain = db.run('INSERT INTO db_test (v) VALUES (?)', ['plain']);
    const tx = db.transaction(async () => {
      await db.run('INSERT INTO db_test (v) VALUES (?)', ['tx']);
      throw new Error('undo');
    });
    await expect(tx).rejects.toThrow('undo');
    await plain;
    expect(await values()).toEqual(['plain']);
    await db.run('DELETE FROM db_test');
  });

  it('refuses objects as parameters instead of shifting the others', async () => {
    await expect(db.get('SELECT ? AS a, ? AS b', [{}, 7])).rejects.toThrow(/parameter/);
    await expect(db.get('SELECT ? AS a, ? AS b', [[], 7])).rejects.toThrow(/parameter/);
    await expect(db.get('SELECT ? AS a', [{ x: 1 }])).rejects.toThrow(/parameter/);
    // Buffers, typed arrays and null still bind.
    expect(await db.get('SELECT length(?) AS n, ? AS z', [Buffer.from('abc'), null])).toEqual({ n: 3, z: null });
    expect(await db.get('SELECT length(?) AS n', [new Uint8Array(4)])).toEqual({ n: 4 });
  });
});
