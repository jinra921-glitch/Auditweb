import pool from '../config/db.js';
import { clientRecord, validateRecord } from '../services/recordService.js';

function recordId(request, response) {
  const id = String(request.params.recordId || '');
  if (/^[1-9]\d{0,19}$/.test(id)) return id;
  response.status(400).json({ error: 'Invalid record ID.' });
  return null;
}

export async function listRecords(request, response, next) {
  try {
    const search = typeof request.query.search === 'string' ? request.query.search.trim() : '';
    if (search.length > 2000) return response.status(400).json({ error: 'Search must be at most 2,000 characters.' });
    const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
    const offset = Number(request.query.offset || 0);
    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000) return response.status(400).json({ error: 'Invalid page.' });
    let where = 'tenant_id = ?';
    const values = [request.session.user.tenantId];
    if (search) {
      where += " AND (description LIKE ? ESCAPE '!' OR item_number LIKE ? ESCAPE '!' OR serial_number LIKE ? ESCAPE '!')";
      const pattern = '%' + search.replace(/[!%_]/g, value => '!' + value) + '%';
      values.push(pattern, pattern, pattern);
    }
    const [[rows], [count]] = await Promise.all([
      pool.execute('SELECT * FROM inventory_records WHERE ' + where + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', [...values, limit, offset]),
      pool.execute('SELECT COUNT(*) AS total FROM inventory_records WHERE ' + where, values)
    ]);
    response.json({ records: rows.map(clientRecord), page: { limit, offset, total: Number(count[0].total) } });
  } catch (error) { next(error); }
}

export async function getRecord(request, response, next) {
  try {
    const id = recordId(request, response);
    if (!id) return;
    const [rows] = await pool.execute('SELECT * FROM inventory_records WHERE id = ? AND tenant_id = ?', [id, request.session.user.tenantId]);
    if (!rows[0]) return response.status(404).json({ error: 'Record not found.' });
    response.json({ record: clientRecord(rows[0]) });
  } catch (error) { next(error); }
}

export async function createRecord(request, response, next) {
  try {
    const { value, error } = validateRecord(request.body);
    if (error) return response.status(400).json({ error });
    const tenantId = request.session.user.tenantId;
    const [result] = await pool.execute('INSERT INTO inventory_records (tenant_id, description, item_number, serial_number, quantity, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [tenantId, value.description, value.itemNumber, value.serialNumber, value.quantity, request.session.user.id]);
    const [rows] = await pool.execute('SELECT * FROM inventory_records WHERE id = ? AND tenant_id = ?', [result.insertId, tenantId]);
    response.status(201).json({ record: clientRecord(rows[0]) });
  } catch (error) { next(error); }
}

export async function updateRecord(request, response, next) {
  try {
    const id = recordId(request, response);
    if (!id) return;
    const { value, error } = validateRecord(request.body);
    if (error) return response.status(400).json({ error });
    const tenantId = request.session.user.tenantId;
    await pool.execute('UPDATE inventory_records SET description = ?, item_number = ?, serial_number = ?, quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?',
      [value.description, value.itemNumber, value.serialNumber, value.quantity, id, tenantId]);
    // Reading the scoped row also handles an unchanged update consistently.
    const [rows] = await pool.execute('SELECT * FROM inventory_records WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!rows[0]) return response.status(404).json({ error: 'Record not found.' });
    response.json({ record: clientRecord(rows[0]) });
  } catch (error) { next(error); }
}

export async function deleteRecord(request, response, next) {
  try {
    const id = recordId(request, response);
    if (!id) return;
    const [result] = await pool.execute('DELETE FROM inventory_records WHERE id = ? AND tenant_id = ?', [id, request.session.user.tenantId]);
    if (!result.affectedRows) return response.status(404).json({ error: 'Record not found.' });
    response.status(204).end();
  } catch (error) { next(error); }
}
