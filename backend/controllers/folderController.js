import { randomUUID } from 'node:crypto';
import pool from '../config/db.js';
import { cleanUpCommittedFiles, cleanUpTemporaryUpload, deleteStoredFiles, persistUploadedFile, relativeUploadPath, storedFileUrl } from '../services/fileService.js';

const allowedSections = new Set(['pos-digital', 'blip', 'nirinsha', 'tlpj']);
const MAX_UNSIGNED_INT = 4_294_967_295;

function folderInput(body) {
  const section = typeof body?.section === 'string' ? body.section.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  return { section, name, valid: allowedSections.has(section) && Boolean(name) && name.length <= 255 };
}

function clientFolderFile(file) {
  return {
    id: String(file.id), sessionId: file.session_id, fileName: file.original_name,
    storedName: file.stored_name || null, path: file.path || null,
    mimeType: file.mime_type || null, size: file.size == null ? null : Number(file.size),
    url: storedFileUrl(file.path), itemCount: Number(file.item_count || 0),
    updatedAt: new Date(file.created_at).getTime()
  };
}

function folderFromRows(folder, files) {
  const mappedFiles = files.map(clientFolderFile);
  const primary = mappedFiles[0] || {};
  return { id: folder.id, section: folder.section, name: folder.name, files: mappedFiles, sessionId: primary.sessionId || null, fileName: primary.fileName || null, itemCount: primary.itemCount || 0, createdAt: new Date(folder.created_at).getTime(), updatedAt: new Date(folder.updated_at).getTime() };
}

function groupFilesByFolder(files) {
  const result = new Map();
  for (const file of files) {
    const folderId = String(file.folder_id);
    const grouped = result.get(folderId) || [];
    grouped.push(file);
    result.set(folderId, grouped);
  }
  return result;
}

export async function listFolders(request, response, next) {
  try {
    const [folders] = await pool.execute('SELECT * FROM folders WHERE tenant_id = ? AND section NOT LIKE ? ORDER BY updated_at DESC', [request.session.user.tenantId, 'attachment:%']);
    const [files] = await pool.execute('SELECT f.* FROM files f JOIN folders d ON d.id = f.folder_id WHERE d.tenant_id = ? ORDER BY f.created_at', [request.session.user.tenantId]);
    const filesByFolder = groupFilesByFolder(files);
    response.json({ folders: folders.map(folder => folderFromRows(folder, filesByFolder.get(String(folder.id)) || [])) });
  } catch (error) { next(error); }
}

export async function getFolder(request, response, next) {
  try {
    const [folders] = await pool.execute('SELECT * FROM folders WHERE id = ? AND tenant_id = ? AND section NOT LIKE ?', [request.params.folderId, request.session.user.tenantId, 'attachment:%']);
    if (!folders[0]) return response.status(404).json({ error: 'Folder not found.' });
    const [files] = await pool.execute('SELECT * FROM files WHERE folder_id = ? ORDER BY created_at', [folders[0].id]);
    response.json({ folder: folderFromRows(folders[0], files) });
  } catch (error) { next(error); }
}

export async function createFolder(request, response, next) {
  try {
    const { section, name, valid } = folderInput(request.body);
    if (!valid) return response.status(400).json({ error: 'Choose a valid section and provide a folder name.' });
    const folderId = `folder_${randomUUID()}`;
    await pool.execute('INSERT INTO folders (id, tenant_id, section, name, created_by) VALUES (?, ?, ?, ?, ?)', [folderId, request.session.user.tenantId, section, name, request.session.user.id]);
    const [folders] = await pool.execute('SELECT * FROM folders WHERE id = ?', [folderId]);
    response.status(201).json({ folder: folderFromRows(folders[0], []) });
  } catch (error) { next(error); }
}

