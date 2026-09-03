import { randomUUID } from 'node:crypto';
import pool from '../config/db.js';
import { deleteStoredFiles } from '../services/fileService.js';
import { isNonNegativeWholeQuantity, MAX_ADJUSTMENT_REASON_LENGTH, MAX_SCAN_QUANTITY, normalizeAdjustmentReason } from '../services/scanQuantity.js';

const tenantId = request => request.session.user.tenantId;
const asNumber = value => Number(value || 0);
const clientId = value => {
  const text = String(value);
  const numeric = Number(text);
  return /^(0|[1-9]\d*)$/.test(text) && Number.isSafeInteger(numeric) ? numeric : text;
};
const cleanCode = value => String(value || '').trim().toUpperCase();
const cleanDescription = value => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
const cleanStatus = value => String(value || 'found').trim().toLowerCase();
const MAX_UNSIGNED_INT = MAX_SCAN_QUANTITY;
const MAX_DECIMAL_14_3 = 99_999_999_999.999;

function accountScannerName(request) {
  return String(request.session.user.username || '').trim().split(/[._-]+/).filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(' ') || 'Unassigned';
}

function positiveQuantity(value) {
  const quantity = value == null ? 1 : Number(value);
  return Number.isSafeInteger(quantity) && quantity > 0 && quantity <= MAX_UNSIGNED_INT ? quantity : null;
}

async function recordScanAdjustment(connection, session, scan, action, previousQty, nextQty, userId, reason) {
  await connection.execute(
    'INSERT INTO scan_adjustments (session_id, scan_log_id, scan_client_id, scan_code, action, previous_qty, next_qty, reason, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [session.id, scan.id, scan.client_id, scan.code, action, previousQty, nextQty, reason, userId]
  );
}

function sessionPayloadError(payload, publicId) {
  if (!publicId || publicId.length > 191) return 'Session IDs must contain 1-191 characters.';
  if (payload.sessionId && payload.sessionId !== publicId) return 'Session ID does not match the route.';
  if (payload.folderId && String(payload.folderId).length > 191) return 'Folder ID is too long.';
  if (payload.fileName && String(payload.fileName).length > 255) return 'Source file name is too long.';
  if (payload.batchName && String(payload.batchName).length > 150) return 'Batch name is too long.';
  if (payload.items !== undefined && !Array.isArray(payload.items)) return 'Audit items must be an array.';
  if (payload.scanLog !== undefined && !Array.isArray(payload.scanLog)) return 'Scan log must be an array.';
  if (payload.noRecordEntries !== undefined && !Array.isArray(payload.noRecordEntries)) return 'No-record entries must be an array.';
  if (payload.deletedNoRecordIds !== undefined && !Array.isArray(payload.deletedNoRecordIds)) return 'Deleted no-record IDs must be an array.';
  const notFoundCount = Number(payload.notFoundCount || 0);
  if (!Number.isSafeInteger(notFoundCount) || notFoundCount < 0 || notFoundCount > MAX_UNSIGNED_INT) return 'Not-found count must be a non-negative whole number.';
  const itemIds = new Set();
  for (const [index, item] of (payload.items || []).entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'Each audit item must be an object.';
    const itemId = String(item?.id ?? index);
    if (!itemId || itemId.length > 80) return 'An audit item ID is invalid.';
    if (itemIds.has(itemId)) return 'Audit item IDs must be unique within a session.';
    itemIds.add(itemId);
    if (item?.division && String(item.division).length > 255) return 'An audit item division is too long.';
    for (const value of [item?.itemNumber, item?.serial]) if (value && String(value).length > 191) return 'An item or serial number is too long.';
    for (const value of [item?.itemNumberDisplay, item?.serialDisplay]) if (value && String(value).length > 255) return 'An item or serial display value is too long.';
    const expected = Number(item?.expected || 0);
    if (!Number.isFinite(expected) || expected < 0 || expected > MAX_DECIMAL_14_3) return 'Expected quantities must be non-negative numbers.';
  }
  for (const scan of payload.scanLog || []) {
    if (!scan || typeof scan !== 'object' || Array.isArray(scan)) return 'Each scan log entry must be an object.';
    if (cleanStatus(scan?.status) !== 'found' || !scan?.clientScanId) continue;
    if (String(scan.clientScanId).length > 191) return 'A scan client ID is too long.';
    if (!String(scan.code || '').trim() || String(scan.code).length > 255) return 'A scan code is invalid.';
    if ([scan.itemNumber, scan.serial].some(value => value && String(value).length > 255)) return 'An item or serial number in the scan log is too long.';
    if (scan.batch && String(scan.batch).length > 150) return 'A scan batch name is too long.';
    const scanQuantity = scan.qty == null ? 1 : Number(scan.qty);
    if (!Number.isSafeInteger(scanQuantity) || scanQuantity < 0 || scanQuantity > MAX_UNSIGNED_INT) return 'Scan quantities must be non-negative whole numbers.';
  }
  for (const entry of payload.noRecordEntries || []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'Each no-record entry must be an object.';
  }
  if ((payload.deletedNoRecordIds || []).some(id => !String(id || '').trim() || String(id).length > 191)) return 'Deleted no-record IDs must contain 1-191 characters.';
  return null;
}

