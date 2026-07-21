'use strict';

/**
 * @module SessionManager
 * @description Handles LMS authentication, cookie persistence, and session
 *              lifecycle management.
 *
 *  Session lifecycle:
 *  1. On startup, attempt to load saved cookies from disk
 *  2. Navigate to a protected page; if redirect → login page, cookies are stale
 *  3. Perform fresh login, save cookies to disk
 *  4. Expose `ensureAuthenticated(page)` for callers to call before any action
 *  5. If mid-session the page redirects to /login, auto-relogin is triggered
 */

const path = require('path');
const fs = require('fs').promises;
const retry = require('p-retry');
const config = require('./config');
const logger = require('./logger');

const SESSION_FILE = path.resolve(config.storage.sessionDir, 'session.json');

// ── Exact selectors confirmed via live LMS DOM inspection ─────────────────────
// Registration number field  → id="login-reg-no"   (type="text", NOT email)
// Password field             → id="login-password"
// Submit button              → button.auth-page-submit  (text: "Sign In")
// Dashboard indicator        → URL contains /dashboard after successful login
const SELECTORS = {
  emailInput: '#login-reg-no',           // Registration Number field (NOT email)
  passwordInput: '#login-password',
  submitButton: 'button.auth-page-submit, button.registration-pay',
  dashboardIndicator: '[href*="/dashboard"], .dashboard, .user-menu, .user-profile',
  errorMessage: '.error, .alert-danger, .auth-error, [class*="error"]',
};

class SessionManager {
  #email;
  #password;
  #lmsUrl;

  constructor() {
    this.#email = config.lms.email;
    this.#password = config.lms.password;
    this.#lmsUrl = config.lms.url;
  }

  // ─── Cookie Persistence ────────────────────────────────────────────────────

  /**
   * Loads saved cookies from disk and injects them into the given page.
   * Returns true if cookies were loaded, false if no session file exists.
   */
  async loadSession(page) {
    try {
      const raw = await fs.readFile(SESSION_FILE, 'utf8');
      const { cookies, savedAt } = JSON.parse(raw);

      const ageHours = (Date.now() - savedAt) / 3_600_000;
      if (ageHours > 168) { // 7 days max
        logger.info('[SessionManager] Saved session is older than 7 days — will re-login');
        return false;
      }

      await page.setCookie(...cookies);
      logger.info(`[SessionManager] Loaded ${cookies.length} cookies (saved ${ageHours.toFixed(1)}h ago)`);
      return true;
    } catch {
      logger.info('[SessionManager] No valid session file found — fresh login required');
      return false;
    }
  }

  /**
   * Saves current page cookies to disk for session reuse.
   */
  async saveSession(page) {
    const cookies = await page.cookies();
    const payload = { cookies, savedAt: Date.now() };
    await fs.writeFile(SESSION_FILE, JSON.stringify(payload, null, 2));
    logger.info(`[SessionManager] Session saved (${cookies.length} cookies)`);
  }

  /**
   * Clears the saved session file to force a fresh login next time.
   */
  async clearSession() {
    try {
      await fs.unlink(SESSION_FILE);
      logger.info('[SessionManager] Session file cleared');
    } catch {
      // File may not exist
    }
  }

  // ─── Authentication ────────────────────────────────────────────────────────

  /**
   * Performs a full login flow. Called when cookies are missing or stale.
   * Wraps the actual attempt in p-retry for transient network failures.
   *
   * @param {import('puppeteer').Page} page
   */
  async login(page) {
    return retry(
      async (attemptNumber) => {
        logger.info(`[SessionManager] Login attempt ${attemptNumber}...`);

        await page.goto(`${this.#lmsUrl}/login`, {
          waitUntil: 'networkidle2',
          timeout: config.browser.navTimeout,
        });

        // Wait for email input with a generous timeout
        await page.waitForSelector(SELECTORS.emailInput, { timeout: 15000 });

        // ── Type credentials with human-like delays ─────────────────────────
        await this.#typeHuman(page, SELECTORS.emailInput, this.#email);
        await this.#sleep(randInt(400, 900));
        await this.#typeHuman(page, SELECTORS.passwordInput, this.#password);
        await this.#sleep(randInt(300, 700));

        // ── Click submit ───────────────────────────────────────────────────
        // Try text-based button first, fall back to generic submit
        const submitted = await this.#clickSubmitButton(page);
        if (!submitted) throw new Error('Could not locate submit button');

        // ── Wait for post-login navigation ─────────────────────────────────
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
          page.waitForSelector(SELECTORS.dashboardIndicator, { timeout: 30000 }),
        ]);

        // ── Verify we are NOT back on the login page ───────────────────────
        const currentUrl = page.url();
        if (currentUrl.includes('/login')) {
          // Check for error messages
          const errorText = await page.$eval(
            SELECTORS.errorMessage,
            (el) => el.innerText,
          ).catch(() => '');
          throw new Error(`Login failed — still on login page. Error: "${errorText}"`);
        }

        logger.info(`[SessionManager] Login successful — redirected to: ${currentUrl}`);
        await this.saveSession(page);
      },
      {
        retries: config.execution.maxRetries,
        minTimeout: config.execution.retryBaseDelayMs,
        factor: 2,
        onFailedAttempt: (err) => {
          logger.warn(`[SessionManager] Login attempt failed: ${err.message} (${err.retriesLeft} retries left)`);
        },
      }
    );
  }

  // ─── Main public API ───────────────────────────────────────────────────────

  /**
   * Ensures the given page has a valid authenticated session.
   * Strategy:
   *   1. Attempt to load saved cookies
   *   2. Navigate to dashboard
   *   3. If redirected to /login → perform full login
   *
   * @param {import('puppeteer').Page} page
   */
  async ensureAuthenticated(page) {
    const cookiesLoaded = await this.loadSession(page);

    await page.goto(`${this.#lmsUrl}/dashboard`, {
      waitUntil: 'networkidle2',
      timeout: config.browser.navTimeout,
    });

    const afterUrl = page.url();

    if (afterUrl.includes('/login') || !cookiesLoaded) {
      logger.info('[SessionManager] Session invalid or missing — performing fresh login');
      await this.clearSession();
      await this.login(page);
    } else {
      logger.info('[SessionManager] Existing session is valid ✓');
    }
  }

  /**
   * Checks whether the current page URL indicates a session expiry.
   * Call this in a loop during long video watches.
   */
  isSessionExpired(page) {
    return page.url().includes('/login');
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Clears an input and types a string character-by-character with human-like
   * inter-keystroke delays (30–90ms) to evade typing-speed detection.
   */
  async #typeHuman(page, selector, text) {
    await page.click(selector, { clickCount: 3 }); // select-all
    await page.keyboard.press('Backspace');
    for (const char of text) {
      await page.keyboard.type(char, { delay: randInt(30, 90) });
    }
  }

  /**
   * Tries several strategies to click the login submit button.
   */
  async #clickSubmitButton(page) {
    // Strategy 1: standard type="submit"
    const submitSel = 'button[type="submit"], input[type="submit"]';
    try {
      await page.waitForSelector(submitSel, { timeout: 5000 });
      await page.click(submitSel);
      return true;
    } catch { /* try next */ }

    // Strategy 2: any button containing login/sign-in text
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a[role="button"]'));
      const target = btns.find((b) =>
        /login|sign.?in|submit/i.test(b.innerText || b.textContent)
      );
      if (target) { target.click(); return true; }
      return false;
    });
    if (clicked) return true;

    // Strategy 3: press Enter on the password field
    await page.keyboard.press('Enter');
    return true;
  }

  #sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

module.exports = new SessionManager();
