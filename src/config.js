'use strict';

/**
 * @module config
 * @description Centralised, validated configuration loaded once at startup.
 *              All other modules import from here — never from dotenv directly.
 */

const path = require('path');
const fs = require('fs');
const Joi = require('joi');
require('dotenv').config();

// ─── Schema ──────────────────────────────────────────────────────────────────

const schema = Joi.object({
  lms: Joi.object({
    url: Joi.string().uri().default('https://lms.aimdip.org'),
    // LMS uses Registration Number (e.g. AIMDIP-INT2026/0162), not email
    email: Joi.string().min(1).required(),
    password: Joi.string().min(1).required(),
  }).required(),

  browser: Joi.object({
    headless: Joi.boolean().default(true),
    slowMo: Joi.number().integer().min(0).default(0),
    viewportWidth: Joi.number().integer().min(800).default(1280),
    viewportHeight: Joi.number().integer().min(600).default(800),
    navTimeout: Joi.number().integer().min(5000).default(60000),
    playerInitTimeout: Joi.number().integer().min(5000).default(30000),
  }).required(),

  execution: Joi.object({
    maxConcurrency: Joi.number().integer().min(1).max(10).default(2),
    maxRetries: Joi.number().integer().min(0).max(10).default(3),
    retryBaseDelayMs: Joi.number().integer().min(1000).default(5000),
    watchPercentage: Joi.number().min(50).max(100).default(92),
  }).required(),

  storage: Joi.object({
    sessionDir: Joi.string().default('./sessions'),
    screenshotDir: Joi.string().default('./screenshots'),
    logDir: Joi.string().default('./logs'),
  }).required(),

  notifications: Joi.object({
    slackWebhookUrl: Joi.string().uri().allow('', null).default(null),
    telegramBotToken: Joi.string().allow('', null).default(null),
    telegramChatId: Joi.string().allow('', null).default(null),
    genericWebhookUrl: Joi.string().uri().allow('', null).default(null),
  }).required(),

  health: Joi.object({
    port: Joi.number().integer().min(1024).max(65535).default(3001),
  }).required(),

  reporting: Joi.object({
    cron: Joi.string().default('59 23 * * *'),
  }).required(),

  logLevel: Joi.string()
    .valid('error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly')
    .default('info'),
});

// ─── Build raw config object from env vars ───────────────────────────────────

const raw = {
  lms: {
    url: process.env.LMS_URL,
    email: process.env.LMS_REGISTRATION_NO || process.env.LMS_EMAIL, // support both names
    password: process.env.LMS_PASSWORD,
  },
  browser: {
    headless: process.env.HEADLESS !== 'false',
    slowMo: parseInt(process.env.SLOW_MO || '0', 10),
    viewportWidth: parseInt(process.env.VIEWPORT_WIDTH || '1280', 10),
    viewportHeight: parseInt(process.env.VIEWPORT_HEIGHT || '800', 10),
    navTimeout: parseInt(process.env.NAV_TIMEOUT || '60000', 10),
    playerInitTimeout: parseInt(process.env.PLAYER_INIT_TIMEOUT || '30000', 10),
  },
  execution: {
    maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || '2', 10),
    maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
    retryBaseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS || '5000', 10),
    watchPercentage: parseFloat(process.env.WATCH_PERCENTAGE || '92'),
  },
  storage: {
    sessionDir: process.env.SESSION_DIR || './sessions',
    screenshotDir: process.env.SCREENSHOT_DIR || './screenshots',
    logDir: process.env.LOG_DIR || './logs',
  },
  notifications: {
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || null,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || null,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
    genericWebhookUrl: process.env.GENERIC_WEBHOOK_URL || null,
  },
  health: {
    port: parseInt(process.env.HEALTH_PORT || '3001', 10),
  },
  reporting: {
    cron: process.env.REPORT_CRON || '59 23 * * *',
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};

// ─── Validate ─────────────────────────────────────────────────────────────────

const { error, value: config } = schema.validate(raw, { abortEarly: false });

if (error) {
  // Cannot use logger here (not yet initialised), so console.error is intentional
  console.error('[CONFIG] Fatal configuration error:');
  error.details.forEach((d) => console.error(' •', d.message));
  process.exit(1);
}

// ─── Ensure storage directories exist ─────────────────────────────────────────

[config.storage.sessionDir, config.storage.screenshotDir, config.storage.logDir].forEach(
  (dir) => {
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
  }
);

module.exports = Object.freeze(config);
