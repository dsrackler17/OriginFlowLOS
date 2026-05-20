# OriginFlow document processing worker

Long-lived Deno process. LISTENs on the Postgres channel
`document_processing` and dispatches events to handlers. Pairs with
**migration 019** (`migrations/019_ai_pipeline_dispatcher.sql`).

## Architecture

```
Borrower uploads file
        │
        ▼
loan_documents.status = 'uploaded'
        │
   AFTER UPDATE trigger
        │
        ▼
pg_notify('document_processing', {event:'av_scan_requested',...})
        │
        ▼
worker dispatches → handleAvScan
        │
ClamAV scan + PDF safety
        │
        ▼
loan_documents.status = 'scanned_clean'
        │
   AFTER UPDATE trigger
        │
        ▼
pg_notify('document_processing', {event:'classification_requested',...})
        │
        ▼
worker dispatches → handleClassification
        │
Anthropic API call
        │
        ▼
loan_documents.ai_classified_doc_type = '<type>'
loan_documents.status = 'classified'
        │
   AFTER UPDATE trigger
        │
        ▼
pg_notify('document_processing', {event:'extraction_requested',...})
        │
        ▼
worker dispatches → handleExtraction (per-type extractor)
        │
        ...
```

State machine, retry semantics, recovery cron, and emit vs silent
transition rules are documented in the migration 019 header.

## Required environment

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | yes | Postgres SESSION pooler (port 5432, **not** 6543) |
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service role JWT (bypasses RLS) |
| `ANTHROPIC_API_KEY` | yes | Anthropic API key |
| `CLAMD_HOST` | no | Default `127.0.0.1` (in-container) |
| `CLAMD_PORT` | no | Default `3310` |
| `MAX_CONCURRENCY` | no | Default `8` |
| `MAX_RETRIES_AV` | no | Default `3` |
| `MAX_RETRIES_CLASSIFY` | no | Default `3` |
| `CLASSIFIER_MODEL` | no | Default `claude-sonnet-4-6` |
| `HEALTHCHECK_PORT` | no | Default `8080` |
| `NODE_ENV` | no | Default `development` |

**Critical:** `DATABASE_URL` must point at the SESSION pooler (port
5432). The TRANSACTION pooler (port 6543) does not support LISTEN —
the worker will connect successfully but never receive a notify.

Get the right URL in the Supabase dashboard: Project Settings →
Database → Connection string → **Session** tab.

## Deploy (Fly.io)

```bash
cd worker/
fly launch --no-deploy --copy-config --name originflow-worker --region dfw

fly secrets set \
  DATABASE_URL='postgresql://postgres.<ref>:<password>@<host>:5432/postgres' \
  SUPABASE_URL='https://<ref>.supabase.co' \
  SUPABASE_SERVICE_ROLE_KEY='eyJ...' \
  ANTHROPIC_API_KEY='sk-ant-...'

fly deploy
```

Monitoring:

```bash
fly logs              # tail structured JSON logs
fly status            # VM health summary
fly ssh console       # shell into the VM (useful for clamd debug)
fly secrets list      # env var names (not values)
```

Smoke test post-deploy:

```bash
# Confirm /health is green
curl https://originflow-worker.fly.dev/health

# Confirm the worker is LISTENing (from a SQL editor):
listen document_processing;
notify document_processing,
  '{"v":1,"document_id":"00000000-0000-0000-0000-000000000000","loan_id":"00000000-0000-0000-0000-000000000000","branch_id":"00000000-0000-0000-0000-000000000000","event":"scan_failed","from_status":"scanning","to_status":"scan_failed","ts":"2026-01-01T00:00:00Z"}';

# fly logs should show:
#   handler:start { event: "scan_failed", document_id: "00000..." }
#   "scan failed; borrower/internal alerting not yet wired"
#   handler:done
```

## Local development

```bash
deno task dev
```

Requires a local clamd or `CLAMD_HOST` / `CLAMD_PORT` pointing at a
running daemon. Without clamd, the AV handler will fail — but the
dispatch wiring and classification flow can still be tested by
manually NOTIFYing other events.

## Patch status

- [x] **12.0.1a** — SQL dispatcher (migration 019)
- [x] **12.0.1b** — Worker scaffold (this directory)
- [ ] **12.0.1c** — AV handler implementation
- [ ] **12.0.1d** — Classification handler implementation
- [ ] **12.0.1e** — Production deploy + runbook
