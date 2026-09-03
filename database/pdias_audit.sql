-- WAIS relational MariaDB schema. The application creates this schema on
-- first start; this file is provided for DBAs and manual provisioning.
CREATE DATABASE IF NOT EXISTS `wais_audit` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `wais_audit`;

CREATE TABLE IF NOT EXISTS tenants (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_id CHAR(36) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
INSERT IGNORE INTO tenants (id, public_id, name) VALUES (1, '00000000-0000-0000-0000-000000000001', 'Default');

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
  username VARCHAR(50) NOT NULL,
  password_salt VARCHAR(64) NOT NULL DEFAULT '',
  password_hash VARCHAR(128) NOT NULL,
  role ENUM('admin','user') NOT NULL DEFAULT 'user',
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_tenant_username (tenant_id, username),
  KEY idx_users_tenant (tenant_id),
  CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS folders (
  id VARCHAR(191) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
  section VARCHAR(80) NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_folders_tenant_section (tenant_id, section),
  CONSTRAINT fk_folders_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_folders_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS files (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
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
  UNIQUE KEY uq_files_folder_session (folder_id, session_id),
  CONSTRAINT fk_files_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  CONSTRAINT fk_files_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
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
  UNIQUE KEY uq_audit_sessions_tenant_session (tenant_id, session_id),
  KEY idx_audit_sessions_tenant_updated (tenant_id, updated_at),
  CONSTRAINT fk_audit_sessions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_audit_sessions_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_sessions_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_sessions_operator FOREIGN KEY (operator_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
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
  UNIQUE KEY uq_audit_items_session_client (session_id, client_item_id),
  KEY idx_audit_items_session_item (session_id, item_number),
  KEY idx_audit_items_session_serial (session_id, serial_number),
  CONSTRAINT fk_audit_items_session FOREIGN KEY (session_id) REFERENCES audit_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS scan_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
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
  UNIQUE KEY uq_scan_logs_session_client (session_id, client_id),
  KEY idx_scan_logs_session_created (session_id, created_at),
  CONSTRAINT fk_scan_logs_session FOREIGN KEY (session_id) REFERENCES audit_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_scan_logs_item FOREIGN KEY (audit_item_id) REFERENCES audit_items(id) ON DELETE SET NULL,
  CONSTRAINT fk_scan_logs_user FOREIGN KEY (scanned_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS scan_adjustments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
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
  KEY idx_scan_adjustments_session_created (session_id, created_at),
  KEY idx_scan_adjustments_scan (scan_log_id),
  CONSTRAINT fk_scan_adjustments_session FOREIGN KEY (session_id) REFERENCES audit_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_scan_adjustments_user FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS no_record_entries (
  id VARCHAR(191) PRIMARY KEY,
  session_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  actual_count DECIMAL(14,3) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_no_record_session (session_id),
  CONSTRAINT fk_no_record_session FOREIGN KEY (session_id) REFERENCES audit_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_no_record_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS attachments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  folder_id VARCHAR(191) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  path VARCHAR(500) NOT NULL,
  mime_type VARCHAR(150) NOT NULL,
  size BIGINT UNSIGNED NOT NULL,
  uploaded_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_attachments_folder (folder_id),
  CONSTRAINT fk_attachments_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  CONSTRAINT fk_attachments_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS attachment_collection_revisions (
  tenant_id BIGINT UNSIGNED NOT NULL,
  collection VARCHAR(80) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, collection),
  CONSTRAINT fk_attachment_collection_revisions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS web_sessions (
  sid VARCHAR(191) NOT NULL,
  data MEDIUMTEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (sid),
  KEY idx_web_sessions_expires_at (expires_at)
) ENGINE=InnoDB;
