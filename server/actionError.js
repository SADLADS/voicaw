// An action refused (a guild action shared by the app's routes and the bot API, routes/botApi.js):
// `status` is the HTTP status, `message` what the app shows, `code` Discord's JSON error code
// for the bot API (50013 Missing Permissions when not given and status is 403, else 50035).
class ActionError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code ?? (status === 403 ? 50013 : status === 404 ? 10000 : 50035);
  }
}

// Express handler wrapper for app routes: an ActionError becomes { error } with its status.
const withActionErrors = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (err instanceof ActionError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
};

module.exports = { ActionError, withActionErrors };
