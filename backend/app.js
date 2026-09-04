import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import auditRoutes from './routes/auditRoutes.js';
import folderRoutes from './routes/folderRoutes.js';
import fileRoutes from './routes/fileRoutes.js';
import { requireAuth } from './middleware/auth.js';
import { MariaDbSessionStore } from './services/sessionStore.js';
import pool from './config/db.js';
import { absoluteUploadPath, loadStoredFile, usesDatabaseUploadStorage } from './services/fileService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true });

const app = express();
const frontendDirectory = path.resolve(__dirname, '../frontend');
const xlsxBundlePath = path.resolve(__dirname, '../node_modules/xlsx/dist/xlsx.full.min.js');
const configuredOrigins = (process.env.WAIS_FRONTEND_ORIGINS || process.env.PDIAS_FRONTEND_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
const localDevelopmentOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const allowDevelopmentOrigins = process.env.NODE_ENV === 'development';
const jsonBodyLimit = String(process.env.JSON_BODY_LIMIT || '25mb').trim();
const helmetOptions = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  },
  // Uploaded images can be rendered by the signed-in workstation, including
  // a separately hosted frontend explicitly allowed through CORS.
  crossOriginResourcePolicy: { policy: 'cross-origin' }
};
const httpsHeaders = helmet(helmetOptions);
const httpHeaders = helmet({ ...helmetOptions, crossOriginOpenerPolicy: false, originAgentCluster: false });
const sessionSecret = process.env.SESSION_SECRET;
const trustProxy = String(process.env.TRUST_PROXY || '').trim() === '1';
const inlineImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const noRecordAttachmentSections = new Set(['attachment:noRecordFolders', 'attachment:noRecordAttachmentFolders']);

if (typeof sessionSecret !== 'string' || sessionSecret.length < 32) {
  throw new Error('Set SESSION_SECRET to a unique value of at least 32 characters in backend/.env before starting WAIS.');
}

// The bundled HTTPS server is normally accessed directly. Trust a proxy only
// when one is explicitly configured, otherwise forwarded headers are client
// supplied and must not influence secure-cookie behavior.
app.set('trust proxy', trustProxy);
// COOP and origin-keyed agent clusters require a trustworthy origin. Keep
// them on HTTPS (including a trusted HTTPS reverse proxy), but omit them
// consistently from plain HTTP LAN responses such as 192.168.x.x.
app.use((request, response, next) => (request.secure ? httpsHeaders : httpHeaders)(request, response, next));
app.use(cors((request, callback) => {
  const origin = request.get('origin');
  let sameServerOrigin = !origin;
  try {
    if (origin) {
      const originUrl = new URL(origin);
      sameServerOrigin = originUrl.protocol === (request.secure ? 'https:' : 'http:') &&
        originUrl.host.toLowerCase() === String(request.get('host') || '').toLowerCase();
    }
  } catch (error) {
    sameServerOrigin = false;
  }
  const allowed = sameServerOrigin || configuredOrigins.includes(origin) || (allowDevelopmentOrigins && localDevelopmentOrigin.test(origin || ''));
  callback(null, { credentials: true, origin: allowed });
}));
app.use(express.json({ limit: jsonBodyLimit }));
app.use(session({
  name: process.env.WAIS_SESSION_COOKIE || 'wais_session', secret: sessionSecret, store: new MariaDbSessionStore(),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 12 * 60 * 60 * 1000 }
}));

function requestedUploadPath(value) {
  const segments = Array.isArray(value) ? value : [value];
  if (!segments.length || segments.some(segment => typeof segment !== 'string' || !segment)) return null;
  return segments.join('/');
}

function sendStoredFileError(error, response, next) {
  if (!error || error.code === 'ECONNABORTED') return;
  if (response.headersSent) return next(error);
  if (error.code === 'ENOENT' || error.status === 404) return response.status(404).json({ error: 'Stored file not found.' });
  next(error);
}

