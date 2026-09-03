'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const core = require('./core');
const db = require('./db');

class StorageError extends Error {
  constructor(message, status = 500, code = 'storage_error', detail = null) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Validates if Vultr Object Storage configuration is present.
 */
function isConfigured() {
  return Boolean(
    process.env.VULTR_ACCESS_KEY_ID &&
    process.env.VULTR_SECRET_ACCESS_KEY &&
    process.env.VULTR_ENDPOINT_URL &&
    process.env.VULTR_BUCKET_NAME
  );
}

/**
 * Returns an initialized S3Client configured for Vultr Object Storage.
 */
let cachedClient = null;
let cachedEndpoint = null;
let cachedAccessKey = null;

function getClient(options = {}) {
  const accessKeyId = options.accessKeyId || process.env.VULTR_ACCESS_KEY_ID;
  const secretAccessKey = options.secretAccessKey || process.env.VULTR_SECRET_ACCESS_KEY;
  const endpoint = options.endpoint || process.env.VULTR_ENDPOINT_URL;
  const region = options.region || process.env.VULTR_REGION || 'us-east-1';

  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new StorageError(
      'Vultr Object Storage credentials or endpoint are not configured (VULTR_ACCESS_KEY_ID, VULTR_SECRET_ACCESS_KEY, VULTR_ENDPOINT_URL)',
      503,
      'storage_not_configured'
    );
  }

  // Reuse cached client if configuration hasn't changed
  if (cachedClient && cachedEndpoint === endpoint && cachedAccessKey === accessKeyId && !options.forceNew) {
    return cachedClient;
  }

  const client = new S3Client({
    endpoint,
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    forcePathStyle: true,
  });

  if (!options.forceNew) {
    cachedClient = client;
    cachedEndpoint = endpoint;
    cachedAccessKey = accessKeyId;
  }

  return client;
}

/**
 * Record recording metadata in PostgreSQL or JSON DB store.
 */
async function saveRecordingRecord({ id, callId, tenantId, s3Key, durationSeconds, sizeBytes, createdAt }) {
  const now = createdAt || new Date().toISOString();
  if (db.isPostgres) {
    await db.query(
      `INSERT INTO call_recordings (id, call_id, tenant_id, s3_key, duration_seconds, size_bytes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         s3_key = EXCLUDED.s3_key,
         size_bytes = EXCLUDED.size_bytes,
         duration_seconds = EXCLUDED.duration_seconds`,
      [id, callId, tenantId, s3Key, durationSeconds || null, sizeBytes || 0, now]
    );
  } else {
    await core.mutate((d) => {
      if (!d.callRecordings) d.callRecordings = [];
      const idx = d.callRecordings.findIndex((r) => (r.id === id || r.callId === callId || r.call_id === callId) && (r.tenantId === tenantId || r.tenant_id === tenantId));
      const entry = {
        id,
        callId,
        call_id: callId,
        tenantId,
        tenant_id: tenantId,
        s3Key,
        s3_key: s3Key,
        durationSeconds: durationSeconds || null,
        duration_seconds: durationSeconds || null,
        sizeBytes: sizeBytes || 0,
        size_bytes: sizeBytes || 0,
        createdAt: now,
        created_at: now,
      };
      if (idx >= 0) {
        d.callRecordings[idx] = entry;
      } else {
        d.callRecordings.push(entry);
      }
    });
  }
  return { id, callId, tenantId, s3Key, durationSeconds, sizeBytes, createdAt: now };
}

/**
 * Look up recording record by callId and tenantId.
 */
