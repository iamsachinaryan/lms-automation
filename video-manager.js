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

        // ── Queue System ──────────────────────────────────────────
        this.videoQueue = [];       // pending { url, duration, name }
        this.isQueueRunning = false; // ek time pe sirf ek video

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
            name: job.name,
            duration: job.duration,
            progress: job.progress,
            status: job.status,
            startTime: job.startTime
        }));
    }

    // ── Queue Methods ──────────────────────────────────────────────

    /** Single video: add to queue */
    async enqueue(url, duration, name = '') {
        this.videoQueue.push({ url, duration: parseInt(duration), name });
        this.emitQueueUpdate();
        console.log(`📋 Queued: ${url} (${duration} min). Queue size: ${this.videoQueue.length}`);

        if (!this.isQueueRunning) {
            await this.processNextInQueue();
        }
        return { queued: true, position: this.videoQueue.length };
    }

    /** Bulk add: CSV se aaye videos */
    async enqueueBulk(videos) {
        for (const v of videos) {
            this.videoQueue.push({ url: v.url, duration: parseInt(v.duration), name: v.name || '' });
        }
        this.emitQueueUpdate();
        console.log(`📋 Bulk queued: ${videos.length} videos. Total queue: ${this.videoQueue.length}`);

        if (!this.isQueueRunning) {
            await this.processNextInQueue();
        }
        return { queued: true, count: videos.length };
    }

    /** Queue se agla video uthao aur start karo */
    async processNextInQueue() {
        if (this.videoQueue.length === 0) {
            this.isQueueRunning = false;
            this.emitQueueUpdate();
            this.io.emit('queue-all-complete');
            console.log('🎉 All queued videos completed!');
            return;
        }

        this.isQueueRunning = true;
        const next = this.videoQueue.shift();
        this.emitQueueUpdate();

        console.log(`▶️  Starting next in queue: ${next.url}`);
        this.addJob(next.url, next.duration, next.name).catch(err => {
            console.error('Queue job error:', err);
            // Error pe bhi agla chalao
            setTimeout(() => this.processNextInQueue(), 3000);
        });
    }

    /** Emit queue status to all clients */
    emitQueueUpdate() {
        this.io.emit('queue-updated', {
            pending: this.videoQueue.map((v, i) => ({ ...v, position: i + 1 })),
            count: this.videoQueue.length,
            isRunning: this.isQueueRunning
        });
    }

    getQueue() {
        return this.videoQueue;
    }

    // ── Job Processing ─────────────────────────────────────────────

    async addJob(url, duration, name = '') {
        if (!fs.existsSync(COOKIE_FILE)) {
            throw new Error('cookies.json not found! Please run setup first.');
        }

        const jobId = uuidv4();
        const job = {
            id: jobId,
            url,
            name,
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

        this.processJob(jobId).catch(err => {
            console.error(`Error in job ${jobId}:`, err);
            this.updateJob(jobId, { status: 'error' });
            // Error pe bhi queue continue karo
            setTimeout(() => this.processNextInQueue(), 3000);
        });

        return job;
    }

    async processJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) return;

        const browser = await this.initBrowser();

        const context = await browser.createBrowserContext();
        job.context = context;

        const page = await context.newPage();
        job.page = page;

        // Inject cookies
        const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
        await page.setCookie(...cookies);

        // Inject LocalStorage
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

        // Inject SessionStorage
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

        // Prevent background tab detection
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

        this.updateJob(jobId, { status: 'playing' });
        await this.forcePlayVideo(page);

        // ── TRIGGER NEXT VIDEO ──────────────────────────────────────
        // Jaise hi ye video play ho gaya, turant agla video start karo
        console.log(`✅ Video #${jobId} is playing! Starting next video in 2 seconds...`);
        setTimeout(() => this.processNextInQueue(), 2000);
        // ────────────────────────────────────────────────────────────

        const durationMs = job.duration * 60 * 1000;

        // Progress loop
        job.interval = setInterval(async () => {
            const elapsedMs = Date.now() - job.startTime;
            let progress = Math.min(100, Math.floor((elapsedMs / durationMs) * 100));

            await this.keepAlive(page);
            await this.ensurePlaying(page);

            this.updateJob(jobId, { progress });

            if (elapsedMs >= durationMs) {
                this.completeJob(jobId);
            }
        }, 5000);

        // Live View loop
        job.liveViewInterval = setInterval(async () => {
            if (this.isAnyoneWatching(jobId) && !page.isClosed()) {
                try {
                    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 50 });
                    this.broadcastLiveView(jobId, `data:image/jpeg;base64,${screenshot}`);
                } catch (e) { /* ignore */ }
            }
        }, 1000);
    }

    async forcePlayVideo(page) {
        try {
            console.log('⏳ Waiting for video player (iframe) to appear on screen...');
            await page.waitForSelector('iframe', { timeout: 45000 }).catch(() => console.log('No iframe found after 45s.'));

            console.log('⏳ Iframe detected! Waiting 3 extra seconds for it to fully load its content...');
            await new Promise(r => setTimeout(r, 3000));

            await page.evaluate(() => {
                const frames = document.querySelectorAll('iframe');
                frames.forEach(f => {
                    try { f.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*'); } catch(e) {}
                });
                const videos = document.querySelectorAll('video');
                videos.forEach(v => { if (v.paused) v.play().catch(e => {}); });
                const playButtons = document.querySelectorAll('.play-button, .play-btn, .vjs-play-control, .plyr__control, .vjs-big-play-button, button[title="Play"], [aria-label="Play"]');
                playButtons.forEach(btn => btn.click());
            });

            const iframeHandles = await page.$$('iframe');
            console.log(`🔍 Found ${iframeHandles.length} iframes on the page.`);
            for (let iframe of iframeHandles) {
                const box = await iframe.boundingBox();
                if (box && box.width > 0 && box.height > 0) {
                    console.log(`🖱️ Clicking center of iframe at X:${box.x + box.width / 2}, Y:${box.y + box.height / 2}`);
                    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                    await new Promise(r => setTimeout(r, 1500));

                    console.log(`🖱️ Carpet-bombing bottom-left corner of iframe to hit custom play button...`);
                    const startX = box.x;
                    const startY = box.y + box.height;
                    for (let offsetX = 10; offsetX <= 60; offsetX += 15) {
                        for (let offsetY = -40; offsetY <= 20; offsetY += 15) {
                            await page.mouse.click(startX + offsetX, startY + offsetY);
                        }
                    }

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
            await page.evaluate(() => {
                const frames = document.querySelectorAll('iframe');
                frames.forEach(f => {
                    try { f.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*'); } catch(e) {}
                });
                const videos = document.querySelectorAll('video');
                videos.forEach(v => { if (v.paused) v.play().catch(e => {}); });
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
            await job.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
            await job.page.close().catch(() => null);
        }
        if (job.context) {
            await job.context.close().catch(() => null);
        }

        this.updateJob(jobId, { status: 'completed', progress: 100 });
        console.log(`✅ Job ${jobId} completed.`);
        
        // Agar koi naya video queue me aaya ho toh check kar lo
        if (!this.isQueueRunning && this.videoQueue.length > 0) {
            this.processNextInQueue();
        }
    }

    async stopJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) return;

        clearInterval(job.interval);
        clearInterval(job.liveViewInterval);

        if (job.page && !job.page.isClosed()) await job.page.close().catch(() => null);
        if (job.context) await job.context.close().catch(() => null);

        this.updateJob(jobId, { status: 'stopped' });

        // Stop ke baad bhi check kar lo
        if (!this.isQueueRunning && this.videoQueue.length > 0) {
            this.processNextInQueue();
        }
    }

    updateJob(jobId, updates) {
        const job = this.jobs.get(jobId);
        if (job) {
            Object.assign(job, updates);
            this.io.emit('jobs-updated', this.getJobs());
        }
    }

    subscribeLiveView(socketId, jobId) { this.liveViewSubscriptions.set(socketId, jobId); }
    unsubscribeLiveView(socketId) { this.liveViewSubscriptions.delete(socketId); }
    isAnyoneWatching(jobId) { return Array.from(this.liveViewSubscriptions.values()).includes(jobId); }

    broadcastLiveView(jobId, imageBase64) {
        for (const [socketId, subscribedJobId] of this.liveViewSubscriptions.entries()) {
            if (subscribedJobId === jobId) {
                this.io.to(socketId).emit('live-view-frame', imageBase64);
            }
        }
    }
}

module.exports = VideoManager;