export async function uploadFolderFile(request, response, next) {
  let storedPath = null;
  let committed = false;
  const connection = await pool.getConnection();
  try {
    if (!request.file) return response.status(400).json({ error: 'Choose a .xlsx, .xls, or .csv spreadsheet.' });
    storedPath = relativeUploadPath(request.file.path);
    if (request.file.originalname.length > 255 || String(request.file.mimetype || '').length > 150) {
      await deleteStoredFiles([storedPath]);
      return response.status(400).json({ error: 'The spreadsheet name or MIME type is too long.' });
    }
    const sessionId = String(request.body?.sessionId || '').trim();
    const itemCount = Number(request.body?.itemCount || 0);
    if (!sessionId || sessionId.length > 191 || !Number.isSafeInteger(itemCount) || itemCount < 0 || itemCount > MAX_UNSIGNED_INT) {
      await deleteStoredFiles([storedPath]);
      return response.status(400).json({ error: 'A valid audit session and item count are required.' });
    }
    await connection.beginTransaction();
    const [folders] = await connection.execute('SELECT * FROM folders WHERE id = ? AND tenant_id = ? FOR UPDATE', [request.params.folderId, request.session.user.tenantId]);
    const folder = folders[0];
    if (!folder || !allowedSections.has(folder.section)) {
      await connection.rollback();
      await deleteStoredFiles([storedPath]);
      return response.status(404).json({ error: 'Folder not found.' });
    }
    const [sessions] = await connection.execute('SELECT id FROM audit_sessions WHERE tenant_id = ? AND session_id = ? FOR UPDATE', [request.session.user.tenantId, sessionId]);
    if (!sessions[0]) {
      await connection.rollback();
      await deleteStoredFiles([storedPath]);
      return response.status(404).json({ error: 'Save the audit session before uploading its spreadsheet.' });
    }
    const [existingFiles] = await connection.execute('SELECT * FROM files WHERE folder_id = ? AND session_id = ? FOR UPDATE', [folder.id, sessionId]);
    const existing = existingFiles[0];
    let storedFileId;
    if (existing?.path) {
      // A retry may arrive after the first request committed but before the
      // browser received its response. Retain the original row and discard
      // the second temporary upload instead of creating duplicate evidence.
      await connection.commit();
      committed = true;
      await cleanUpCommittedFiles([storedPath], 'duplicate spreadsheet upload');
      return response.status(200).json({ file: clientFolderFile(existing), duplicate: true });
    }
    if (existing) {
      storedFileId = existing.id;
      await connection.execute('UPDATE files SET original_name = ?, stored_name = ?, path = ?, mime_type = ?, size = ?, item_count = ?, uploaded_by = ? WHERE id = ?',
        [request.file.originalname, request.file.filename, storedPath, request.file.mimetype || 'application/octet-stream', request.file.size, itemCount, request.session.user.id, storedFileId]);
    } else {
      const [result] = await connection.execute('INSERT INTO files (folder_id, session_id, original_name, stored_name, path, mime_type, size, item_count, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [folder.id, sessionId, request.file.originalname, request.file.filename, storedPath, request.file.mimetype || 'application/octet-stream', request.file.size, itemCount, request.session.user.id]);
      storedFileId = result.insertId;
    }
    await persistUploadedFile(connection, storedPath, request.file, request.session.user.tenantId, { fileId: storedFileId });
    await connection.execute('UPDATE audit_sessions SET folder_id = ?, file_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [folder.id, storedFileId, sessions[0].id]);
    await connection.commit();
    committed = true;
    await cleanUpTemporaryUpload(storedPath, 'spreadsheet upload staging file');
    const [files] = await pool.execute('SELECT * FROM files WHERE id = ?', [storedFileId]);
    response.status(201).json({ file: clientFolderFile(files[0]) });
  } catch (error) {
    if (!committed) {
      await connection.rollback().catch(() => {});
      if (storedPath) await deleteStoredFiles([storedPath]).catch(() => {});
    }
    next(error);
  } finally {
    connection.release();
  }
}

export async function saveFolder(request, response, next) {
  const connection = await pool.getConnection();
  const stalePaths = [];
  let committed = false;
  try {
    const { folderId } = request.params, body = request.body || {};
    if (!folderId || folderId.length > 191) return response.status(400).json({ error: 'Folder ID must contain 1-191 characters.' });
    if (body.id && body.id !== folderId) return response.status(400).json({ error: 'Folder ID does not match the route.' });
    const { section, name, valid } = folderInput(body);
    if (!valid) return response.status(400).json({ error: 'Choose a valid section and provide a folder name.' });
    if (Array.isArray(body.files)) {
      const invalidFile = body.files.find(file => {
        if (!file || typeof file !== 'object' || Array.isArray(file)) return true;
        const fileName = typeof file?.fileName === 'string' ? file.fileName.trim() : '';
        const itemCount = Number(file?.itemCount || 0);
        return !fileName || fileName.length > 255 || (file.sessionId && String(file.sessionId).length > 191) || !Number.isSafeInteger(itemCount) || itemCount < 0 || itemCount > MAX_UNSIGNED_INT;
      });
      if (invalidFile) return response.status(400).json({ error: 'Folder files require a name, valid session ID, and non-negative whole item count.' });
    }
    await connection.beginTransaction();
    const [existing] = await connection.execute('SELECT tenant_id, section FROM folders WHERE id = ? FOR UPDATE', [folderId]);
    if (existing[0] && (Number(existing[0].tenant_id) !== Number(request.session.user.tenantId) || !allowedSections.has(existing[0].section))) {
      await connection.rollback();
      return response.status(404).json({ error: 'Folder not found.' });
    }
    await connection.execute(`INSERT INTO folders (id, tenant_id, section, name, created_by) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE section = VALUES(section), name = VALUES(name), updated_at = CURRENT_TIMESTAMP`, [folderId, request.session.user.tenantId, section, name, request.session.user.id]);
    if (Array.isArray(body.files)) {
      const [currentFiles] = await connection.execute('SELECT * FROM files WHERE folder_id = ? FOR UPDATE', [folderId]);
      const currentById = new Map(currentFiles.map(file => [Number(file.id), file]));
      const keepIds = new Set();
      for (const file of body.files) {
        const fileId = Number(file?.id);
        const current = Number.isSafeInteger(fileId) ? currentById.get(fileId) : null;
        const fileName = typeof file?.fileName === 'string' ? file.fileName.trim() : '';
        if (!fileName) continue;
        if (current) {
          keepIds.add(fileId);
          await connection.execute('UPDATE files SET session_id = ?, original_name = ?, item_count = ? WHERE id = ? AND folder_id = ?', [file.sessionId || null, fileName, Math.max(0, Number(file.itemCount) || 0), fileId, folderId]);
        } else {
          const [insert] = await connection.execute('INSERT INTO files (folder_id, session_id, original_name, item_count, uploaded_by) VALUES (?, ?, ?, ?, ?)', [folderId, file.sessionId || null, fileName, Math.max(0, Number(file.itemCount) || 0), request.session.user.id]);
          keepIds.add(Number(insert.insertId));
        }
      }
      const staleFiles = currentFiles.filter(file => !keepIds.has(Number(file.id)));
      stalePaths.push(...staleFiles.map(file => file.path).filter(Boolean));
      if (keepIds.size) await connection.execute(`DELETE FROM files WHERE folder_id = ? AND id NOT IN (${[...keepIds].map(() => '?').join(',')})`, [folderId, ...keepIds]);
      else await connection.execute('DELETE FROM files WHERE folder_id = ?', [folderId]);
    }
    await connection.commit();
    committed = true;
    await cleanUpCommittedFiles(stalePaths, 'spreadsheet files');
    const [folders] = await pool.execute('SELECT * FROM folders WHERE id = ? AND tenant_id = ?', [folderId, request.session.user.tenantId]);
    const [files] = await pool.execute('SELECT * FROM files WHERE folder_id = ? ORDER BY created_at', [folderId]);
    response.json({ folder: folderFromRows(folders[0], files) });
  } catch (error) {
    if (!committed) await connection.rollback().catch(() => {});
    next(error);
  } finally {
    connection.release();
  }
}

export async function removeFolder(request, response, next) {
  const connection = await pool.getConnection();
  let committed = false;
  try {
    await connection.beginTransaction();
    const [folders] = await connection.execute('SELECT id, section FROM folders WHERE id = ? AND tenant_id = ? FOR UPDATE', [request.params.folderId, request.session.user.tenantId]);
    if (!folders[0] || !allowedSections.has(folders[0].section)) {
      await connection.rollback();
      return response.status(404).json({ error: 'Folder not found.' });
    }
    const [files] = await connection.execute('SELECT path FROM files WHERE folder_id = ?', [request.params.folderId]);
    await connection.execute('DELETE FROM folders WHERE id = ?', [request.params.folderId]);
    await connection.commit();
    committed = true;
    await cleanUpCommittedFiles(files.map(file => file.path), 'spreadsheet files');
    response.status(204).end();
  } catch (error) {
    if (!committed) await connection.rollback().catch(() => {});
    next(error);
  } finally {
    connection.release();
  }
}
