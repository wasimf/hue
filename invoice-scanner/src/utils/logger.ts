import pino, { type Logger } from 'pino';
import { getConfig } from '../config/index.js';

let instance: Logger | null = null;

export function getLogger(): Logger {
  if (!instance) {
    const config = getConfig();
    instance = pino({
      level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
      ...(config.LOG_PRETTY
        ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }
        : {}),
    });
  }
  return instance;
}
