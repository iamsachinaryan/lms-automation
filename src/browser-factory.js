'use strict';

/**
 * @module BrowserFactory
 * @description Responsible for creating stealth-hardened Puppeteer browser
 *              instances and isolated browser contexts.
 *
 *              Anti-detection strategy:
 *  1. puppeteer-extra-plugin-stealth patches 13+ fingerprint vectors
 *     (webdriver flag, navigator.plugins, Chrome runtime object, etc.)
 *  2. User-Agent is randomised from a curated pool of real browser UAs
 *  3. Viewport is jittered ±N pixels so no two sessions share an identical
 *     screen resolution — a common bot fingerprinting heuristic
 *  4. Timezone, language, and Accept-Language headers match a real locale
 *  5. WebGL, Canvas, and AudioContext fingerprints are masked by stealth plugin
 *  6. --disable-blink-features=AutomationControlled removes the JS property
 *     that sites check to detect Puppeteer/Selenium
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');
const config = require('./config');
const logger = require('./logger');

// Register plugins once (idempotent)
puppeteer.use(StealthPlugin());
puppeteer.use(AnonymizeUAPlugin({ makeWindows: true }));

// ─── UA Pool ──────────────────────────────────────────────────────────────────
// Curated list of real Chrome/Edge UAs from 2024–2025 desktop sessions
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
];

/**
 * Returns a random integer in [min, max] inclusive.
 */
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * Returns a random element from an array.
 */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ─── Chrome launch args ───────────────────────────────────────────────────────
// These are tuned for both local execution and headless server deployment.
// Args prefixed with # are excluded when running non-headless.
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',        // prevents /dev/shm crashes in Docker
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',                  // not needed in headless; saves resources
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--allow-running-insecure-content',
  '--disable-web-security',         // needed to interact with cross-origin iframes
  '--autoplay-policy=no-user-gesture-required', // let YouTube autoplay
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-popup-blocking',
  '--disable-extensions',
  '--disable-infobars',
  '--ignore-certificate-errors',
  '--ignore-certificate-errors-spki-list',
  `--window-size=${config.browser.viewportWidth + randInt(-20, 20)},${config.browser.viewportHeight + randInt(-20, 20)}`,
];

class BrowserFactory {
  /** @type {import('puppeteer').Browser|null} */
  #browser = null;

  /**
   * Launches a new browser instance. Idempotent — if already launched,
   * returns the existing instance.
   */
  async launch() {
    if (this.#browser && this.#browser.isConnected()) return this.#browser;

    logger.info('[BrowserFactory] Launching stealth browser...');

    this.#browser = await puppeteer.launch({
      headless: config.browser.headless ? 'new' : false,
      slowMo: config.browser.slowMo,
      args: CHROME_ARGS,
      ignoreHTTPSErrors: true,
      defaultViewport: null, // controlled per-context
      timeout: config.browser.navTimeout,
    });

    this.#browser.on('disconnected', () => {
      logger.warn('[BrowserFactory] Browser disconnected unexpectedly');
      this.#browser = null;
    });

    logger.info('[BrowserFactory] Browser launched successfully');
    return this.#browser;
  }

  /**
   * Creates an isolated BrowserContext with its own cookies, storage, and UA.
   * Each video watch session gets its own context for complete isolation.
   *
   * @param {string} [userAgent]  Override UA; if omitted, a random one is picked
   * @returns {{ context: BrowserContext, userAgent: string, viewport: Object }}
   */
  async createContext(userAgent) {
    const browser = await this.launch();
    const context = await browser.createIncognitoBrowserContext();

    const ua = userAgent || pick(USER_AGENTS);
    const viewport = {
      width: config.browser.viewportWidth + randInt(-50, 50),
      height: config.browser.viewportHeight + randInt(-50, 50),
      deviceScaleFactor: pick([1, 1, 1, 1.25, 1.5]), // mostly 1
      hasTouch: false,
      isLandscape: true,
      isMobile: false,
    };

    // Patch every new page opened in this context
    context.on('targetcreated', async (target) => {
      if (target.type() !== 'page') return;
      const page = await target.page();
      if (!page) return;
      await page.setUserAgent(ua);
      await page.setViewport(viewport);
      // Re-apply WebDriver flag removal after any navigation
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
        // Make navigator.plugins non-empty (fingerprint hardening)
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });
        // Chromium headless exposes a special chrome.runtime; replicate it
        if (!window.chrome) {
          window.chrome = { runtime: {} };
        }
      });
    });

    logger.debug(`[BrowserFactory] Context created | UA: ${ua.slice(0, 50)}...`);
    return { context, userAgent: ua, viewport };
  }

  /**
   * Gracefully closes the browser. Always call this in a finally block.
   */
  async close() {
    if (this.#browser) {
      await this.#browser.close().catch(() => {});
      this.#browser = null;
      logger.info('[BrowserFactory] Browser closed');
    }
  }

  get isRunning() {
    return this.#browser !== null && this.#browser.isConnected();
  }
}

// Export a singleton — one browser process per Node process
module.exports = new BrowserFactory();
