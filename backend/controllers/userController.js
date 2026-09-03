import bcrypt from 'bcrypt';
import pool from '../config/db.js';

const safeUser = user => ({ id: user.id, username: user.username, role: user.role, tenantId: user.tenant_id, mustChangePassword: Boolean(user.must_change_password), createdAt: user.created_at, updatedAt: user.updated_at });
const validUsername = username => /^[a-z0-9._-]{3,50}$/i.test(username);

export async function listUsers(request, response, next) {
  try {
    const [users] = await pool.execute('SELECT id, username, role, tenant_id, must_change_password, created_at, updated_at FROM users WHERE tenant_id = ? ORDER BY username', [request.session.user.tenantId]);
    response.json({ users: users.map(safeUser) });
  } catch (error) { next(error); }
}

export async function createUser(request, response, next) {
  try {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const { password, role } = request.body || {};
    if (!validUsername(username)) return response.status(400).json({ error: 'Use a unique username with 3-50 letters, numbers, dots, hyphens, or underscores.' });
    if (typeof password !== 'string' || password.length < 8) return response.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!['admin', 'user'].includes(role)) return response.status(400).json({ error: 'Choose either User or Admin for the account type.' });
    const [result] = await pool.execute('INSERT INTO users (tenant_id, username, password_salt, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, ?, 0)',
      [request.session.user.tenantId, username, '', await bcrypt.hash(password, 12), role]);
    response.status(201).json({ user: { id: result.insertId, username, role, tenantId: request.session.user.tenantId, mustChangePassword: false } });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: 'That username is already in use.' });
    next(error);
  }
}

export async function updateUser(request, response, next) {
  const targetUsername = String(request.params.username || '').trim();
  const roleProvided = request.body?.role !== undefined;
  const passwordProvided = request.body?.password !== undefined;
  const usernameProvided = request.body?.newUsername !== undefined;
  const role = request.body?.role;
  const password = request.body?.password;
  const newUsername = typeof request.body?.newUsername === 'string' ? request.body.newUsername.trim() : '';
  if (!roleProvided && !passwordProvided && !usernameProvided) return response.status(400).json({ error: 'Provide a role, new username, or temporary password to change.' });
  if (roleProvided && !['admin', 'user'].includes(role)) return response.status(400).json({ error: 'Choose either User or Admin for the account type.' });
  if (passwordProvided && (typeof password !== 'string' || password.length < 8)) return response.status(400).json({ error: 'Temporary passwords must be at least 8 characters.' });
  if (usernameProvided && !validUsername(newUsername)) return response.status(400).json({ error: 'Use a unique username with 3-50 letters, numbers, dots, hyphens, or underscores.' });

  const passwordHash = passwordProvided ? await bcrypt.hash(password, 12) : null;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM users WHERE tenant_id = ? AND username = ? FOR UPDATE', [request.session.user.tenantId, targetUsername]);
    const target = rows[0];
    if (!target) {
      await connection.rollback();
      return response.status(404).json({ error: 'That account no longer exists.' });
    }
    if (Number(target.id) === Number(request.session.user.id) && roleProvided && role !== 'admin') {
      await connection.rollback();
      return response.status(400).json({ error: 'You cannot remove administrator access from your own account.' });
    }
    if (target.role === 'admin' && roleProvided && role !== 'admin') {
      const [admins] = await connection.execute("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin' FOR UPDATE", [request.session.user.tenantId]);
      if (admins.length <= 1) {
        await connection.rollback();
        return response.status(409).json({ error: 'At least one administrator account must remain.' });
      }
    }

    const updates = [], values = [];
    if (usernameProvided) { updates.push('username = ?'); values.push(newUsername); }
    if (roleProvided) { updates.push('role = ?'); values.push(role); }
    if (passwordProvided) {
      updates.push('password_hash = ?', "password_salt = ''", 'must_change_password = 1');
      values.push(passwordHash);
    }
    values.push(target.id);
    await connection.execute('UPDATE users SET ' + updates.join(', ') + ' WHERE id = ?', values);
    const [updated] = await connection.execute('SELECT id, username, role, tenant_id, must_change_password, created_at, updated_at FROM users WHERE id = ?', [target.id]);
    await connection.commit();
    response.json({ user: safeUser(updated[0]) });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: 'That username is already in use.' });
    next(error);
  } finally {
    connection.release();
  }
}

export async function deleteUser(request, response, next) {
  const connection = await pool.getConnection();
  try {
    const username = String(request.params.username || '');
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM users WHERE tenant_id = ? AND username = ? FOR UPDATE', [request.session.user.tenantId, username]);
    const target = rows[0];
    if (!target) {
      await connection.rollback();
      return response.status(404).json({ error: 'That account no longer exists.' });
    }
    if (Number(target.id) === Number(request.session.user.id)) {
      await connection.rollback();
      return response.status(400).json({ error: 'You cannot delete your own administrator account.' });
    }
    if (target.role === 'admin') {
      const [admins] = await connection.execute("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin' FOR UPDATE", [request.session.user.tenantId]);
      if (admins.length <= 1) {
        await connection.rollback();
        return response.status(409).json({ error: 'At least one administrator account must remain.' });
      }
    }
    await connection.execute('DELETE FROM users WHERE id = ?', [target.id]);
    await connection.commit();
    response.status(204).end();
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
}