async function getRecordingRecord(tenantId, callId) {
  if (db.isPostgres) {
    const res = await db.query(
      `SELECT id, call_id, tenant_id, s3_key, duration_seconds, size_bytes, created_at
       FROM call_recordings
       WHERE (call_id = $1 OR id = $1) AND tenant_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [callId, tenantId]
    ).catch(() => ({ rows: [] }));
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      callId: row.callId || row.call_id,
      tenantId: row.tenantId || row.tenant_id,
      s3Key: row.s3Key || row.s3_key,
      durationSeconds: row.durationSeconds || row.duration_seconds,
      sizeBytes: Number(row.sizeBytes || row.size_bytes || 0),
      createdAt: row.createdAt || row.created_at,
    };
  }

  const d = core.loadDb();
  const row = (d.callRecordings || []).find(
    (r) => ((r.callId === callId || r.call_id === callId || r.id === callId) &&
            (r.tenantId === tenantId || r.tenant_id === tenantId))
  );
  if (!row) return null;
  return {
    id: row.id,
    callId: row.callId || row.call_id,
    tenantId: row.tenantId || row.tenant_id,
    s3Key: row.s3Key || row.s3_key,
    durationSeconds: row.durationSeconds || row.duration_seconds,
    sizeBytes: Number(row.sizeBytes || row.size_bytes || 0),
    createdAt: row.createdAt || row.created_at,
  };
}

/**
 * Uploads an in-memory buffer directly to Vultr Object Storage and logs to call_recordings.
 */
async function uploadBuffer({ tenantId, callId, buffer, contentType = 'audio/wav', durationSeconds = null, key = null }) {
  if (!tenantId || !callId) {
    throw new StorageError('tenantId and callId are required for recording upload', 422, 'missing_parameters');
  }
  if (!Buffer.isBuffer(buffer)) {
    throw new StorageError('Audio buffer must be an instance of Buffer', 422, 'invalid_buffer');
  }

  const bucket = process.env.VULTR_BUCKET_NAME;
  if (!bucket) {
    throw new StorageError('VULTR_BUCKET_NAME is not configured', 503, 'missing_bucket');
  }

  const s3Key = key || `recordings/${tenantId}/${callId}.wav`;
  const client = getClient();

  try {
    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: buffer,
      ContentType: contentType,
      Metadata: {
        tenant_id: String(tenantId),
        call_id: String(callId),
      },
    });
    await client.send(cmd);
  } catch (err) {
    throw new StorageError(`Vultr Object Storage upload failed: ${err.message}`, 502, 'upload_failed', err);
  }

  const recId = core.genId('rec_');
  const record = await saveRecordingRecord({
    id: recId,
    callId,
    tenantId,
    s3Key,
    durationSeconds,
    sizeBytes: buffer.length,
  });

  return record;
}

/**
 * Fetches audio from a remote recording URL (e.g. Dograh URL) and streams it into Vultr Object Storage.
 */
async function uploadRecording(tenantId, callId, recordingUrl, durationSeconds = null) {
  if (!recordingUrl) {
    throw new StorageError('recordingUrl is required', 422, 'missing_recording_url');
  }

  let response;
  try {
    response = await fetch(recordingUrl);
  } catch (fetchErr) {
    throw new StorageError(`Failed to fetch audio from remote URL: ${fetchErr.message}`, 502, 'fetch_failed', fetchErr);
  }

  if (!response.ok) {
    throw new StorageError(`Remote recording URL returned HTTP ${response.status}`, 502, 'fetch_http_error');
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get('content-type') || 'audio/wav';

  return uploadBuffer({
    tenantId,
    callId,
    buffer,
    contentType,
    durationSeconds,
  });
}

/**
 * Generates a 24-hour (or custom) pre-signed GET URL for a tenant's call recording.
 */
async function getPresignedUrl(tenantId, callId, expiresInSeconds = 86400) {
  if (!tenantId || !callId) {
    throw new StorageError('tenantId and callId are required', 422, 'missing_parameters');
  }

  const record = await getRecordingRecord(tenantId, callId);
  if (!record) {
    throw new StorageError('Call recording not found', 404, 'recording_not_found');
  }

  const bucket = process.env.VULTR_BUCKET_NAME;
  if (!bucket) {
    throw new StorageError('VULTR_BUCKET_NAME is not configured', 503, 'missing_bucket');
  }

  const client = getClient();
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: record.s3Key,
  });

  try {
    const presignedUrl = await getSignedUrl(client, cmd, { expiresIn: expiresInSeconds });
    return {
      url: presignedUrl,
      key: record.s3Key,
      callId: record.callId,
      expiresInSeconds,
    };
  } catch (err) {
    throw new StorageError(`Failed to generate pre-signed URL: ${err.message}`, 502, 'presign_failed', err);
  }
}

/**
 * Deletes a recording object from Vultr Object Storage and removes the record from database.
 */
async function deleteRecording(tenantId, callId) {
  const record = await getRecordingRecord(tenantId, callId);
  if (!record) return false;

  const bucket = process.env.VULTR_BUCKET_NAME;
  if (bucket && isConfigured()) {
    try {
      const client = getClient();
      await client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: record.s3Key,
      }));
    } catch (err) {
      console.error(`[storage] Warning: failed to delete Vultr object ${record.s3Key}:`, err.message);
    }
  }

  if (db.isPostgres) {
    await db.query('DELETE FROM call_recordings WHERE id = $1 AND tenant_id = $2', [record.id, tenantId]);
  } else {
    await core.mutate((d) => {
      if (d.callRecordings) {
        d.callRecordings = d.callRecordings.filter((r) => r.id !== record.id);
      }
    });
  }

  return true;
}

module.exports = {
  StorageError,
  isConfigured,
  getClient,
  uploadBuffer,
  uploadRecording,
  getPresignedUrl,
  getRecordingRecord,
  deleteRecording,
  saveRecordingRecord,
};
