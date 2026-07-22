const socket = io();

// ── Elements ────────────────────────────────────────────────────────
const tabBtnSingle = document.getElementById('tab-btn-single');
const tabBtnBulk = document.getElementById('tab-btn-bulk');
const tabSingle = document.getElementById('tab-single');
const tabBulk = document.getElementById('tab-bulk');

const form = document.getElementById('job-form');
const urlInput = document.getElementById('url');
const durationInput = document.getElementById('duration');
const jobsGrid = document.getElementById('jobs-grid');

const csvFileInput = document.getElementById('csv-file');
const csvPreview = document.getElementById('csv-preview');
const csvList = document.getElementById('csv-list');
const csvCount = document.getElementById('csv-count');
const btnUploadCsv = document.getElementById('btn-upload-csv');

const queueCountSpan = document.getElementById('queue-count');
const queueListDiv = document.getElementById('queue-list');

const modal = document.getElementById('live-view-modal');
const closeModalBtn = document.getElementById('close-modal');
const liveStreamImg = document.getElementById('live-stream');
const streamLoader = document.getElementById('stream-loader');

let currentViewJobId = null;
let parsedCsvVideos = [];

// ── Tabs Logic ──────────────────────────────────────────────────────
tabBtnSingle.addEventListener('click', () => {
    tabBtnSingle.classList.add('active');
    tabBtnBulk.classList.remove('active');
    tabSingle.classList.add('active');
    tabBulk.classList.remove('active');
});

tabBtnBulk.addEventListener('click', () => {
    tabBtnBulk.classList.add('active');
    tabBtnSingle.classList.remove('active');
    tabBulk.classList.add('active');
    tabSingle.classList.remove('active');
});

// ── Single Video Submission ─────────────────────────────────────────
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = urlInput.value;
    const duration = durationInput.value;
    
    try {
        const res = await fetch('/api/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, duration })
        });
        
        if (res.ok) {
            urlInput.value = '';
            durationInput.value = '';
            alert('Added to queue!');
        } else {
            const err = await res.json();
            alert('Error: ' + err.error);
        }
    } catch (e) {
        alert('Failed to connect to server.');
    }
});

// ── CSV Parsing & Upload ────────────────────────────────────────────
csvFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        const text = event.target.result;
        parseCSV(text);
    };
    reader.readAsText(file);
});

function parseCSV(text) {
    parsedCsvVideos = [];
    const lines = text.split('\n');
    
    // Check if first line has 'url' (header)
    let startIndex = 0;
    if (lines[0].toLowerCase().includes('url')) {
        startIndex = 1;
    }

    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const parts = line.split(',');
        if (parts.length >= 2) {
            const url = parts[0].trim();
            const duration = parseInt(parts[1].trim());
            if (url && !isNaN(duration)) {
                parsedCsvVideos.push({ url, duration, name: `Video from CSV row ${i+1}` });
            }
        }
    }

    renderCsvPreview();
}

function renderCsvPreview() {
    csvList.innerHTML = '';
    csvCount.innerText = parsedCsvVideos.length;

    if (parsedCsvVideos.length > 0) {
        csvPreview.classList.remove('hidden');
        parsedCsvVideos.forEach((v, index) => {
            const div = document.createElement('div');
            // short url display
            const shortUrl = v.url.length > 50 ? v.url.substring(0, 47) + '...' : v.url;
            div.innerHTML = `<span>#${index + 1} ${shortUrl}</span> <span>${v.duration} min</span>`;
            csvList.appendChild(div);
        });
    } else {
        csvPreview.classList.add('hidden');
        alert('No valid videos found in CSV. Format must be: url,duration');
    }
}

btnUploadCsv.addEventListener('click', async () => {
    if (parsedCsvVideos.length === 0) return;

    btnUploadCsv.disabled = true;
    btnUploadCsv.innerText = 'Adding to Queue...';

    try {
        const res = await fetch('/api/queue/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videos: parsedCsvVideos })
        });
        
        if (res.ok) {
            alert(`Successfully added ${parsedCsvVideos.length} videos to queue!`);
            csvFileInput.value = '';
            parsedCsvVideos = [];
            renderCsvPreview();
        } else {
            const err = await res.json();
            alert('Error: ' + err.error);
        }
    } catch (e) {
        alert('Failed to connect to server.');
    } finally {
        btnUploadCsv.disabled = false;
        btnUploadCsv.innerText = 'Add All to Queue';
    }
});

