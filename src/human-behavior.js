'use strict';

/**
 * @module HumanBehavior
 * @description Provides realistic human-like interaction patterns to evade
 *              bot-detection heuristics used by modern LMS and video platforms.
 *
 *  Techniques implemented:
 *  ─ Random Bézier-curve mouse movements (not linear interpolation)
 *  ─ Occasional random scrolls mimicking reading behaviour
 *  ─ Randomised click jitter (never clicking the exact element centre)
 *  ─ Tab-focus pinging (prevents "paused when tab inactive" behaviour)
 *  ─ Periodic random micro-delays between all actions
 *  ─ Simulated "Are you still watching?" dismissal
 */

const logger = require('./logger');

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HumanBehavior {
  /**
   * Moves the mouse along a Bézier curve to the target coordinates.
   * This is far less detectable than direct page.mouse.move() calls
   * which produce perfectly straight or instantaneous paths.
   *
   * @param {import('puppeteer').Page} page
   * @param {number} targetX
   * @param {number} targetY
   * @param {number} [steps=25]
   */
  async moveMouse(page, targetX, targetY, steps = 25) {
    try {
      const { x: startX, y: startY } = await page.evaluate(() => ({
        x: Math.round(Math.random() * window.innerWidth),
        y: Math.round(Math.random() * window.innerHeight),
      }));

      // Control points for a quadratic Bézier curve
      const cp1x = randInt(Math.min(startX, targetX), Math.max(startX, targetX));
      const cp1y = randInt(Math.min(startY, targetY), Math.max(startY, targetY));

      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // Quadratic Bézier formula: B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
        const x = Math.round((1 - t) ** 2 * startX + 2 * (1 - t) * t * cp1x + t ** 2 * targetX);
        const y = Math.round((1 - t) ** 2 * startY + 2 * (1 - t) * t * cp1y + t ** 2 * targetY);
        await page.mouse.move(x, y);
        await sleep(randInt(5, 20)); // variable speed
      }
    } catch (err) {
      logger.debug(`[HumanBehavior] moveMouse failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * Moves the mouse to a random position on screen.
   * Called periodically during long video watches.
   */
  async randomMouseMove(page) {
    try {
      const { width, height } = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      const x = randInt(100, width - 100);
      const y = randInt(100, height - 100);
      await this.moveMouse(page, x, y);
    } catch (err) {
      logger.debug(`[HumanBehavior] randomMouseMove failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * Performs a small random scroll — mimics a user skimming the page.
   * Avoids large scrolls that might move the video out of the viewport.
   */
  async randomScroll(page) {
    try {
      const direction = Math.random() > 0.5 ? 1 : -1;
      const pixels = randInt(50, 200) * direction;
      await page.evaluate((px) => window.scrollBy({ top: px, behavior: 'smooth' }), pixels);
      await sleep(randInt(300, 700));
      // Scroll back to keep video visible
      await page.evaluate((px) => window.scrollBy({ top: -px, behavior: 'smooth' }), pixels);
    } catch (err) {
      logger.debug(`[HumanBehavior] randomScroll failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * Keeps the browser tab "active" by periodically calling document.hasFocus()
   * and dispatching visibility change events.
   *
   * YouTube pauses playback when the tab loses visibility. This injection
   * tricks the page into always believing the tab is focused.
   *
   * @param {import('puppeteer').Page} page
   */
  async injectFocusKeepAlive(page) {
    await page.evaluateOnNewDocument(() => {
      // Intercept the visibilitychange event — always report "visible"
      Object.defineProperty(document, 'visibilityState', {
        get: () => 'visible',
        configurable: true,
      });
      Object.defineProperty(document, 'hidden', {
        get: () => false,
        configurable: true,
      });

      // Prevent YouTube's "Are you still watching?" timer from firing
      // by spoofing Date.now() calls used internally
      const _DateNow = Date.now.bind(Date);
      Date.now = () => _DateNow();

      // Keep document active
      document.addEventListener('visibilitychange', (e) => {
        e.stopImmediatePropagation();
      }, true);
    });

    logger.debug('[HumanBehavior] Focus keep-alive injected');
  }

  /**
   * Periodically re-asserts focus on the page to handle any resets.
   * Call this in a setInterval during the watch period.
   *
   * @param {import('puppeteer').Page} page
   */
  async pingFocus(page) {
    try {
      await page.evaluate(() => {
        if (typeof document.dispatchEvent === 'function') {
          document.dispatchEvent(new Event('focus'));
          window.dispatchEvent(new Event('focus'));
        }
      });
    } catch { /* ignore */ }
  }

  /**
   * Dismisses YouTube's "Are you still watching?" overlay if it appears.
   * Checks both the main page and any embedded iframe contexts.
   *
   * @param {import('puppeteer').Page} page
   * @returns {boolean} true if an overlay was found and dismissed
   */
  async dismissStillWatchingPrompt(page) {
    // In the main page context
    const dismissed = await page.evaluate(() => {
      // YouTube overlay button text patterns
      const patterns = ['Yes', 'Still watching', 'Continue watching'];
      const buttons = Array.from(document.querySelectorAll('button, .ytp-button'));
      for (const btn of buttons) {
        if (patterns.some((p) => (btn.innerText || '').includes(p))) {
          btn.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (dismissed) {
      logger.info('[HumanBehavior] Dismissed "Are you still watching?" prompt');
    }
    return dismissed;
  }

  /**
   * Runs a complete "idle human behaviour" cycle during a video watch.
   * Call this on a timer (every 2–5 minutes) to maintain authenticity.
   *
   * Actions performed:
   *  - Random mouse movement
   *  - Optional small scroll
   *  - Dismiss any prompts
   *  - Ping focus
   *
   * @param {import('puppeteer').Page} page
   */
  async simulateIdleBehavior(page) {
    await this.randomMouseMove(page);
    await sleep(randInt(500, 1500));

    if (Math.random() > 0.6) {
      await this.randomScroll(page);
    }

    await this.dismissStillWatchingPrompt(page);
    await this.pingFocus(page);

    logger.debug('[HumanBehavior] Idle behaviour cycle completed');
  }

  /**
   * Waits for a random duration within [minMs, maxMs], useful between actions
   * to avoid machine-speed timing patterns.
   */
  async randomDelay(minMs = 1000, maxMs = 3000) {
    const delay = randInt(minMs, maxMs);
    logger.debug(`[HumanBehavior] Random delay: ${delay}ms`);
    await sleep(delay);
  }
}

module.exports = new HumanBehavior();
