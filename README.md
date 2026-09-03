# WAIS — Web Audit Inventory System

WAIS is a Node.js and MariaDB web application for managing audit folders,
attachments, inventory scans, and account-based access.

## What is in this repository

- `frontend/` — the application browser interface.
- `backend/` — Express API, authentication, sessions, uploads, and database setup.
- `database/` — MariaDB schema reference.
- `scripts/` and `*.cmd` — Windows startup, HTTPS, sharing, and service helpers.
- `docs/` — a GitHub Pages interface preview. It is not a working WAIS server.

## Run locally

1. Install Node.js and MariaDB/MySQL.
2. Run `npm install`.
3. Copy `backend/.env.example` to `backend/.env`.
4. Set the database settings, a unique `SESSION_SECRET` (32+ characters), and
   a strong temporary `WAIS_ADMIN_PASSWORD` (12+ characters).
5. Start WAIS with `WAIS.cmd` on Windows, or run `npm start`.

The first successful sign-in creates the configured administrator account and
requires that administrator to change its temporary password. Administrators
can then create normal user accounts from **User Management**.

For local HTTPS and trusted LAN use, run `npm run setup:https` before starting
the application. See [API.md](API.md) for configuration and API details.

## Security

Never commit `backend/.env`, certificates, database credentials, session
secrets, user passwords, audit uploads, or logs. This repository intentionally
contains only `.env.example` placeholders.

## GitHub Pages

GitHub Pages can host only the static interface preview in `docs/`. A working
WAIS deployment needs the full Node.js backend, MariaDB, persistent upload
storage, and HTTPS on the same application domain.
