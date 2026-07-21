'use strict';

/**
 * @module NotificationService
 * @description Multi-channel notification dispatcher.
 *
 *  Supported channels (configured via env vars):
 *  ─ Slack     : Incoming Webhook
 *  ─ Telegram  : Bot API sendMessage
 *  ─ Generic   : HTTP POST to any webhook URL
 *
 *  All channels are optional. If none are configured, notifications are
 *  silently logged only. All failures are non-fatal (caught internally).
 */

const axios = require('axios');
const fs = require('fs').promises;
const config = require('./config');
const logger = require('./logger');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class NotificationService {
  /**
   * Sends a notification across all configured channels.
   *
   * @param {Object} payload
   * @param {string} payload.type       'completion' | 'error' | 'daily_report'
   * @param {string} payload.title      Short title
   * @param {string} payload.body       Detailed message body
   * @param {string} [payload.url]      Associated LMS URL
   * @param {string} [payload.screenshotPath] Path to screenshot file
   * @param {Object} [payload.data]     Additional structured data
   */
  async notify(payload) {
    logger.info(`[Notifications] Dispatching: ${payload.type} — "${payload.title}"`);

    const promises = [];

    if (config.notifications.slackWebhookUrl) {
      promises.push(this.#sendSlack(payload));
    }

    if (config.notifications.telegramBotToken && config.notifications.telegramChatId) {
      promises.push(this.#sendTelegram(payload));
    }

    if (config.notifications.genericWebhookUrl) {
      promises.push(this.#sendGenericWebhook(payload));
    }

    if (promises.length === 0) {
      logger.debug('[Notifications] No channels configured — logging only');
      logger.info(`[NOTIFICATION] ${payload.title}\n${payload.body}`);
      return;
    }

    const results = await Promise.allSettled(promises);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        logger.warn(`[Notifications] Channel ${i} failed: ${r.reason?.message || r.reason}`);
      }
    });
  }

  // ─── Convenience methods ───────────────────────────────────────────────────

  async notifyCompletion(job, result) {
    const durationStr = result.durationMinutes
      ? `${result.durationMinutes.toFixed(1)} minutes`
      : 'unknown duration';

    await this.notify({
      type: 'completion',
      title: '✅ Video Completed',
      body: [
        `*URL:* ${job.url}`,
        `*Duration:* ${durationStr}`,
        `*Session:* \`${result.sessionId}\``,
        `*LMS Status:* ${result.completionText || 'Verified'}`,
        `*Completed At:* ${result.completedAt}`,
      ].join('\n'),
      url: job.url,
      screenshotPath: result.screenshotPath,
      data: result,
    });
  }

  async notifyError(job, error, screenshotPath = null) {
    await this.notify({
      type: 'error',
      title: '❌ Video Watch Failed',
      body: [
        `*URL:* ${job.url}`,
        `*Error:* ${error.message || error}`,
        `*Time:* ${new Date().toISOString()}`,
      ].join('\n'),
      url: job.url,
      screenshotPath,
      data: { error: error.message || String(error) },
    });
  }

  async notifyDailyReport(stats, summaryText) {
    await this.notify({
      type: 'daily_report',
      title: '📊 Daily Progress Report',
      body: summaryText,
      data: stats,
    });
  }

  // ─── Channel implementations ───────────────────────────────────────────────

  async #sendSlack(payload) {
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: payload.title, emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: payload.body },
      },
    ];

    if (payload.url) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Link:* <${payload.url}|Open Course>`,
        },
      });
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `LMS Automator • ${new Date().toUTCString()}`,
        },
      ],
    });

    await this.#httpPost(
      config.notifications.slackWebhookUrl,
      { blocks },
      'Slack'
    );
  }

  async #sendTelegram(payload) {
    const token = config.notifications.telegramBotToken;
    const chatId = config.notifications.telegramChatId;
    const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;

    // Telegram uses MarkdownV2 — escape special chars
    const text = `*${escapeTgMd(payload.title)}*\n\n${escapeTgMd(payload.body)}`;

    await this.#httpPost(apiUrl, {
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
    }, 'Telegram');
  }

  async #sendGenericWebhook(payload) {
    await this.#httpPost(
      config.notifications.genericWebhookUrl,
      {
        type: payload.type,
        title: payload.title,
        body: payload.body,
        url: payload.url || null,
        timestamp: new Date().toISOString(),
        data: payload.data || null,
      },
      'GenericWebhook'
    );
  }

  /**
   * HTTP POST with retry logic.
   */
  async #httpPost(url, body, channelName) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await axios.post(url, body, {
          timeout: 10_000,
          headers: { 'Content-Type': 'application/json' },
        });
        logger.debug(`[Notifications] ${channelName} delivered ✓`);
        return;
      } catch (err) {
        logger.warn(`[Notifications] ${channelName} attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
      }
    }
    throw new Error(`${channelName} delivery failed after ${MAX_RETRIES} attempts`);
  }
}

/** Escapes Telegram MarkdownV2 reserved characters */
function escapeTgMd(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

module.exports = new NotificationService();
