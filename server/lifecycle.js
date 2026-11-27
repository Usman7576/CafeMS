// Graceful shutdown: stop the background jobs, let requests in progress finish, then close the database.
// A request that never finishes cannot block it: after forceAfterMs the process exits anyway.
function createShutdown({ server, client, stopWorkers, logger, exit = (code) => process.exit(code), forceAfterMs = 10000 }) {
  let stopping = false;
  return function stop() {
    if (stopping) return false;
    stopping = true;
    if (logger) logger.info("Shutting down");
    stopWorkers();
    setTimeout(() => exit(1), forceAfterMs).unref();
    server.close(() => Promise.resolve(client.close()).finally(() => exit(0)));
    server.closeIdleConnections();
    return true;
  };
}

module.exports = { createShutdown };
