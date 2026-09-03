'use strict';

const sgMail = require('@sendgrid/mail');
const core = require('./core');
const db = require('./db');

class EmailError extends Error {
  constructor(message, status = 500, code = 'email_error', detail = null) {
    super(message);
    this.name = 'EmailError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Checks if SendGrid is configured with an API key.
 */
function isConfigured() {
  return Boolean(process.env.SENDGRID_API_KEY);
}

/**
 * Logs an email attempt into the notifications table (PostgreSQL or JSON store).
 */
async function logNotification({ id, tenantId, type, recipientEmail, subject, status, sendgridId }) {
  const notifId = id || core.genId('notif_');
  const now = new Date().toISOString();

  if (db.isPostgres) {
    await db.query(
      `INSERT INTO notifications (id, tenant_id, type, recipient_email, subject, status, sendgrid_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         sendgrid_id = EXCLUDED.sendgrid_id`,
      [notifId, tenantId, type || 'general', recipientEmail, subject, status, sendgridId || null, now]
    ).catch((err) => {
      console.error('[email] Error logging notification to Postgres:', err.message);
    });
  } else {
    await core.mutate((d) => {
      if (!d.notifications) d.notifications = [];
      const idx = d.notifications.findIndex((n) => n.id === notifId);
      const entry = {
        id: notifId,
        tenantId,
        tenant_id: tenantId,
        type: type || 'general',
        recipientEmail,
        recipient_email: recipientEmail,
        subject,
        status,
        sendgridId: sendgridId || null,
        sendgrid_id: sendgridId || null,
        createdAt: now,
        created_at: now,
      };
      if (idx >= 0) {
        d.notifications[idx] = entry;
      } else {
        d.notifications.push(entry);
      }
    });
  }

  return { id: notifId, tenantId, type, recipientEmail, subject, status, sendgridId, createdAt: now };
}

/**
 * Look up tenant owner's primary email address.
 */
async function getTenantOwnerEmail(tenantId) {
  if (!tenantId) return null;

  if (db.isPostgres) {
    const res = await db.query(
      `SELECT email FROM users WHERE tenant_id = $1 AND role IN ('owner', 'super_admin') AND status = 'active' ORDER BY created_at ASC LIMIT 1`,
      [tenantId]
    ).catch(() => ({ rows: [] }));
    if (res.rows.length > 0 && res.rows[0].email) {
      return res.rows[0].email;
    }
  } else {
    const d = core.loadDb();
    const user = (d.users || []).find(
      (u) => (u.tenantId === tenantId || u.tenant_id === tenantId) &&
             (u.role === 'owner' || u.role === 'super_admin') &&
             u.status !== 'deleted'
    );
    if (user && user.email) return user.email;
  }

  return null;
}

/**
 * Core sendEmail method wrapping @sendgrid/mail and persisting to `notifications`.
 */
async function sendEmail({ tenantId, to, subject, text, html, type = 'general', cc, bcc }) {
  const notifId = core.genId('notif_');
  const recipientEmail = String(to || '').trim();

  if (!tenantId) {
    throw new EmailError('tenantId is required to send and log notification', 422, 'missing_tenant');
  }
  if (!recipientEmail || !recipientEmail.includes('@')) {
    throw new EmailError('Valid recipient email address is required', 422, 'bad_email');
  }
  if (!subject) {
    throw new EmailError('Email subject is required', 422, 'missing_subject');
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    await logNotification({
      id: notifId,
      tenantId,
      type,
      recipientEmail,
      subject,
      status: 'failed',
      sendgridId: null,
    });
    throw new EmailError('SENDGRID_API_KEY is not configured', 503, 'email_not_configured');
  }

  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@getqualify.ai';
  sgMail.setApiKey(apiKey);

  const msg = {
    to: recipientEmail,
    from: fromEmail,
    subject,
    text: text || '',
    html: html || text || '',
  };
  if (cc) msg.cc = cc;
  if (bcc) msg.bcc = bcc;

  let sendgridId = null;
  try {
    const [response] = await sgMail.send(msg);
    if (response && response.headers) {
      sendgridId = response.headers['x-message-id'] || null;
    }
    await logNotification({
      id: notifId,
      tenantId,
      type,
      recipientEmail,
      subject,
      status: 'sent',
      sendgridId,
    });
    return {
      ok: true,
      notificationId: notifId,
      sendgridId,
      recipientEmail,
      status: 'sent',
    };
  } catch (err) {
    await logNotification({
      id: notifId,
      tenantId,
      type,
      recipientEmail,
      subject,
      status: 'failed',
      sendgridId: null,
    });
    const detail = err.response && err.response.body ? err.response.body : null;
    throw new EmailError(`SendGrid dispatch failed: ${err.message}`, 502, 'upstream_email_error', detail);
  }
}

/**
 * Sends a structured post-call summary email with transcript and caller details.
 */
async function sendCallSummary(tenantId, {
  recipientEmail = null,
  callerName = 'Prospective Customer',
  callerPhone = 'Unknown',
  duration = 0,
  transcript = '',
  summary = '',
  leadId = null,
  callId = null,
  recordingUrl = null,
} = {}) {
  const targetEmail = recipientEmail || (await getTenantOwnerEmail(tenantId));
  if (!targetEmail) {
    throw new EmailError('Recipient email address could not be resolved for tenant', 422, 'missing_recipient_email');
  }

  const durationMin = Math.floor(duration / 60);
  const durationSec = duration % 60;
  const durationFormatted = `${durationMin}m ${durationSec}s (${duration}s total)`;

  const subject = `Call Summary: ${callerName} (${callerPhone}) - GetQualify`;

  const text = `
Call Summary & Transcript
-------------------------
Caller: ${callerName} (${callerPhone})
Duration: ${durationFormatted}
${leadId ? `Lead ID: ${leadId}` : ''}
${callId ? `Call ID: ${callId}` : ''}

Key Discussion / Summary:
${summary || 'No AI summary generated for this call.'}

Transcript:
${transcript || 'No transcript available.'}

${recordingUrl ? `Listen to recording: ${recordingUrl}` : ''}
`.trim();

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
  <div style="background-color: #4f46e5; padding: 24px; color: #ffffff;">
    <h1 style="margin: 0; font-size: 20px; font-weight: 600;">GetQualify Call Summary</h1>
    <p style="margin: 6px 0 0 0; font-size: 14px; opacity: 0.9;">Caller: ${core.htmlEscape(callerName)} (${core.htmlEscape(callerPhone)})</p>
  </div>
  <div style="padding: 24px;">
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr>
        <td style="padding: 6px 0; color: #64748b; font-size: 14px; width: 120px;">Duration</td>
        <td style="padding: 6px 0; font-size: 14px; font-weight: 500;">${core.htmlEscape(durationFormatted)}</td>
      </tr>
      ${leadId ? `<tr><td style="padding: 6px 0; color: #64748b; font-size: 14px;">Lead ID</td><td style="padding: 6px 0; font-size: 14px; font-mono;">${core.htmlEscape(leadId)}</td></tr>` : ''}
      ${callId ? `<tr><td style="padding: 6px 0; color: #64748b; font-size: 14px;">Call ID</td><td style="padding: 6px 0; font-size: 14px; font-mono;">${core.htmlEscape(callId)}</td></tr>` : ''}
    </table>

    ${summary ? `
    <div style="margin-bottom: 24px; background: #f8fafc; border-left: 4px solid #4f46e5; padding: 16px; border-radius: 4px;">
      <h3 style="margin: 0 0 8px 0; font-size: 14px; text-transform: uppercase; color: #475569; letter-spacing: 0.5px;">Summary</h3>
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #334155;">${core.htmlEscape(summary)}</p>
    </div>` : ''}

    <h3 style="margin: 0 0 12px 0; font-size: 14px; text-transform: uppercase; color: #475569; letter-spacing: 0.5px;">Transcript</h3>
    <div style="background: #f1f5f9; padding: 16px; border-radius: 6px; font-family: monospace; font-size: 13px; line-height: 1.5; color: #334155; white-space: pre-wrap; max-height: 350px; overflow-y: auto;">
${core.htmlEscape(transcript || 'No transcript available.')}
    </div>

    ${recordingUrl ? `
    <div style="margin-top: 24px; text-align: center;">
      <a href="${core.htmlEscape(recordingUrl)}" style="background-color: #4f46e5; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 500; display: inline-block;">Listen to Call Audio</a>
    </div>` : ''}
  </div>
  <div style="border-top: 1px solid #e2e8f0; padding: 16px 24px; text-align: center; font-size: 12px; color: #94a3b8;">
    Sent automatically by GetQualify AI Voice Agent Platform.
  </div>
</div>
`;

  return sendEmail({
    tenantId,
    to: targetEmail,
    subject,
    text,
    html,
    type: 'call_summary',
  });
}

/**
 * Sends booking confirmation email to client and business owner.
 */
async function sendBookingConfirmation(tenantId, {
  recipientEmail,
  clientName = 'Valued Client',
  appointmentTime = '',
  agentName = 'Voice Assistant',
  calendarEventUrl = null,
  businessName = 'GetQualify',
  notes = '',
} = {}) {
  if (!recipientEmail) {
    throw new EmailError('Recipient email is required for booking confirmation', 422, 'missing_email');
  }

  const subject = `Appointment Confirmed: ${appointmentTime} with ${businessName}`;

  const text = `
Appointment Confirmation
------------------------
Hello ${clientName},

Your appointment has been successfully scheduled!

Details:
- Date & Time: ${appointmentTime}
- Booked by: ${agentName}
${notes ? `- Notes: ${notes}` : ''}
${calendarEventUrl ? `- Calendar Event: ${calendarEventUrl}` : ''}

Thank you for choosing ${businessName}.
`.trim();

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
  <div style="background-color: #059669; padding: 24px; color: #ffffff;">
    <h1 style="margin: 0; font-size: 20px; font-weight: 600;">Booking Confirmed!</h1>
    <p style="margin: 6px 0 0 0; font-size: 14px; opacity: 0.9;">Appointment with ${core.htmlEscape(businessName)}</p>
  </div>
  <div style="padding: 24px;">
    <p style="font-size: 15px; margin: 0 0 20px 0;">Hello <strong>${core.htmlEscape(clientName)}</strong>,</p>
    <p style="font-size: 14px; color: #475569; margin: 0 0 20px 0;">Your appointment has been successfully booked with our team.</p>

    <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 18px; margin-bottom: 24px;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 6px 0; color: #166534; font-size: 14px; font-weight: 600; width: 120px;">Scheduled Time:</td>
          <td style="padding: 6px 0; font-size: 15px; font-weight: 700; color: #14532d;">${core.htmlEscape(appointmentTime)}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #166534; font-size: 14px;">Assisted By:</td>
          <td style="padding: 6px 0; font-size: 14px; color: #166534;">${core.htmlEscape(agentName)}</td>
        </tr>
        ${notes ? `<tr><td style="padding: 6px 0; color: #166534; font-size: 14px;">Notes:</td><td style="padding: 6px 0; font-size: 14px; color: #166534;">${core.htmlEscape(notes)}</td></tr>` : ''}
      </table>
    </div>

    ${calendarEventUrl ? `
    <div style="text-align: center; margin-top: 24px;">
      <a href="${core.htmlEscape(calendarEventUrl)}" style="background-color: #059669; color: #ffffff; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600; display: inline-block;">View in Calendar</a>
    </div>` : ''}
  </div>
  <div style="border-top: 1px solid #e2e8f0; padding: 16px 24px; text-align: center; font-size: 12px; color: #94a3b8;">
    Thank you for choosing ${core.htmlEscape(businessName)}.
  </div>
</div>
`;

  return sendEmail({
    tenantId,
    to: recipientEmail,
    subject,
    text,
    html,
    type: 'booking_confirmation',
  });
}

/**
 * Sends an invoice notice to the tenant billing contact.
 */
async function sendInvoiceNotification(tenantId, {
  recipientEmail = null,
  invoiceId = 'INV-001',
  amountInr = 0,
  period = '',
  dueDate = '',
  downloadUrl = null,
} = {}) {
  const targetEmail = recipientEmail || (await getTenantOwnerEmail(tenantId));
  if (!targetEmail) {
    throw new EmailError('Recipient email address could not be resolved for invoice', 422, 'missing_recipient_email');
  }

  const subject = `Invoice ${invoiceId} Available: ₹${amountInr.toLocaleString('en-IN')}`;

  const text = `
GetQualify Invoice Notice
-------------------------
Invoice ID: ${invoiceId}
Billing Period: ${period}
Amount: INR ₹${amountInr.toLocaleString('en-IN')}
Due Date: ${dueDate}

${downloadUrl ? `Download / View Invoice: ${downloadUrl}` : ''}
`.trim();

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
  <div style="background-color: #0f172a; padding: 24px; color: #ffffff;">
    <h1 style="margin: 0; font-size: 20px; font-weight: 600;">GetQualify Invoice</h1>
    <p style="margin: 6px 0 0 0; font-size: 14px; opacity: 0.9;">Invoice ${core.htmlEscape(invoiceId)}</p>
  </div>
  <div style="padding: 24px;">
    <p style="font-size: 14px; color: #475569; margin: 0 0 20px 0;">Your invoice for the recent billing period has been generated.</p>

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 18px; margin-bottom: 24px;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 6px 0; color: #64748b; font-size: 14px; width: 120px;">Amount Due:</td>
          <td style="padding: 6px 0; font-size: 18px; font-weight: 700; color: #0f172a;">₹${amountInr.toLocaleString('en-IN')}</td>
        </tr>
        ${period ? `<tr><td style="padding: 6px 0; color: #64748b; font-size: 14px;">Period:</td><td style="padding: 6px 0; font-size: 14px; color: #334155;">${core.htmlEscape(period)}</td></tr>` : ''}
        ${dueDate ? `<tr><td style="padding: 6px 0; color: #64748b; font-size: 14px;">Due Date:</td><td style="padding: 6px 0; font-size: 14px; color: #334155;">${core.htmlEscape(dueDate)}</td></tr>` : ''}
      </table>
    </div>

    ${downloadUrl ? `
    <div style="text-align: center; margin-top: 24px;">
      <a href="${core.htmlEscape(downloadUrl)}" style="background-color: #0f172a; color: #ffffff; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600; display: inline-block;">View & Pay Invoice</a>
    </div>` : ''}
  </div>
  <div style="border-top: 1px solid #e2e8f0; padding: 16px 24px; text-align: center; font-size: 12px; color: #94a3b8;">
    Thank you for your business.
  </div>
</div>
`;

  return sendEmail({
    tenantId,
    to: targetEmail,
    subject,
    text,
    html,
    type: 'invoice_notification',
  });
}

module.exports = {
  EmailError,
  isConfigured,
  sendEmail,
  sendCallSummary,
  sendBookingConfirmation,
  sendInvoiceNotification,
  logNotification,
  getTenantOwnerEmail,
};
