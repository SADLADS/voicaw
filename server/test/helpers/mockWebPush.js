// Records web pushes instead of sending them. Like mockS3.js this swaps the module in
// Node's CJS require cache (index.js loads it with plain `require`, which vi.mock can't
// intercept); import it before requiring index.js.
const webPushPath = require.resolve('web-push');
const real = require(webPushPath);

export const sentPushes = [];
// Per-endpoint failures to simulate, e.g. { 'https://push.test/gone': 410 }.
export const pushFailures = {};

require.cache[webPushPath].exports = {
  ...real,
  setVapidDetails() {},
  async sendNotification(subscription, payload, options) {
    const status = pushFailures[subscription.endpoint];
    if (status) throw Object.assign(new Error(`push failed ${status}`), { statusCode: status });
    sentPushes.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
    return { statusCode: 201 };
  },
};

// Pushes are sent after the HTTP response; wait until `count` more have been recorded.
export async function waitForPushes(count, since = 0, timeoutMs = 2000) {
  const start = Date.now();
  while (sentPushes.length - since < count) {
    if (Date.now() - start > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return sentPushes.slice(since);
}
