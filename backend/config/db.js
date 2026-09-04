import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep configuration beside the backend, so npm can be run from the project
// root without relying on a separate root-level .env file.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env'), quiet: true });

const databaseName = process.env.DB_NAME || 'wais_audit';
if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
  throw new Error('DB_NAME may only contain letters, numbers, and underscores.');
}

function integerSetting(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a whole number between ${minimum} and ${maximum}.`);
  }
  return value;
}

const databasePort = integerSetting('DB_PORT', 3306, 1, 65535);
const databaseConnectionLimit = integerSetting('DB_CONNECTION_LIMIT', 10, 1, 100);
const databaseQueueLimit = integerSetting('DB_QUEUE_LIMIT', 100, 1, 10_000);
const databaseConnectTimeoutMs = integerSetting('DB_CONNECT_TIMEOUT_MS', 10_000, 1_000, 120_000);
const databaseSslEnabled = ['1', 'true', 'yes'].includes(String(process.env.DB_SSL || '').trim().toLowerCase());
const databaseSslCaPath = String(process.env.DB_SSL_CA_PATH || '').trim();
const databaseSslCaPem = String(process.env.DB_SSL_CA_PEM || '').trim();
if (databaseSslCaPath && databaseSslCaPem) {
  throw new Error('Set either DB_SSL_CA_PATH or DB_SSL_CA_PEM, not both.');
}
const databaseSsl = databaseSslEnabled ? {
  rejectUnauthorized: !['0', 'false', 'no'].includes(String(process.env.DB_SSL_REJECT_UNAUTHORIZED || '1').trim().toLowerCase()),
  ...(databaseSslCaPem ? { ca: databaseSslCaPem } : databaseSslCaPath ? { ca: readFileSync(path.resolve(databaseSslCaPath), 'utf8') } : {})
} : undefined;

const connectionOptions = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: databasePort,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  charset: 'utf8mb4',
  connectTimeout: databaseConnectTimeoutMs,
  ...(databaseSsl ? { ssl: databaseSsl } : {})
};

const pool = mysql.createPool({
  ...connectionOptions,
  database: databaseName,
  waitForConnections: true,
  connectionLimit: databaseConnectionLimit,
  queueLimit: databaseQueueLimit,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

async function getDatabaseConnection() {
  try {
    // Most installations use a least-privilege account which can connect to
    // its existing schema but deliberately cannot create databases.  Connect
    // to the configured schema first so startup does not require broader
    // privileges than the application actually needs.
    return await pool.getConnection();
  } catch (error) {
    if (error.code !== 'ER_BAD_DB_ERROR') throw error;
  }

  // Bootstrap only a genuinely missing schema.  This preserves the
  // first-run convenience without making CREATE DATABASE a runtime
  // requirement for every subsequent start.
  const bootstrap = await mysql.createConnection(connectionOptions);
  try {
    await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (error) {
    if (error.code === 'ER_DBACCESS_DENIED_ERROR' || error.code === 'ER_ACCESS_DENIED_ERROR') {
      const configurationError = new Error(`Database \"${databaseName}\" does not exist and DB_USER needs CREATE DATABASE permission to bootstrap it. Create the schema manually or grant that permission for the first start.`);
      configurationError.cause = error;
      throw configurationError;
    }
    throw error;
  } finally {
    await bootstrap.end();
  }

  return pool.getConnection();
}

