const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const COOKIE_FILE = path.join(__dirname, 'cookies.json');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function runSetup() {
    console.log('🚀 Launching browser for initial setup...');
    
    const loginUrl = 'https://lms.aimdip.org/login';

    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--start-maximized']
    });

    const page = await browser.newPage();
    console.log(`🌐 Navigating to ${loginUrl}...`);
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });

    console.log('\n--------------------------------------------------');
    console.log('🛑 ACTION REQUIRED IN BROWSER:');
    console.log('1. Please log in manually if you are not already logged in.');
    console.log('2. Navigate to the video page if redirected.');
    console.log('3. MANUALLY CLICK PLAY on the video so it starts playing.');
    console.log('--------------------------------------------------\n');

    return new Promise((resolve) => {
        rl.question('▶️  Video playing? Press ENTER to save session and start keep-alive setup... ', async () => {
            console.log('\n✅ ENTER pressed. Saving session cookies...');
            
            try {
                // Save cookies
                const cookies = await page.cookies();
                fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
                
                // Save local storage
                const lsData = await page.evaluate(() => JSON.stringify(window.localStorage));
                fs.writeFileSync(path.join(__dirname, 'localstorage.json'), lsData);
                
                // Save session storage
                const ssData = await page.evaluate(() => JSON.stringify(window.sessionStorage));
                fs.writeFileSync(path.join(__dirname, 'sessionstorage.json'), ssData);

                console.log(`💾 Session data (Cookies, LocalStorage) saved successfully!`);
                console.log('🎉 Initial setup completed. Closing local browser...');
            } catch (error) {
                console.error('❌ Error saving cookies:', error);
            } finally {
                await browser.close();
                rl.close();
                console.log('👋 Setup finished. You can now run the keep-alive script (keeper.js) on your server/locally.');
                resolve();
            }
        });
    });
}

runSetup().catch(err => {
    console.error('💥 Fatal Error:', err);
    process.exit(1);
});
