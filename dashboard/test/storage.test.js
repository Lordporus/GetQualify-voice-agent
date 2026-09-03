'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { mkdtemp, rm } = require('node:fs/promises');

const storage = require('../lib/storage');
const core = require('../lib/core');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const presigner = require('@aws-sdk/s3-request-presigner');

test('Vultr Object Storage client initialization and validation', async (t) => {
  const origEnv = { ...process.env };

  t.after(() => {
    process.env = origEnv;
  });

  // 1. Unconfigured check
  delete process.env.VULTR_ACCESS_KEY_ID;
  delete process.env.VULTR_SECRET_ACCESS_KEY;
  delete process.env.VULTR_ENDPOINT_URL;
  delete process.env.VULTR_BUCKET_NAME;

  assert.equal(storage.isConfigured(), false);
  assert.throws(
    () => storage.getClient({ forceNew: true }),
    (err) => err instanceof storage.StorageError && err.code === 'storage_not_configured'
  );

  // 2. Configured check with Vultr endpoint
  process.env.VULTR_ACCESS_KEY_ID = 'test-vultr-key';
  process.env.VULTR_SECRET_ACCESS_KEY = 'test-vultr-secret';
  process.env.VULTR_ENDPOINT_URL = 'https://blr1.vultrobjects.com';
  process.env.VULTR_BUCKET_NAME = 'getqualify-recordings';
  process.env.VULTR_REGION = 'us-east-1';

  assert.equal(storage.isConfigured(), true);
  const client = storage.getClient({ forceNew: true });
  assert.ok(client instanceof S3Client);

  // Verify endpoint and forcePathStyle
  const endpointResolved = await client.config.endpoint();
  assert.equal(endpointResolved.hostname, 'blr1.vultrobjects.com');
  assert.equal(client.config.forcePathStyle, true);
});

test('Vultr Object Storage buffer upload and recording retrieval in JSON mode', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gq-storage-test-'));
  const dbFile = path.join(tempDir, 'db.json');
  const origDbFile = process.env.GETQUALIFY_DB_FILE;
  const origEnv = { ...process.env };

  process.env.GETQUALIFY_DB_FILE = dbFile;
  process.env.DB_DRIVER = 'json';
  process.env.VULTR_ACCESS_KEY_ID = 'test-key';
  process.env.VULTR_SECRET_ACCESS_KEY = 'test-secret';
  process.env.VULTR_ENDPOINT_URL = 'https://blr1.vultrobjects.com';
  process.env.VULTR_BUCKET_NAME = 'test-bucket';

  t.after(async () => {
    process.env = origEnv;
    if (origDbFile) process.env.GETQUALIFY_DB_FILE = origDbFile;
    else delete process.env.GETQUALIFY_DB_FILE;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const tenantId = 't_storage_demo';
  const callId = 'call_rec_123';

  // Mock S3Client send
  let sentCommand = null;
  const origSend = S3Client.prototype.send;
  S3Client.prototype.send = async function (cmd) {
    sentCommand = cmd;
    return {};
  };
  t.after(() => {
    S3Client.prototype.send = origSend;
  });

  const audioBuf = Buffer.from('FAKE-WAV-AUDIO-DATA-12345');
  const record = await storage.uploadBuffer({
    tenantId,
    callId,
    buffer: audioBuf,
    contentType: 'audio/wav',
    durationSeconds: 45,
  });

  assert.ok(record.id.startsWith('rec_'));
  assert.equal(record.callId, callId);
  assert.equal(record.tenantId, tenantId);
  assert.equal(record.s3Key, `recordings/${tenantId}/${callId}.wav`);
  assert.equal(record.sizeBytes, audioBuf.length);
  assert.equal(record.durationSeconds, 45);

  // Verify PutObjectCommand parameters sent to Vultr
  assert.ok(sentCommand instanceof PutObjectCommand);
  assert.equal(sentCommand.input.Bucket, 'test-bucket');
  assert.equal(sentCommand.input.Key, `recordings/${tenantId}/${callId}.wav`);
  assert.equal(sentCommand.input.ContentType, 'audio/wav');

  // Verify retrieved record matches
  const retrieved = await storage.getRecordingRecord(tenantId, callId);
  assert.ok(retrieved);
  assert.equal(retrieved.id, record.id);
  assert.equal(retrieved.s3Key, record.s3Key);

  // Mock getSignedUrl to test pre-signed URL generation
  const origGetSignedUrl = presigner.getSignedUrl;
  presigner.getSignedUrl = async (client, cmd, opts) => {
    return `https://blr1.vultrobjects.com/test-bucket/${cmd.input.Key}?X-Amz-Signature=mockedsig&expires=${opts.expiresIn}`;
  };
  t.after(() => {
    presigner.getSignedUrl = origGetSignedUrl;
  });

  const presigned = await storage.getPresignedUrl(tenantId, callId, 3600);
  assert.ok(presigned.url.includes('https://blr1.vultrobjects.com/test-bucket/recordings/t_storage_demo/call_rec_123.wav'));
  assert.equal(presigned.expiresInSeconds, 3600);

  // Test tenant isolation: querying with wrong tenant fails with 404
  await assert.rejects(
    () => storage.getPresignedUrl('t_other_tenant', callId),
    (err) => err instanceof storage.StorageError && err.code === 'recording_not_found'
  );

  // Test deletion
  const deleted = await storage.deleteRecording(tenantId, callId);
  assert.equal(deleted, true);
  const afterDelete = await storage.getRecordingRecord(tenantId, callId);
  assert.equal(afterDelete, null);
});
