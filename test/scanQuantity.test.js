import assert from 'node:assert/strict';
import test from 'node:test';
import { isNonNegativeWholeQuantity, MAX_ADJUSTMENT_REASON_LENGTH, MAX_SCAN_QUANTITY, normalizeAdjustmentReason } from '../backend/services/scanQuantity.js';

test('quantity validation accepts the documented unsigned whole-number range', () => {
  assert.equal(isNonNegativeWholeQuantity(0), true);
  assert.equal(isNonNegativeWholeQuantity(MAX_SCAN_QUANTITY), true);
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER, '1', null, NaN]) {
    assert.equal(isNonNegativeWholeQuantity(value), false, String(value));
  }
});

test('adjustment reasons are trimmed and safely bounded', () => {
  assert.deepEqual(normalizeAdjustmentReason(null), { valid: true, value: null });
  assert.deepEqual(normalizeAdjustmentReason('  stock recount  '), { valid: true, value: 'stock recount' });
  assert.equal(normalizeAdjustmentReason('x'.repeat(MAX_ADJUSTMENT_REASON_LENGTH + 1)).valid, false);
  assert.equal(normalizeAdjustmentReason({ reason: 'invalid' }).valid, false);
});