// ── Queue Updates (Socket.io) ───────────────────────────────────────
socket.on('queue-updated', (data) => {
    queueCountSpan.innerText = data.count;
    queueListDiv.innerHTML = '';

    if (data.count === 0) {
        queueListDiv.innerHTML = '<p style="color: #94a3b8;">Queue is empty.</p>';
        return;
    }

    data.pending.forEach((v) => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        
        const shortUrl = v.url.length > 60 ? v.url.substring(0, 57) + '...' : v.url;
        
        item.innerHTML = `
            <div class="queue-item-details">
                <span class="queue-badge">#${v.position}</span>
                <span title="${v.url}" style="color: #cbd5e1; font-size: 0.95rem;">${shortUrl}</span>
            </div>
            <div style="color: #94a3b8; font-size: 0.9rem;">
                ${v.duration} min
            </div>
        `;
        queueListDiv.appendChild(item);
    });
});

socket.on('queue-all-complete', () => {
    // Optional: play a sound or show a notification
    console.log("All videos in queue are completed!");
});


// ── Job Controls ────────────────────────────────────────────────────
async function stopJob(id) {
    if(confirm('Are you sure you want to stop this video?')) {
        await fetch(`/api/jobs/${id}/stop`, { method: 'POST' });
    }
}

function viewJob(id) {
    currentViewJobId = id;
    modal.classList.remove('hidden');
    streamLoader.style.display = 'flex';
    liveStreamImg.src = '';
    socket.emit('request-live-view', id);
}

closeModalBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
    socket.emit('stop-live-view');
    currentViewJobId = null;
});

// ── Active Jobs Updates (Socket.io) ─────────────────────────────────
socket.on('jobs-updated', (jobs) => {
    jobsGrid.innerHTML = '';
    
    // Only show jobs that are NOT 'completed' and NOT 'stopped' (or maybe show them temporarily)
    const activeJobs = jobs.filter(j => j.status !== 'completed' && j.status !== 'stopped');

    if (activeJobs.length === 0) {
        jobsGrid.innerHTML = '<p style="color: #94a3b8; grid-column: 1/-1; text-align: center;">No active videos currently playing.</p>';
        return;
    }

    activeJobs.forEach(job => {
        const card = document.createElement('div');
        card.className = 'job-card';
        
        card.innerHTML = `
            <div class="job-header">
                <span class="job-url" title="${job.url}">${job.url}</span>
                <span class="job-status status-${job.status}">${job.status}</span>
            </div>
            <div class="progress-container">
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width: ${job.progress}%"></div>
                </div>
                <div class="progress-text">
                    <span>${job.progress}% Watched</span>
                    <span>${job.duration} mins</span>
                </div>
            </div>
            <div class="job-actions">
                <button class="btn-secondary" onclick="viewJob('${job.id}')">👁️ View Live</button>
                <button class="btn-danger" onclick="stopJob('${job.id}')">Stop</button>
            </div>
        `;
        
        jobsGrid.appendChild(card);
    });
});

// Receive Live View Frames
socket.on('live-view-frame', (base64Img) => {
    if (currentViewJobId) {
        streamLoader.style.display = 'none';
        liveStreamImg.src = base64Img;
    }
});

// Initial load for active jobs
fetch('/api/jobs')
    .then(r => r.json())
    .then(jobs => {
        if(socket._callbacks['$jobs-updated']) {
             socket._callbacks['$jobs-updated'][0](jobs);
        }
    });

// Initial load for queue
fetch('/api/queue')
    .then(r => r.json())
    .then(data => {
        if(socket._callbacks['$queue-updated']) {
             socket._callbacks['$queue-updated'][0](data);
        }
    });
