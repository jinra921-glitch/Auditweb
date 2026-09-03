import session from 'express-session';
import pool from '../config/db.js';

// express-session's built-in MemoryStore is intentionally unsuitable for a
// long-running server: sessions disappear on restart and accumulate in RAM.
// This store keeps the same signed cookie contract while persisting session
// data in MariaDB.
export class MariaDbSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.defaultTtlMs = Number(options.defaultTtlMs || 12 * 60 * 60 * 1000);
  }

  expiresAt(sessionData) {
    const supplied = new Date(sessionData?.cookie?.expires || 0);
    if (!Number.isNaN(supplied.getTime()) && supplied > new Date()) return supplied;
    return new Date(Date.now() + this.defaultTtlMs);
  }

  get(sid, callback) {
    pool.execute('SELECT data FROM web_sessions WHERE sid = ? AND expires_at > CURRENT_TIMESTAMP', [sid])
      .then(([rows]) => {
        if (!rows[0]) return callback(null, null);
        try {
          callback(null, JSON.parse(rows[0].data));
        } catch (error) {
          this.destroy(sid, () => callback(null, null));
        }
      })
      .catch(error => callback(error));
  }

  set(sid, sessionData, callback = () => {}) {
    let serialized;
    try {
      serialized = JSON.stringify(sessionData);
    } catch (error) {
      callback(error);
      return;
    }
    pool.execute(`INSERT INTO web_sessions (sid, data, expires_at) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE data = VALUES(data), expires_at = VALUES(expires_at)`, [sid, serialized, this.expiresAt(sessionData)])
      .then(() => callback(null))
      .catch(error => callback(error));
  }

  destroy(sid, callback = () => {}) {
    pool.execute('DELETE FROM web_sessions WHERE sid = ?', [sid])
      .then(() => callback(null))
      .catch(error => callback(error));
  }

  touch(sid, sessionData, callback = () => {}) {
    pool.execute('UPDATE web_sessions SET expires_at = ? WHERE sid = ?', [this.expiresAt(sessionData), sid])
      .then(() => callback(null))
      .catch(error => callback(error));
  }
}

// MariaDB does not expire rows automatically. Pruning is deliberately kept
// outside request handling so a burst of sign-ins cannot grow this table
// forever or make an ordinary session lookup pay for cleanup work.
export async function pruneExpiredSessions() {
  const [result] = await pool.execute('DELETE FROM web_sessions WHERE expires_at <= CURRENT_TIMESTAMP');
  return Number(result.affectedRows || 0);
}
