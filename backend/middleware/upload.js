import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs';
import { uploadsDirectory } from '../services/fileService.js';

const collectionDirectory = {
  noRecordFolders: 'no-record', noRecordAttachmentFolders: 'no-record',
  initialFindingsFolders: 'initial-findings', finalFindingsFolders: 'final-findings'
};
const datedDirectory = request => {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const category = collectionDirectory[request.params.collection] || 'audit-files';
  return { relative: path.posix.join(category, year, month), absolute: path.join(uploadsDirectory, category, year, month) };
};

const storage = multer.diskStorage({
  destination(request, _file, callback) {
    const directory = datedDirectory(request);
    request.uploadRelativeDirectory = directory.relative;
    mkdir(directory.absolute, { recursive: true }, error => callback(error, directory.absolute));
  },
  filename(_request, file, callback) {
    callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  }
});

function boundedUploadSize() {
  const value = Number(process.env.UPLOAD_MAX_BYTES || 10 * 1024 * 1024);
  return Number.isSafeInteger(value) && value >= 1 && value <= 100 * 1024 * 1024
    ? value
    : 10 * 1024 * 1024;
}

const uploadOptions = {
  storage,
  // Every route is a single-file upload. Bound metadata and multipart parts
  // too, so an attacker cannot consume memory/CPU with thousands of fields.
  limits: {
    fileSize: boundedUploadSize(),
    files: 1,
    fields: 8,
    parts: 10,
    fieldNameSize: 100,
    fieldSize: 64 * 1024,
    headerPairs: 100
  }
};

const noRecordImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const noRecordImageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
// Attachments are delivered as downloads, but reject web-active formats as a
// second layer of defense in case a file is accessed outside that route.
const unsafeAttachmentExtensions = new Set([
  '.html', '.htm', '.xhtml', '.xht', '.shtml', '.shtm', '.mhtml', '.mht',
  '.svg', '.svgz', '.xml', '.xsl', '.xslt',
  '.js', '.mjs', '.cjs', '.wasm', '.php', '.phtml', '.phar', '.asp', '.aspx',
  '.exe', '.msi', '.bat', '.cmd', '.ps1', '.sh', '.dll', '.jar', '.hta'
]);
const unsafeAttachmentMimeTypes = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/xml',
  'text/xml', 'application/xslt+xml', 'application/javascript', 'text/javascript',
  'application/ecmascript', 'text/ecmascript'
]);

function attachmentFileFilter(request, file, callback) {
  const extension = path.extname(file.originalname).toLowerCase();
  const collection = request.params.collection;
  if (collection === 'noRecordFolders' || collection === 'noRecordAttachmentFolders') {
    if (!noRecordImageExtensions.has(extension) || !noRecordImageTypes.has(String(file.mimetype || '').toLowerCase())) {
      const error = new Error('No Record attachments must be JPG, PNG, GIF, or WebP images.');
      error.status = 415;
      return callback(error);
    }
  } else if (unsafeAttachmentExtensions.has(extension) || unsafeAttachmentMimeTypes.has(String(file.mimetype || '').toLowerCase())) {
    const error = new Error('This file type is not allowed as an attachment.');
    error.status = 415;
    return callback(error);
  }
  callback(null, true);
}

export const upload = multer({ ...uploadOptions, fileFilter: attachmentFileFilter });
export const spreadsheetUpload = multer({
  ...uploadOptions,
  fileFilter(_request, file, callback) {
    if (['.xlsx', '.xls', '.csv'].includes(path.extname(file.originalname).toLowerCase())) return callback(null, true);
    const error = new Error('Only .xlsx, .xls, and .csv spreadsheets can be uploaded here.');
    error.status = 415;
    callback(error);
  }
});
