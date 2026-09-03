# WAIS (Web Audit Inventory System) API route map

Before starting, copy `backend/.env.example` to `backend/.env`, set the MySQL credentials and a unique `SESSION_SECRET` of at least 32 characters, and set `WAIS_ADMIN_PASSWORD` to a unique value of at least 12 characters. The backend creates that first administrator and requires a password change at first login. New WAIS installations create the `wais_audit` schema and required tables on first start.

For trusted LAN access, run `npm run setup:https` once from the project directory, then start WAIS with `WAIS.cmd` or `npm start`. After HTTPS setup, both launch paths use HTTP port 3000 only to redirect requests to HTTPS port 3443. Open `https://localhost:3443` on this computer or `https://<server-ip>:3443` from another trusted device. The generated development certificate is trusted only for the Windows user that ran the setup; export the generated `.cer` file to other authorized devices and install it as a trusted certificate before using the LAN URL. Without TLS, production WAIS deliberately binds only to localhost; set `WAIS_ALLOW_INSECURE_HTTP=1` only for a short-lived trusted development test. The script detects the current private LAN IP; if the server IP changes, regenerate the certificate with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-local-https.ps1 -LanIp <server-ip> -Force` and distribute the new certificate. When `DB_HOST` is remote, make that database available before starting WAIS; the Windows launcher starts XAMPP only for local database hosts.

`WAIS_*` settings are the current names. Existing `PDIAS_*` administrator, tenant, API-base, and frontend-origin settings are accepted for compatibility while an existing installation is migrated.

For shared scanning, start WAIS once on the computer that will host the audit,
then have every scanner open the same `https://<host-computer-IP>:3443` address
(for example, `https://192.168.1.25:3443`) rather than `localhost`; `localhost`
always means the device currently being used. Use the generated certificate on
each authorized LAN device. The WAIS sharing command opens the required private
firewall ports. For access outside the local network, deploy this same Node
application to an HTTPS host.

| Area | Route module | Endpoints |
| --- | --- | --- |
| Authentication | `backend/routes/authRoutes.js` | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/change-password` |
| User management | `backend/routes/userRoutes.js` | `GET/POST /api/auth/users`, `PATCH/DELETE /api/auth/users/:username` |
| Audit sessions | `backend/routes/auditRoutes.js` | `GET /api/audit-sessions/summaries`, `GET/PUT/DELETE /api/audit-sessions/:sessionId`, scan, adjustment-history, and no-record endpoints |
| POS/BLIP folders | `backend/routes/folderRoutes.js` | `GET/POST /api/folders`, `GET/PUT/DELETE /api/folders/:folderId`, `POST /api/folders/:folderId/files` |
| Attachments | `backend/routes/fileRoutes.js` | `GET/PUT /api/attachments/:collection`, `POST /api/attachments/:collection/:folderId/files` |

Authentication and authorization are server-only. Passwords are bcrypt hashes in MariaDB, sessions use an HTTP-only cookie, and protected requests reload the current role and account status from the database. The browser deletes the legacy IndexedDB account store during its storage upgrade; IndexedDB remains only for non-credential offline audit data, including account-scoped pending Qty, session, folder, spreadsheet, scan-deletion, and attachment retries.

The frontend treats every HTTP response as authoritative. `401`, `403`, validation failures, missing records, and server errors never trigger IndexedDB fallback; only a genuine fetch/network failure does. Offline cache entries are tagged with the signed-in tenant and user ID. Clean entries refresh from the server, while a locally pending mutation overlays newer snapshots and remains in IndexedDB until the matching API confirmation is received.

All `/api/auth/users` routes require both authentication and the server-side administrator role. Administrators can change an account's `role`, `newUsername`, or temporary `password` with `PATCH /api/auth/users/:username`; a password reset forces that user to choose a new password at next login. Self-deletion, self-demotion, and removal of the final administrator are rejected.

`backend/app.js` registers route modules. Browser assets are in `frontend/`; the API is organized into `config`, `middleware`, `routes`, `controllers`, and `services` under `backend/`. MySQL/MariaDB is the authoritative store; account-scoped IndexedDB data is used only during a genuine network outage. Shared scans are append-only server events, so two users who open the same saved audit session see each other's scans and totals within a few seconds.

Uploaded spreadsheets and attachments are stored on disk under `uploads/<category>/<year>/<month>/`; MariaDB stores only their names, relative paths, MIME types, sizes, owners, and timestamps. File URLs require the same authenticated HTTP-only session as the API. Deleting a file or folder also removes its stored file from disk.

Each `POST /api/audit-sessions/:sessionId/scans` appends one `scan_logs` row and atomically increments the matched item's quantity. Send a unique top-level `clientId` for each scan event and reuse that same value only when retrying the event; duplicate retries return the existing record without incrementing totals again. Requests may identify an item using `itemId`, `itemNumber`, `serial`, or a matching `code`.

`PATCH /api/audit-sessions/:sessionId/scans/:scanId` accepts `{ "qty": <non-negative whole integer>, "reason"?: "optional note" }`, including `0`, and atomically updates that scan and its matched item's total. Concurrent quantity updates use last-successful-write behavior: the last PATCH request to complete successfully is the authoritative quantity. `DELETE /api/audit-sessions/:sessionId/scans/:scanId` also accepts an optional JSON `reason`.

Every non-no-op Qty change and scan deletion is recorded in the append-only `scan_adjustments` ledger with the scan's stable IDs/code, old and new quantities, optional reason, authenticated user, and timestamp. Read the newest records with `GET /api/audit-sessions/:sessionId/scan-adjustments?limit=100` (1–500 records). Resume-screen queries use `GET /api/audit-sessions/summaries?limit=100&offset=0`, which returns lightweight session metadata and a `page.hasMore` flag instead of loading every scan row.

## Operational safeguards

Set `WAIS_FRONTEND_ORIGINS` to a comma-separated list of exact browser origins only when the frontend is hosted separately from WAIS. Same-origin WAIS requests always work; in development, separate `localhost` and `127.0.0.1` origins are allowed automatically. A separately hosted production LAN frontend must be explicitly configured. The deployed frontend uses a local `xlsx` bundle and a restrictive content-security policy, so normal operation does not require a third-party script CDN. Master-list parsing runs in a disposable worker with a 25 MB file limit, 50,000-row limit, and 20-second timeout; split a larger trusted master list before importing it.

Database connections are bounded by `DB_CONNECTION_LIMIT`, `DB_QUEUE_LIMIT`, and `DB_CONNECT_TIMEOUT_MS`. For a remote database, set `DB_SSL=1`; provide `DB_SSL_CA_PATH` where the database requires a private CA, and leave `DB_SSL_REJECT_UNAUTHORIZED=1` unless a temporary trusted test explicitly requires otherwise. `JSON_BODY_LIMIT` and `UPLOAD_MAX_BYTES` bound request sizes. Expired HTTP sessions are pruned periodically using `SESSION_PRUNE_INTERVAL_MS`.
