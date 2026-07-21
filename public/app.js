const socket = io();

const form = document.getElementById('job-form');
const urlInput = document.getElementById('url');
const durationInput = document.getElementById('duration');
const jobsGrid = document.getElementById('jobs-grid');

const modal = document.getElementById('live-view-modal');
const closeModalBtn = document.getElementById('close-modal');
const liveStreamImg = document.getElementById('live-stream');
const streamLoader = document.getElementById('stream-loader');

let currentViewJobId = null;

// Handle Form Submission
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
        } else {
            const err = await res.json();
            alert('Error: ' + err.error);
        }
    } catch (e) {
        alert('Failed to connect to server.');
    }
});

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

// Update Grid
socket.on('jobs-updated', (jobs) => {
    jobsGrid.innerHTML = '';
    
    if (jobs.length === 0) {
        jobsGrid.innerHTML = '<p style="color: #94a3b8; grid-column: 1/-1; text-align: center;">No active videos. Add one above to start!</p>';
        return;
    }

    jobs.forEach(job => {
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

// Initial load
fetch('/api/jobs')
    .then(r => r.json())
    .then(jobs => {
        // manually trigger the render
        socket._callbacks['$jobs-updated'][0](jobs);
    });
