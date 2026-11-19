// One queue for all picture processing (profile pictures, banners, guild icons, emoji, bots',
// webhooks' and imported authors' pictures; security audit, 2026-11-18). Each job holds one of
// libuv's 4 worker threads, which also do DNS lookups and file reads for the whole server, and
// an animation can take seconds and hundreds of MB: so at most MAX_RUNNING at once, a short
// waiting list, and beyond it an ImageBusyError (answered 429).

const MAX_RUNNING = 2;
const MAX_WAITING = 20;

class ImageBusyError extends Error {
  constructor() {
    super('The server is busy with other pictures. Try again in a moment.');
    this.status = 429;
  }
}

let running = 0;
const waiting = [];

// Resolves to what `task` resolves to, once there's room.
async function imageJob(task) {
  if (running >= MAX_RUNNING) {
    if (waiting.length >= MAX_WAITING) throw new ImageBusyError();
    await new Promise((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

module.exports = { imageJob, ImageBusyError, MAX_RUNNING, MAX_WAITING };
