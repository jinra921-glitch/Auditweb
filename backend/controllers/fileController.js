import pool from '../config/db.js';
import { readFile } from 'node:fs/promises';
import { cleanUpCommittedFiles, deleteStoredFiles, relativeUploadPath, storedFileUrl } from '../services/fileService.js';

const collections = new Set(['noRecordFolders', 'noRecordAttachmentFolders', 'initialFindingsFolders', 'finalFindingsFolders']);

function validCollection(request, response) {
  if (collections.has(request.params.collection)) return true;
  response.status(404).json({ error: 'Attachment collection not found.' });
  return false;
}

const sectionFor = collection => `attachment:${collection}`;
const legacyDirectory = collection => collection === 'initialFindingsFolders' ? 'initial-findings' : collection === 'finalFindingsFolders' ? 'final-findings' : 'no-record';
const effectivePath = (file, collection) => file.path || (file.stored_name ? `${legacyDirectory(collection)}/${file.stored_name}` : null);
const noRecordImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

async function hasValidNoRecordImageSignature(file) {
  if (!noRecordImageTypes.has(String(file?.mimetype || '').toLowerCase())) return false;
  const bytes = await readFile(file.path);
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isGif = bytes.length >= 6 && (bytes.subarray(0, 6).equals(Buffer.from('GIF87a')) || bytes.subarray(0, 6).equals(Buffer.from('GIF89a')));
  const isWebp = bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'));
  return isJpeg || isPng || isGif || isWebp;
}
const clientFile = (file, collection) => {
  const storedPath = effectivePath(file, collection);
  return {
    id: String(file.id), name: file.original_name, storedName: file.stored_name,
    path: storedPath, type: file.mime_type, size: Number(file.size),
    url: storedFileUrl(storedPath), uploadedAt: new Date(file.created_at).getTime()
  };
};

function groupAttachmentsByFolder(attachments) {
  const result = new Map();
  for (const attachment of attachments) {
    const folderId = String(attachment.folder_id);
    const grouped = result.get(folderId) || [];
    grouped.push(attachment);
    result.set(folderId, grouped);
  }
  return result;
}

async function collectionFolders(tenantId, collection) {
  const [[folders], [attachments], [revisions]] = await Promise.all([
    pool.execute('SELECT * FROM folders WHERE tenant_id = ? AND section = ? ORDER BY updated_at DESC', [tenantId, sectionFor(collection)]),
    pool.execute(`SELECT a.* FROM attachments a JOIN folders f ON f.id = a.folder_id
      WHERE f.tenant_id = ? AND f.section = ? ORDER BY a.created_at`, [tenantId, sectionFor(collection)]),
    pool.execute('SELECT revision FROM attachment_collection_revisions WHERE tenant_id = ? AND collection = ?', [tenantId, collection])
  ]);
  const attachmentsByFolder = groupAttachmentsByFolder(attachments);
  return {
    folders: folders.map(folder => ({ id: folder.id, name: folder.name, files: (attachmentsByFolder.get(String(folder.id)) || []).map(file => clientFile(file, collection)) })),
    revision: Number(revisions[0]?.revision || 0)
  };
}

export async function listAttachmentFolders(request, response, next) {
  try {
    if (!validCollection(request, response)) return;
    response.json(await collectionFolders(request.session.user.tenantId, request.params.collection));
  } catch (error) { next(error); }
}

