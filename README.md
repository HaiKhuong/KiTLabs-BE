# KiTools BE (NestJS)

Backend NestJS for:

- Video translation queue (BullMQ + Redis)
- JWT auth + refresh token
- Multi database (main + tool + audit PostgreSQL connections)
- Rate limit + anti-spam duplicate request blocking
- Standardized response + exception format
- Local file upload
- Download history from link/file
- Users with credit and device info
- Credit histories
- User action logs
- Translation histories
- Download histories
- Notifications
- Global settings and user settings
- WebSocket notification events

## Quick Start

1. Copy env:

```bash
cp .env.example .env
```

2. Install dependencies:

```bash
npm install
```

3. (Optional) Start PostgreSQL (main + audit) + Redis:

```bash
docker compose up -d
```

When using `docker-compose.yml`, set `AUDIT_DB_PORT=5433` in `.env`.

4. Start development:

```bash
npm run start:dev
```

5. Build:

```bash
npm run build
```

## Main APIs

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/auth/profile`
- `POST /api/credits/adjust`
- `GET /api/credits/history`
- `POST /api/downloads`
- `GET /api/downloads/history`
- `POST /api/files/upload` (multipart form-data, field name: `file`)
- `POST /api/translates`
- `GET /api/translates/history`
- `GET /api/notifications`
- `PATCH /api/notifications/:notificationId/read`
- `GET /api/settings?type=...`
- `POST /api/settings`
- `GET /api/settings/user`
- `POST /api/settings/user`
- `GET /api/logs?userId=...`
- `GET /api/docs` (Swagger UI)

## Swagger

- URL: `/api/docs`
- Bearer auth is configured in Swagger (`Authorize` button).
- Environment options:
  - `SWAGGER_ENABLED=true|false`
  - `SWAGGER_PATH=docs`

## Security/Traffic Controls

- Global JWT guard (except public routes)
- Global throttler (rate limit)
- Anti-spam interceptor blocks duplicate write requests in short TTL
- Blocked duplicate requests are stored in `audit` database table `spam_logs`

## TypeORM Migrations (3 DB)

This project uses three TypeORM DataSources:

- Main DB datasource: `src/database/data-source.main.ts`
- Tool DB datasource: `src/database/data-source.tool.ts`
- Audit DB datasource: `src/database/data-source.audit.ts`

Migration commands:

```bash
# Main DB
npm run migration:run:main
npm run migration:revert:main
npm run migration:generate:main

# Tool DB
npm run migration:run:tool
npm run migration:revert:tool
npm run migration:generate:tool

# Audit DB
npm run migration:run:audit
npm run migration:revert:audit
npm run migration:generate:audit
```

Initial migrations included:

- `src/database/migrations/main/1760000000000-InitMainSchema.ts`
- `src/database/migrations/audit/1760000001000-InitAuditSchema.ts`

In runtime app config, `synchronize` is disabled and replaced by migrations.

## Module Namespace

- Tool business modules are namespaced under `src/tools/*` for multi-project organization.
- `audit` logic stays separated (anti-spam logs in audit DB).

## Python Translate Command

Translate worker calls Python command from `TranslateProcessor`:

- `TRANSLATE_PYTHON_BIN` (default: `python`)
- `TRANSLATE_PYTHON_SCRIPT` (recommended: `tools/video-pipeline/auto_vietsub_pro.py`)
- `TRANSLATE_CMD_TIMEOUT_MS` (default: `600000`)

### Setup Python video pipeline (Windows)

```powershell
cd tools/video-pipeline
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Suggested `.env` values:

- `TRANSLATE_PYTHON_BIN=tools/video-pipeline/.venv/Scripts/python.exe`
- `TRANSLATE_PYTHON_SCRIPT=tools/video-pipeline/auto_vietsub_pro.py`

Arguments passed to script:

- Positional: `<video_path>` from `engineConfig.localVideoPath`
- `--step` generated from `stepNbr` array in API (example `[1,2,3]` -> `--step 1,3`)
- Optional style/audio/tts/logo flags from `engineConfig` (only fields sent by API are appended)

Translate API payload notes:

- `stepNbr` is required and supports values `1..6`
- `functionUsed` is auto-generated and stored in `translate_histories`

## WebSocket

Socket.IO gateway enabled. It emits:

- `translate.completed`
- `translate.failed`
