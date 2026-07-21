const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const COOKIE_FILE = path.join(__dirname, 'cookies.json');
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

class VideoManager {
    constructor(io) {
        this.io = io;
        this.jobs = new Map();
        this.browser = null;
        this.liveViewSubscriptions = new Map(); // socketId -> jobId
        
        if (!fs.existsSync(SCREENSHOT_DIR)) {
            fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        }
    }

    async initBrowser() {
        if (!this.browser) {
            this.browser = await puppeteer.launch({
                headless: "new",
                defaultViewport: { width: 1280, height: 720 },
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });
            console.log('✅ Headless browser initialized for Dashboard.');
        }
        return this.browser;
    }

    getJobs() {
        return Array.from(this.jobs.values()).map(job => ({
            id: job.id,
            url: job.url,
            duration: job.duration,
            progress: job.progress,
            status: job.status,
            startTime: job.startTime
        }));
    }

    async addJob(url, duration) {
        if (!fs.existsSync(COOKIE_FILE)) {
            throw new Error('cookies.json not found! Please run setup first.');
        }

        const jobId = uuidv4();
        const job = {
            id: jobId,
            url,
            duration,
            progress: 0,
            status: 'starting',
            startTime: Date.now(),
            page: null,
            context: null,
            interval: null,
            liveViewInterval: null
        };
        
        this.jobs.set(jobId, job);
        this.io.emit('jobs-updated', this.getJobs());

        // Start processing asynchronously
        this.processJob(jobId).catch(err => {
            console.error(`Error in job ${jobId}:`, err);
            this.updateJob(jobId, { status: 'error' });
        });

        return job;
    }

