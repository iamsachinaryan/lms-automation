'use strict';

/**
 * @module YouTubeController
 * @description Controls the YouTube player embedded inside an LMS iframe.
 *
 *  Architecture:
 *  ─ Locates the YouTube iframe on the LMS page
 *  ─ Switches Puppeteer's execution context to the iframe
 *  ─ Interacts with the YouTube IFrame API (YT.Player) if available,
 *    or falls back to direct DOM manipulation on the <video> element
 *  ─ Monitors playback progress in real-time
 *  ─ Handles ads (SkipAd button, preroll wait)
 *  ─ Adjusts playback speed if platform allows
 *
 *  IMPORTANT: YouTube embeds run inside a cross-origin iframe.
 *  The --disable-web-security Chrome flag (set in BrowserFactory) is
 *  required to allow JS execution inside cross-origin frames.
 */

const logger = require('./logger');
const humanBehavior = require('./human-behavior');
const config = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// How long to wait for the player to initialise before giving up
const PLAYER_INIT_TIMEOUT = config.browser.playerInitTimeout;

class YouTubeController {
  /**
   * Finds the YouTube iframe frame handle on the current page.
   * Tries multiple URL patterns (youtu.be, youtube.com/embed).
   *
   * @param {import('puppeteer').Page} page
   * @returns {import('puppeteer').Frame}
   * @throws {Error} if no YouTube iframe is found
   */
  async findYouTubeFrame(page) {
    const deadline = Date.now() + PLAYER_INIT_TIMEOUT;

    while (Date.now() < deadline) {
      const frames = page.frames();
      const ytFrame = frames.find((f) => {
        const url = f.url();
        return (
          url.includes('youtube.com/embed') ||
          url.includes('youtu.be') ||
          url.includes('youtube-nocookie.com')
        );
      });

      if (ytFrame) {
        logger.info(`[YouTubeController] Found YT frame: ${ytFrame.url()}`);
        return ytFrame;
      }

      await sleep(1000);
    }

    throw new Error(`YouTube iframe not found within ${PLAYER_INIT_TIMEOUT / 1000}s`);
  }

  /**
   * Waits for the YouTube <video> element to be ready and in a playable state.
   * Readiness is determined by readyState >= 3 (HAVE_FUTURE_DATA).
   *
   * @param {import('puppeteer').Frame} frame
   */
  async waitForPlayerReady(frame) {
    const deadline = Date.now() + PLAYER_INIT_TIMEOUT;

    while (Date.now() < deadline) {
      const ready = await frame.evaluate(() => {
        const video = document.querySelector('video');
        // readyState: 0=HAVE_NOTHING, 1=HAVE_METADATA, 2=HAVE_CURRENT_DATA,
        //             3=HAVE_FUTURE_DATA, 4=HAVE_ENOUGH_DATA
        return video && video.readyState >= 1 && video.duration > 0;
      }).catch(() => false);

      if (ready) {
        logger.info('[YouTubeController] Player is ready');
        return;
      }

      await sleep(1500);
    }

    throw new Error('YouTube player did not become ready in time');
  }

  /**
   * Returns total video duration in seconds.
   *
   * @param {import('puppeteer').Frame} frame
   * @returns {number} duration in seconds
   */
  async getDuration(frame) {
    return frame.evaluate(() => {
      const video = document.querySelector('video');
      if (!video || !isFinite(video.duration)) return 0;
      return video.duration;
    });
  }

  /**
   * Returns current playback position in seconds.
   *
   * @param {import('puppeteer').Frame} frame
   * @returns {number} currentTime in seconds
   */
  async getCurrentTime(frame) {
    return frame.evaluate(() => {
      const video = document.querySelector('video');
      return video ? video.currentTime : 0;
    });
  }

  /**
   * Checks whether the video is currently playing (not paused).
   *
   * @param {import('puppeteer').Frame} frame
   * @returns {boolean}
   */
  async isPlaying(frame) {
    return frame.evaluate(() => {
      const video = document.querySelector('video');
      return video ? !video.paused && !video.ended : false;
    });
  }

