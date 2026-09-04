import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { absoluteUploadPath, MAX_DATABASE_UPLOAD_BYTES, relativeUploadPath, uploadsDirectory, usesDatabaseUploadStorage } from '../backend/services/fileService.js';

test('stored upload paths stay inside the uploads root', () => {
  const relative = 'audit-files/2026/09/example.xlsx';
  assert.equal(absoluteUploadPath(relative), path.join(uploadsDirectory, 'audit-files', '2026', '09', 'example.xlsx'));
  assert.equal(relativeUploadPath(path.join(uploadsDirectory, 'audit-files', '2026', '09', 'example.xlsx')), relative);
});

test('stored upload paths reject traversal, absolute paths, and Windows ADS syntax', () => {
  for (const value of ['../outside.xlsx', '/outside.xlsx', 'C:/outside.xlsx', 'audit-files/../secret.xlsx', 'audit-files/file.xlsx:stream', '']) {
    assert.equal(absoluteUploadPath(value), null, value);
  }
  assert.throws(() => relativeUploadPath(path.join(uploadsDirectory, '..', 'outside.xlsx')));
});

test('database-backed upload storage is opt-in and preserves its bounded file limit', () => {
  const original = process.env.WAIS_UPLOAD_STORAGE;
  try {
    process.env.WAIS_UPLOAD_STORAGE = 'database';
    assert.equal(usesDatabaseUploadStorage(), true);
    process.env.WAIS_UPLOAD_STORAGE = 'filesystem';
    assert.equal(usesDatabaseUploadStorage(), false);
    assert.equal(MAX_DATABASE_UPLOAD_BYTES, 10 * 1024 * 1024);
  } finally {
    if (original === undefined) delete process.env.WAIS_UPLOAD_STORAGE;
    else process.env.WAIS_UPLOAD_STORAGE = original;
  }
});
