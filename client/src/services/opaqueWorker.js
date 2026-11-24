// OPAQUE's client functions in a worker of their own (services/opaqueSession.js starts one per
// login, sign-up or password check and ends it after). Its key stretching (argon2id) grows the
// WebAssembly memory by about 70 MB, which WebAssembly never gives back: ending the worker
// does (Memory and start-up in docs/desktop-and-site.md).
// Messages: { id, name, args } with `name` one of opaque.client's functions; answers
// { id, result } or { id, error }.
import * as opaque from '@serenity-kit/opaque';

const FUNCTIONS = new Set(['startLogin', 'finishLogin', 'startRegistration', 'finishRegistration']);

self.onmessage = async ({ data: { id, name, args } }) => {
  try {
    if (!FUNCTIONS.has(name)) throw new Error(`unknown OPAQUE function ${name}`);
    await opaque.ready;
    self.postMessage({ id, result: opaque.client[name](args) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
