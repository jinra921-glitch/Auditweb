import pool from '../config/db.js';

function sessionUser(user) {
  return { id: user.id, username: user.username, role: user.role, tenantId: user.tenant_id, mustChangePassword: Boolean(user.must_change_password), createdAt: user.created_at };
}

export async function requireAuth(request, response, next) {
  if (!request.session?.user) return response.status(401).json({ code: 'AUTH_REQUIRED', error: 'Sign-in is required.' });
  try {
    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [request.session.user.id, request.session.user.tenantId]);
    if (!rows[0]) {
      request.session.destroy(() => {});
      return response.status(401).json({ code: 'AUTH_REVOKED', error: 'This account is no longer available.' });
    }
    request.session.user = sessionUser(rows[0]);
    if (request.session.user.mustChangePassword) return response.status(403).json({ code: 'PASSWORD_CHANGE_REQUIRED', error: 'Change the temporary password before using the application.' });
    next();
  } catch (error) { next(error); }
}

export function requireAuthForPasswordChange(request, response, next) {
  if (!request.session?.user) return response.status(401).json({ code: 'AUTH_REQUIRED', error: 'Sign-in is required.' });
  next();
}
