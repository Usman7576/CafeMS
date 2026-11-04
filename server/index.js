require("dotenv").config({ quiet: true });

const { loadConfig, ConfigError } = require("./config");
const { createApp } = require("./app");
const { createClient, ensureIndexes } = require("./db");
const { createLogger } = require("./lib/logger");

async function start() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`CafeMS will not start: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config);
  const client = createClient(config);
  await client.connect();
  const db = client.db(config.mongoDb);
  await ensureIndexes(db);

  const server = createApp({ config, db, logger }).listen(config.port, () => {
    logger.info(`CafeMS running at ${config.appOrigin}`);
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;

  const stop = () => server.close(() => client.close().finally(() => process.exit(0)));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

start().catch((error) => {
  console.error(`CafeMS could not start: ${error.message}`);
  process.exitCode = 1;
});
