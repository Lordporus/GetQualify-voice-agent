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

const REMINDER_QUEUE_NAME = 'appointment_reminders';
let reminderQueue = null;
let reminderWorker = null;
let reminderReady = false;

/**
 * Initialize BullMQ outbound call queue and worker.
 * @param {Object} [options]
 * @param {Object} [options.providers] - providers instance with dial()
 * @param {Object} [options.db] - db instance for updating job status
 * @param {Object} [options.sms] - sms instance
 * @param {Object} [options.whatsapp] - whatsapp instance
 */
function init(options = {}) {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    isReady = false;
    reminderReady = false;
    return { ready: false, reason: 'redis_not_configured' };
  }

  if (!Queue || !Worker || !Redis) {
    console.warn('[queue] bullmq or ioredis not installed. Running in offline fallback mode.');
    isReady = false;
    reminderReady = false;
    return { ready: false, reason: 'missing_dependencies' };
  }

  try {
    redisConn = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
    redisConn.on('error', (err) => {
      console.error('[queue:redisConn] Redis connection error:', err.message);
    });

    workerConn = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
    workerConn.on('error', (err) => {
      console.error('[queue:workerConn] Redis worker connection error:', err.message);
    });

    queue = new Queue(QUEUE_NAME, {
      connection: redisConn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    });
    queue.on('error', (err) => {
      console.error('[queue:bullmq] Queue error:', err.message);
    });

    const providers = options.providers || require('./providers');
    const db = options.db || require('./db');

    worker = new Worker(QUEUE_NAME, async (job) => {
      const { agentId, tenantId, phoneNumber, jobDbId } = job.data;
      try {
        // Resolve workflowId from job, agent, or default env
        let workflowId = job.data.workflowId || job.data.workflow_id;
        if (!workflowId && agentId) {
          if (db.isPostgres) {
            const aRes = await db.query('SELECT dograh_workflow_id FROM agents WHERE id = $1 LIMIT 1', [agentId]).catch(() => ({ rows: [] }));
            if (aRes.rows.length > 0 && (aRes.rows[0].dograh_workflow_id || aRes.rows[0].dograhWorkflowId)) {
              workflowId = Number(aRes.rows[0].dograh_workflow_id || aRes.rows[0].dograhWorkflowId);
            }
          } else {
            const core = require('./core');
            const agent = (core.db().agents || []).find((a) => a.id === agentId);
            if (agent && (agent.dograhWorkflowId || agent.dograh_workflow_id)) {
              workflowId = Number(agent.dograhWorkflowId || agent.dograh_workflow_id);
            }
          }
        }
        if (!workflowId || !Number.isInteger(Number(workflowId))) {
          workflowId = Number(process.env.DOGRAH_WORKFLOW_ID || 19);
        }

        await providers.telephony.dial(phoneNumber, { workflowId, agentId, tenantId });
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

    worker.on('error', (err) => {
      console.error('[queue:worker] Worker error:', err.message);
    });

    worker.on('failed', (job, err) => {
      console.error(`[queue] Outbound job ${job?.id} failed:`, err.message);
    });

    // --- Appointment Reminder Queue ---
    const sms = options.sms || require('./sms');
    const whatsapp = options.whatsapp || require('./whatsapp');

    reminderQueue = new Queue(REMINDER_QUEUE_NAME, {
      connection: redisConn,   // reuse existing redisConn
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    });
    reminderQueue.on('error', (err) => {
      console.error('[queue:reminder] Queue error:', err.message);
    });

    reminderWorker = new Worker(REMINDER_QUEUE_NAME, async (job) => {
      const { tenantId, appointmentId, attendeePhone, attendeeName, appointmentTime, businessName, channel = 'whatsapp' } = job.data;
      const jobDbId = job.opts?.jobId || job.id;

      // Check if reminder is still scheduled (not canceled)
      if (db.isPostgres && jobDbId) {
        const statusRes = await db.query(
          `SELECT status FROM appointment_reminders WHERE id = $1`, [jobDbId]
        ).catch(() => ({ rows: [] }));
        if (statusRes.rows.length > 0 && statusRes.rows[0].status !== 'scheduled') {
          return; // Silently skip — appointment was canceled
        }
      }

      try {
        if (channel === 'sms') {
          await sms.sendAppointmentReminder(attendeePhone, { businessName, appointmentTime });
        } else if (channel === 'voice') {
          await providers.telephony.dial(attendeePhone, {
            workflowId: Number(process.env.DOGRAH_WORKFLOW_ID || 19),
            tenantId,
          });
        } else {
          // Default: whatsapp
          await whatsapp.sendAppointmentReminder(attendeePhone, {
            tenantId,
            customerName: attendeeName || 'Customer',
            serviceName: 'Appointment',
            timeString: appointmentTime,
          });
        }

        if (db.isPostgres && jobDbId) {
          await db.query(
            `UPDATE appointment_reminders SET status='sent' WHERE id=$1`, [jobDbId]
          ).catch(() => {});
        }
      } catch (err) {
        if (db.isPostgres && jobDbId) {
          await db.query(
            `UPDATE appointment_reminders SET status='failed', last_error=$1 WHERE id=$2`,
            [String(err.message || err).slice(0, 1000), jobDbId]
          ).catch(() => {});
        }
        throw err;
      }
    }, {
      connection: workerConn,   // reuse existing workerConn
      concurrency: 3,
    });

    reminderWorker.on('error', (err) => {
      console.error('[queue:reminder] Worker error:', err.message);
    });
    reminderWorker.on('failed', (job, err) => {
      console.error(`[queue] Reminder job ${job?.id} failed:`, err.message);
    });

    reminderReady = true;
    console.log('[queue] BullMQ appointment reminder queue ready.');

    isReady = true;
    console.log('[queue] BullMQ outbound queue ready on ' + redisUrl);
    return { ready: true };
  } catch (err) {
    console.warn('[queue] Failed to initialize Redis/BullMQ:', err.message);
    isReady = false;
    reminderReady = false;
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
 * Schedule an appointment reminder job.
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.appointmentId  - Google Calendar event ID
 * @param {string} params.attendeePhone
 * @param {string} [params.attendeeName]
 * @param {string} [params.appointmentTime] - Human-readable time string for message
 * @param {string} [params.businessName]
 * @param {string} [params.channel]  - 'whatsapp' | 'sms' | 'voice'
 * @param {number} [params.delay]    - delay in ms
 * @param {string} [params.jobId]    - DB record ID for tracking
 */
async function scheduleReminder({ tenantId, appointmentId, attendeePhone, attendeeName, appointmentTime, businessName, channel = 'whatsapp', delay = 0, jobId }) {
  if (!reminderReady || !reminderQueue) {
    return { queued: false, reason: 'reminder_queue_not_ready' };
  }
  const job = await reminderQueue.add(
    'reminder',
    { tenantId, appointmentId, attendeePhone, attendeeName, appointmentTime, businessName, channel },
    { delay: Math.max(0, delay), jobId: jobId || undefined }
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
  reminderReady = false;
  if (reminderWorker) {
    try { await reminderWorker.close(); } catch (_) {}
  }
  if (reminderQueue) {
    try { await reminderQueue.close(); } catch (_) {}
  }
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
  scheduleReminder,
  getStatus,
  close,
  get isReady() { return isReady; },
  get reminderReady() { return reminderReady; },
  get queue() { return queue; },
  get reminderQueue() { return reminderQueue; },
};