    async processJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) return;

        const browser = await this.initBrowser();
        
        // Use Incognito Context to completely isolate this video from other playing videos
        const context = await browser.createBrowserContext();
        job.context = context;
        
        const page = await context.newPage();
        job.page = page;

        // Inject cookies
        const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
        await page.setCookie(...cookies);

        // Inject LocalStorage and SessionStorage
        const lsPath = path.join(__dirname, 'localstorage.json');
        if (fs.existsSync(lsPath)) {
            const lsData = fs.readFileSync(lsPath, 'utf8');
            await page.evaluateOnNewDocument((data) => {
                const parsed = JSON.parse(data);
                for (let key in parsed) {
                    localStorage.setItem(key, parsed[key]);
                }
            }, lsData);
        }
        
        const ssPath = path.join(__dirname, 'sessionstorage.json');
        if (fs.existsSync(ssPath)) {
            const ssData = fs.readFileSync(ssPath, 'utf8');
            await page.evaluateOnNewDocument((data) => {
                const parsed = JSON.parse(data);
                for (let key in parsed) {
                    sessionStorage.setItem(key, parsed[key]);
                }
            }, ssData);
        }

        // --- CRITICAL HACK: Prevent LMS from knowing the tab is in background ---
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
            Object.defineProperty(document, 'hidden', { get: () => false });
            document.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
            window.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
            window.addEventListener('blur', e => e.stopImmediatePropagation(), true);
            document.hasFocus = () => true;
        });

        this.updateJob(jobId, { status: 'loading' });
        await page.goto(job.url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Auto-play logic
        this.updateJob(jobId, { status: 'playing' });
        await this.forcePlayVideo(page);

        const durationMs = job.duration * 60 * 1000;
        
        // Progress loop
        job.interval = setInterval(async () => {
            const elapsedMs = Date.now() - job.startTime;
            let progress = Math.min(100, Math.floor((elapsedMs / durationMs) * 100));
            
            // Keep alive interaction and prevent pausing
            await this.keepAlive(page);
            await this.ensurePlaying(page);
            
            this.updateJob(jobId, { progress });

            if (elapsedMs >= durationMs) {
                this.completeJob(jobId);
            }
        }, 5000); // Update progress every 5 seconds

        // Live View loop (only takes screenshots if someone is watching)
        job.liveViewInterval = setInterval(async () => {
            if (this.isAnyoneWatching(jobId) && !page.isClosed()) {
                try {
                    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 50 });
                    this.broadcastLiveView(jobId, `data:image/jpeg;base64,${screenshot}`);
                } catch (e) {
                    // ignore screenshot errors during transitions
                }
            }
        }, 1000); // 1 fps live view stream
    }

    async forcePlayVideo(page) {
        try {
            console.log('⏳ Waiting for video player (iframe) to appear on screen...');
            // Wait dynamically until an iframe appears (up to 45 seconds)
            await page.waitForSelector('iframe', { timeout: 45000 }).catch(() => console.log('No iframe found after 45s.'));
            
            console.log('⏳ Iframe detected! Waiting 3 extra seconds for it to fully load its content...');
            await new Promise(r => setTimeout(r, 3000));

            // 1. Try standard HTML5 Video and YouTube API
            await page.evaluate(() => {
                const frames = document.querySelectorAll('iframe');
                frames.forEach(f => {
                    try { f.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*'); } catch(e) {}
                });
                const videos = document.querySelectorAll('video');
                videos.forEach(v => {
                    if (v.paused) v.play().catch(e => {});
                });
                // Try clicking common custom play buttons
                const playButtons = document.querySelectorAll('.play-button, .play-btn, .vjs-play-control, .plyr__control, .vjs-big-play-button, button[title="Play"], [aria-label="Play"]');
                playButtons.forEach(btn => btn.click());
            });

            // 2. Find iframes and physically click their centers (Best for YouTube embeds)
            const iframeHandles = await page.$$('iframe');
            console.log(`🔍 Found ${iframeHandles.length} iframes on the page.`);
            for (let iframe of iframeHandles) {
                const box = await iframe.boundingBox();
                if (box && box.width > 0 && box.height > 0) {
                    console.log(`🖱️ Clicking center of iframe at X:${box.x + box.width / 2}, Y:${box.y + box.height / 2}`);
                    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                    await new Promise(r => setTimeout(r, 1500));
                    
                    // Carpet-bomb the bottom-left area to hit the custom white play button
                    console.log(`🖱️ Carpet-bombing bottom-left corner of iframe to hit custom play button...`);
                    const startX = box.x;
                    const startY = box.y + box.height;
                    for (let offsetX = 10; offsetX <= 60; offsetX += 15) {
                        for (let offsetY = -40; offsetY <= 20; offsetY += 15) {
                            await page.mouse.click(startX + offsetX, startY + offsetY);
                        }
                    }
                    
                    // Also aggressively click anything with 'play' in its class
                    await page.evaluate(() => {
                        const allEls = document.querySelectorAll('*');
                        allEls.forEach(el => {
                            const c = el.className;
                            if (typeof c === 'string' && c.toLowerCase().includes('play') && !c.toLowerCase().includes('display')) {
                                el.click();
                            }
                        });
                    });
                }
            }
            
            // 3. Fallbacks
            const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
            await page.mouse.click(viewport.width / 2, viewport.height / 2);
            await page.mouse.click(30, viewport.height - 30);
            
            console.log('✅ Autoplay sequence completed.');
        } catch (err) {
            console.error('⚠️ Error during autoplay:', err);
        }
    }

    async keepAlive(page) {
        try {
            if (page.isClosed()) return;
            const width = await page.evaluate(() => window.innerWidth);
            const height = await page.evaluate(() => window.innerHeight);
            await page.mouse.move(Math.floor(Math.random() * width), Math.floor(Math.random() * height), { steps: 2 });
            await page.evaluate(() => window.scrollBy(0, (Math.random() > 0.5 ? 1 : -1) * 50));
        } catch (e) {}
    }

    async ensurePlaying(page) {
        try {
            if (page.isClosed()) return;
            
            // Constantly ensure the YouTube player stays playing
            await page.evaluate(() => {
                const frames = document.querySelectorAll('iframe');
                frames.forEach(f => {
                    try { f.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*'); } catch(e) {}
                });
                const videos = document.querySelectorAll('video');
                videos.forEach(v => {
                    if (v.paused) v.play().catch(e => {});
                });
                
                // Keep the document fully focused
                if (typeof document.dispatchEvent === 'function') {
                    document.dispatchEvent(new Event('focus'));
                    window.dispatchEvent(new Event('focus'));
                }
            });
        } catch (e) {}
    }

    async completeJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) return;

        clearInterval(job.interval);
        clearInterval(job.liveViewInterval);

        if (job.page && !job.page.isClosed()) {
            const screenshotPath = path.join(SCREENSHOT_DIR, `completed_${jobId}.png`);
            await job.page.screenshot({ path: screenshotPath, fullPage: true }).catch(()=>null);
            await job.page.close().catch(()=>null);
        }
        if (job.context) {
            await job.context.close().catch(()=>null);
        }

        this.updateJob(jobId, { status: 'completed', progress: 100 });
    }

    async stopJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) return;

        clearInterval(job.interval);
        clearInterval(job.liveViewInterval);

        if (job.page && !job.page.isClosed()) await job.page.close().catch(()=>null);
        if (job.context) await job.context.close().catch(()=>null);

        this.updateJob(jobId, { status: 'stopped' });
    }

    updateJob(jobId, updates) {
        const job = this.jobs.get(jobId);
        if (job) {
            Object.assign(job, updates);
            this.io.emit('jobs-updated', this.getJobs());
        }
    }

    subscribeLiveView(socketId, jobId) {
        this.liveViewSubscriptions.set(socketId, jobId);
    }

    unsubscribeLiveView(socketId) {
        this.liveViewSubscriptions.delete(socketId);
    }

    isAnyoneWatching(jobId) {
        return Array.from(this.liveViewSubscriptions.values()).includes(jobId);
    }

    broadcastLiveView(jobId, imageBase64) {
        for (const [socketId, subscribedJobId] of this.liveViewSubscriptions.entries()) {
            if (subscribedJobId === jobId) {
                this.io.to(socketId).emit('live-view-frame', imageBase64);
            }
        }
    }
}

module.exports = VideoManager;
