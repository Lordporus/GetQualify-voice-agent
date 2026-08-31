'use strict';

const crypto = require('crypto');

const TOKEN_ID_RE = /^[a-f0-9]{16}$/;
const TOKEN_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function createDemoToken() {
  const id = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  return { id, token: `${id}.${secret}`, tokenHash: sha256(`${id}.${secret}`) };
}

function parseDemoToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !TOKEN_ID_RE.test(parts[0]) || !TOKEN_SECRET_RE.test(parts[1])) return null;
  return { id: parts[0], tokenHash: sha256(`${parts[0]}.${parts[1]}`) };
}

function safeHashEqual(a, b) {
  try {
    const left = Buffer.from(String(a), 'hex');
    const right = Buffer.from(String(b), 'hex');
    return left.length === 32 && right.length === 32 && crypto.timingSafeEqual(left, right);
  } catch (_) { return false; }
}

function findDemoLink(database, token) {
  const parsed = parseDemoToken(token);
  if (!parsed) return null;
  const link = (database.demoLinks || []).find((item) => item.id === parsed.id);
  return link && safeHashEqual(parsed.tokenHash, link.tokenHash) ? link : null;
}

function demoLinkStatus(link, now = Date.now()) {
  if (!link || link.status === 'revoked') return 'revoked';
  if (Date.parse(link.expiresAt) <= now) return 'expired';
  if (Number(link.starts || 0) >= Number(link.maxStarts || 0)) return 'exhausted';
  return 'active';
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function normalizeDemoLimits(input, now = Date.now()) {
  const days = clampInteger(input && input.expiresInDays, 7, 1, 30);
  return {
    expiresAt: new Date(now + days * 86400000).toISOString(),
    maxSessionSeconds: clampInteger(input && input.maxSessionSeconds, 300, 60, 600),
    maxStarts: clampInteger(input && input.maxStarts, 25, 1, 1000),
  };
}

function publicDemoLink(link, now = Date.now()) {
  return {
    id: link.id,
    agentId: link.agentId,
    label: link.label,
    status: demoLinkStatus(link, now),
    expiresAt: link.expiresAt,
    maxSessionSeconds: link.maxSessionSeconds,
    maxStarts: link.maxStarts,
    starts: Number(link.starts || 0),
    createdAt: link.createdAt,
  };
}

module.exports = {
  createDemoToken,
  parseDemoToken,
  findDemoLink,
  demoLinkStatus,
  normalizeDemoLimits,
  publicDemoLink,
};
