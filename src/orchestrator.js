'use strict';

/**
 * @module Orchestrator
 * @description The top-level engine that processes a batch of video jobs with
 *              configurable concurrency, priority ordering, and graceful shutdown.
 *
 *  Architecture:
 *  ─ Uses p-queue for bounded concurrency with priority support
 *  ─ Each job runs in its own isolated browser context (via VideoWatcher)
 *  ─ Emits lifecycle events consumed by the health server and reports
 *  ─ Handles SIGINT/SIGTERM for graceful shutdown (closes browser)
 *  ─ Schedules daily reports via node-cron
 */

const PQueue = require('p-queue').default || require('p-queue');
const cron = require('node-cron');
const Joi = require('joi');

const videoWatcher = require('./video-watcher');
const progressTracker = require('./progress-tracker');
const notificationService = require('./notification-service');
const browserFactory = require('./browser-factory');
const config = require('./config');
const logger = require('./logger');

// ─── Input schema ─────────────────────────────────────────────────────────────

const jobSchema = Joi.object({
  url: Joi.string().uri().required(),
  expectedDuration: Joi.number().positive().optional(), // minutes
  priority: Joi.number().integer().min(1).default(1),
});

const batchSchema = Joi.object({
  videos: Joi.array().items(jobSchema).min(1).required(),
  settings: Joi.object({
    concurrency: Joi.number().integer().min(1).max(10).default(config.execution.maxConcurrency),
    headless: Joi.boolean().default(config.browser.headless),
    notificationWebhook: Joi.string().uri().allow('', null).optional(),
    screenshotOnComplete: Joi.boolean().default(true),
  }).default({}),
});

class Orchestrator {
  /** @type {PQueue} */
  #queue = null;

  /** @type {Map<string, AbortController>} jobId → AbortController for cancellation */
  #activeJobs = new Map();

  #cronJob = null;
  #isShuttingDown = false;

