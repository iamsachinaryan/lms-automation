'use strict';

/**
 * @module VideoWatcher
 * @description Orchestrates the complete video watching workflow for a single
 *              LMS course page. This is the core unit of work executed per video.
 *
 *  Workflow per video:
 *  1. Create isolated browser context
 *  2. Ensure authenticated session
 *  3. Navigate to course URL
 *  4. Locate & initialise YouTube iframe
 *  5. Handle any pre-roll ads
 *  6. Watch until completion threshold
 *  7. Verify completion on LMS page
 *  8. Take screenshot of completion state
 *  9. Emit completion event
 * 10. Clean up browser context
 */

const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const retry = require('p-retry');

const browserFactory = require('./browser-factory');
const sessionManager = require('./session-manager');
const youtubeController = require('./youtube-controller');
const humanBehavior = require('./human-behavior');
const progressTracker = require('./progress-tracker');
const config = require('./config');
const logger = require('./logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

class VideoWatcher {
  /**
   * Watches a single video to completion.
   *
   * @param {Object}   job
   * @param {string}   job.url               LMS course page URL
   * @param {number}   [job.expectedDuration] Expected video duration in minutes (optional hint)
   * @param {number}   [job.priority]         Queue priority
   * @param {Function} [job.onProgress]       Progress callback(currentSec, totalSec)
   * @param {Function} [job.onComplete]       Completion callback(result)
   * @param {Function} [job.onError]          Error callback(error)
   *
   * @returns {Promise<Object>} result object with completion details
   */
  async watch(job) {
    const sessionId = uuidv4().slice(0, 8);
    const log = logger.forContext({ sessionId, videoUrl: job.url });

    log.info(`[VideoWatcher] Starting watch job | URL: ${job.url}`);

    return retry(
      async (attemptNumber) => {
        log.info(`[VideoWatcher] Attempt ${attemptNumber}/${config.execution.maxRetries + 1}`);
        return this.#executeWatchSession(job, sessionId, log);
      },
      {
        retries: config.execution.maxRetries,
        minTimeout: config.execution.retryBaseDelayMs,
        factor: 2,
        randomize: true,
        onFailedAttempt: async (err) => {
          log.error(`[VideoWatcher] Attempt failed: ${err.message} (${err.retriesLeft} retries left)`);
          progressTracker.recordError(job.url, err.message);
        },
      }
    );
  }

  /**
   * Core session execution — runs inside the retry wrapper.
   */
  async #executeWatchSession(job, sessionId, log) {
    const { context } = await browserFactory.createContext();
    const page = await context.newPage();

    // Inject focus keep-alive BEFORE any navigation
    await humanBehavior.injectFocusKeepAlive(page);

    // Set a generous navigation timeout
    page.setDefaultNavigationTimeout(config.browser.navTimeout);
    page.setDefaultTimeout(config.browser.navTimeout);

    try {
      // ── Step 1: Authenticate ────────────────────────────────────────────
      log.info('[VideoWatcher] Ensuring authenticated session...');
      await sessionManager.ensureAuthenticated(page);
      await humanBehavior.randomDelay(1000, 2500);

      // ── Step 2: Navigate to course page ────────────────────────────────
      log.info(`[VideoWatcher] Navigating to course: ${job.url}`);
      await page.goto(job.url, {
        waitUntil: 'networkidle2',
        timeout: config.browser.navTimeout,
      });

      // Check if redirected to login (session expired between steps)
      if (sessionManager.isSessionExpired(page)) {
        log.warn('[VideoWatcher] Session expired mid-navigation — re-authenticating');
        await sessionManager.login(page);
        await page.goto(job.url, { waitUntil: 'networkidle2', timeout: config.browser.navTimeout });
      }

      await humanBehavior.randomDelay(2000, 4000);

      // ── Step 3: Wait for YouTube iframe ────────────────────────────────
      log.info('[VideoWatcher] Locating YouTube iframe...');

      // Some LMS pages load the iframe lazily after a button click
      await this.#triggerVideoLoad(page, log);

      const ytFrame = await youtubeController.findYouTubeFrame(page);

      // ── Step 4: Wait for player to be ready ────────────────────────────
      await youtubeController.waitForPlayerReady(ytFrame);

      // ── Step 5: Get video duration ──────────────────────────────────────
      let duration = await youtubeController.getDuration(ytFrame);

      if (!duration || duration < 10) {
        // Fall back to expectedDuration hint if player returns 0
        if (job.expectedDuration) {
          duration = job.expectedDuration * 60;
          log.warn(`[VideoWatcher] Player duration unavailable — using hint: ${job.expectedDuration}min`);
        } else {
          throw new Error('Could not determine video duration and no hint provided');
        }
      }

      const durationMin = (duration / 60).toFixed(1);
      log.info(`[VideoWatcher] Video duration: ${durationMin}min (${duration}s)`);

      // Record job start in tracker
      progressTracker.recordStart(job.url, duration, sessionId);

      // ── Step 6: Handle pre-roll ads ─────────────────────────────────────
      await youtubeController.handleAds(ytFrame);

      // ── Step 7: Begin playback ──────────────────────────────────────────
      await youtubeController.play(ytFrame, page);
      await sleep(2000);

      // ── Step 8: Watch loop ──────────────────────────────────────────────
      const progressCallback = (currentSec, totalSec) => {
        progressTracker.recordProgress(job.url, currentSec, totalSec);
        if (typeof job.onProgress === 'function') {
          job.onProgress(currentSec, totalSec, sessionId);
        }
      };

      await youtubeController.watchUntilComplete(
        ytFrame, page, duration, sessionId, progressCallback
      );

      // ── Step 9: Post-watch delay (let LMS mark completion) ──────────────
      log.info('[VideoWatcher] Watch complete — waiting for LMS to register completion...');
      await sleep(randInt(5000, 10000));

      // ── Step 10: Verify completion ──────────────────────────────────────
      const completionData = await this.#verifyCompletion(page, log);

      // ── Step 11: Screenshot ─────────────────────────────────────────────
      const screenshotPath = await this.#takeCompletionScreenshot(page, job.url, sessionId);

      // ── Step 12: Build result ───────────────────────────────────────────
      const result = {
        sessionId,
        url: job.url,
        durationSeconds: duration,
        durationMinutes: parseFloat(durationMin),
        completed: completionData.completed,
        completionText: completionData.text,
        screenshotPath,
        completedAt: new Date().toISOString(),
      };

      progressTracker.recordComplete(job.url, result);
      log.info(`[VideoWatcher] Job complete ✓ | Completion: ${completionData.text}`);

      if (typeof job.onComplete === 'function') {
        job.onComplete(result);
      }

      return result;
    } finally {
      // ── Always clean up context ──────────────────────────────────────────
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      log.debug('[VideoWatcher] Browser context closed');
    }
  }

  /**
   * Some LMS platforms hide the video behind a "Start Watching" button or
   * render the iframe only after user interaction. This method handles that.
   */
  async #triggerVideoLoad(page, log) {
    // Look for common "start" / "play" triggers
    const startButtonSelectors = [
      'button[class*="start"], button[class*="play"], button[class*="watch"]',
      '.start-video, .play-button, .watch-btn',
      '[data-action="play"], [data-action="start"]',
    ];

    for (const sel of startButtonSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          log.info(`[VideoWatcher] Found video trigger button: ${sel}`);
          await btn.click();
          await sleep(2000);
          return;
        }
      } catch { /* continue */ }
    }

    // Check if an iframe already exists — no trigger needed
    const hasIframe = await page.evaluate(() =>
      !!document.querySelector('iframe[src*="youtube"], iframe[src*="youtu.be"]')
    );

    if (!hasIframe) {
      // Scroll down to potentially trigger lazy-loaded content
      await page.evaluate(() => window.scrollBy(0, 400));
      await sleep(2000);
    }
  }

  /**
   * Verifies completion status on the LMS page after watching.
   * Looks for common completion indicators:
   *  - "X min / X min watched" text
   *  - "Completed" badge/icon
   *  - Progress bar at 100%
   *
   * @param {import('puppeteer').Page} page
   * @returns {{ completed: boolean, text: string }}
   */
  async #verifyCompletion(page, log) {
    const data = await page.evaluate(() => {
      // Pattern: "62m / 62m watched" or "1h 2m / 1h 2m watched"
      const bodyText = document.body.innerText || '';

      // Look for watched indicator
      const watchedMatch = bodyText.match(/(\d+[hm\s]+)\s*\/\s*(\d+[hm\s]+)\s*watched/i);
      const completedEl = document.querySelector(
        '.completed, .completion-badge, [class*="complete"], [data-status="completed"]'
      );
      const progressBar = document.querySelector('[role="progressbar"], .progress-bar');
      const progressValue = progressBar
        ? parseInt(progressBar.getAttribute('aria-valuenow') || progressBar.style.width || '0', 10)
        : null;

      let text = 'Unknown';
      let completed = false;

      if (watchedMatch && watchedMatch[1].trim() === watchedMatch[2].trim()) {
        text = `${watchedMatch[0]} — FULL COMPLETION`;
        completed = true;
      } else if (watchedMatch) {
        text = watchedMatch[0];
        completed = false;
      } else if (completedEl) {
        text = completedEl.innerText || 'Completion badge found';
        completed = true;
      } else if (progressValue !== null && progressValue >= 90) {
        text = `Progress bar: ${progressValue}%`;
        completed = progressValue >= 90;
      }

      return { completed, text, bodyText: bodyText.slice(0, 500) };
    });

    log.info(`[VideoWatcher] Completion check — text: "${data.text}" | completed: ${data.completed}`);

    if (!data.completed) {
      log.warn('[VideoWatcher] LMS did not report full completion; this may be expected if the platform takes time to update.');
    }

    return { completed: data.completed, text: data.text };
  }

  /**
   * Takes a full-page screenshot and saves it to the configured directory.
   *
   * @param {import('puppeteer').Page} page
   * @param {string} url
   * @param {string} sessionId
   * @returns {string} absolute path of screenshot
   */
  async #takeCompletionScreenshot(page, url, sessionId) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `completion_${sessionId}_${timestamp}.png`;
      const screenshotPath = path.resolve(config.storage.screenshotDir, filename);

      await page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info(`[VideoWatcher] Screenshot saved: ${screenshotPath}`);
      return screenshotPath;
    } catch (err) {
      logger.warn(`[VideoWatcher] Screenshot failed (non-fatal): ${err.message}`);
      return null;
    }
  }
}

module.exports = new VideoWatcher();
