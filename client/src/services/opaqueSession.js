// Runs one OPAQUE exchange (a login, a sign-up, a password check): `withOpaque(async (client) =>
// ...)` gives `client.startLogin(args)` and the rest of opaque.client's functions, each
// resolving to what OPAQUE returns. They run in a worker of their own (opaqueWorker.js) that ends
// when the callback has finished, so the ~70 MB its key stretching grows WebAssembly's memory by
// is given back, instead of staying with the page for as long as it's open (Memory and start-up
// in docs/desktop-and-site.md). Without workers (tests in Node) they run in the page, as before.
// OPAQUE (with its WebAssembly, ~400 kB) loads only then, not with the app on every start.

const NAMES = ['startLogin', 'finishLogin', 'startRegistration', 'finishRegistration'];

function workerClient() {
  const worker = new Worker(new URL('./opaqueWorker.js', import.meta.url), { type: 'module' });
  let nextId = 0;
  const waiting = new Map();
  const fail = (error) => {
    for (const call of waiting.values()) call.reject(error);
    waiting.clear();
  };
  worker.onmessage = ({ data }) => {
    const call = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error) call?.reject(new Error(data.error));
    else call?.resolve(data.result);
  };
  worker.onerror = (event) => {
    event.preventDefault?.();
    fail(new Error(event.message || 'The login worker failed'));
  };
  const client = Object.fromEntries(NAMES.map((name) => [name, (args) => new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, name, args });
  })]));
  return {
    client,
    close() {
      worker.terminate();
      fail(new Error('The login worker was closed'));
    },
  };
}

async function pageClient() {
  const opaque = await import('@serenity-kit/opaque');
  await opaque.ready;
  const client = Object.fromEntries(NAMES.map((name) => [name, async (args) => opaque.client[name](args)]));
  return { client, close() {} };
}

export async function withOpaque(run) {
  const { client, close } = typeof Worker === 'undefined' ? await pageClient() : workerClient();
  try {
    return await run(client);
  } finally {
    close();
  }
}