function scanIdentifiesItem(scan, item) {
  const itemNumber = cleanCode(scan.itemNumber);
  const serial = cleanCode(scan.serial);
  const itemNumberMatches = itemNumber && [item.item_number, item.item_number_display].some(value => cleanCode(value) === itemNumber);
  const serialMatches = serial && [item.serial_number, item.serial_number_display].some(value => cleanCode(value) === serial);
  if (itemNumber && serial) return Boolean(itemNumberMatches && serialMatches);
  if (itemNumber) return Boolean(itemNumberMatches);
  if (serial) return Boolean(serialMatches);
  return scanMatchesItem(scan, item);
}

async function sessionRow(tenant, publicId, connection = pool, lock = false) {
  const [rows] = await connection.execute(`SELECT * FROM audit_sessions WHERE tenant_id = ? AND session_id = ?${lock ? ' FOR UPDATE' : ''}`, [tenant, publicId]);
  return rows[0] || null;
}

async function loadSession(tenant, publicId, connection = pool) {
  const session = await sessionRow(tenant, publicId, connection);
  if (!session) return null;
  const [itemRows] = await connection.execute('SELECT * FROM audit_items WHERE session_id = ? ORDER BY id', [session.id]);
  const [operatorRows] = await connection.execute(`SELECT audit_item_id, operator_name, SUM(qty) quantity FROM scan_logs
    WHERE session_id = ? AND status = 'found' GROUP BY audit_item_id, operator_name`, [session.id]);
  const operatorsByItem = new Map();
  for (const entry of operatorRows) {
    if (!entry.operator_name) continue;
    const operators = operatorsByItem.get(entry.audit_item_id) || {};
    operators[entry.operator_name] = asNumber(entry.quantity);
    operatorsByItem.set(entry.audit_item_id, operators);
  }
  const items = itemRows.map(row => {
    const byOperator = operatorsByItem.get(row.id) || {};
    return { id: clientId(row.client_item_id), division: row.division_name || '', itemNumber: row.item_number || '', itemNumberDisplay: row.item_number_display || '', serial: row.serial_number || '', serialDisplay: row.serial_number_display || '', desc: row.description || '', expected: asNumber(row.expected_qty), scanned: asNumber(row.actual_qty), byOperator };
  });
  const [scanRows] = await connection.execute(`SELECT l.*, i.client_item_id FROM scan_logs l LEFT JOIN audit_items i ON i.id = l.audit_item_id
    WHERE l.session_id = ? ORDER BY l.id`, [session.id]);
  const scanLog = scanRows.map((row, index) => ({ id: String(row.id), clientId: row.client_id, clientScanId: row.client_id, seq: index + 1, ts: new Date(row.created_at).getTime(), batch: row.batch_name || '(unnamed batch)', operator: row.operator_name || 'Unassigned', code: row.code, itemNumber: row.item_number || '', serial: row.serial || '', desc: row.description || '', itemId: row.client_item_id == null ? null : clientId(row.client_item_id), qty: Number(row.qty), status: row.status }));
  const [noRecords] = await connection.execute('SELECT * FROM no_record_entries WHERE session_id = ? ORDER BY created_at', [session.id]);
  return { sessionId: session.session_id, fileName: session.source_file_name, folderId: session.folder_id, batchName: session.batch_name, scannerName: session.scanner_name || '', status: session.status, notFoundCount: Number(session.not_found_count), items, scanLog, noRecordEntries: noRecords.map(entry => ({ id: entry.id, code: entry.code, description: entry.description, actualCount: asNumber(entry.actual_count), createdAt: new Date(entry.created_at).getTime() })), savedAt: new Date(session.updated_at).getTime() };
}

