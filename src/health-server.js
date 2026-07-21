'use strict';

/**
 * @module HealthServer
 * @description Express HTTP server exposing health check and status endpoints.
 *
 *  Endpoints:
 *  GET /health     — liveness probe (K8s/Docker compatible)
 *  GET /status     — detailed operational status
 *  GET /jobs       — all tracked video jobs and their states
 *  GET /stats      — aggregate statistics
 *  POST /pause     — pause the job queue
 *  POST /resume    — resume the job queue
 *
 *  This server can be probed by uptime monitors (UptimeRobot, Datadog, etc.)
 *  to ensure the automator is still alive during long overnight runs.
 */

const express = require('express');
const config = require('./config');
const logger = require('./logger');
const progressTracker = require('./progress-tracker');

class HealthServer {
  #app = express();
  #server = null;
  /** @type {import('./orchestrator')} */
  #orchestrator = null;

  /**
   * @param {Object} orchestrator  Injected to avoid circular deps
   */
  start(orchestrator) {
    this.#orchestrator = orchestrator;
    this.#registerRoutes();

    this.#server = this.#app.listen(config.health.port, () => {
      logger.info(`[HealthServer] Listening on http://localhost:${config.health.port}`);
    });

    this.#server.on('error', (err) => {
      logger.error(`[HealthServer] Server error: ${err.message}`);
    });

    return this.#server;
  }

  stop() {
    this.#server?.close(() => {
      logger.info('[HealthServer] Stopped');
    });
  }

  #registerRoutes() {
    this.#app.use(express.json());

    // ── GET /health ────────────────────────────────────────────────────────
    this.#app.get('/health', (req, res) => {
      res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: formatMemory(process.memoryUsage()),
      });
    });

    // ── GET /status ────────────────────────────────────────────────────────
    this.#app.get('/status', (req, res) => {
      const queueStatus = this.#orchestrator?.getQueueStatus() || {};
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        queue: queueStatus,
        stats: progressTracker.getStats(),
        memory: formatMemory(process.memoryUsage()),
        timestamp: new Date().toISOString(),
      });
    });

    // ── GET /jobs ──────────────────────────────────────────────────────────
    this.#app.get('/jobs', (req, res) => {
      const jobs = progressTracker.getAllJobs();
      res.json({ count: jobs.length, jobs });
    });

    // ── GET /stats ─────────────────────────────────────────────────────────
    this.#app.get('/stats', (req, res) => {
      res.json(progressTracker.getStats());
    });

    // ── POST /pause ────────────────────────────────────────────────────────
    this.#app.post('/pause', (req, res) => {
      this.#orchestrator?.pause();
      res.json({ message: 'Queue paused' });
    });

    // ── POST /resume ───────────────────────────────────────────────────────
    this.#app.post('/resume', (req, res) => {
      this.#orchestrator?.resume();
      res.json({ message: 'Queue resumed' });
    });

    // ── 404 handler ────────────────────────────────────────────────────────
    this.#app.use((req, res) => {
      res.status(404).json({ error: 'Not found', path: req.path });
    });

    // ── Error handler ──────────────────────────────────────────────────────
    this.#app.use((err, req, res, next) => {
      logger.error(`[HealthServer] Request error: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    });
  }
}

function formatMemory(mem) {
  const toMB = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';
  return {
    rss: toMB(mem.rss),
    heapUsed: toMB(mem.heapUsed),
    heapTotal: toMB(mem.heapTotal),
    external: toMB(mem.external),
  };
}

module.exports = new HealthServer();
