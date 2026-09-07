export const MAX_RECORD_QUANTITY = 4_294_967_295;

export function validateRecord(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Provide the record fields.' };
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description || description.length > 2000) return { error: 'Description is required and must be at most 2,000 characters.' };
  const optionalCode = value => value == null || value === '' ? null : typeof value === 'string' ? value.trim() || null : undefined;
  const itemNumber = optionalCode(body.itemNumber);
  const serialNumber = optionalCode(body.serialNumber);
  if (itemNumber === undefined || serialNumber === undefined || (itemNumber?.length || 0) > 191 || (serialNumber?.length || 0) > 191) {
    return { error: 'Item Number and Serial Number must be text of at most 191 characters, or left blank.' };
  }
  const rawQuantity = body.quantity;
  const quantity = typeof rawQuantity === 'number' || (typeof rawQuantity === 'string' && /^\d+$/.test(rawQuantity.trim())) ? Number(rawQuantity) : NaN;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_RECORD_QUANTITY) {
    return { error: 'Qty must be a whole number from 1 to 4,294,967,295.' };
  }
  return { value: { description, itemNumber, serialNumber, quantity } };
}

export function clientRecord(row) {
  return {
    id: String(row.id), description: row.description,
    itemNumber: row.item_number ?? null, serialNumber: row.serial_number ?? null,
    quantity: Number(row.quantity),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString()
  };
}
