import { describe, it, expect } from 'vitest';
import {
  generateECDH_P256_PEM,
  encryptPrivateKey,
  decryptPrivateKey,
  deriveSharedKey,
  encryptMessage,
  decryptMessage,
  decryptMessagesBatch,
} from './encryptionService';

describe('generateECDH_P256_PEM', () => {
  it('produces PEM-wrapped public and private keys', async () => {
    const { publicPEM, privatePEM } = await generateECDH_P256_PEM();

    expect(publicPEM).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
    expect(publicPEM).toMatch(/-----END PUBLIC KEY-----\n$/);
    expect(privatePEM).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(privatePEM).toMatch(/-----END PRIVATE KEY-----\n$/);
  });

  it('generates a fresh keypair on every call', async () => {
    const a = await generateECDH_P256_PEM();
    const b = await generateECDH_P256_PEM();
    expect(a.privatePEM).not.toBe(b.privatePEM);
  });
});

describe('encryptPrivateKey / decryptPrivateKey', () => {
  it('round-trips the private key PEM under a password', async () => {
    const { privatePEM } = await generateECDH_P256_PEM();
    const password = 'correct horse battery staple';

    const wrapped = await encryptPrivateKey(privatePEM, password);
    expect(wrapped).not.toContain(privatePEM);

    const unwrapped = await decryptPrivateKey(wrapped, password);
    expect(unwrapped).toBe(privatePEM);
  });

  it('fails to decrypt with the wrong password', async () => {
    const { privatePEM } = await generateECDH_P256_PEM();
    const wrapped = await encryptPrivateKey(privatePEM, 'right-password');

    await expect(decryptPrivateKey(wrapped, 'wrong-password')).rejects.toThrow();
  });

  it('produces different ciphertext each time (random salt/iv)', async () => {
    const { privatePEM } = await generateECDH_P256_PEM();
    const wrapped1 = await encryptPrivateKey(privatePEM, 'pw');
    const wrapped2 = await encryptPrivateKey(privatePEM, 'pw');
    expect(wrapped1).not.toBe(wrapped2);
  });
});

describe('deriveSharedKey', () => {
  it('produces the same shared secret from both sides of an ECDH exchange', async () => {
    const alice = await generateECDH_P256_PEM();
    const bob = await generateECDH_P256_PEM();

    const aliceSharedKey = await deriveSharedKey(alice.privatePEM, bob.publicPEM);
    const bobSharedKey = await deriveSharedKey(bob.privatePEM, alice.publicPEM);

    const message = 'shared secrets should match on both ends';
    const ciphertext = await encryptMessage(message, aliceSharedKey);
    const plaintext = await decryptMessage(ciphertext, bobSharedKey);

    expect(plaintext).toBe(message);
  });

  it('produces a different shared secret with an unrelated keypair', async () => {
    const alice = await generateECDH_P256_PEM();
    const bob = await generateECDH_P256_PEM();
    const mallory = await generateECDH_P256_PEM();

    const aliceSharedKey = await deriveSharedKey(alice.privatePEM, bob.publicPEM);
    const malloryKeyClaimingToBeBob = await deriveSharedKey(mallory.privatePEM, alice.publicPEM);

    const ciphertext = await encryptMessage('hello bob', aliceSharedKey);
    await expect(decryptMessage(ciphertext, malloryKeyClaimingToBeBob)).rejects.toThrow();
  });
});

describe('encryptMessage / decryptMessage', () => {
  it('round-trips plaintext through AES-GCM', async () => {
    const alice = await generateECDH_P256_PEM();
    const bob = await generateECDH_P256_PEM();
    const key = await deriveSharedKey(alice.privatePEM, bob.publicPEM);

    const message = 'hello, encrypted world! 🔒';
    const ciphertext = await encryptMessage(message, key);
    expect(ciphertext).not.toContain(message);

    const plaintext = await decryptMessage(ciphertext, key);
    expect(plaintext).toBe(message);
  });

  it('produces different ciphertext for the same message due to random IV', async () => {
    const alice = await generateECDH_P256_PEM();
    const bob = await generateECDH_P256_PEM();
    const key = await deriveSharedKey(alice.privatePEM, bob.publicPEM);

    const c1 = await encryptMessage('same message', key);
    const c2 = await encryptMessage('same message', key);
    expect(c1).not.toBe(c2);
  });

  it('rejects tampered ciphertext', async () => {
    const alice = await generateECDH_P256_PEM();
    const bob = await generateECDH_P256_PEM();
    const key = await deriveSharedKey(alice.privatePEM, bob.publicPEM);

    const ciphertext = await encryptMessage('untampered', key);
    const tampered = ciphertext.slice(0, -4) + (ciphertext.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');

    await expect(decryptMessage(tampered, key)).rejects.toThrow();
  });
});

describe('decryptMessagesBatch', () => {
  it('decrypts a batch of messages and their parent replies', async () => {
    const alice = await generateECDH_P256_PEM();
    const bob = await generateECDH_P256_PEM();
    const key = await deriveSharedKey(alice.privatePEM, bob.publicPEM);

    const parentContent = await encryptMessage('parent message', key);
    const childContent = await encryptMessage('child reply', key);

    const messages = [
      { id: 1, content: parentContent },
      { id: 2, content: childContent, parent_message_id: 1, parent_content: parentContent },
    ];

    const results = await decryptMessagesBatch(messages, key);

    expect(results[0].plaintext).toBe('parent message');
    expect(results[1].plaintext).toBe('child reply');
    expect(results[1].parent_plaintext).toBe('parent message');
  });

  it('tolerates individual decryption failures without throwing', async () => {
    const alice = await generateECDH_P256_PEM();
    const bob = await generateECDH_P256_PEM();
    const key = await deriveSharedKey(alice.privatePEM, bob.publicPEM);

    const goodContent = await encryptMessage('this one works', key);

    const messages = [
      { id: 1, content: 'not-valid-base64-ciphertext!!!' },
      { id: 2, content: goodContent },
    ];

    const results = await decryptMessagesBatch(messages, key);

    expect(results[0].plaintext).toBeNull();
    expect(results[1].plaintext).toBe('this one works');
  });
});
