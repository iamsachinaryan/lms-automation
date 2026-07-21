const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const VideoManager = require('./video-manager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Video Manager
const videoManager = new VideoManager(io);

// API Endpoints
app.get('/api/jobs', (req, res) => {
    res.json(videoManager.getJobs());
});

app.post('/api/jobs', async (req, res) => {
    const { url, duration } = req.body;
    if (!url || !duration) {
        return res.status(400).json({ error: 'URL and duration are required.' });
    }
    
    try {
        const job = await videoManager.addJob(url, parseInt(duration));
        res.json({ success: true, job });
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

// Socket.io for Real-time Live View and Progress
io.on('connection', (socket) => {
    console.log('Client connected to Dashboard');
    
    // Client requests live view for a specific job
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
