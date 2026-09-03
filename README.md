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

## Deploy the full application

GitHub Pages serves only the interface preview. For working sign-in, audit
data, and uploads, deploy this repository's Docker image to a Node-capable
host with MariaDB/MySQL and persistent storage.

For a self-hosted Docker deployment:

1. Point a public DNS hostname at the server, then copy `.env.example` to
   `.env` and replace every placeholder. Use a unique `SESSION_SECRET` (32+
   characters) and an administrator password of at least 12 characters.
2. Run `docker compose up --build -d`.
3. Caddy obtains and renews the HTTPS certificate automatically. Only Caddy
   exposes ports 80 and 443; the WAIS and database containers remain private.

For a managed Node host, deploy the `Dockerfile`, attach a managed
MariaDB/MySQL database and persistent volume for `/app/uploads`, then set the
same environment variables. The host must terminate HTTPS and forward requests
to port 3000. Keep `TRUST_PROXY=1` and `WAIS_BEHIND_HTTPS_PROXY=1` only when
the container is behind that trusted HTTPS proxy.

## Security

Never commit `backend/.env`, certificates, database credentials, session
secrets, user passwords, audit uploads, or logs. This repository intentionally
contains only `.env.example` placeholders.

## GitHub Pages

GitHub Pages can host only the static interface preview in `docs/`. A working
WAIS deployment needs the full Node.js backend, MariaDB, persistent upload
storage, and HTTPS on the same application domain.