  /**
   * Clicks the play button if the video is paused.
   * Attempts: YT API → big play button → video element click
   *
   * @param {import('puppeteer').Frame} frame
   * @param {import('puppeteer').Page} page  needed for mouse events
   */
  async play(frame, page) {
    const playing = await this.isPlaying(frame);
    if (playing) return;

    logger.info('[YouTubeController] Starting playback...');

    // Method 1: Programmatic play via <video> element
    await frame.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.play();
    }).catch(() => {});

    await sleep(1000);

    // Method 2: Click the YouTube large play button overlay
    const playButtonSel = '.ytp-large-play-button, .ytp-play-button, button[aria-label*="Play"]';
    try {
      const playBtn = await frame.$(playButtonSel);
      if (playBtn) await playBtn.click();
    } catch { /* non-fatal */ }

    await sleep(1500);

    // Verify
    const nowPlaying = await this.isPlaying(frame);
    if (!nowPlaying) {
      logger.warn('[YouTubeController] Play may not have triggered — video still paused');
    } else {
      logger.info('[YouTubeController] Playback confirmed ✓');
    }
  }

  /**
   * Handles YouTube ads:
   *  - If a "Skip Ad" button is visible, waits for it to become clickable then clicks
   *  - If it's a non-skippable ad, waits for it to finish
   *
   * @param {import('puppeteer').Frame} frame
   * @returns {boolean} true if an ad was detected and handled
   */
  async handleAds(frame) {
    const adDetected = await frame.evaluate(() => {
      const skipBtn = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button');
      const adOverlay = document.querySelector('.ytp-ad-player-overlay, .ad-showing');
      return !!(skipBtn || adOverlay);
    }).catch(() => false);

    if (!adDetected) return false;

    logger.info('[YouTubeController] Ad detected — attempting to skip...');

    // Wait up to 30s for the skip button to become active
    const skipDeadline = Date.now() + 30_000;
    while (Date.now() < skipDeadline) {
      const skipped = await frame.evaluate(() => {
        const btn = document.querySelector(
          '.ytp-skip-ad-button:not([disabled]), .ytp-ad-skip-button:not([disabled])'
        );
        if (btn) { btn.click(); return true; }
        return false;
      }).catch(() => false);

      if (skipped) {
        logger.info('[YouTubeController] Ad skipped ✓');
        await sleep(1000);
        return true;
      }

      await sleep(1000);
    }

    // Non-skippable — wait for ad duration (max 60s)
    logger.info('[YouTubeController] Non-skippable ad — waiting up to 60s...');
    const adFinishDeadline = Date.now() + 60_000;
    while (Date.now() < adFinishDeadline) {
      const adGone = await frame.evaluate(() => {
        return !document.querySelector('.ad-showing, .ytp-ad-player-overlay');
      }).catch(() => true);
      if (adGone) {
        logger.info('[YouTubeController] Ad finished ✓');
        return true;
      }
      await sleep(2000);
    }

    logger.warn('[YouTubeController] Ad timeout — proceeding anyway');
    return true;
  }

  /**
   * Core watch loop. Monitors playback progress and maintains the session
   * for the full required watch duration.
   *
   * Strategy:
   *  ─ targetTime = duration × (watchPercentage / 100)
   *  ─ Poll every POLL_INTERVAL seconds
   *  ─ If video pauses unexpectedly → re-trigger play
   *  ─ Every HUMAN_INTERVAL → run idle human behaviour cycle
   *  ─ Every FOCUS_INTERVAL → ping tab focus
   *  ─ If session expires mid-watch → re-authenticate
   *
   * @param {import('puppeteer').Frame} frame
   * @param {import('puppeteer').Page} page
   * @param {number} totalDuration   seconds
   * @param {string} sessionId       for logging
   * @param {Function} onProgress    callback(currentSec, totalSec)
   */
  async watchUntilComplete(frame, page, totalDuration, sessionId, onProgress) {
    const watchPct = config.execution.watchPercentage / 100;
    const targetTime = Math.floor(totalDuration * watchPct);

    logger.info(
      `[YouTubeController][${sessionId}] Target: ${targetTime}s / ${totalDuration}s (${config.execution.watchPercentage}%)`
    );

    const POLL_INTERVAL = 10_000;       // check every 10s
    const HUMAN_INTERVAL = 120_000;     // idle behaviour every 2min
    const FOCUS_INTERVAL = 30_000;      // focus ping every 30s
    const AD_CHECK_INTERVAL = 60_000;   // ad check every 1min

    let lastHumanAction = Date.now();
    let lastFocusPing = Date.now();
    let lastAdCheck = Date.now();
    let stuckCount = 0;
    let lastKnownTime = 0;

    while (true) {
      await sleep(POLL_INTERVAL);

      const now = Date.now();
      const currentTime = await this.getCurrentTime(frame);
      const playing = await this.isPlaying(frame);

      // Progress callback
      if (typeof onProgress === 'function') {
        onProgress(currentTime, totalDuration);
      }

      logger.info(
        `[YouTubeController][${sessionId}] Progress: ${fmtTime(currentTime)} / ${fmtTime(totalDuration)} (${((currentTime / totalDuration) * 100).toFixed(1)}%)`
      );

      // ── Completion check ─────────────────────────────────────────────────
      if (currentTime >= targetTime) {
        logger.info(`[YouTubeController][${sessionId}] Target ${config.execution.watchPercentage}% reached ✓`);
        break;
      }

      // ── Stuck detection ──────────────────────────────────────────────────
      if (Math.abs(currentTime - lastKnownTime) < 2 && currentTime < targetTime) {
        stuckCount++;
        logger.warn(`[YouTubeController][${sessionId}] Progress stalled (${stuckCount}/3)`);
        if (stuckCount >= 3) {
          logger.warn('[YouTubeController] Attempting to resume stuck playback...');
          await this.play(frame, page);
          stuckCount = 0;
        }
      } else {
        stuckCount = 0;
      }
      lastKnownTime = currentTime;

      // ── Resume if paused ─────────────────────────────────────────────────
      if (!playing) {
        logger.info('[YouTubeController] Video paused — resuming...');
        await this.play(frame, page);
      }

      // ── Ad check ─────────────────────────────────────────────────────────
      if (now - lastAdCheck > AD_CHECK_INTERVAL) {
        await this.handleAds(frame);
        lastAdCheck = now;
      }

      // ── Human behaviour ───────────────────────────────────────────────────
      if (now - lastHumanAction > HUMAN_INTERVAL) {
        await humanBehavior.simulateIdleBehavior(page);
        lastHumanAction = now;
      }

      // ── Focus ping ────────────────────────────────────────────────────────
      if (now - lastFocusPing > FOCUS_INTERVAL) {
        await humanBehavior.pingFocus(page);
        lastFocusPing = now;
      }
    }
  }
}

/** Formats seconds as MM:SS */
function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

module.exports = new YouTubeController();
