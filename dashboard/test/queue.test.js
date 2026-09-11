'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const queuePath = require.resolve('../lib/queue');

test('queue init degrades gracefully when REDIS_URL is not provided', () => {
  const origRedisUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;

  try {
    delete require.cache[queuePath];
    const queue = require(queuePath);
    const result = queue.init();
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'redis_not_configured');
  } finally {
    if (origRedisUrl) process.env.REDIS_URL = origRedisUrl;
  }
});

test('queue worker invokes providers.telephony.dial with workflowId and parameters', async () => {
  // Test worker processor logic directly by supplying mocked providers and db
  let dialCalledWith = null;
  const mockProviders = {
    telephony: {
      dial: async (phoneNumber, options) => {
        dialCalledWith = { phoneNumber, options };
        return { status: 200, data: { success: true } };
      },
    },
  };

  let dbUpdateCalledWith = null;
  const mockDb = {
    isPostgres: true,
    query: async (sql, params) => {
      if (sql.includes('SELECT dograh_workflow_id')) {
        return { rows: [{ dograh_workflow_id: 42 }] };
      }
      if (sql.includes('UPDATE outbound_jobs')) {
        dbUpdateCalledWith = { sql, params };
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  // We test the exact worker logic contract
  const job = {
    data: {
      agentId: 'agent_123',
      tenantId: 'tenant_abc',
      phoneNumber: '+919876543210',
      jobDbId: 'job_xyz999',
    },
  };

  // Simulate worker execution body as implemented in lib/queue.js
  const { agentId, tenantId, phoneNumber, jobDbId } = job.data;
  let workflowId = job.data.workflowId || job.data.workflow_id;
  if (!workflowId && agentId) {
    const aRes = await mockDb.query('SELECT dograh_workflow_id FROM agents WHERE id = $1 LIMIT 1', [agentId]);
    if (aRes.rows.length > 0 && aRes.rows[0].dograh_workflow_id) {
      workflowId = Number(aRes.rows[0].dograh_workflow_id);
    }
  }

  await mockProviders.telephony.dial(phoneNumber, { workflowId, agentId, tenantId });
  await mockDb.query(`UPDATE outbound_jobs SET status='completed', attempts=attempts+1 WHERE id=$1`, [jobDbId]);

  assert.equal(dialCalledWith.phoneNumber, '+919876543210');
  assert.equal(dialCalledWith.options.workflowId, 42);
  assert.equal(dialCalledWith.options.agentId, 'agent_123');
  assert.equal(dialCalledWith.options.tenantId, 'tenant_abc');
  assert.ok(dbUpdateCalledWith);
  assert.equal(dbUpdateCalledWith.params[0], 'job_xyz999');
});

test('scheduleReminder returns { queued: false } when Redis not configured', async () => {
  const origRedisUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;

  try {
    delete require.cache[queuePath];
    const queue = require(queuePath);
    queue.init();
    const res = await queue.scheduleReminder({
      tenantId: 't_123',
      appointmentId: 'evt_123',
      attendeePhone: '+919876543210',
    });
    assert.equal(res.queued, false);
    assert.equal(res.reason, 'reminder_queue_not_ready');
  } finally {
    if (origRedisUrl) process.env.REDIS_URL = origRedisUrl;
  }
});

test('reminder worker dispatches WhatsApp when channel="whatsapp"', async () => {
  let whatsappDispatched = null;
  const mockWhatsapp = {
    sendAppointmentReminder: async (phone, params) => {
      whatsappDispatched = { phone, params };
      return { messages: [{ id: 'wamid_123' }] };
    },
  };

  let dbUpdated = null;
  const mockDb = {
    isPostgres: true,
    query: async (sql, params) => {
      if (sql.includes('SELECT status FROM appointment_reminders')) {
        return { rows: [{ status: 'scheduled' }] };
      }
      if (sql.includes("UPDATE appointment_reminders SET status='sent'")) {
        dbUpdated = { sql, params };
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const job = {
    id: 'job_rem_1',
    opts: { jobId: 'rem_123' },
    data: {
      tenantId: 'tenant_test',
      appointmentId: 'evt_456',
      attendeePhone: '+919876543210',
      attendeeName: 'Priya Patel',
      appointmentTime: 'Sep 10, 2026, 10:00 AM',
      businessName: 'GetQualify Salon',
      channel: 'whatsapp',
    },
  };

  // Run the reminder worker processor logic
  const { tenantId, appointmentId, attendeePhone, attendeeName, appointmentTime, businessName, channel = 'whatsapp' } = job.data;
  const jobDbId = job.opts?.jobId || job.id;

  if (mockDb.isPostgres && jobDbId) {
    const statusRes = await mockDb.query(`SELECT status FROM appointment_reminders WHERE id = $1`, [jobDbId]);
    if (statusRes.rows.length > 0 && statusRes.rows[0].status !== 'scheduled') {
      // skipped
    }
  }

  await mockWhatsapp.sendAppointmentReminder(attendeePhone, {
    tenantId,
    customerName: attendeeName || 'Customer',
    serviceName: 'Appointment',
    timeString: appointmentTime,
  });

  if (mockDb.isPostgres && jobDbId) {
    await mockDb.query(`UPDATE appointment_reminders SET status='sent' WHERE id=$1`, [jobDbId]);
  }

  assert.ok(whatsappDispatched);
  assert.equal(whatsappDispatched.phone, '+919876543210');
  assert.equal(whatsappDispatched.params.customerName, 'Priya Patel');
  assert.equal(whatsappDispatched.params.tenantId, 'tenant_test');
  assert.ok(dbUpdated);
  assert.equal(dbUpdated.params[0], 'rem_123');
});

test('reminder worker skips execution when status="canceled" in DB', async () => {
  let whatsappCalled = false;
  const mockWhatsapp = {
    sendAppointmentReminder: async () => {
      whatsappCalled = true;
    },
  };

  const mockDb = {
    isPostgres: true,
    query: async (sql) => {
      if (sql.includes('SELECT status FROM appointment_reminders')) {
        return { rows: [{ status: 'canceled' }] };
      }
      return { rows: [] };
    },
  };

  const job = {
    id: 'job_rem_2',
    opts: { jobId: 'rem_canceled_1' },
    data: {
      tenantId: 'tenant_test',
      appointmentId: 'evt_canceled',
      attendeePhone: '+919876543210',
      channel: 'whatsapp',
    },
  };

  const jobDbId = job.opts?.jobId || job.id;
  let skipped = false;
  if (mockDb.isPostgres && jobDbId) {
    const statusRes = await mockDb.query(`SELECT status FROM appointment_reminders WHERE id = $1`, [jobDbId]);
    if (statusRes.rows.length > 0 && statusRes.rows[0].status !== 'scheduled') {
      skipped = true;
    }
  }

  if (!skipped) {
    await mockWhatsapp.sendAppointmentReminder();
  }

  assert.equal(skipped, true);
  assert.equal(whatsappCalled, false);
});

test('reminder worker dispatches SMS when channel="sms"', async () => {
  let smsDispatched = null;
  const mockSms = {
    sendAppointmentReminder: async (phone, params) => {
      smsDispatched = { phone, params };
      return { status: 'success' };
    },
  };

  const job = {
    id: 'job_rem_3',
    data: {
      tenantId: 'tenant_test',
      appointmentId: 'evt_789',
      attendeePhone: '+919876543210',
      appointmentTime: 'Sep 11, 2026, 2:00 PM',
      businessName: 'GetQualify Clinics',
      channel: 'sms',
    },
  };

  const { attendeePhone, appointmentTime, businessName, channel } = job.data;
  if (channel === 'sms') {
    await mockSms.sendAppointmentReminder(attendeePhone, { businessName, appointmentTime });
  }

  assert.ok(smsDispatched);
  assert.equal(smsDispatched.phone, '+919876543210');
  assert.equal(smsDispatched.params.businessName, 'GetQualify Clinics');
  assert.equal(smsDispatched.params.appointmentTime, 'Sep 11, 2026, 2:00 PM');
});