export async function saveAttachmentFolders(request, response, next) {
  try {
    if (!validCollection(request, response)) return;
    const supplied = request.body?.folders;
    if (!Array.isArray(supplied)) return response.status(400).json({ error: 'Folders must be an array.' });
    const expectedRevision = Number(request.body?.revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return response.status(400).json({ error: 'Attachment collection revision is required.' });
    const invalidFolder = supplied.find(folder => {
      const id = String(folder?.id || '');
      const name = String(folder?.name || '').trim();
      return !id || id.length > 191 || !name || name.length > 255 || !Array.isArray(folder.files || []);
    });
    const folderIds = supplied.map(folder => String(folder?.id || ''));
    if (invalidFolder || new Set(folderIds).size !== folderIds.length) return response.status(400).json({ error: 'Each attachment folder needs a unique ID, a name of at most 255 characters, and a files array.' });
    const cleanFolders = supplied;
    const section = sectionFor(request.params.collection);
    const tenantId = request.session.user.tenantId;
    const stalePaths = [];
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('INSERT IGNORE INTO attachment_collection_revisions (tenant_id, collection, revision) VALUES (?, ?, 0)', [tenantId, request.params.collection]);
      const [revisionRows] = await connection.execute('SELECT revision FROM attachment_collection_revisions WHERE tenant_id = ? AND collection = ? FOR UPDATE', [tenantId, request.params.collection]);
      const currentRevision = Number(revisionRows[0]?.revision || 0);
      if (currentRevision !== expectedRevision) {
        const error = new Error('These attachments changed in another browser. Reload the folder and try again.');
        error.status = 409;
        error.code = 'ATTACHMENT_COLLECTION_CHANGED';
        throw error;
      }
      const [currentFiles] = await connection.execute(`SELECT a.id, a.folder_id, a.path, a.stored_name FROM attachments a
        JOIN folders f ON f.id = a.folder_id WHERE f.tenant_id = ? AND f.section = ? FOR UPDATE`, [tenantId, section]);
      const suppliedById = new Map(cleanFolders.map(folder => [String(folder.id), folder]));
      for (const file of currentFiles) {
        const folder = suppliedById.get(String(file.folder_id));
        const keepIds = new Set((folder?.files || []).map(entry => Number(entry.id)).filter(Number.isSafeInteger));
        if (!folder || !keepIds.has(Number(file.id))) stalePaths.push(file.path || `${legacyDirectory(request.params.collection)}/${file.stored_name}`);
      }

      const ids = cleanFolders.map(folder => folder.id);
      if (ids.length) await connection.execute(`DELETE FROM folders WHERE tenant_id = ? AND section = ? AND id NOT IN (${ids.map(() => '?').join(',')})`, [tenantId, section, ...ids]);
      else await connection.execute('DELETE FROM folders WHERE tenant_id = ? AND section = ?', [tenantId, section]);

      for (const folder of cleanFolders) {
        const [existing] = await connection.execute('SELECT tenant_id, section FROM folders WHERE id = ? FOR UPDATE', [folder.id]);
        if (existing[0] && (Number(existing[0].tenant_id) !== Number(tenantId) || existing[0].section !== section)) {
          const error = new Error('Attachment folder not found.');
          error.status = 404;
          throw error;
        }
        await connection.execute(`INSERT INTO folders (id, tenant_id, section, name, created_by) VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = CURRENT_TIMESTAMP`, [folder.id, tenantId, section, String(folder.name).trim(), request.session.user.id]);
        const keep = (folder.files || []).map(file => Number(file.id)).filter(Number.isSafeInteger);
        if (keep.length) await connection.execute(`DELETE FROM attachments WHERE folder_id = ? AND id NOT IN (${keep.map(() => '?').join(',')})`, [folder.id, ...keep]);
        else await connection.execute('DELETE FROM attachments WHERE folder_id = ?', [folder.id]);
      }
      await connection.execute('UPDATE attachment_collection_revisions SET revision = revision + 1 WHERE tenant_id = ? AND collection = ?', [tenantId, request.params.collection]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await cleanUpCommittedFiles(stalePaths, 'attachment files');
    response.json(await collectionFolders(tenantId, request.params.collection));
  } catch (error) { next(error); }
}

export async function uploadAttachment(request, response, next) {
  let storedPath = null;
  let connection = null;
  let committed = false;
  try {
    if (request.file) storedPath = relativeUploadPath(request.file.path);
    if (!validCollection(request, response)) {
      await deleteStoredFiles([storedPath]);
      return;
    }
    if (!request.file) return response.status(400).json({ error: 'Attach a file.' });
    if ((request.params.collection === 'noRecordFolders' || request.params.collection === 'noRecordAttachmentFolders') && !(await hasValidNoRecordImageSignature(request.file))) {
      await deleteStoredFiles([storedPath]);
      return response.status(415).json({ error: 'The uploaded No Record attachment is not a valid JPG, PNG, GIF, or WebP image.' });
    }
    if (request.file.originalname.length > 255 || String(request.file.mimetype || '').length > 150) {
      await deleteStoredFiles([storedPath]);
      return response.status(400).json({ error: 'The attachment name or MIME type is too long.' });
    }
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [folders] = await connection.execute('SELECT id FROM folders WHERE id = ? AND tenant_id = ? AND section = ? FOR UPDATE', [request.params.folderId, request.session.user.tenantId, sectionFor(request.params.collection)]);
    const folder = folders[0];
    if (!folder) {
      await connection.rollback();
      await deleteStoredFiles([storedPath]);
      return response.status(404).json({ error: 'Attachment folder not found.' });
    }
    const [result] = await connection.execute(`INSERT INTO attachments (folder_id, original_name, stored_name, path, mime_type, size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [folder.id, request.file.originalname, request.file.filename, storedPath, request.file.mimetype || 'application/octet-stream', request.file.size, request.session.user.id]);
    await connection.execute(`INSERT INTO attachment_collection_revisions (tenant_id, collection, revision) VALUES (?, ?, 1)
      ON DUPLICATE KEY UPDATE revision = revision + 1`, [request.session.user.tenantId, request.params.collection]);
    const [revisions] = await connection.execute('SELECT revision FROM attachment_collection_revisions WHERE tenant_id = ? AND collection = ?', [request.session.user.tenantId, request.params.collection]);
    const [files] = await connection.execute('SELECT * FROM attachments WHERE id = ?', [result.insertId]);
    await connection.commit();
    committed = true;
    response.status(201).json({ file: clientFile(files[0], request.params.collection), revision: Number(revisions[0]?.revision || 0) });
  } catch (error) {
    if (!committed) {
      if (connection) await connection.rollback().catch(() => {});
      if (storedPath) await deleteStoredFiles([storedPath]).catch(() => {});
    }
    next(error);
  } finally {
    connection?.release();
  }
}
