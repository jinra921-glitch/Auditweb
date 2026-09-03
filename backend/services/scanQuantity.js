export const MAX_SCAN_QUANTITY = 4_294_967_295;
export const MAX_ADJUSTMENT_REASON_LENGTH = 500;

export function isNonNegativeWholeQuantity(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SCAN_QUANTITY;
}

export function normalizeAdjustmentReason(value) {
  if (value == null || value === '') return { valid: true, value: null };
  if (typeof value !== 'string') return { valid: false, value: null };
  const cleaned = value.trim();
  return { valid: cleaned.length <= MAX_ADJUSTMENT_REASON_LENGTH, value: cleaned || null };
}
