// The desktop app's own tests: its main-process logic that doesn't need Electron running.
module.exports = { test: { environment: 'node', include: ['test/**/*.test.js'] } };
