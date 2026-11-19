import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createLoginStore } = require('../loginStore.js');

describe('the saved login', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-login-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.c2ln';

  it('knows nothing until a login is saved', () => {
    expect(createLoginStore(dir).get()).toEqual({ known: false, token: null });
  });

  it('keeps the token across restarts, and a logout as null', () => {
    createLoginStore(dir).set(token);
    expect(createLoginStore(dir).get()).toEqual({ known: true, token });
    createLoginStore(dir).set(null);
    expect(createLoginStore(dir).get()).toEqual({ known: true, token: null });
    expect(fs.existsSync(path.join(dir, 'login.json.tmp'))).toBe(false);
  });

  it('refuses anything that is not a token', () => {
    const store = createLoginStore(dir);
    store.set(token);
    for (const bad of [42, {}, '', 'has spaces', 'x'.repeat(5000), undefined]) expect(store.set(bad)).toBe(false);
    expect(createLoginStore(dir).get().token).toBe(token);
  });

  it('treats a damaged or unknown file as nothing saved', () => {
    fs.writeFileSync(path.join(dir, 'login.json'), '{not json');
    expect(createLoginStore(dir).get().known).toBe(false);
    fs.writeFileSync(path.join(dir, 'login.json'), JSON.stringify({ v: 2, token }));
    expect(createLoginStore(dir).get().known).toBe(false);
  });
});
