import bcrypt from 'bcrypt';
import pool from '../config/db.js';

const tenantId = () => Number(process.env.WAIS_DEFAULT_TENANT_ID || process.env.PDIAS_DEFAULT_TENANT_ID || 1);
const cleanUsername = value => typeof value === 'string' ? value.trim() : '';
const safeUser = user => ({ id: user.id, username: user.username, role: user.role, tenantId: user.tenant_id, mustChangePassword: Boolean(user.must_change_password), createdAt: user.created_at });
function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
const LOGIN_WINDOW_MS = boundedInteger(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000, 10_000, 24 * 60 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = boundedInteger(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS, 8, 1, 100);
const LOGIN_MAX_TRACKED_KEYS = boundedInteger(process.env.LOGIN_RATE_LIMIT_MAX_TRACKED_KEYS, 10_000, 100, 100_000);
const failedLogins = new Map();
let lastFailedLoginPruneAt = 0;

function loginKey(request, username) {
  return String(request.ip || request.socket?.remoteAddress || 'unknown') + ':' + String(username || '').toLowerCase();
}

function pruneFailedLogins(now = Date.now()) {
  if (now - lastFailedLoginPruneAt < 60_000 && failedLogins.size < LOGIN_MAX_TRACKED_KEYS) return;
  lastFailedLoginPruneAt = now;
  for (const [key, record] of failedLogins) {
    if (now - record.firstAttemptAt >= LOGIN_WINDOW_MS) failedLogins.delete(key);
  }
  while (failedLogins.size > LOGIN_MAX_TRACKED_KEYS) {
    const oldestKey = failedLogins.keys().next().value;
    if (oldestKey === undefined) break;
    failedLogins.delete(oldestKey);
  }
}

function activeLoginLimit(key) {
  pruneFailedLogins();
  const record = failedLogins.get(key);
  if (!record) return 0;
  if (Date.now() - record.firstAttemptAt >= LOGIN_WINDOW_MS) {
    failedLogins.delete(key);
    return 0;
  }
  return record.attempts;
}

function recordFailedLogin(key) {
  const now = Date.now();
  pruneFailedLogins(now);
  const existing = failedLogins.get(key);
  if (!existing || now - existing.firstAttemptAt >= LOGIN_WINDOW_MS) {
    while (failedLogins.size >= LOGIN_MAX_TRACKED_KEYS) {
      const oldestKey = failedLogins.keys().next().value;
      if (oldestKey === undefined) break;
      failedLogins.delete(oldestKey);
    }
    failedLogins.set(key, { attempts: 1, firstAttemptAt: now });
    return;
  }
  existing.attempts += 1;
}

async function ensureAdmin() {
  const username = cleanUsername(process.env.WAIS_ADMIN_USERNAME || process.env.PDIAS_ADMIN_USERNAME || 'admin');
  const [rows] = await pool.execute('SELECT id FROM users WHERE tenant_id = ? AND username = ?', [tenantId(), username]);
  if (!rows.length) {
    const bootstrapPassword = process.env.WAIS_ADMIN_PASSWORD || process.env.PDIAS_ADMIN_PASSWORD;
    if (typeof bootstrapPassword !== 'string' || bootstrapPassword.length < 12) {
      const error = new Error('No administrator exists. Set WAIS_ADMIN_PASSWORD to at least 12 characters in backend/.env, then sign in once.');
      error.status = 503;
      throw error;
    }
    const hash = await bcrypt.hash(bootstrapPassword, 12);
    await pool.execute('INSERT INTO users (tenant_id, username, password_salt, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, ?, ?)',
      [tenantId(), username, '', hash, 'admin', 1]);
  }
}

export async function login(request, response, next) {
  try {
    const username = cleanUsername(request.body?.username);
    const password = request.body?.password;
    if (!username || typeof password !== 'string') return response.status(400).json({ error: 'Username and password are required.' });
    const limitKey = loginKey(request, username);
    if (activeLoginLimit(limitKey) >= LOGIN_MAX_ATTEMPTS) return response.status(429).json({ error: 'Too many sign-in attempts. Try again in a few minutes.' });
    await ensureAdmin();
    const [rows] = await pool.execute('SELECT * FROM users WHERE tenant_id = ? AND username = ?', [tenantId(), username]);
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
      recordFailedLogin(limitKey);
      return response.status(401).json({ error: 'Invalid username or password.' });
    }
    failedLogins.delete(limitKey);
    const user = safeUser(rows[0]);
    request.session.regenerate(error => {
      if (error) return next(error);
      request.session.user = user;
      request.session.save(saveError => saveError ? next(saveError) : response.json({ user }));
    });
  } catch (error) { next(error); }
}

export async function me(request, response, next) {
  try {
    const sessionUser = request.session?.user;
    if (!sessionUser) return response.json({ user: null });
    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [sessionUser.id, sessionUser.tenantId]);
    if (!rows[0]) {
      request.session.destroy(() => {});
      return response.json({ user: null });
    }
    const user = safeUser(rows[0]);
    request.session.user = user;
    response.json({ user });
  } catch (error) { next(error); }
}

export function logout(request, response, next) {
  request.session.destroy(error => {
    if (error) return next(error);
    response.clearCookie(process.env.WAIS_SESSION_COOKIE || 'wais_session', { path: '/' });
    response.clearCookie('pdias_session', { path: '/' }); // Clears cookies issued by older releases.
    response.status(204).end();
  });
}

export async function changePassword(request, response, next) {
  try {
    const { currentPassword, newPassword } = request.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) return response.status(400).json({ error: 'New password must be at least 8 characters.' });
    const user = request.session.user;
    const [rows] = await pool.execute('SELECT * FROM users WHERE tenant_id = ? AND username = ?', [user.tenantId, user.username]);
    if (!rows[0] || !(await bcrypt.compare(currentPassword || '', rows[0].password_hash))) return response.status(401).json({ error: 'Current password is incorrect.' });
    await pool.execute('UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0 WHERE id = ?', [await bcrypt.hash(newPassword, 12), '', rows[0].id]);
    response.json({ user: { ...user, mustChangePassword: false } });
  } catch (error) { next(error); }
}
