'use strict';
/**
 * Standalone login test — verifies credentials & saves session cookie
 * Run: node test-login.js
 */
require('dotenv').config();

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const path = require('path');
const fs = require('fs');

const REGISTRATION_NO = process.env.LMS_REGISTRATION_NO;
const PASSWORD = process.env.LMS_PASSWORD;
const LMS_URL = process.env.LMS_URL || 'https://lms.aimdip.org';
const HEADLESS = process.env.HEADLESS !== 'false';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\n[LoginTest] Registration No : ${REGISTRATION_NO}`);
  console.log(`[LoginTest] LMS URL         : ${LMS_URL}`);
  console.log(`[LoginTest] Headless        : ${HEADLESS}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  try {
    console.log('[LoginTest] Navigating to login page...');
    await page.goto(`${LMS_URL}/login`, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('[LoginTest] Page loaded:', page.url());

    // ── Dump all inputs for debug ──────────────────────────────────────────
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, button[type="submit"]')).map((el) => ({
        tag: el.tagName,
        type: el.type,
        id: el.id,
        name: el.name,
        placeholder: el.placeholder,
        className: el.className.slice(0, 60),
        text: (el.innerText || '').trim().slice(0, 40),
      }))
    );
    console.log('[LoginTest] Form elements found:');
    inputs.forEach((el) => console.log('  ', JSON.stringify(el)));

    // ── Try primary selectors ──────────────────────────────────────────────
    let regField = await page.$('#login-reg-no');
    if (!regField) {
      // Fallback: first text input
      regField = await page.$('input[type="text"], input:not([type="password"])');
      console.log('[LoginTest] #login-reg-no not found — using fallback');
    }

    await regField.click({ clickCount: 3 });
    await page.keyboard.type(REGISTRATION_NO, { delay: 50 });
    console.log('[LoginTest] Typed registration number');

    const pwField = await page.$('#login-password') || await page.$('input[type="password"]');
    await pwField.click({ clickCount: 3 });
    await page.keyboard.type(PASSWORD, { delay: 50 });
    console.log('[LoginTest] Typed password');

    await sleep(500);

    // Screenshot before submit
    await page.screenshot({ path: 'screenshots/before-login.png' });
    console.log('[LoginTest] Screenshot saved: screenshots/before-login.png');

    // Submit
    const submitBtn = await page.$('button.auth-page-submit') ||
                      await page.$('button[type="submit"]') ||
                      await page.$('input[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    console.log('[LoginTest] Submit clicked — waiting for navigation...');

    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      sleep(20000),
    ]);

    const afterUrl = page.url();
    console.log(`\n[LoginTest] POST-LOGIN URL: ${afterUrl}`);

    const success = !afterUrl.includes('/login');
    console.log(`[LoginTest] Login ${success ? '✅ SUCCESSFUL' : '❌ FAILED — still on login page'}`);

    // Screenshot after login
    await page.screenshot({ path: 'screenshots/after-login.png', fullPage: true });
    console.log('[LoginTest] Screenshot saved: screenshots/after-login.png');

    if (success) {
      // Save session cookies
      const cookies = await page.cookies();
      fs.mkdirSync('sessions', { recursive: true });
      fs.writeFileSync('sessions/session.json', JSON.stringify({ cookies, savedAt: Date.now() }, null, 2));
      console.log(`[LoginTest] Session saved (${cookies.length} cookies)`);

      // Navigate to the sample course
      const courseUrl = 'https://lms.aimdip.org/dashboard/course?module=3080c567&topic=fbc6f4a7';
      console.log(`\n[LoginTest] Navigating to course: ${courseUrl}`);
      await page.goto(courseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(3000);

      // Check for YouTube iframe
      const ytFrame = page.frames().find((f) => f.url().includes('youtube'));
      const hasYT = !!ytFrame;
      console.log(`[LoginTest] YouTube iframe present: ${hasYT ? '✅ YES' : '❌ NO'}`);
      if (ytFrame) console.log(`[LoginTest] YT frame URL: ${ytFrame.url()}`);

      await page.screenshot({ path: 'screenshots/course-page.png', fullPage: true });
      console.log('[LoginTest] Course screenshot saved: screenshots/course-page.png');
    }
  } catch (err) {
    console.error('[LoginTest] Error:', err.message);
    await page.screenshot({ path: 'screenshots/error.png' }).catch(() => {});
  } finally {
    await browser.close();
    console.log('\n[LoginTest] Done. Check screenshots/ folder for results.');
  }
}

main();
