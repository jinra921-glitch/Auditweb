const databaseErrors = {
  ER_NO_SUCH_TABLE: ['DATABASE_SETUP_REQUIRED', 'Database setup is incomplete. Redeploy WAIS and check the startup logs.'],
  ER_BAD_FIELD_ERROR: ['DATABASE_SETUP_REQUIRED', 'The database schema does not match this WAIS version. Check the deployment startup logs.'],
  ER_BAD_DB_ERROR: ['DATABASE_SETUP_REQUIRED', 'The configured WAIS database could not be found. Check the database settings.'],
  ER_ACCESS_DENIED_ERROR: ['DATABASE_PERMISSION_DENIED', 'The database rejected the WAIS account. Check its database credentials and permissions.'],
  ER_DBACCESS_DENIED_ERROR: ['DATABASE_PERMISSION_DENIED', 'The WAIS account cannot access the configured database. Check its database permissions.'],
  ER_TABLEACCESS_DENIED_ERROR: ['DATABASE_PERMISSION_DENIED', 'The WAIS database account is not allowed to save this data. Check its table permissions.'],
  ECONNREFUSED: ['DATABASE_UNAVAILABLE', 'The database is unavailable. Wait a moment and try again.'],
  ETIMEDOUT: ['DATABASE_UNAVAILABLE', 'The database connection timed out. Wait a moment and try again.'],
  PROTOCOL_CONNECTION_LOST: ['DATABASE_UNAVAILABLE', 'The database connection was interrupted. Wait a moment and try again.'],
  ER_CON_COUNT_ERROR: ['DATABASE_BUSY', 'The database is busy. Wait a moment and try again.'],
  ER_TOO_MANY_USER_CONNECTIONS: ['DATABASE_BUSY', 'The database connection limit was reached. Wait a moment and try again.'],
  ER_LOCK_DEADLOCK: ['DATABASE_BUSY', 'Another save conflicted with this request. Please try again.'],
  ER_LOCK_WAIT_TIMEOUT: ['DATABASE_BUSY', 'The save waited too long for another database operation. Please try again.']
};

export function errorResponse(error) {
  if (Object.hasOwn(databaseErrors, error.code)) {
    const [code, message] = databaseErrors[error.code];
    return { status: 503, payload: { error: message, code } };
  }
  const isLimit = typeof error.code === 'string' && error.code.startsWith('LIMIT_');
  const suppliedStatus = Number(error.status);
  const status = isLimit ? 413 : Number.isInteger(suppliedStatus) && suppliedStatus >= 400 && suppliedStatus <= 599 ? suppliedStatus : 500;
  const message = status === 413 ? 'The upload is too large or contains too many fields.' : status < 500 || status === 503 ? error.message : 'An unexpected server error occurred.';
  const payload = { error: message };
  if (status < 500 && typeof error.code === 'string' && error.code.length <= 80) payload.code = error.code;
  return { status, payload };
}