function scanMatchesItem(scan, item) {
  const code = cleanCode(scan.code);
  if (!code) return false;
  const codeMatches = [item.item_number, item.serial_number, item.item_number_display, item.serial_number_display]
    .some(value => cleanCode(value) === code);
  return codeMatches || cleanDescription(item.description) === cleanDescription(scan.code);
}

async function insertItems(connection, sessionId, items) {
  for (const [index, item] of (items || []).entries()) {
    const key = String(item?.id ?? index);
    await connection.execute(`INSERT INTO audit_items (session_id, client_item_id, division_name, item_number, item_number_display, serial_number, serial_number_display, description, expected_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [sessionId, key, item?.division || null, item?.itemNumber || null, item?.itemNumberDisplay || null, item?.serial || null, item?.serialDisplay || null, item?.desc || null, asNumber(item?.expected)]);
  }
}

async function mergeEvents(connection, session, payload, userId, operatorName) {
  const [items] = await connection.execute('SELECT * FROM audit_items WHERE session_id = ?', [session.id]);
  const itemByClient = new Map(items.map(item => [item.client_item_id, item]));
  for (const scan of payload.scanLog || []) {
    if (cleanStatus(scan?.status) !== 'found' || !scan?.clientScanId) continue;
    const item = itemByClient.get(String(scan.itemId));
    if (!item || !scanMatchesItem(scan, item)) continue;
    // Session uploads may include a previously created offline scan whose quantity
    // was later edited to zero. Preserve that event; only POST /scans requires a
    // strictly positive quantity.
    const quantity = scan.qty == null ? 1 : Number(scan.qty);
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > MAX_UNSIGNED_INT) continue;
    const [insert] = await connection.execute(`INSERT IGNORE INTO scan_logs (session_id, audit_item_id, client_id, code, item_number, serial, description, batch_name, operator_name, status, qty, scanned_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'found', ?, ?)`, [session.id, item.id, scan.clientScanId, String(scan.code || ''), scan.itemNumber || item.item_number_display, scan.serial || item.serial_number_display, scan.desc || item.description, scan.batch || payload.batchName || 'Box 1', operatorName, quantity, userId]);
    if (insert.affectedRows) await connection.execute('UPDATE audit_items SET actual_qty = actual_qty + ? WHERE id = ?', [quantity, item.id]);
  }
  for (const entryId of payload.deletedNoRecordIds || []) {
    await connection.execute('DELETE FROM no_record_entries WHERE id = ? AND session_id = ?', [String(entryId), session.id]);
  }
  for (const entry of payload.noRecordEntries || []) {
    const entryId = String(entry?.id || '');
    const code = String(entry?.code || '').trim();
    const description = String(entry?.description || '').trim();
    const actualCount = Number(entry?.actualCount);
    if (!entryId || entryId.length > 191 || !code || code.length > 255 || !description || !Number.isFinite(actualCount) || actualCount < 0 || actualCount > MAX_DECIMAL_14_3) continue;
    await connection.execute(`INSERT IGNORE INTO no_record_entries (id, session_id, code, description, actual_count, created_by)
      VALUES (?, ?, ?, ?, ?, ?)`, [entryId, session.id, code, description, actualCount, userId]);
  }
}

async function savePayload(request) {
  const connection = await pool.getConnection();
  try {
    const payload = request.body || {}, publicId = request.params.sessionId;
    const validationError = sessionPayloadError(payload, publicId);
    if (validationError) return { error: validationError };
    await connection.beginTransaction();
    if (payload.folderId) {
      const [folders] = await connection.execute('SELECT id FROM folders WHERE id = ? AND tenant_id = ? AND section NOT LIKE ? FOR UPDATE', [payload.folderId, tenantId(request), 'attachment:%']);
      if (!folders[0]) {
        await connection.rollback();
        return { error: 'Folder not found.' };
      }
    }
    const operatorName = accountScannerName(request);
    let session = await sessionRow(tenantId(request), publicId, connection, true);
    if (!session) {
      const [result] = await connection.execute(`INSERT INTO audit_sessions (tenant_id, session_id, folder_id, operator_id, batch_name, scanner_name, source_file_name, not_found_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [tenantId(request), publicId, payload.folderId || null, request.session.user.id, payload.batchName || 'Box 1', operatorName, payload.fileName || '', Math.max(0, asNumber(payload.notFoundCount))]);
      session = { id: result.insertId, session_id: publicId };
      await insertItems(connection, session.id, payload.items);
    } else {
      await connection.execute(`UPDATE audit_sessions SET folder_id = COALESCE(?, folder_id), batch_name = ?, scanner_name = ?, source_file_name = COALESCE(NULLIF(?, ''), source_file_name), not_found_count = GREATEST(not_found_count, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [payload.folderId || null, payload.batchName || 'Box 1', operatorName, payload.fileName || '', Math.max(0, asNumber(payload.notFoundCount)), session.id]);
    }
    await mergeEvents(connection, session, payload, request.session.user.id, operatorName);
    await connection.commit();
    return { session: await loadSession(tenantId(request), publicId) };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

export async function listSessions(request, response, next) {
  try {
    const [rows] = await pool.execute('SELECT session_id FROM audit_sessions WHERE tenant_id = ? ORDER BY updated_at DESC', [tenantId(request)]);
    response.json({ sessions: (await Promise.all(rows.map(row => loadSession(tenantId(request), row.session_id)))).filter(Boolean) });
  } catch (error) { next(error); }
}
export async function listSessionSummaries(request, response, next) {
  try {
    const requestedLimit = Number(request.query?.limit ?? 100);
    const requestedOffset = Number(request.query?.offset ?? 0);
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
    const offset = Number.isSafeInteger(requestedOffset) ? Math.min(Math.max(requestedOffset, 0), 1_000_000) : 0;
    const [rows] = await pool.execute(`SELECT s.session_id, s.source_file_name, s.updated_at,
      COUNT(i.id) item_count, COALESCE(SUM(i.actual_qty), 0) scanned_total
      FROM audit_sessions s LEFT JOIN audit_items i ON i.session_id = s.id
      WHERE s.tenant_id = ? GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`, [tenantId(request), limit + 1, offset]);
    const hasMore = rows.length > limit;
    response.json({ sessions: rows.slice(0, limit).map(row => ({
      sessionId: row.session_id,
      fileName: row.source_file_name,
      itemCount: Number(row.item_count || 0),
      scannedTotal: asNumber(row.scanned_total),
      savedAt: new Date(row.updated_at).getTime()
    })), page: { limit, offset, hasMore } });
  } catch (error) { next(error); }
}
export async function getSession(request, response, next) { try { const session = await loadSession(tenantId(request), request.params.sessionId); if (!session) return response.status(404).json({ error: 'Audit session not found.' }); response.json({ session }); } catch (error) { next(error); } }
export async function saveSession(request, response, next) { try { const result = await savePayload(request); if (result.error) return response.status(400).json(result); response.json(result); } catch (error) { next(error); } }
export async function deleteSession(request, response, next) {
  const connection = await pool.getConnection();
  let committed = false;
  try {
    await connection.beginTransaction();
    const session = await sessionRow(tenantId(request), request.params.sessionId, connection, true);
    if (!session) {
      await connection.rollback();
      return response.status(404).json({ error: 'Audit session not found.' });
    }
    // A folder spreadsheet is tied to its audit session by session_id rather
    // than a foreign key. Remove it in the same transaction so "Discard" does
    // not leave a folder entry that points to a deleted audit session.
    const [files] = await connection.execute(`SELECT f.id, f.path FROM files f
      JOIN folders d ON d.id = f.folder_id
      WHERE f.session_id = ? AND d.tenant_id = ? FOR UPDATE`, [session.session_id, tenantId(request)]);
    await connection.execute('DELETE FROM audit_sessions WHERE id = ?', [session.id]);
    if (files.length) {
      await connection.execute(`DELETE f FROM files f JOIN folders d ON d.id = f.folder_id
        WHERE f.session_id = ? AND d.tenant_id = ?`, [session.session_id, tenantId(request)]);
    }
    await connection.commit();
    committed = true;
    try {
      await deleteStoredFiles(files.map(file => file.path));
    } catch (error) {
      // The database update succeeded; keep the API result authoritative and
      // leave a logged orphan for a later filesystem cleanup.
      console.error('Could not remove a discarded spreadsheet file:', error);
    }
    response.status(204).end();
  } catch (error) {
    if (!committed) await connection.rollback().catch(() => {});
    next(error);
  } finally {
    connection.release();
  }
}
export async function validateScan(request, response, next) {
  try {
    const code = String(request.body?.code || '').trim();
    if (!code || code.length > 255) return response.status(400).json({ error: 'A scan code or description of at most 255 characters is required.' });
    const session = await sessionRow(tenantId(request), request.params.sessionId);
    if (!session) return response.status(404).json({ error: 'Audit session not found.' });
    const [items] = await pool.execute('SELECT * FROM audit_items WHERE session_id = ?', [session.id]);
    const matches = items.filter(entry => scanMatchesItem({ code }, entry));
    if (!matches.length) return response.status(404).json({ found: false, message: 'Item Not Found.' });
    if (matches.length > 1) return response.status(409).json({ found: false, message: 'More than one item has this description. Enter the item number or serial number instead.' });
    const item = matches[0];
    response.json({ found: true, item: { id: clientId(item.client_item_id), division: item.division_name || '', itemNumber: item.item_number || '', itemNumberDisplay: item.item_number_display || '', serial: item.serial_number || '', serialDisplay: item.serial_number_display || '', desc: item.description || '', expected: asNumber(item.expected_qty), scanned: asNumber(item.actual_qty) } });
  } catch (error) { next(error); }
}
export async function scanHistory(request, response, next) { try { const session = await loadSession(tenantId(request), request.params.sessionId); if (!session) return response.status(404).json({ error: 'Audit session not found.' }); response.json({ scans: session.scanLog.filter(scan => scan.status === 'found') }); } catch (error) { next(error); } }

export async function listScanAdjustments(request, response, next) {
  try {
    const session = await sessionRow(tenantId(request), request.params.sessionId);
    if (!session) return response.status(404).json({ error: 'Audit session not found.' });
    const requestedLimit = Number(request.query?.limit || 100);
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
    const [rows] = await pool.execute(`SELECT a.*, u.username AS changed_by_username
      FROM scan_adjustments a LEFT JOIN users u ON u.id = a.changed_by
      WHERE a.session_id = ? ORDER BY a.id DESC LIMIT ?`, [session.id, limit]);
    response.json({
      adjustments: rows.map(row => ({
        id: String(row.id),
        scanId: String(row.scan_log_id),
        clientId: row.scan_client_id,
        code: row.scan_code,
        action: row.action,
        previousQty: Number(row.previous_qty),
        nextQty: Number(row.next_qty),
        reason: row.reason || null,
        changedBy: row.changed_by_username || null,
        changedAt: new Date(row.created_at).getTime()
      }))
    });
  } catch (error) { next(error); }
}

export async function createScan(request, response, next) {
  const connection = await pool.getConnection();
  try {
    const body = request.body || {};
    const scan = body.scan || body;
    // Older clients put the idempotency key inside scan.clientScanId;
    // the public API accepts the documented top-level clientId as well.
    const scanClientId = String(scan.clientScanId || body.clientId || '').trim();
    const code = String(scan.code || '').trim();
    const quantity = positiveQuantity(scan.qty);
    if (!scanClientId || scanClientId.length > 191) return response.status(400).json({ error: 'A unique clientId of at most 191 characters is required for each scan.' });
    if (!code || code.length > 255) return response.status(400).json({ error: 'A scan code of at most 255 characters is required.' });
    if ([scan.itemNumber, scan.serial].some(value => value && String(value).length > 255)) return response.status(400).json({ error: 'Item and serial numbers may contain at most 255 characters.' });
    if (scan.batch && String(scan.batch).length > 150) return response.status(400).json({ error: 'Batch names may contain at most 150 characters.' });
    if (cleanStatus(scan.status) !== 'found') return response.status(400).json({ error: 'Only FOUND scans can be appended to this endpoint.' });
    if (!quantity) return response.status(400).json({ error: 'Scan quantity must be a positive whole number.' });
    await connection.beginTransaction();
    const session = await sessionRow(tenantId(request), request.params.sessionId, connection, true);
    if (!session) { await connection.rollback(); return response.status(404).json({ error: 'Audit session not found. Open or create it before scanning.' }); }
    const [existing] = await connection.execute('SELECT id FROM scan_logs WHERE session_id = ? AND client_id = ?', [session.id, scanClientId]);
    if (existing[0]) { await connection.commit(); const full = await loadSession(tenantId(request), request.params.sessionId); return response.status(201).json({ session: full, scan: full.scanLog.find(entry => entry.id === String(existing[0].id)), duplicate: true }); }
    const [items] = await connection.execute('SELECT * FROM audit_items WHERE session_id = ?', [session.id]);
    const matches = scan.itemId == null
      ? items.filter(item => scanIdentifiesItem(scan, item))
      : items.filter(item => String(item.client_item_id) === String(scan.itemId) && scanIdentifiesItem(scan, item));
    if (matches.length > 1) { await connection.rollback(); return response.status(409).json({ error: 'The scan matches more than one audit item. Include a serial number or item ID.' }); }
    const item = matches[0];
    if (!item) { await connection.rollback(); return response.status(400).json({ error: 'The scan does not match an item in this audit session.' }); }
    const [insert] = await connection.execute(`INSERT INTO scan_logs (session_id, audit_item_id, client_id, code, item_number, serial, description, batch_name, operator_name, status, qty, scanned_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'found', ?, ?)`, [session.id, item.id, scanClientId, code, scan.itemNumber || item.item_number_display, scan.serial || item.serial_number_display, scan.desc || item.description, scan.batch || session.batch_name, accountScannerName(request), quantity, request.session.user.id]);
    await connection.execute('UPDATE audit_items SET actual_qty = actual_qty + ? WHERE id = ?', [quantity, item.id]);
    await connection.execute('UPDATE audit_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [session.id]);
    await connection.commit(); const full = await loadSession(tenantId(request), request.params.sessionId);
    response.status(201).json({ session: full, scan: full.scanLog.find(entry => entry.id === String(insert.insertId)), duplicate: false });
  } catch (error) { await connection.rollback(); next(error); } finally { connection.release(); }
}

export async function changeScan(request, response, next) {
  const qty = request.body?.qty;
  if (!isNonNegativeWholeQuantity(qty)) return response.status(400).json({ error: 'Scan quantity must be a non-negative whole number.' });
  const reason = normalizeAdjustmentReason(request.body?.reason);
  if (!reason.valid) return response.status(400).json({ error: `Adjustment reasons may contain at most ${MAX_ADJUSTMENT_REASON_LENGTH} characters.` });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const session = await sessionRow(tenantId(request), request.params.sessionId, connection, true);
    if (!session) {
      await connection.rollback();
      return response.status(404).json({ error: 'Audit session not found.' });
    }
    const [rows] = await connection.execute('SELECT * FROM scan_logs WHERE id = ? AND session_id = ? FOR UPDATE', [request.params.scanId, session.id]);
    const scan = rows[0];
    if (!scan) {
      await connection.rollback();
      return response.status(404).json({ error: 'Scan not found.' });
    }
    const delta = qty - Number(scan.qty);
    await connection.execute('UPDATE scan_logs SET qty = ? WHERE id = ?', [qty, scan.id]);
    await connection.execute('UPDATE audit_items SET actual_qty = GREATEST(0, actual_qty + ?) WHERE id = ?', [delta, scan.audit_item_id]);
    if (delta !== 0) {
      await recordScanAdjustment(connection, session, scan, 'qty_changed', Number(scan.qty), qty, request.session.user.id, reason.value);
      await connection.execute('UPDATE audit_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [session.id]);
    }
    await connection.commit();
    const full = await loadSession(tenantId(request), request.params.sessionId);
    response.json({ session: full, scan: full.scanLog.find(entry => entry.id === String(scan.id)) });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
}

export async function deleteScan(request, response, next) {
  const reason = normalizeAdjustmentReason(request.body?.reason);
  if (!reason.valid) return response.status(400).json({ error: `Deletion reasons may contain at most ${MAX_ADJUSTMENT_REASON_LENGTH} characters.` });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const session = await sessionRow(tenantId(request), request.params.sessionId, connection, true);
    if (!session) {
      await connection.rollback();
      return response.status(404).json({ error: 'Audit session not found.' });
    }
    const [rows] = await connection.execute('SELECT * FROM scan_logs WHERE id = ? AND session_id = ? FOR UPDATE', [request.params.scanId, session.id]);
    const scan = rows[0];
    if (!scan) {
      await connection.rollback();
      return response.status(404).json({ error: 'Scan not found.' });
    }
    await recordScanAdjustment(connection, session, scan, 'deleted', Number(scan.qty), 0, request.session.user.id, reason.value);
    await connection.execute('DELETE FROM scan_logs WHERE id = ?', [scan.id]);
    await connection.execute('UPDATE audit_items SET actual_qty = GREATEST(0, actual_qty - ?) WHERE id = ?', [scan.qty, scan.audit_item_id]);
    await connection.execute('UPDATE audit_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [session.id]);
    await connection.commit();
    response.status(204).end();
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
}
export async function listNoRecords(request, response, next) { try { const session = await loadSession(tenantId(request), request.params.sessionId); if (!session) return response.status(404).json({ error: 'Audit session not found.' }); response.json({ entries: session.noRecordEntries }); } catch (error) { next(error); } }
export async function createNoRecord(request, response, next) {
  try {
    const body = request.body || {};
    const code = String(body.code || '').trim();
    const description = String(body.description || '').trim();
    const actualCount = Number(body.actualCount);
    if (!code || code.length > 255 || !description || !Number.isFinite(actualCount) || actualCount < 0 || actualCount > MAX_DECIMAL_14_3) {
      return response.status(400).json({ error: 'A code of at most 255 characters, description, and non-negative actual count are required.' });
    }
    const session = await sessionRow(tenantId(request), request.params.sessionId);
    if (!session) return response.status(404).json({ error: 'Audit session not found.' });
    const entry = { id: randomUUID(), code, description, actualCount, createdAt: Date.now() };
    await pool.execute('INSERT INTO no_record_entries (id, session_id, code, description, actual_count, created_by) VALUES (?, ?, ?, ?, ?, ?)', [entry.id, session.id, entry.code, entry.description, entry.actualCount, request.session.user.id]);
    response.status(201).json({ entry });
  } catch (error) { next(error); }
}
export async function deleteNoRecord(request, response, next) { try { const session = await sessionRow(tenantId(request), request.params.sessionId); if (!session) return response.status(404).json({ error: 'Audit session not found.' }); const [result] = await pool.execute('DELETE FROM no_record_entries WHERE id = ? AND session_id = ?', [request.params.entryId, session.id]); if (!result.affectedRows) return response.status(404).json({ error: 'No-record entry not found.' }); response.status(204).end(); } catch (error) { next(error); } }
