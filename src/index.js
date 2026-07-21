'use strict';

/**
 * @module index
 * @description Application entry point.
 *
 *  Accepts input from one of three sources (in order of priority):
 *  1. JSON config file path passed as --config=./config.json CLI arg
 *  2. Inline JSON passed as --inline='{"videos":[...]}'  CLI arg
 *  3. A default videos.config.json in the project root
 *
 *  Usage:
 *    node src/index.js --config=./my-batch.json
 *    node src/index.js --inline='{"videos":[{"url":"...","expectedDuration":62}]}'
 */

const path = require('path');
const fs = require('fs');

const orchestrator = require('./orchestrator');
const healthServer = require('./health-server');
const logger = require('./logger');

// ─── Parse CLI args ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};

  for (const arg of args) {
    if (arg.startsWith('--config=')) {
      result.configPath = arg.slice('--config='.length);
    } else if (arg.startsWith('--inline=')) {
      result.inline = arg.slice('--inline='.length);
    }
  }

  return result;
}

// ─── Load batch config ────────────────────────────────────────────────────────

function loadBatchConfig(args) {
  // Priority 1: --inline JSON
  if (args.inline) {
    try {
      return JSON.parse(args.inline);
    } catch (e) {
      logger.error(`[Main] Failed to parse --inline JSON: ${e.message}`);
      process.exit(1);
    }
  }

  // Priority 2: --config file path
  const configPath = args.configPath
    ? path.resolve(args.configPath)
    : path.resolve('videos.config.json');

  if (!fs.existsSync(configPath)) {
    logger.error(`[Main] No config file found at: ${configPath}`);
    logger.error('[Main] Create a videos.config.json or pass --config=<path>');
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    logger.info(`[Main] Loaded config from: ${configPath}`);
    return parsed;
  } catch (e) {
    logger.error(`[Main] Failed to parse config file: ${e.message}`);
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  logger.info('');
  logger.info('  ██╗     ███╗   ███╗███████╗     █████╗ ██╗   ██╗████████╗ ██████╗ ');
  logger.info('  ██║     ████╗ ████║██╔════╝    ██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗');
  logger.info('  ██║     ██╔████╔██║███████╗    ███████║██║   ██║   ██║   ██║   ██║');
  logger.info('  ██║     ██║╚██╔╝██║╚════██║    ██╔══██║██║   ██║   ██║   ██║   ██║');
  logger.info('  ███████╗██║ ╚═╝ ██║███████║    ██║  ██║╚██████╔╝   ██║   ╚██████╔╝');
  logger.info('  ╚══════╝╚═╝     ╚═╝╚══════╝    ╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝ ');
  logger.info('');
  logger.info('  LMS Video Automator v2.0.0 | Production Grade | Anti-Detection');
  logger.info('');

  // Start health server immediately so it's ready before jobs start
  healthServer.start(orchestrator);

  const args = parseArgs();
  const batchConfig = loadBatchConfig(args);

  logger.info(`[Main] Processing ${batchConfig.videos?.length || 0} video(s)...`);

  try {
    const results = await orchestrator.run(batchConfig);

    const completed = results.filter((r) => r && r.completed).length;
    logger.info(`\n[Main] All jobs finished. ${completed}/${results.length} videos completed.`);
  } catch (err) {
    logger.error(`[Main] Fatal orchestrator error: ${err.message}`, { stack: err.stack });
    process.exit(1);
  }
}

main();
