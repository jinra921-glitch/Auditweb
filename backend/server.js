import app from './app.js';
import { verifyDatabase } from './config/db.js';
import { pruneExpiredSessions } from './services/sessionStore.js';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';
const httpsPort = Number(process.env.HTTPS_PORT || 3443);
const backendDirectory = path.dirname(fileURLToPath(import.meta.url));
const certificateDirectory = path.join(backendDirectory, 'certificates');
const pfxPath = process.env.TLS_PFX_PATH || path.join(certificateDirectory, 'pdias-local.pfx');
const passphrasePath = process.env.TLS_PASSPHRASE_PATH || path.join(certificateDirectory, 'pdias-local.passphrase');
const allowInsecureLan = String(process.env.WAIS_ALLOW_INSECURE_HTTP || '').trim() === '1';
const behindHttpsProxy = String(process.env.WAIS_BEHIND_HTTPS_PROXY || '').trim() === '1';
const trustProxy = String(process.env.TRUST_PROXY || '').trim() === '1';
const productionMode = process.env.NODE_ENV !== 'development';
const requestedSessionPruneIntervalMs = Number(process.env.SESSION_PRUNE_INTERVAL_MS || 6 * 60 * 60 * 1000);
const sessionPruneIntervalMs = Number.isSafeInteger(requestedSessionPruneIntervalMs) && requestedSessionPruneIntervalMs >= 60_000
  ? requestedSessionPruneIntervalMs
  : 6 * 60 * 60 * 1000;

if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.error('Set SESSION_SECRET to a long, unique value before running WAIS in production.');
  process.exit(1);
}

function redirectHost(request) {
  const requestedHost = String(request.headers.host || 'localhost').replace(/^\[|\](:\d+)?$/g, '').replace(/:\d+$/, '');
  return requestedHost.includes(':') ? `[${requestedHost}]` : requestedHost;
}

function isLoopbackHost(value) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(value || '').trim().toLowerCase());
}

function startServers() {
  const hasLocalCertificate = fs.existsSync(pfxPath) && fs.existsSync(passphrasePath);
  if (!hasLocalCertificate) {
    if (behindHttpsProxy && !trustProxy) {
      console.error('Set TRUST_PROXY=1 when WAIS_BEHIND_HTTPS_PROXY=1 so secure session cookies can trust the HTTPS proxy.');
      process.exit(1);
    }
    // Credentials and session cookies must not be exposed to a LAN over plain
    // HTTP by accident. Development, a trusted TLS-terminating proxy, and an
    // explicit short-lived LAN opt-in retain all-interface behavior; normal
    // production fallback is local-only until HTTPS setup has completed.
    const mayBindProxyHttp = behindHttpsProxy && trustProxy;
    const insecureHost = productionMode && !allowInsecureLan && !mayBindProxyHttp && !isLoopbackHost(host) ? '127.0.0.1' : host;
    app.listen(port, insecureHost, () => {
      console.log(`WAIS API listening on http://${insecureHost}:${port}`);
      if (behindHttpsProxy) {
        console.log('WAIS is accepting internal HTTP behind a trusted HTTPS proxy.');
      } else if (insecureHost !== host) {
        console.warn('HTTPS is not configured, so WAIS is available only on this computer. Run npm run setup:https before sharing it on the LAN.');
      } else if (!isLoopbackHost(insecureHost)) {
        console.warn('WAIS is serving insecure HTTP on the LAN. Run npm run setup:https to protect sign-ins and downloads.');
      }
    });
    return;
  }

  const tlsOptions = {
    pfx: fs.readFileSync(pfxPath),
    passphrase: fs.readFileSync(passphrasePath, 'utf8').trim()
  };
  https.createServer(tlsOptions, app).listen(httpsPort, host, () => {
    console.log(`WAIS HTTPS listening on https://${host}:${httpsPort}`);
  });
  http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok', https: true, httpsPort }));
      return;
    }
    response.writeHead(308, { Location: `https://${redirectHost(request)}:${httpsPort}${request.url || '/'}` });
    response.end();
  }).listen(port, host, () => {
    console.log(`WAIS HTTP redirects to HTTPS on port ${port}`);
  });
}

function scheduleSessionPruning() {
  const prune = () => pruneExpiredSessions()
    .catch(error => console.error('Could not prune expired web sessions:', error.message));
  prune();
  const timer = setInterval(prune, sessionPruneIntervalMs);
  timer.unref();
}

verifyDatabase()
  .then(() => {
    scheduleSessionPruning();
    startServers();
  })
  .catch(error => {
    console.error('WAIS could not connect to MySQL. Check the DB_* values in backend/.env.');
    console.error(error.message);
    process.exit(1);
  });