export async function verifyDatabase() {
  const connection = await getDatabaseConnection();
  try {
    await connection.ping();
    await connection.execute(`CREATE TABLE IF NOT EXISTS tenants (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      public_id CHAR(36) NOT NULL,
      name VARCHAR(150) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_tenants_public_id (public_id)
    ) ENGINE=InnoDB`);
    await connection.execute(`INSERT IGNORE INTO tenants (id, public_id, name)
      VALUES (1, '00000000-0000-0000-0000-000000000001', 'Default')`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
      username VARCHAR(50) NOT NULL,
      password_salt VARCHAR(64) NOT NULL,
      password_hash VARCHAR(128) NOT NULL,
      role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_tenant_username (tenant_id, username),
      KEY idx_users_tenant (tenant_id),
      CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS folders (
      id VARCHAR(191) NOT NULL,
      tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
      section VARCHAR(80) NOT NULL,
      name VARCHAR(255) NOT NULL,
      created_by BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), KEY idx_folders_tenant_section (tenant_id, section),
      CONSTRAINT fk_folders_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
      CONSTRAINT fk_folders_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS files (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      folder_id VARCHAR(191) NOT NULL,
      session_id VARCHAR(191) NULL,
      original_name VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) NULL,
      path VARCHAR(500) NULL,
      mime_type VARCHAR(150) NULL,
      size BIGINT UNSIGNED NULL,
      item_count INT UNSIGNED NOT NULL DEFAULT 0,
      uploaded_by BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_files_folder_session (folder_id, session_id),
      CONSTRAINT fk_files_folder FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE,
      CONSTRAINT fk_files_user FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS audit_sessions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
      session_id VARCHAR(191) NOT NULL,
      folder_id VARCHAR(191) NULL,
      file_id BIGINT UNSIGNED NULL,
      operator_id BIGINT UNSIGNED NULL,
      batch_name VARCHAR(150) NOT NULL DEFAULT 'Box 1',
      scanner_name VARCHAR(150) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      source_file_name VARCHAR(255) NOT NULL DEFAULT '',
      not_found_count INT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_audit_sessions_tenant_session (tenant_id, session_id),
      KEY idx_audit_sessions_tenant_updated (tenant_id, updated_at),
      CONSTRAINT fk_audit_sessions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
      CONSTRAINT fk_audit_sessions_folder FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE SET NULL,
      CONSTRAINT fk_audit_sessions_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE SET NULL,
      CONSTRAINT fk_audit_sessions_operator FOREIGN KEY (operator_id) REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS audit_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      session_id BIGINT UNSIGNED NOT NULL,
      client_item_id VARCHAR(80) NOT NULL,
      division_name VARCHAR(255) NULL,
      item_number VARCHAR(191) NULL,
      item_number_display VARCHAR(255) NULL,
      serial_number VARCHAR(191) NULL,
      serial_number_display VARCHAR(255) NULL,
      description TEXT NULL,
      expected_qty DECIMAL(14,3) NOT NULL DEFAULT 0,
      actual_qty DECIMAL(14,3) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_audit_items_session_client (session_id, client_item_id),
      KEY idx_audit_items_session_item (session_id, item_number), KEY idx_audit_items_session_serial (session_id, serial_number),
      CONSTRAINT fk_audit_items_session FOREIGN KEY (session_id) REFERENCES audit_sessions (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS scan_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      session_id BIGINT UNSIGNED NOT NULL,
      audit_item_id BIGINT UNSIGNED NULL,
      client_id VARCHAR(191) NOT NULL,
      code VARCHAR(255) NOT NULL,
      item_number VARCHAR(255) NULL,
      serial VARCHAR(255) NULL,
      description TEXT NULL,
      batch_name VARCHAR(150) NULL,
      operator_name VARCHAR(150) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'found',
      qty INT UNSIGNED NOT NULL DEFAULT 1,
      scanned_by BIGINT UNSIGNED NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id), UNIQUE KEY uq_scan_logs_session_client (session_id, client_id),
      KEY idx_scan_logs_session_created (session_id, created_at),
      CONSTRAINT fk_scan_logs_session FOREIGN KEY (session_id) REFERENCES audit_sessions (id) ON DELETE CASCADE,
      CONSTRAINT fk_scan_logs_item FOREIGN KEY (audit_item_id) REFERENCES audit_items (id) ON DELETE SET NULL,
      CONSTRAINT fk_scan_logs_user FOREIGN KEY (scanned_by) REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS scan_adjustments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      session_id BIGINT UNSIGNED NOT NULL,
      scan_log_id BIGINT UNSIGNED NOT NULL,
      scan_client_id VARCHAR(191) NOT NULL,
      scan_code VARCHAR(255) NOT NULL,
      action ENUM('qty_changed', 'deleted') NOT NULL,
      previous_qty INT UNSIGNED NOT NULL,
      next_qty INT UNSIGNED NOT NULL,
      reason VARCHAR(500) NULL,
      changed_by BIGINT UNSIGNED NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_scan_adjustments_session_created (session_id, created_at),
      KEY idx_scan_adjustments_scan (scan_log_id),
      CONSTRAINT fk_scan_adjustments_session FOREIGN KEY (session_id) REFERENCES audit_sessions (id) ON DELETE CASCADE,
      CONSTRAINT fk_scan_adjustments_user FOREIGN KEY (changed_by) REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS no_record_entries (
      id VARCHAR(191) NOT NULL,
      session_id BIGINT UNSIGNED NOT NULL,
      code VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      actual_count DECIMAL(14,3) NOT NULL DEFAULT 0,
      created_by BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), KEY idx_no_record_session (session_id),
      CONSTRAINT fk_no_record_session FOREIGN KEY (session_id) REFERENCES audit_sessions (id) ON DELETE CASCADE,
      CONSTRAINT fk_no_record_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS attachments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      folder_id VARCHAR(191) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) NOT NULL,
      path VARCHAR(500) NOT NULL,
      mime_type VARCHAR(150) NOT NULL,
      size BIGINT UNSIGNED NOT NULL,
      uploaded_by BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), KEY idx_attachments_folder (folder_id),
      CONSTRAINT fk_attachments_folder FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE,
      CONSTRAINT fk_attachments_user FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS upload_blobs (
      path VARCHAR(500) NOT NULL,
      tenant_id BIGINT UNSIGNED NOT NULL,
      file_id BIGINT UNSIGNED NULL,
      attachment_id BIGINT UNSIGNED NULL,
      content MEDIUMBLOB NOT NULL,
      content_size INT UNSIGNED NOT NULL,
      content_sha256 BINARY(32) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (path),
      UNIQUE KEY uq_upload_blobs_file (file_id),
      UNIQUE KEY uq_upload_blobs_attachment (attachment_id),
      KEY idx_upload_blobs_tenant (tenant_id),
      CONSTRAINT fk_upload_blobs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
      CONSTRAINT fk_upload_blobs_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE,
      CONSTRAINT fk_upload_blobs_attachment FOREIGN KEY (attachment_id) REFERENCES attachments (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS attachment_collection_revisions (
      tenant_id BIGINT UNSIGNED NOT NULL,
      collection VARCHAR(80) NOT NULL,
      revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, collection),
      CONSTRAINT fk_attachment_collection_revisions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS web_sessions (
      sid VARCHAR(191) NOT NULL,
      data MEDIUMTEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      PRIMARY KEY (sid),
      KEY idx_web_sessions_expires_at (expires_at)
    ) ENGINE=InnoDB`);
    // Existing installations created before the relational migration need
    // these two fields without requiring a destructive database rebuild.
    const [columns] = await connection.execute(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME IN ('must_change_password', 'updated_at')`);
    const present = new Set(columns.map(column => column.COLUMN_NAME));
    if (!present.has('must_change_password')) await connection.execute('ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0');
    if (!present.has('updated_at')) await connection.execute('ALTER TABLE users ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    // Add disk paths to installations created before uploads were separated
    // into dated directories. Existing attachment rows keep their old paths.
    for (const table of ['files', 'attachments']) {
      const [pathColumns] = await connection.execute(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'path'`, [table]);
      if (!pathColumns.length) await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN path VARCHAR(500) NULL AFTER stored_name`);
    }
    await connection.execute(`UPDATE attachments a JOIN folders f ON f.id = a.folder_id
      SET a.path = CONCAT(CASE
        WHEN f.section = 'attachment:initialFindingsFolders' THEN 'initial-findings/'
        WHEN f.section = 'attachment:finalFindingsFolders' THEN 'final-findings/'
        ELSE 'no-record/' END, a.stored_name)
      WHERE (a.path IS NULL OR a.path = '') AND a.stored_name <> ''`);
  } finally {
    connection.release();
  }
}

export default pool;
