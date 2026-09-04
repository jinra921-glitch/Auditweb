# Render deployment (free pilot)

This repository includes [`render.yaml`](render.yaml) for a real WAIS web
service, not a static GitHub Pages preview. It serves the login page and API
from one HTTPS origin.

## What this free configuration uses

- **Render Free Web Service** for the Node.js application.
- **MariaDB Cloud Serverless Developer** (or another managed MariaDB/MySQL
  service) for accounts, audit data, sessions, and uploaded files.
- `WAIS_UPLOAD_STORAGE=database`, so uploaded files are saved as bounded
  database BLOBs instead of Render's disposable local filesystem.

The free configuration is suitable for a small pilot or demonstration. Render
can sleep an idle Free web service and may restart it, so the first request
after idle time can take about a minute. It is not an SLA-backed production
service. Do not use it for high-volume or mission-critical audit data without
moving to persistent paid infrastructure and a backup policy.

## Deploy it

1. Create a free MariaDB Cloud Serverless Developer database in a region close
   to the Render Singapore region. In the MariaDB portal, obtain the host,
   port, database name, username, password, and CA certificate if one is
   supplied.
2. In MariaDB Cloud's firewall, allow **only** the outbound CIDR ranges shown
   for this Render service in **Connect > Outbound**. Do not allow
   `0.0.0.0/0`.
3. In the Render dashboard, select **New > Blueprint**, choose this GitHub
   repository, and deploy the `render.yaml` Blueprint.
4. Render prompts for the variables marked `sync: false`. Paste the MariaDB
   connection values there. Keep `DB_SSL=1` and
   `DB_SSL_REJECT_UNAUTHORIZED=1`; paste the full CA PEM in `DB_SSL_CA_PEM`
   when the database provider supplies one.
5. Set a unique administrator password of at least 12 characters for
   `WAIS_ADMIN_PASSWORD`. `admin123` is too short for the secure bootstrap, so
   choose a new password. Do not commit or send that password in chat.
6. Open the generated `onrender.com` URL after the health check succeeds. The
   first sign-in creates the administrator and requires a password change.
   Create normal user accounts through **User Management** after signing in.

## Safety notes

- Keep the generated `SESSION_SECRET`; Render generates it as a 256-bit secret.
- Do not set `WAIS_ALLOW_INSECURE_HTTP=1`. Render terminates HTTPS and the
  application trusts only that proxy through `TRUST_PROXY=1`.
- The database BLOB store limits each uploaded file to 10 MiB. This prevents a
  small free database from being exhausted by a single file.
- Database credentials, CA certificates, passwords, uploads, and session
  secrets must stay in Render/MariaDB secrets and out of GitHub.