  constructor() {
    this.#setupGracefulShutdown();
    this.#startDailyReportCron();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Validates and processes a full batch configuration.
   * This is the primary entry point.
   *
   * @param {Object} batchConfig  Matches the JSON input spec
   * @returns {Promise<Object[]>}  Array of result objects
   */
  async run(batchConfig) {
    // ── Validate input ────────────────────────────────────────────────────
    const { error, value: batch } = batchSchema.validate(batchConfig, { abortEarly: false });
    if (error) {
      const msg = error.details.map((d) => d.message).join('; ');
      throw new Error(`Invalid batch configuration: ${msg}`);
    }

    const { videos, settings } = batch;
    const concurrency = settings.concurrency;

    logger.info(`\n${'═'.repeat(60)}`);
    logger.info(`  LMS Automation Engine Starting`);
    logger.info(`  Jobs: ${videos.length} | Concurrency: ${concurrency}`);
    logger.info(`${'═'.repeat(60)}\n`);

    // ── Initialise queue ──────────────────────────────────────────────────
    this.#queue = new PQueue({ concurrency });

    // ── Queue all jobs ────────────────────────────────────────────────────
    const results = [];
    const jobPromises = videos.map((job) => {
      progressTracker.recordQueued(job.url, job.priority);

      return this.#queue.add(
        () => this.#executeJob(job, settings),
        { priority: job.priority }
      );
    });

    // ── Wait for all ──────────────────────────────────────────────────────
    const settled = await Promise.allSettled(jobPromises);
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        const job = videos[i];
        logger.error(`[Orchestrator] Job permanently failed: ${job.url} — ${r.reason?.message}`);
        progressTracker.recordFailed(job.url, r.reason?.message || 'Unknown error');
        notificationService.notifyError(job, r.reason).catch(() => {});
      }
    });

    // ── Final report ──────────────────────────────────────────────────────
    const stats = progressTracker.getStats();
    const summary = progressTracker.getSummaryReport();
    logger.info(summary);

    await notificationService.notifyDailyReport(stats, summary);

    return results;
  }

  /**
   * Adds a single video job to the queue dynamically (hot-add while running).
   *
   * @param {Object} job
   */
  async addJob(job) {
    const { error, value: validated } = jobSchema.validate(job);
    if (error) throw new Error(`Invalid job: ${error.message}`);

    if (!this.#queue) {
      this.#queue = new PQueue({ concurrency: config.execution.maxConcurrency });
    }

    progressTracker.recordQueued(validated.url, validated.priority);
    return this.#queue.add(() => this.#executeJob(validated, {}), {
      priority: validated.priority,
    });
  }

  /**
   * Returns current queue stats for the health check endpoint.
   */
  getQueueStatus() {
    if (!this.#queue) return { size: 0, pending: 0, isPaused: false };
    return {
      size: this.#queue.size,
      pending: this.#queue.pending,
      isPaused: this.#queue.isPaused,
    };
  }

  /**
   * Gracefully pauses the queue (waits for in-flight jobs to finish).
   */
  pause() {
    this.#queue?.pause();
    logger.info('[Orchestrator] Queue paused');
  }

  /**
   * Resumes a paused queue.
   */
  resume() {
    this.#queue?.start();
    logger.info('[Orchestrator] Queue resumed');
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Executes a single job and wires up notifications.
   */
  async #executeJob(job, settings) {
    if (this.#isShuttingDown) {
      throw new Error('Orchestrator is shutting down — job rejected');
    }

    logger.info(`[Orchestrator] Dequeuing job: ${job.url}`);

    const result = await videoWatcher.watch({
      ...job,
      onProgress: (currentSec, totalSec, sessionId) => {
        // Could stream progress to health endpoint here
        logger.debug(`[Orchestrator] Progress ${sessionId}: ${currentSec}s / ${totalSec}s`);
      },
      onComplete: (res) => {
        notificationService.notifyCompletion(job, res).catch((err) => {
          logger.warn(`[Orchestrator] Notification failed: ${err.message}`);
        });
      },
    });

    return result;
  }

  // ─── Cron / Scheduling ─────────────────────────────────────────────────────

  #startDailyReportCron() {
    const cronExpr = config.reporting.cron;
    if (!cron.validate(cronExpr)) {
      logger.warn(`[Orchestrator] Invalid cron expression: ${cronExpr} — daily report disabled`);
      return;
    }

    this.#cronJob = cron.schedule(cronExpr, async () => {
      logger.info('[Orchestrator] Sending scheduled daily report...');
      const stats = progressTracker.getStats();
      const summary = progressTracker.getSummaryReport();
      await notificationService.notifyDailyReport(stats, summary).catch((err) => {
        logger.warn(`[Orchestrator] Daily report notification failed: ${err.message}`);
      });
    });

    logger.info(`[Orchestrator] Daily report scheduled: ${cronExpr}`);
  }

  // ─── Graceful Shutdown ────────────────────────────────────────────────────

  #setupGracefulShutdown() {
    const shutdown = async (signal) => {
      if (this.#isShuttingDown) return;
      this.#isShuttingDown = true;

      logger.info(`\n[Orchestrator] Received ${signal} — initiating graceful shutdown...`);

      // Stop accepting new jobs
      this.#queue?.pause();
      this.#cronJob?.destroy();

      // Wait for in-flight jobs (up to 5 min)
      const inFlight = this.#queue?.pending || 0;
      if (inFlight > 0) {
        logger.info(`[Orchestrator] Waiting for ${inFlight} in-flight job(s) to complete...`);
        await Promise.race([
          this.#queue?.onIdle(),
          new Promise((r) => setTimeout(r, 5 * 60 * 1000)), // 5 min timeout
        ]);
      }

      // Close browser
      await browserFactory.close();

      // Final report
      logger.info(progressTracker.getSummaryReport());

      logger.info('[Orchestrator] Shutdown complete. Goodbye.');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
      logger.error(`[Orchestrator] Uncaught exception: ${err.message}`, { stack: err.stack });
      shutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
      logger.error(`[Orchestrator] Unhandled rejection: ${reason}`);
    });
  }
}

module.exports = new Orchestrator();
