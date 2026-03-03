import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';
const enablePretty = process.env.NANOCLAW_PRETTY_LOGS === '1';
const loggerConfig = enablePretty
  ? { level, transport: { target: 'pino-pretty', options: { colorize: true } } }
  : { level };

export const logger = pino(loggerConfig);

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
