# Production Monitoring & Operations Guide

This guide details the setup and configuration of uptime monitoring, error tracking, and container operations for the GetQualify Voice platform.

---

## 1. Uptime Monitoring with UptimeRobot (Free Tier)

UptimeRobot provides continuous 5-minute external HTTP probes to detect outages, latency spikes, or crashed services without incurring hosting costs.

### Monitor 1: Standard Liveness & Readiness Probe
- **Monitor Type**: `HTTP(s)`
- **Friendly Name**: `GetQualify Voice Studio`
- **URL / IP**: `https://<your-domain-or-ip>/api/health`
- **Monitoring Interval**: `5 minutes` (free tier standard)
- **Monitor Timeout**: `30 seconds`
- **HTTP Method**: `GET`
- **Alert Contacts**: Add your email and webhook (Slack, Telegram, Discord, or SMS via MSG91)
- **Alert When**: Down after `3 consecutive failures` (15 minutes of downtime, avoids alerting on momentary network blips)

### Monitor 2: Deep Database & Engine Probe (Recommended)
- **Monitor Type**: `Keyword`
- **Friendly Name**: `GetQualify Voice DB & Engine`
- **URL / IP**: `https://<your-domain-or-ip>/api/health?deep=true`
- **Keyword to Check**: `"ok":true`
- **Alert Type**: Alert if keyword does **NOT** exist (or returns non-200 status like 503)
- **Monitoring Interval**: `5 minutes`

### Health Endpoint Response Structure
A healthy check returns HTTP `200 OK`:
```json
{
  "ok": true,
  "database": {
    "driver": "postgres",
    "ok": true
  },
  "providers": {
    "stt": { "deepgram": true },
    "tts": { "rumik": true },
    "llm": { "groq": true, "gemini": true },
    "telephony": { "vobiz": true }
  },
  "models": {
    "stt": "nova-3",
    "llm": "llama-3.3-70b-versatile",
    "tts": "mulberry"
  },
  "selected": {
    "stt": { "provider": "deepgram", "model": "nova-3" },
    "tts": { "provider": "rumik", "model": "mulberry" },
    "llm": { "provider": "groq", "model": "llama-3.3-70b-versatile" },
    "telephony": { "provider": "vobiz" }
  }
}
```

If PostgreSQL becomes unreachable during a deep check (`?deep=true`), the endpoint returns HTTP `503 Service Unavailable`:
```json
{
  "ok": false,
  "database": {
    "driver": "postgres",
    "ok": false,
    "error": "connection refused"
  }
}
```

---

## 2. Error Tracking with Sentry (Free Tier: 5,000 events/month)

Sentry captures unhandled exceptions, rejection loops, and route 500 errors in real time.

### Step 1: Create a Project in Sentry
1. Sign in to [sentry.io](https://sentry.io).
2. Click **Projects** -> **Create Project**.
3. Select **Platform**: `Node.js` (Express/Node).
4. Set **Project Name**: `getqualify-voice-studio`.
5. Copy your **Client Key (DSN)** (e.g. `https://examplePublicKey@o0.ingest.sentry.io/1234567`).

### Step 2: Configure Environment Variables
In `/opt/getqualify/.env` on your VPS or in your local `.env`:
```env
SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/1234567
NODE_ENV=production
```

### Step 3: PII & Data Privacy Compliance
The server's Sentry integration in `server.js` automatically strips sensitive headers before transmission via `beforeSend`:
- `Authorization` (Bearer tokens / passwords)
- `Cookie` (Session identifiers)
- `X-Dograh-Webhook-Secret` (Shared webhook secrets)

To prevent customer phone numbers or call transcripts from reaching Sentry:
- Never log raw caller transcripts inside error objects; pass operational error codes (e.g. `code: 'provider_error'`).
- In the Sentry Project Settings, ensure **Data Scrubbing** is toggled ON with default credit card and credential scrapers active.

### Step 4: Recommended Sentry Alerts
1. **Issue Alert: High Frequency Spike**
   - Condition: More than 10 events in 1 hour.
   - Action: Send email or Slack notification immediately.
2. **New Issue Alert**
   - Condition: Any new unhandled exception seen for the first time.
   - Action: Send notification.

---

## 3. Docker Container Operations & Diagnostics

### Container Status & Health
Check the real-time health of the application and PostgreSQL containers:
```bash
docker compose ps
```
Output should indicate `(healthy)` status for both `getqualify-dashboard` and `getqualify-postgres`.

### Inspecting Live Logs
Stream real-time server logs with timestamps:
```bash
# Dashboard application logs
docker compose logs -f dashboard --tail 100

# PostgreSQL logs
docker compose logs -f postgres --tail 100
```

### PostgreSQL Direct Probe & Diagnostics
Verify the database connection directly inside the running container:
```bash
docker compose exec postgres pg_isready -U getqualify -d getqualify_voice
```

To run diagnostic queries:
```bash
docker compose exec postgres psql -U getqualify -d getqualify_voice -c "SELECT COUNT(*) FROM calls;"
docker compose exec postgres psql -U getqualify -d getqualify_voice -c "SELECT COUNT(*) FROM leads;"
```

### Automated Restart & Recovery
Containers in `docker-compose.yml` are configured with `restart: unless-stopped`.
If an unexpected OOM or system crash occurs, Docker daemon will automatically bring the containers back online.

### Database Volume Backup
To perform an ad-hoc backup of the PostgreSQL database:
```bash
docker compose exec -T postgres pg_dump -U getqualify getqualify_voice > backup-$(date +%F).sql
```

To restore from a backup:
```bash
docker compose exec -T postgres psql -U getqualify getqualify_voice < backup-2026-09-04.sql
```
