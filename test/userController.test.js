import assert from 'node:assert/strict';
import test from 'node:test';
import pool from '../backend/config/db.js';
import { createUser } from '../backend/controllers/userController.js';

test('new managed accounts receive a temporary password and must change it', async () => {
  const originalExecute = pool.execute;
  let statement = '';
  let values = [];
  pool.execute = async (query, parameters) => {
    statement = query;
    values = parameters;
    return [{ insertId: 42 }];
  };

  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };

  try {
    await createUser({
      body: { username: 'test-user', password: 'test-user-password-123', role: 'user' },
      session: { user: { tenantId: 1 } }
    }, response, error => { throw error; });
  } finally {
    pool.execute = originalExecute;
  }

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.user.mustChangePassword, true);
  assert.match(statement, /must_change_password\) VALUES \([^)]*, 1\)/);
  assert.deepEqual(values.slice(0, 3), [1, 'test-user', '']);
  assert.equal(values[4], 'user');
});
