import assert from 'node:assert/strict';
import test from 'node:test';
import pool from '../backend/config/db.js';
import { ensureAdmin } from '../backend/controllers/authController.js';

async function withEnvironment(values, callback) {
  const original = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await callback();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('bootstrap does not create another administrator when one already exists', async () => {
  const originalExecute = pool.execute;
  const calls = [];
  pool.execute = async (statement, values) => {
    calls.push({ statement, values });
    return [[{ id: 7 }]];
  };

  try {
    await withEnvironment({ WAIS_ADMIN_USERNAME: 'replacement-admin', WAIS_ADMIN_PASSWORD: 'temporary-password-123' }, () => ensureAdmin());
  } finally {
    pool.execute = originalExecute;
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0].statement, /role = \?/);
  assert.deepEqual(calls[0].values, [1, 'admin']);
});

test('a concurrent first-sign-in accepts an administrator created by the other request', async () => {
  const originalExecute = pool.execute;
  let lookupCount = 0;
  pool.execute = async statement => {
    if (statement.startsWith('SELECT id FROM users')) {
      lookupCount += 1;
      return lookupCount === 1 ? [[]] : [[{ id: 8 }]];
    }
    const error = new Error('Duplicate entry');
    error.code = 'ER_DUP_ENTRY';
    throw error;
  };

  try {
    await withEnvironment({ WAIS_ADMIN_USERNAME: 'admin', WAIS_ADMIN_PASSWORD: 'temporary-password-123' }, () => ensureAdmin());
  } finally {
    pool.execute = originalExecute;
  }

  assert.equal(lookupCount, 2);
});
