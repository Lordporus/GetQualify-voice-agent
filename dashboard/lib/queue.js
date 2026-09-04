'use strict';

/**
 * BullMQ Outbound Call Queue with ioredis and offline fallback.
 * 
 * Manages scheduled outbound call dispatching via Dograh / VoBiz telephony.
 * When REDIS_URL is not provided or Redis is unreachable, degrades gracefully
 * to offline mode where jobs are recorded in the database without crashing.
 */

let Queue = null;
let Worker = null;
let Redis = null;

try {
  const bullmq = require('bullmq');
  Queue = bullmq.Queue;
  Worker = bullmq.Worker;
  Redis = require('ioredis');
} catch (_) {
  // Dependencies optional at runtime if Redis not used
}

let queue = null;
let worker = null;
let redisConn = null;
let workerConn = null;
let isReady = false;

const QUEUE_NAME = 'outbound_calls';

/**
 * Initialize BullMQ outbound call queue and worker.
 * @param {Object} [options]
 * @param {Object} [options.providers] - providers instance with dial()
 * @param {Object} [options.db] - db instance for updating job status
 */
function init(options = {}) {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    isReady = false;
    return { ready: false, reason: 'redis_not_configured' };
  }

  if (!Queue || !Worker || !Redis) {
    console.warn('[queue] bullmq or ioredis not installed. Running in offline fallback mode.');
    isReady = false;
    return { ready: false, reason: 'missing_dependencies' };
  }

  try {
    redisConn = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
    workerConn = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });

    queue = new Queue(QUEUE_NAME, {
      connection: redisConn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    });

    const providers = options.providers || require('./providers');
    const db = options.db || require('./db');

    worker = new Worker(QUEUE_NAME, async (job) => {
      const { agentId, tenantId, phoneNumber, jobDbId } = job.data;
      try {
        await providers.dial({ agentId, tenantId, phoneNumber, confirm: true });
        if (db.isPostgres && jobDbId) {
          await db.query(`UPDATE outbound_jobs SET status='completed', attempts=attempts+1 WHERE id=$1`, [jobDbId]);
        }
      } catch (err) {
        if (db.isPostgres && jobDbId) {
          await db.query(
            `UPDATE outbound_jobs SET status='failed', attempts=attempts+1, last_error=$1 WHERE id=$2`,
            [String(err.message || err).slice(0, 1000), jobDbId]
          );
        }
        throw err;
      }
    }, {
      connection: workerConn,
      concurrency: 5,
      limiter: { max: 5, duration: 60000 }, // 5 concurrent calls per minute
    });

    worker.on('failed', (job, err) => {
      console.error(`[queue] Outbound job ${job?.id} failed:`, err.message);
    });

    isReady = true;
    console.log('[queue] BullMQ outbound queue ready on ' + redisUrl);
    return { ready: true };
  } catch (err) {
    console.warn('[queue] Failed to initialize Redis/BullMQ:', err.message);
    isReady = false;
    return { ready: false, reason: err.message };
  }
}

/**
 * Schedule or enqueue an outbound call.
 * @param {Object} jobData
 * @param {string} jobData.agentId
 * @param {string} jobData.tenantId
 * @param {string} jobData.phoneNumber
 * @param {string} [jobData.jobDbId]
 * @param {number} [jobData.delay] - delay in ms
 */
async function scheduleCall({ agentId, tenantId, phoneNumber, jobDbId, delay = 0 }) {
  if (!isReady || !queue) {
    return { queued: false, reason: 'redis_not_configured' };
  }

  const job = await queue.add(
    'dial',
    { agentId, tenantId, phoneNumber, jobDbId },
    { delay: Math.max(0, delay), jobId: jobDbId }
  );

  return { queued: true, jobId: job.id };
}

/**
 * Get queue metrics and status.
 */
async function getStatus() {
  if (!isReady || !queue) {
    return { ready: false, waiting: 0, active: 0, failed: 0 };
  }
  try {
    const [waiting, active, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getFailedCount(),
    ]);
    return { ready: true, waiting, active, failed };
  } catch (_) {
    return { ready: isReady, waiting: 0, active: 0, failed: 0 };
  }
}

async function close() {
  isReady = false;
  if (worker) {
    try { await worker.close(); } catch (_) {}
  }
  if (queue) {
    try { await queue.close(); } catch (_) {}
  }
  if (redisConn) {
    try { redisConn.disconnect(); } catch (_) {}
  }
  if (workerConn) {
    try { workerConn.disconnect(); } catch (_) {}
  }
}

module.exports = {
  init,
  scheduleCall,
  getStatus,
  close,
  get isReady() { return isReady; },
  get queue() { return queue; },
};
