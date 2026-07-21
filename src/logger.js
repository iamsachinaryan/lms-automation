'use strict';

/**
 * @module logger
 * @description Winston logger with daily log rotation, structured JSON output,
 *              and a pretty console transport for local development.
 */

const path = require('path');
const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const config = require('./config');

const { combine, timestamp, errors, json, colorize, printf } = format;

// ─── Console format (human-readable) ─────────────────────────────────────────

const consoleFormat = printf(({ level, message, timestamp: ts, sessionId, videoUrl, ...meta }) => {
  const sid = sessionId ? ` [${sessionId}]` : '';
  const url = videoUrl ? ` <${videoUrl}>` : '';
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} ${level}${sid}${url}: ${message}${extra}`;
});

// ─── File format (structured JSON) ───────────────────────────────────────────

const fileFormat = combine(
  timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  errors({ stack: true }),
  json()
);

// ─── Transports ──────────────────────────────────────────────────────────────

const logDir = path.resolve(config.storage.logDir);

const rotateOptions = {
  dirname: logDir,
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d',
  format: fileFormat,
};

const logger = createLogger({
  level: config.logLevel,
  defaultMeta: { service: 'lms-automator' },
  transports: [
    // Console — coloured, pretty
    new transports.Console({
      format: combine(
        colorize({ all: true }),
        timestamp({ format: 'HH:mm:ss' }),
        consoleFormat
      ),
    }),
    // All levels ≥ info
    new DailyRotateFile({
      ...rotateOptions,
      filename: 'combined-%DATE%.log',
    }),
    // Errors only (keeps a separate file for quick triage)
    new DailyRotateFile({
      ...rotateOptions,
      filename: 'error-%DATE%.log',
      level: 'error',
    }),
  ],
  exitOnError: false,
});

/**
 * Returns a child logger pre-bound with contextual metadata.
 * @param {Object} meta  e.g. { sessionId, videoUrl }
 */
logger.child = (meta) => logger.child(meta); // winston already supports this
// Expose a convenience factory so callers don't import winston directly
logger.forContext = (meta) =>
  createLogger({
    level: config.logLevel,
    defaultMeta: { service: 'lms-automator', ...meta },
    transports: logger.transports,
  });

module.exports = logger;
