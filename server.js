const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const VideoManager = require('./video-manager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Video Manager
const videoManager = new VideoManager(io);

// ── Single Video (goes through queue) ─────────────────────────────
app.get('/api/jobs', (req, res) => {
    res.json(videoManager.getJobs());
});

app.post('/api/jobs', async (req, res) => {
    const { url, duration, name } = req.body;
    if (!url || !duration) {
        return res.status(400).json({ error: 'URL and duration are required.' });
    }
    try {
        const result = await videoManager.enqueue(url, parseInt(duration), name || '');
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/jobs/:id/stop', async (req, res) => {
    try {
        await videoManager.stopJob(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── CSV Bulk Queue ──────────────────────────────────────────────────
app.get('/api/queue', (req, res) => {
    res.json({
        pending: videoManager.getQueue(),
        count: videoManager.getQueue().length,
        isRunning: videoManager.isQueueRunning
    });
});

app.post('/api/queue/bulk', async (req, res) => {
    const { videos } = req.body;
    if (!videos || !Array.isArray(videos) || videos.length === 0) {
        return res.status(400).json({ error: 'Videos array required.' });
    }
    // Validate each video
    for (const v of videos) {
        if (!v.url || !v.duration || isNaN(parseInt(v.duration))) {
            return res.status(400).json({ error: 'Each video must have url and duration.' });
        }
    }
    try {
        const result = await videoManager.enqueueBulk(videos);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── Socket.io ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('Client connected to Dashboard');

    // Send current queue state to new client
    socket.emit('queue-updated', {
        pending: videoManager.getQueue().map((v, i) => ({ ...v, position: i + 1 })),
        count: videoManager.getQueue().length,
        isRunning: videoManager.isQueueRunning
    });

    socket.on('request-live-view', (jobId) => {
        videoManager.subscribeLiveView(socket.id, jobId);
    });
    socket.on('stop-live-view', () => {
        videoManager.unsubscribeLiveView(socket.id);
    });
    socket.on('disconnect', () => {
        videoManager.unsubscribeLiveView(socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 LMS Video Dashboard running at http://localhost:${PORT}`);
});