async function serveTenantUpload(request, response, next) {
  try {
    const storedPath = requestedUploadPath(request.params.storedPath);
    if (!storedPath || !absoluteUploadPath(storedPath)) return response.status(404).json({ error: 'Stored file not found.' });
    const tenantId = request.session.user.tenantId;
    const [records] = await pool.execute(`SELECT f.id AS storage_id, 'file' AS storage_kind, f.path AS stored_path, f.original_name, f.mime_type, d.section
      FROM files f JOIN folders d ON d.id = f.folder_id
      WHERE d.tenant_id = ? AND f.path = ?
      UNION ALL
      SELECT a.id AS storage_id, 'attachment' AS storage_kind, a.path AS stored_path, a.original_name, a.mime_type, d.section
      FROM attachments a JOIN folders d ON d.id = a.folder_id
      WHERE d.tenant_id = ? AND a.path = ?
      LIMIT 1`, [tenantId, storedPath, tenantId, storedPath]);
    const record = records[0];
    if (!record) return response.status(404).json({ error: 'Stored file not found.' });

    const mimeType = String(record.mime_type || '').toLowerCase();
    const allowInlineImage = noRecordAttachmentSections.has(record.section) && inlineImageTypes.has(mimeType);
    const securityHeaders = {
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff'
    };
    const databaseContent = usesDatabaseUploadStorage()
      ? await loadStoredFile(record.stored_path, tenantId, record.storage_kind === 'file'
        ? { fileId: Number(record.storage_id) }
        : { attachmentId: Number(record.storage_id) })
      : null;
    if (Buffer.isBuffer(databaseContent)) {
      if (allowInlineImage) {
        response.set({ ...securityHeaders, 'Content-Disposition': 'inline', 'Content-Type': mimeType });
        return request.method === 'HEAD' ? response.status(200).end() : response.send(databaseContent);
      }
      response.attachment(record.original_name || 'download');
      response.set({ ...securityHeaders, 'Content-Type': 'application/octet-stream' });
      return request.method === 'HEAD' ? response.status(200).end() : response.send(databaseContent);
    }

    const absolutePath = absoluteUploadPath(record.stored_path);
    if (!absolutePath) return response.status(404).json({ error: 'Stored file not found.' });
    if (allowInlineImage) {
      response.set({ ...securityHeaders, 'Content-Disposition': 'inline', 'Content-Type': mimeType });
      return response.sendFile(absolutePath, error => sendStoredFileError(error, response, next));
    }
    return response.download(absolutePath, record.original_name || 'download', {
      headers: { ...securityHeaders, 'Content-Type': 'application/octet-stream' }
    }, error => sendStoredFileError(error, response, next));
  } catch (error) { next(error); }
}

app.get('/health', (_request, response) => response.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/auth/users', userRoutes);
app.use('/api/audit-sessions', auditRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/attachments', fileRoutes);
app.get('/uploads', requireAuth, (_request, response) => response.status(404).json({ error: 'Stored file not found.' }));
app.head('/uploads', requireAuth, (_request, response) => response.status(404).end());
app.get('/uploads/{*storedPath}', requireAuth, serveTenantUpload);
app.head('/uploads/{*storedPath}', requireAuth, serveTenantUpload);
app.get('/vendor/xlsx.full.min.js', (_request, response, next) => {
  response.sendFile(xlsxBundlePath, error => {
    if (!error || error.code === 'ECONNABORTED') return;
    if (response.headersSent) return next(error);
    next(error);
  });
});
app.use(express.static(frontendDirectory, { index: 'Index.html', setHeaders(response, filePath) { if (filePath.endsWith('.js')) response.setHeader('Cache-Control', 'no-cache'); } }));
app.use('/api', (_request, response) => response.status(404).json({ error: 'API route not found.' }));
app.get('/{*path}', (_request, response) => response.sendFile(path.join(frontendDirectory, 'Index.html')));
app.use((error, _request, response, next) => {
  if (response.headersSent) return next(error);
  console.error(error);
  const isUploadLimit = typeof error.code === 'string' && error.code.startsWith('LIMIT_');
  const status = isUploadLimit ? 413 : Number(error.status) || 500;
  const message = status === 413 ? 'The upload is too large or contains too many fields.' : status >= 400 && status < 500 ? error.message : status === 503 ? error.message : 'An unexpected server error occurred.';
  const payload = { error: message };
  if (status >= 400 && status < 500 && typeof error.code === 'string' && error.code.length <= 80) payload.code = error.code;
  response.status(status).json(payload);
});
export default app;
