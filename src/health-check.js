'use strict';

/**
 * Standalone health check script.
 * Used by Docker HEALTHCHECK CMD and can be run manually:
 *   node src/health-check.js
 *
 * Exits 0 if health endpoint returns OK, exits 1 otherwise.
 */

const http = require('http');
const config = require('./config');

const options = {
  hostname: 'localhost',
  port: config.health.port,
  path: '/health',
  method: 'GET',
  timeout: 5000,
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    if (res.statusCode === 200) {
      const data = JSON.parse(body);
      console.log(`[HealthCheck] OK — uptime: ${data.uptime?.toFixed(1)}s`);
      process.exit(0);
    } else {
      console.error(`[HealthCheck] FAIL — status: ${res.statusCode}`);
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.error(`[HealthCheck] FAIL — ${err.message}`);
  process.exit(1);
});

req.on('timeout', () => {
  req.destroy();
  console.error('[HealthCheck] FAIL — timeout');
  process.exit(1);
});

req.end();
