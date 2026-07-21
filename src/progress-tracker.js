'use strict';

/**
 * @module ProgressTracker
 * @description In-memory + persistent progress tracking for all video jobs.
 *
 *  Tracks:
 *  ─ Job lifecycle: queued → started → in-progress → completed / failed
 *  ─ Real-time playback position updates
 *  ─ Aggregate statistics for daily reports
 *  ─ Persists state to disk so restarts don't lose context
 */

const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const config = require('./config');
const logger = require('./logger');

const STATE_FILE = path.resolve(config.storage.sessionDir, 'progress-state.json');

const STATUS = Object.freeze({
  QUEUED: 'queued',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

class ProgressTracker extends EventEmitter {
  /** @type {Map<string, Object>} url → job state */
  #jobs = new Map();

  /** @type {{ total: number, completed: number, failed: number, totalWatchedMinutes: number }} */
  #stats = { total: 0, completed: 0, failed: 0, totalWatchedMinutes: 0 };

  constructor() {
    super();
    this.#loadState();
  }

  // ─── Lifecycle Events ──────────────────────────────────────────────────────

  recordQueued(url, priority = 1) {
    const job = {
      url,
      priority,
      status: STATUS.QUEUED,
      queuedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      sessionId: null,
      durationSeconds: null,
      currentSeconds: 0,
      errors: [],
    };
    this.#jobs.set(url, job);
    this.#stats.total++;
    this.#save();
    this.emit('queued', job);
    logger.debug(`[ProgressTracker] Queued: ${url}`);
  }

  recordStart(url, durationSeconds, sessionId) {
    const job = this.#getOrCreate(url);
    Object.assign(job, {
      status: STATUS.IN_PROGRESS,
      startedAt: Date.now(),
      durationSeconds,
      sessionId,
    });
    this.#save();
    this.emit('started', job);
    logger.info(`[ProgressTracker] Started: ${url} (${(durationSeconds / 60).toFixed(1)}min)`);
  }

  recordProgress(url, currentSeconds, totalSeconds) {
    const job = this.#getOrCreate(url);
    job.currentSeconds = currentSeconds;
    job.totalSeconds = totalSeconds;
    job.percentComplete = totalSeconds > 0
      ? parseFloat(((currentSeconds / totalSeconds) * 100).toFixed(1))
      : 0;
    this.emit('progress', job);
    // Don't save on every progress tick — too many disk writes
    // State is saved on start/complete/error
  }

  recordComplete(url, result) {
    const job = this.#getOrCreate(url);
    Object.assign(job, {
      status: STATUS.COMPLETED,
      completedAt: Date.now(),
      screenshotPath: result.screenshotPath,
      completionText: result.completionText,
      percentComplete: 100,
    });
    this.#stats.completed++;
    this.#stats.totalWatchedMinutes += result.durationMinutes || 0;
    this.#save();
    this.emit('completed', job);
    logger.info(`[ProgressTracker] Completed: ${url}`);
  }

  recordError(url, errorMessage) {
    const job = this.#getOrCreate(url);
    job.errors.push({ message: errorMessage, at: Date.now() });
    // Status stays in_progress until all retries are exhausted
    this.#save();
    this.emit('error', { job, error: errorMessage });
  }

  recordFailed(url, errorMessage) {
    const job = this.#getOrCreate(url);
    Object.assign(job, {
      status: STATUS.FAILED,
      failedAt: Date.now(),
    });
    job.errors.push({ message: errorMessage, at: Date.now() });
    this.#stats.failed++;
    this.#save();
    this.emit('failed', job);
    logger.error(`[ProgressTracker] Failed: ${url} — ${errorMessage}`);
  }

  // ─── Query API ─────────────────────────────────────────────────────────────

  getJob(url) {
    return this.#jobs.get(url) || null;
  }

  getAllJobs() {
    return Array.from(this.#jobs.values());
  }

  getStats() {
    return {
      ...this.#stats,
      pending: this.#stats.total - this.#stats.completed - this.#stats.failed,
      successRate:
        this.#stats.total > 0
          ? ((this.#stats.completed / this.#stats.total) * 100).toFixed(1) + '%'
          : '0%',
    };
  }

  getSummaryReport() {
    const jobs = this.getAllJobs();
    const stats = this.getStats();
    const lines = [
      `\n${'─'.repeat(60)}`,
      `  LMS Automation Progress Report — ${new Date().toLocaleString()}`,
      `${'─'.repeat(60)}`,
      `  Total Jobs    : ${stats.total}`,
      `  Completed     : ${stats.completed}`,
      `  Failed        : ${stats.failed}`,
      `  Pending       : ${stats.pending}`,
      `  Success Rate  : ${stats.successRate}`,
      `  Total Watched : ${stats.totalWatchedMinutes.toFixed(1)} minutes`,
      `${'─'.repeat(60)}`,
    ];

    if (jobs.length > 0) {
      lines.push('  Video Status:');
      jobs.forEach((job) => {
        const pct = job.percentComplete ? `${job.percentComplete}%` : '0%';
        const dur = job.durationSeconds ? `${(job.durationSeconds / 60).toFixed(1)}min` : 'unknown';
        lines.push(`    [${job.status.toUpperCase().padEnd(11)}] ${truncate(job.url, 55)} | ${pct} | ${dur}`);
      });
    }

    lines.push(`${'─'.repeat(60)}\n`);
    return lines.join('\n');
  }

  // ─── State Persistence ─────────────────────────────────────────────────────

  #save() {
    try {
      const state = {
        jobs: Array.from(this.#jobs.entries()),
        stats: this.#stats,
        savedAt: Date.now(),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      logger.warn(`[ProgressTracker] State save failed: ${err.message}`);
    }
  }

  #loadState() {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const { jobs, stats } = JSON.parse(raw);
      this.#jobs = new Map(jobs);
      this.#stats = stats;
      logger.info(`[ProgressTracker] Loaded ${this.#jobs.size} jobs from previous state`);
    } catch (err) {
      logger.warn(`[ProgressTracker] State load failed (starting fresh): ${err.message}`);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  #getOrCreate(url) {
    if (!this.#jobs.has(url)) {
      this.#jobs.set(url, {
        url,
        status: STATUS.QUEUED,
        errors: [],
        currentSeconds: 0,
        percentComplete: 0,
      });
    }
    return this.#jobs.get(url);
  }
}

const truncate = (str, len) => (str.length > len ? str.slice(0, len - 1) + '…' : str);

module.exports = new ProgressTracker();
module.exports.STATUS = STATUS;
