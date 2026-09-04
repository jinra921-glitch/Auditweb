let items = [];
  let scanLog = [];           // {seq, ts, batch, code, itemNumber, serial, desc, status}
  let currentFilter = 'all';
  let notFoundCount = 0;
  let sessionId = null;
  let fileName = '';
  let exported = true;
  let lastScanCode = null;
  let lastScanTime = 0;
  let lastReadoutItemId = null;
  let lastReadoutRawCode = '';
  let isPaused = false;
  let openBoxFolder = null;
  let isBrowsingFolders = false;
  let saveQueue = Promise.resolve();
  let autosaveDebounceTimer = null;
  let autosaveDebounceResolvers = [];
  let audioContext = null;
  const DATABASE_NAME = 'pdias-local-audit';
  const DATABASE_VERSION = 7;
  const SESSION_STORE = 'sessions';
  const METADATA_STORE = 'metadata';
  const FOLDERS_STORE = 'folders';
  const PENDING_QTY_STORE = 'pendingQuantityEdits';
  const PENDING_MUTATION_STORE = 'pendingMutations';
  const SCANNER_CLIENT_ID_KEY = 'pdias-scanner-client-id';
  const DUPLICATE_WINDOW_MS = 800;
  const MAX_SCAN_QUANTITY = 4_294_967_295;
  const MAX_MASTER_SPREADSHEET_BYTES = 25 * 1024 * 1024;
  const SPREADSHEET_PARSE_TIMEOUT_MS = 20 * 1000;
  // A standalone frontend preview uses the API server running on port 3000.
  // A deployed client can set window.WAIS_API_BASE_URL before app.js loads.
  // PDIAS_API_BASE_URL remains supported for older deployment wrappers.
  const standaloneFrontend = window.location.protocol === 'file:' || ['5500', '5501', '5173', '5174'].includes(window.location.port);
  const localApiHost = window.location.hostname || 'localhost';
  const API_BASE_URL = window.WAIS_API_BASE_URL || window.PDIAS_API_BASE_URL || (standaloneFrontend ? `http://${localApiHost}:3000/api` : '/api');
  const API_REQUEST_TIMEOUT_MS = 30 * 1000;
  const attachmentCollectionRevisions = new Map();
  let apiAvailable = true;
  // Incremented whenever an authenticated work area is discarded. Every
  // queued mutation captures this value so an older account/session can
  // never finish work after a logout and affect the next account.
  let accountContextGeneration = 0;
  let scanSyncQueue = Promise.resolve();
  const SHARED_SESSION_REFRESH_MS = 5 * 1000;
  let sharedSessionRefreshTimer = null;
  let sharedSessionRefreshPending = false;
  let authorizationRefreshPending = false;
  // Qty edits are deliberately kept separate from the server session cache.
  // Replacing a cached server session must never discard an unsynced edit.
  let pendingQuantityEdits = new Map();
  let pendingQuantityEditVersion = 0;
  let pendingQuantityStorageQueue = Promise.resolve();
  let pendingQuantitySyncPromise = null;
  let pendingQuantitySyncRequested = false;
  let pendingQuantitySyncGeneration = 0;
  let pendingQuantityRetryTimer = null;
  let pendingQuantityOfflineNoticeShown = false;
  // The quantity editor has stricter replay rules, but all other workstation
  // mutations also need a durable outbox. Cache entries are never treated as
  // disposable until their matching mutation is confirmed by the API.
  let pendingMutationStorageQueue = Promise.resolve();
  let pendingMutationSyncPromise = null;
  let pendingMutationSyncRequested = false;
  let pendingMutationRetryTimer = null;
  let pendingMutationVersion = 0;
  let pendingMutationOfflineNoticeShown = false;
  let historyQtyEdit = null;
  let deferredSharedSession = null;
  let sessionQuantityRevision = 0;
  let noRecordModalTrigger = null;

  function scannerClientId() {
    try {
      let value = window.localStorage.getItem(SCANNER_CLIENT_ID_KEY);
      if (!value) {
        value = window.crypto?.randomUUID?.() || ('client_' + Date.now() + '_' + Math.random().toString(36).slice(2));
        window.localStorage.setItem(SCANNER_CLIENT_ID_KEY, value);
      }
      return value;
    } catch (error) {
      return 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    }
  }

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const dropStage = document.getElementById('dropStage');
  const auditStage = document.getElementById('auditStage');
  const fileSub = document.getElementById('fileSub');
  const scanInput = document.getElementById('scanInput');
  const readout = document.getElementById('readout');
  const saveBadge = document.getElementById('saveBadge');
  const ledDot = document.getElementById('ledDot');
  const resumePanel = document.getElementById('resumePanel');
  const resumeList = document.getElementById('resumeList');
  const batchNameInput = document.getElementById('batchName');
  const operatorNameInput = document.getElementById('operatorName');
  const noRecordsBtn = document.getElementById('noRecordsBtn');
  const noRecordsOverlay = document.getElementById('noRecordsOverlay');
  const noRecordsOverlayClose = document.getElementById('noRecordsOverlayClose');
  const pausedOverlay = document.getElementById('pausedOverlay');
  const pausedStats = document.getElementById('pausedStats');
  const resumeOverlayBtn = document.getElementById('resumeOverlayBtn');
  const newBatchBtn = document.getElementById('newBatchBtn');

  // Keep barcode entry first, alongside the batch and scanner-name fields.
  const scannerRow = document.querySelector('.scanrow');
  const scanFieldLabel = document.querySelector('label[for="scanInput"]');
  const scanFieldWrap = document.querySelector('.scan-input-wrap');
  if (scannerRow && scanFieldLabel && scanFieldWrap) {
    const scanField = document.createElement('div');
    scanField.className = 'batchwrap scan-input-field';
    scanField.append(scanFieldLabel, scanFieldWrap);
    scannerRow.prepend(scanField);
  }

  /* ---------------- persistence ---------------- */

  async function storageSafe(fn, fallback) {
    try { return await fn(); }
    catch (e) { return fallback; }
  }

  function offlineCacheOwner() {
    return signedInUser ? String(signedInUser.tenantId) + ':' + String(signedInUser.id) : null;
  }

  function offlineSettingKey(key) {
    const owner = offlineCacheOwner();
    return owner ? 'account:' + owner + ':' + key : null;
  }

  async function apiResponseError(response, fallbackMessage) {
    const result = await response.json().catch(() => ({}));
    const error = new Error(result.error || fallbackMessage || ('API request failed: ' + response.status));
    error.status = response.status;
    error.code = result.code;
    return error;
  }

  async function fetchApi(path, options = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const externalSignal = options.signal;
    const abortForExternalSignal = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', abortForExternalSignal, { once: true });
    }
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, API_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(API_BASE_URL + path, { ...options, credentials: 'include', signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        const timeoutError = new Error('The server did not respond within 30 seconds.');
        timeoutError.code = 'REQUEST_TIMEOUT';
        timeoutError.networkError = true;
        throw timeoutError;
      }
      error.networkError = true;
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', abortForExternalSignal);
    }
  }

  async function requestApi(path, options) {
    const response = await fetchApi(path, options);
    if (!response.ok) throw await apiResponseError(response);
    return response.status === 204 ? null : response.json();
  }

  // A server session belongs to one browser/device. Do not treat a 401 as an
  // offline-server error: that would leave the workstation open locally and
  // repeatedly retry protected audit endpoints without credentials.
  function handleAuthenticationRequired(error) {
    if (error?.status !== 401) return false;
    apiAvailable = true;
    clearActiveAuditState();
    showAuthStage();
    return true;
  }

  async function refreshAuthorizationState(message) {
    if (authorizationRefreshPending) return;
    const contextGeneration = accountContextGeneration;
    authorizationRefreshPending = true;
    try {
      const state = await requestApi('/auth/me');
      if (contextGeneration !== accountContextGeneration) return;
      if (!state.user) {
        handleAuthenticationRequired({ status: 401 });
        return;
      }
      signedInUser = state.user;
      if (state.user.mustChangePassword) {
        showApp(state.user);
        return;
      }
      const admin = isAdminUser(state.user);
      manageUsersNav.style.display = admin ? 'flex' : 'none';
      createUserForm.style.display = admin ? 'block' : 'none';
      if (!admin && document.getElementById('section-manage-users')?.classList.contains('active')) navigateToDashboard('pos-digital');
      if (message) showToast(message, 'error');
    } catch (error) {
      if (contextGeneration === accountContextGeneration && error?.networkError) apiAvailable = false;
    } finally {
      if (contextGeneration === accountContextGeneration) authorizationRefreshPending = false;
    }
  }

  // Only a fetch/network failure permits IndexedDB fallback. Any HTTP
  // response is authoritative, including 401, 403, validation errors, and
  // server errors; cached protected data must not override that decision.
  function useOfflineFallback(error) {
    if (error?.networkError) {
      apiAvailable = false;
      return true;
    }
    apiAvailable = true;
    if (error.status === 401) handleAuthenticationRequired(error);
    else if (error.status === 403) refreshAuthorizationState(error.message);
    return false;
  }

  function nextPendingMutationVersion() {
    pendingMutationVersion = Math.max(Date.now(), pendingMutationVersion + 1);
    return pendingMutationVersion;
  }

  function pendingMutationStorageKey(owner, kind, targetId) {
    return JSON.stringify([owner, String(kind), String(targetId)]);
  }

  function cloneForOutbox(value) {
    try {
      if (typeof window.structuredClone === 'function') return window.structuredClone(value);
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return value;
    }
  }

  function queuePendingMutationStorage(operation) {
    const queued = pendingMutationStorageQueue.catch(() => {}).then(operation);
    pendingMutationStorageQueue = queued.catch(() => {});
    return queued;
  }

  async function queuePendingMutation(kind, targetId, operation, payload) {
    const owner = offlineCacheOwner();
    if (!owner || !targetId) return false;
    const record = {
      key: pendingMutationStorageKey(owner, kind, targetId),
      owner,
      kind: String(kind),
      targetId: String(targetId),
      operation: String(operation),
      payload: cloneForOutbox(payload),
      version: nextPendingMutationVersion(),
      updatedAt: Date.now()
    };
    const saved = await storageSafe(() => queuePendingMutationStorage(() => savePendingMutation(record)), false);
    if (!saved) {
      showToast('This change is only in memory because the offline retry could not be saved.', 'error');
      return false;
    }
    requestPendingMutationSync({ recoverApi: true });
    return true;
  }

  async function clearPendingMutation(kind, targetId) {
    const owner = offlineCacheOwner();
    if (!owner || !targetId) return false;
    return storageSafe(() => queuePendingMutationStorage(() => deletePendingMutation(pendingMutationStorageKey(owner, kind, targetId))), false);
  }

  async function pendingMutationsForCurrentAccount() {
    const owner = offlineCacheOwner();
    return owner ? storageSafe(() => getPendingMutations(owner), []) : [];
  }

  async function hasPendingMutation(kind, targetId) {
    return (await pendingMutationsForCurrentAccount()).some(record =>
      record.kind === String(kind) && record.targetId === String(targetId));
  }

  function showPendingMutationOfflineNotice() {
    if (pendingMutationOfflineNoticeShown) return;
    pendingMutationOfflineNoticeShown = true;
    showToast('Changes are saved locally and will sync when WAIS reconnects.', 'error');
  }

  async function canUseSharedApi() {
    if (!apiAvailable) return true;
    try {
      const authState = await requestApi('/auth/me');
      if (authState.user) return true;
      stopSharedSessionRefresh();
      signedInUser = null;
      showAuthStage();
      return false;
    } catch (error) {
      return useOfflineFallback(error);
    }
  }

  async function saveSessionRecord(session) {
    if (apiAvailable) {
      try {
        await requestApi('/audit-sessions/' + encodeURIComponent(session.sessionId), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(session)
        });
        if (Array.isArray(session.deletedNoRecordIds) && session.deletedNoRecordIds.length) {
          const acknowledged = new Set(session.deletedNoRecordIds);
          pendingNoRecordDeletes = pendingNoRecordDeletes.filter(id => !acknowledged.has(id));
        }
        await clearPendingMutation('session', session.sessionId);
        await storageSafe(() => saveDatabaseSession({ ...session, deletedNoRecordIds: [...pendingNoRecordDeletes] }), false);
        return true;
      } catch (error) {
        if (!useOfflineFallback(error)) return false;
      }
    }
    const saved = await storageSafe(() => saveDatabaseSession(session), false);
    if (!saved) return false;
    const queued = await queuePendingMutation('session', session.sessionId, 'upsert', { session });
    if (queued) showPendingMutationOfflineNotice();
    return queued;
  }

  async function getSessionRecords() {
    if (apiAvailable) {
      if (!await canUseSharedApi()) return [];
      try {
        const remoteSessions = (await requestApi('/audit-sessions')).sessions || [];
        return await reconcileDatabaseSessions(remoteSessions);
      }
      catch (error) {
        if (!useOfflineFallback(error)) return [];
      }
    }
    return storageSafe(getDatabaseSessions, []);
  }

  async function deleteSessionRecord(id) {
    if (apiAvailable) {
      try {
        await requestApi('/audit-sessions/' + encodeURIComponent(id), { method: 'DELETE' });
        await clearPendingMutation('session', id);
        await storageSafe(() => deleteDatabaseSession(id), false);
        return true;
      }
      catch (error) { if (!useOfflineFallback(error)) return null; }
    }
    const deleted = await storageSafe(() => deleteDatabaseSession(id), null);
    if (!deleted) return deleted;
    const queued = await queuePendingMutation('session', id, 'delete', null);
    if (queued) showPendingMutationOfflineNotice();
    return queued;
  }

  // Attachment files are uploaded separately as multipart requests. The
  // collection endpoint only needs folder metadata and server attachment IDs;
  // sending browser data URLs here can exceed the JSON body limit and copies
  // entire files through an endpoint that intentionally does not store them.
  function attachmentCollectionPayload(folders) {
    return (folders || []).map(folder => ({
      id: folder.id,
      name: folder.name,
      files: (folder.files || [])
        .filter(file => file?.id && !String(file.url || '').startsWith('data:'))
        .map(file => ({ id: file.id }))
    }));
  }

  async function syncAttachmentCollectionToApi(key, folders, expectedRevision, onRevision) {
    const reportRevision = async revision => {
      const value = Number(revision || 0);
      attachmentCollectionRevisions.set(key, value);
      if (onRevision) await onRevision(value);
    };
    const initial = await requestApi('/attachments/' + encodeURIComponent(key), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folders: attachmentCollectionPayload(folders), revision: expectedRevision })
    });
    await reportRevision(initial.revision);
    // Move browser-held data URLs to the upload service. Once uploaded, only
    // a normal server URL and attachment ID stay in browser state.
    for (const folder of folders) {
      for (const file of folder.files || []) {
        if (file.id && !String(file.url || '').startsWith('data:')) continue;
        const blob = await fetch(file.url).then(result => result.blob());
        const form = new FormData();
        form.append('file', new File([blob], file.name || 'attachment', { type: file.type || blob.type || 'application/octet-stream' }));
        const response = await fetchApi('/attachments/' + encodeURIComponent(key) + '/' + encodeURIComponent(folder.id) + '/files', { method: 'POST', body: form });
        if (!response.ok) throw await apiResponseError(response, 'Attachment upload failed.');
        const uploaded = await response.json();
        Object.assign(file, uploaded.file);
        await reportRevision(uploaded.revision);
      }
    }
    const completed = await requestApi('/attachments/' + encodeURIComponent(key), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folders: attachmentCollectionPayload(folders), revision: attachmentCollectionRevisions.get(key) || 0 })
    });
    await reportRevision(completed.revision);
    return completed;
  }

  async function saveAttachmentCollectionLocally(key, folders, revision) {
    const localKey = offlineSettingKey(key);
    if (!localKey || !await storageSafe(() => setDatabaseSetting(localKey, folders), false)) return false;
    const queued = await queuePendingMutation('attachment', key, 'upsert', { key, folders, revision });
    if (queued) showPendingMutationOfflineNotice();
    return queued;
  }

  async function saveAttachmentCollection(key, folders) {
    if (apiAvailable) {
      try {
        await syncAttachmentCollectionToApi(key, folders, attachmentCollectionRevisions.get(key) || 0);
        await clearPendingMutation('attachment', key);
        const localKey = offlineSettingKey(key);
        if (localKey) await storageSafe(() => setDatabaseSetting(localKey, folders), false);
        return true;
      } catch (error) {
        if (error?.code === 'ATTACHMENT_COLLECTION_CHANGED') {
          // Keep the user's complete local collection intact. The pending
          // record gives the operator a durable recovery point instead of
          // replacing offline files with another browser's snapshot.
          await saveAttachmentCollectionLocally(key, folders, attachmentCollectionRevisions.get(key) || 0);
          showToast('Attachments changed in another browser. Your local changes are retained and need reconciliation before they can sync.', 'error');
          return false;
        }
        if (!useOfflineFallback(error)) return false;
      }
    }
    return saveAttachmentCollectionLocally(key, folders, attachmentCollectionRevisions.get(key) || 0);
  }

  async function getAttachmentCollection(key) {
    const localKey = offlineSettingKey(key);
    if (apiAvailable) {
      try {
        const result = await requestApi('/attachments/' + encodeURIComponent(key));
        const remoteFolders = result.folders || [];
        attachmentCollectionRevisions.set(key, Number(result.revision || 0));
        if (await hasPendingMutation('attachment', key)) {
          // A refresh must never replace files that are waiting in IndexedDB.
          const localFolders = localKey ? await storageSafe(() => getDatabaseSetting(localKey), null) : null;
          return Array.isArray(localFolders) ? localFolders : remoteFolders;
        }
        if (localKey) await storageSafe(() => setDatabaseSetting(localKey, remoteFolders), false);
        return remoteFolders;
      }
      catch (error) { if (!useOfflineFallback(error)) return []; }
    }
    return localKey ? storageSafe(() => getDatabaseSetting(localKey), []) : [];
  }

  // The browser keeps its existing IndexedDB autosave as the reliable local
  // copy. Each scan is also appended to the shared server session, rather
  // than allowing one browser to overwrite another browser's scan totals.
  function committedScanQuantity(scan) {
    const quantity = Number(scan?.qty);
    return Number.isSafeInteger(quantity) && quantity >= 0 && quantity <= MAX_SCAN_QUANTITY ? quantity : 1;
  }

  function parseEditedScanQuantity(rawValue) {
    const text = String(rawValue ?? '').trim();
    if (!/^\d+$/.test(text)) return null;
    const quantity = Number(text);
    return Number.isSafeInteger(quantity) && quantity >= 0 && quantity <= MAX_SCAN_QUANTITY ? quantity : null;
  }

  function scanIdentity(scan) {
    const clientScanId = String(scan?.clientScanId || scan?.clientId || '').trim();
    const rawServerId = scan?.apiId ?? scan?.id;
    const serverId = rawServerId == null || String(rawServerId).trim() === '' ? null : String(rawServerId);
    if (clientScanId) return { scanKey: 'client:' + clientScanId, clientScanId, serverId };
    if (serverId) return { scanKey: 'server:' + serverId, clientScanId: null, serverId };
    return null;
  }

  function findPendingScan(record, scans = scanLog) {
    if (!record) return null;
    if (record.clientScanId) {
      const byClientId = scans.find(scan => String(scan?.clientScanId || scan?.clientId || '').trim() === record.clientScanId);
      if (byClientId) return byClientId;
    }
    return record.serverId == null ? null : scans.find(scan => String(scan?.apiId ?? scan?.id ?? '') === String(record.serverId));
  }

  function serverScanId(scan) {
    const value = scan?.apiId ?? scan?.id;
    return value == null || String(value).trim() === '' ? null : String(value);
  }

  function nextPendingQuantityEditVersion() {
    pendingQuantityEditVersion = Math.max(Date.now(), pendingQuantityEditVersion + 1);
    return pendingQuantityEditVersion;
  }

  function snapshotPendingQuantityScan(scan, identity) {
    const snapshot = { ...scan };
    // Server row IDs are only valid while a row exists. The stable client ID
    // lets a reconnect resolve a fresh server ID after a session merge.
    delete snapshot.id;
    delete snapshot.apiId;
    if (identity.clientScanId) {
      snapshot.clientScanId = identity.clientScanId;
      snapshot.clientId = identity.clientScanId;
    }
    return snapshot;
  }

  function queuePendingQuantityStorage(operation) {
    const queued = pendingQuantityStorageQueue.catch(() => {}).then(operation);
    pendingQuantityStorageQueue = queued.catch(() => {});
    return queued;
  }

  function persistPendingQuantityEdit(record) {
    return storageSafe(() => queuePendingQuantityStorage(() => savePendingQuantityEdit(record)), false);
  }

  function removePendingQuantityEditFromStorage(record) {
    return storageSafe(() => queuePendingQuantityStorage(() => deletePendingQuantityEditIfCurrent(record)), false);
  }

  function activePendingQuantityEdits() {
    return sessionId ? [...pendingQuantityEdits.values()].filter(record => record.sessionId === String(sessionId)) : [];
  }

  function hasPendingQuantityEdits() {
    return activePendingQuantityEdits().length > 0;
  }

  function showPendingQuantityOfflineNotice() {
    if (pendingQuantityOfflineNoticeShown) return;
    pendingQuantityOfflineNoticeShown = true;
    showToast('Qty saved locally and will sync when the connection returns.', 'error');
  }

  function schedulePendingQuantityRetry() {
    if (!hasPendingQuantityEdits() || pendingQuantityRetryTimer) return;
    pendingQuantityRetryTimer = window.setTimeout(() => {
      pendingQuantityRetryTimer = null;
      requestPendingQuantitySync({ recoverApi: true });
    }, SHARED_SESSION_REFRESH_MS);
  }

  async function restoreApiConnection(contextGeneration) {
    if (apiAvailable) return true;
    if (navigator.onLine === false) return false;
    try {
      const response = await fetchApi('/auth/me');
      if (!response.ok) throw await apiResponseError(response, 'Unable to reconnect to the audit service.');
      const result = await response.json();
      if (!result.user) {
        handleAuthenticationRequired({ status: 401 });
        return false;
      }
      if (contextGeneration !== accountContextGeneration) return false;
      signedInUser = result.user;
      apiAvailable = true;
      return true;
    } catch (error) {
      if (contextGeneration === accountContextGeneration) useOfflineFallback(error);
      return false;
    }
  }

  function applyScanQuantityToModels(modelItems, scan, newQuantity) {
    const oldQuantity = committedScanQuantity(scan);
    const delta = newQuantity - oldQuantity;
    if (delta === 0) return false;
    scan.qty = newQuantity;
    if (scan.itemId == null) return true;
    const item = modelItems.find(candidate => String(candidate.id) === String(scan.itemId));
    if (!item) return true;
    item.scanned = Math.max(0, Number(item.scanned || 0) + delta);
    if (!item.byOperator) item.byOperator = {};
    const operator = scan.operator || 'Unassigned';
    item.byOperator[operator] = Math.max(0, Number(item.byOperator[operator] || 0) + delta);
    return true;
  }

  function nextAvailableScanSequence(scans) {
    return scans.reduce((highest, scan) => Math.max(highest, Number(scan.seq) || 0), 0) + 1;
  }

  // Merge pending local quantities over a fresh server snapshot. This lets
  // shared polling keep showing other operators' work without losing an edit
  // that has not yet received its own PATCH acknowledgement.
  function overlayPendingQuantityEdits(modelItems, modelScans) {
    pendingQuantityEdits.forEach(record => {
      if (record.sessionId !== String(sessionId)) return;
      let scan = findPendingScan(record, modelScans);
      if (!scan && record.scan && record.scan.status === 'found') {
        scan = { ...record.scan, qty: 0 };
        const hasSequence = modelScans.some(candidate => String(candidate.seq) === String(scan.seq));
        if (!Number.isSafeInteger(Number(scan.seq)) || hasSequence) scan.seq = nextAvailableScanSequence(modelScans);
        modelScans.push(scan);
      }
      if (scan) applyScanQuantityToModels(modelItems, scan, record.qty);
    });
  }

  function refreshQuantityViews({ history = false } = {}) {
    renderTable();
    updateStats();
    updateBatchTracker();
    if (lastReadoutItemId != null) refreshReadoutForItem(lastReadoutItemId);
    if (history) renderHistory();
  }

  function applyPendingQuantityEditsToCurrentSession() {
    if (!pendingQuantityEdits.size) return;
    overlayPendingQuantityEdits(items, scanLog);
    refreshQuantityViews({ history: true });
  }

  function quantityEditRecord(scan) {
    const identity = scanIdentity(scan);
    const owner = offlineCacheOwner();
    if (!identity || !owner || !sessionId) return null;
    const version = nextPendingQuantityEditVersion();
    return {
      key: pendingQuantityStorageKey(owner, sessionId, identity.scanKey),
      owner,
      sessionId: String(sessionId),
      scanKey: identity.scanKey,
      clientScanId: identity.clientScanId,
      serverId: identity.serverId,
      qty: committedScanQuantity(scan),
      version,
      updatedAt: Date.now(),
      scan: snapshotPendingQuantityScan(scan, identity)
    };
  }

  async function queuePendingQuantityEdit(scan) {
    const record = quantityEditRecord(scan);
    if (!record) {
      showToast('This scan cannot be updated because it has no stable ID.', 'error');
      return false;
    }
    pendingQuantityEdits.set(record.scanKey, record);
    const saved = await persistPendingQuantityEdit(record);
    if (!saved) showToast('Qty changed, but this browser could not save the offline retry.', 'error');
    requestPendingQuantitySync();
    return saved;
  }

  async function refreshSessionForPendingQuantityEdits(targetSessionId, contextGeneration) {
    try {
      const result = await requestApi('/audit-sessions/' + encodeURIComponent(targetSessionId));
      if (contextGeneration !== accountContextGeneration || targetSessionId !== sessionId) return false;
      if (result.session) applySharedSession(result.session);
      return true;
    } catch (error) {
      if (contextGeneration === accountContextGeneration) {
        useOfflineFallback(error);
        if (error?.networkError) showPendingQuantityOfflineNotice();
      }
      return false;
    }
  }

  async function acknowledgePendingQuantityEdit(record, saved) {
    const current = pendingQuantityEdits.get(record.scanKey);
    if (current && current.version === record.version) {
      pendingQuantityEdits.delete(record.scanKey);
      await removePendingQuantityEditFromStorage(record);
      sessionQuantityRevision += 1;
    }
    if (!hasPendingQuantityEdits()) {
      pendingQuantityOfflineNoticeShown = false;
      if (pendingQuantityRetryTimer) {
        window.clearTimeout(pendingQuantityRetryTimer);
        pendingQuantityRetryTimer = null;
      }
    }
    if (saved.session) applySharedSession(saved.session);
  }

  function syncPendingQuantityEdit(record, targetSessionId, contextGeneration, syncGeneration) {
    scanSyncQueue = scanSyncQueue.then(async () => {
      if (contextGeneration !== accountContextGeneration || syncGeneration !== pendingQuantitySyncGeneration || targetSessionId !== sessionId || !apiAvailable) return false;
      const current = pendingQuantityEdits.get(record.scanKey);
      if (!current) return true;
      const scan = findPendingScan(current);
      const targetScanId = serverScanId(scan);
      if (!targetScanId) return false;
      const sent = { ...current, qty: current.qty, version: current.version };
      try {
        const response = await fetchApi('/audit-sessions/' + encodeURIComponent(targetSessionId) + '/scans/' + encodeURIComponent(targetScanId), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qty: sent.qty })
        });
        if (!response.ok) throw await apiResponseError(response, 'Scan quantity update failed.');
        const saved = await response.json();
        if (contextGeneration !== accountContextGeneration || syncGeneration !== pendingQuantitySyncGeneration || targetSessionId !== sessionId) return false;
        await acknowledgePendingQuantityEdit(sent, saved);
        return true;
      } catch (error) {
        if (contextGeneration !== accountContextGeneration) return false;
        const networkFailure = Boolean(error?.networkError);
        useOfflineFallback(error);
        if (networkFailure) {
          showPendingQuantityOfflineNotice();
          schedulePendingQuantityRetry();
          return false;
        }
        // Invalid or rejected writes are not retryable. Reload the server
        // state so the last confirmed value becomes visible again.
        const latest = pendingQuantityEdits.get(sent.scanKey);
        if (latest && latest.version === sent.version) {
          pendingQuantityEdits.delete(sent.scanKey);
          await removePendingQuantityEditFromStorage(sent);
          sessionQuantityRevision += 1;
        }
        await refreshSessionForPendingQuantityEdits(targetSessionId, contextGeneration);
        showToast(error.message || 'Scan quantity update failed.', 'error');
        return false;
      }
    });
    return scanSyncQueue;
  }

  function requestPendingQuantitySync({ recoverApi = false } = {}) {
    if (!hasPendingQuantityEdits()) return Promise.resolve(false);
    if (pendingQuantitySyncPromise) {
      pendingQuantitySyncRequested = true;
      return pendingQuantitySyncPromise;
    }
    const targetSessionId = sessionId;
    const contextGeneration = accountContextGeneration;
    const syncGeneration = pendingQuantitySyncGeneration;
    const run = (async () => {
      if ((!apiAvailable && !(recoverApi && await restoreApiConnection(contextGeneration))) ||
          contextGeneration !== accountContextGeneration || syncGeneration !== pendingQuantitySyncGeneration || targetSessionId !== sessionId) {
        schedulePendingQuantityRetry();
        return false;
      }
      // Let a just-created scan finish its POST first. The server response
      // assigns its database ID, which PATCH requires.
      await scanSyncQueue.catch(() => {});
      if (contextGeneration !== accountContextGeneration || syncGeneration !== pendingQuantitySyncGeneration || targetSessionId !== sessionId || !apiAvailable) return false;
      const needsServerId = activePendingQuantityEdits().some(record => !serverScanId(findPendingScan(record)));
      if (needsServerId) {
        await enqueueSaveSession({ immediate: true });
        if (contextGeneration !== accountContextGeneration || syncGeneration !== pendingQuantitySyncGeneration || targetSessionId !== sessionId || !apiAvailable) {
          schedulePendingQuantityRetry();
          return false;
        }
        if (!await refreshSessionForPendingQuantityEdits(targetSessionId, contextGeneration)) {
          schedulePendingQuantityRetry();
          return false;
        }
      }
      for (const queuedRecord of activePendingQuantityEdits()) {
        if (contextGeneration !== accountContextGeneration || syncGeneration !== pendingQuantitySyncGeneration || targetSessionId !== sessionId || !apiAvailable) break;
        const record = pendingQuantityEdits.get(queuedRecord.scanKey);
        if (!record) continue;
        const synced = await syncPendingQuantityEdit(record, targetSessionId, contextGeneration, syncGeneration);
        if (!synced && !apiAvailable) break;
      }
      return true;
    })();
    pendingQuantitySyncPromise = run.finally(() => {
      if (syncGeneration !== pendingQuantitySyncGeneration) return;
      pendingQuantitySyncPromise = null;
      if (!hasPendingQuantityEdits()) return;
      if (pendingQuantitySyncRequested) {
        pendingQuantitySyncRequested = false;
        window.setTimeout(() => requestPendingQuantitySync({ recoverApi: true }), 0);
      } else {
        schedulePendingQuantityRetry();
      }
    });
    return pendingQuantitySyncPromise;
  }

  function pendingMutationPriority(record) {
    const key = record.kind + ':' + record.operation;
    return ({
      'folder:upsert': 10,
      'session:upsert': 20,
      'attachment:upsert': 25,
      'folder-file:upload': 30,
      'scan-delete:delete': 35,
      'session:delete': 40,
      'folder:delete': 50
    })[key] ?? 50;
  }

  function schedulePendingMutationRetry() {
    if (pendingMutationRetryTimer) return;
    pendingMutationRetryTimer = window.setTimeout(() => {
      pendingMutationRetryTimer = null;
      requestPendingMutationSync({ recoverApi: true });
    }, SHARED_SESSION_REFRESH_MS);
  }

  async function replayPendingSessionMutation(record, contextGeneration) {
    if (record.operation === 'delete') {
      const response = await fetchApi('/audit-sessions/' + encodeURIComponent(record.targetId), { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw await apiResponseError(response, 'Audit session deletion failed.');
      await storageSafe(() => deleteDatabaseSession(record.targetId), false);
      return;
    }
    const session = record.payload?.session;
    if (!session || String(session.sessionId) !== String(record.targetId)) {
      const error = new Error('The saved offline audit session is incomplete.');
      error.code = 'OUTBOX_INVALID';
      throw error;
    }
    const saved = await requestApi('/audit-sessions/' + encodeURIComponent(record.targetId), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(session)
    });
    if (contextGeneration !== accountContextGeneration) return;
    const confirmed = saved.session || session;
    await storageSafe(() => saveDatabaseSession(confirmed), false);
    if (sessionId === record.targetId && saved.session) applySharedSession(saved.session);
  }

  async function replayPendingFolderMutation(record) {
    if (record.operation === 'delete') {
      const response = await fetchApi('/folders/' + encodeURIComponent(record.targetId), { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw await apiResponseError(response, 'Folder deletion failed.');
      await storageSafe(() => deleteDatabaseFolder(record.targetId), false);
      return;
    }
    const folder = record.payload?.folder;
    if (!folder || String(folder.id) !== String(record.targetId)) {
      const error = new Error('The saved offline folder is incomplete.');
      error.code = 'OUTBOX_INVALID';
      throw error;
    }
    // Files awaiting a durable multipart upload do not exist on the server
    // yet. Do not create a placeholder database row that would make the
    // later idempotent upload collide with its unique folder/session key.
    const payload = {
      ...folder,
      files: (folder.files || []).filter(file => !file?._pendingUpload)
    };
    const saved = await requestApi('/folders/' + encodeURIComponent(record.targetId), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    await storageSafe(() => saveDatabaseFolder(saved.folder || folder), false);
  }

  async function replayPendingFolderFileMutation(record) {
    const payload = record.payload || {};
    const file = payload.file;
    if (!file || !payload.folderId || !payload.auditSessionId) {
      const error = new Error('The saved offline spreadsheet upload is incomplete.');
      error.code = 'OUTBOX_INVALID';
      throw error;
    }
    const form = new FormData();
    form.append('file', file, file.name || payload.fileName || 'spreadsheet');
    form.append('sessionId', payload.auditSessionId);
    form.append('itemCount', String(payload.itemCount || 0));
    const saved = await requestApi('/folders/' + encodeURIComponent(payload.folderId) + '/files', {
      method: 'POST', body: form
    });
    const uploaded = saved.file;
    const folders = await storageSafe(getDatabaseFolders, []);
    const folder = folders.find(candidate => String(candidate.id) === String(payload.folderId));
    if (folder && uploaded) {
      const files = folderFiles(folder);
      const index = files.findIndex(candidate => String(candidate.sessionId) === String(payload.auditSessionId));
      if (index >= 0) files.splice(index, 1, uploaded);
      else files.push(uploaded);
      folder.files = files;
      syncFolderPrimaryFile(folder);
      await storageSafe(() => saveDatabaseFolder(folder), false);
    }
  }

  async function replayPendingAttachmentMutation(record) {
    const payload = record.payload || {};
    const key = String(payload.key || record.targetId || '');
    const folders = payload.folders;
    if (!key || !Array.isArray(folders)) {
      const error = new Error('The saved offline attachment collection is incomplete.');
      error.code = 'OUTBOX_INVALID';
      throw error;
    }
    const persistRevision = async revision => {
      const nextPayload = { ...payload, key, folders, revision };
      const saved = await queuePendingMutationStorage(() => updatePendingMutationIfCurrent(record, nextPayload));
      if (!saved) {
        const error = new Error('The attachment retry changed before its server progress could be recorded.');
        error.code = 'OUTBOX_REPLACED';
        throw error;
      }
      payload.revision = revision;
    };
    await syncAttachmentCollectionToApi(key, folders, Number(payload.revision || 0), persistRevision);
    const localKey = offlineSettingKey(key);
    if (localKey) await storageSafe(() => setDatabaseSetting(localKey, folders), false);
  }

  async function replayPendingScanDeleteMutation(record) {
    const payload = record.payload || {};
    const targetSessionId = String(payload.sessionId || '');
    if (!targetSessionId) {
      const error = new Error('The saved scan deletion is missing its audit session.');
      error.code = 'OUTBOX_INVALID';
      throw error;
    }
    let targetScanId = payload.serverId == null ? null : String(payload.serverId);
    if (!targetScanId && payload.clientScanId) {
      let current;
      try {
        current = await requestApi('/audit-sessions/' + encodeURIComponent(targetSessionId));
      } catch (error) {
        // Deleting the parent session already makes the locally removed scan
        // authoritative; there is nothing left to replay.
        if (error?.status === 404) return;
        throw error;
      }
      const found = (current.session?.scanLog || []).find(scan =>
        String(scan.clientScanId || scan.clientId || '') === String(payload.clientScanId));
      targetScanId = serverScanId(found);
    }
    if (!targetScanId) return;
    const response = await fetchApi('/audit-sessions/' + encodeURIComponent(targetSessionId) + '/scans/' + encodeURIComponent(targetScanId), {
      method: 'DELETE'
    });
    if (!response.ok && response.status !== 404) throw await apiResponseError(response, 'Scan deletion failed.');
  }

  async function replayPendingMutation(record, contextGeneration) {
    if (record.kind === 'session') return replayPendingSessionMutation(record, contextGeneration);
    if (record.kind === 'folder') return replayPendingFolderMutation(record);
    if (record.kind === 'folder-file') return replayPendingFolderFileMutation(record);
    if (record.kind === 'attachment') return replayPendingAttachmentMutation(record);
    if (record.kind === 'scan-delete') return replayPendingScanDeleteMutation(record);
    const error = new Error('This offline change type is not supported by the current workstation.');
    error.code = 'OUTBOX_UNSUPPORTED';
    throw error;
  }

  function requestPendingMutationSync({ recoverApi = false } = {}) {
    if (pendingMutationSyncPromise) {
      pendingMutationSyncRequested = true;
      return pendingMutationSyncPromise;
    }
    const contextGeneration = accountContextGeneration;
    const run = (async () => {
      const records = await pendingMutationsForCurrentAccount();
      if (!records.length) {
        pendingMutationOfflineNoticeShown = false;
        return true;
      }
      if (!apiAvailable && !(recoverApi && await restoreApiConnection(contextGeneration))) {
        schedulePendingMutationRetry();
        return false;
      }
      const ordered = records.slice().sort((left, right) =>
        pendingMutationPriority(left) - pendingMutationPriority(right) || Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
      for (const record of ordered) {
        if (contextGeneration !== accountContextGeneration || !apiAvailable) return false;
        try {
          await replayPendingMutation(record, contextGeneration);
          if (contextGeneration !== accountContextGeneration) return false;
          await queuePendingMutationStorage(() => deletePendingMutationIfCurrent(record));
        } catch (error) {
          if (contextGeneration !== accountContextGeneration) return false;
          useOfflineFallback(error);
          if (error?.networkError) {
            showPendingMutationOfflineNotice();
            schedulePendingMutationRetry();
            return false;
          }
          // Preserve rejected records for operator recovery rather than
          // silently dropping a locally saved audit.
          showToast(error.message || 'A locally saved change needs attention before it can sync.', 'error');
          return false;
        }
      }
      pendingMutationOfflineNoticeShown = false;
      return true;
    })();
    pendingMutationSyncPromise = run.finally(() => {
      if (contextGeneration !== accountContextGeneration) return;
      pendingMutationSyncPromise = null;
      if (pendingMutationSyncRequested) {
        pendingMutationSyncRequested = false;
        window.setTimeout(() => requestPendingMutationSync({ recoverApi: true }), 0);
      }
    });
    return pendingMutationSyncPromise;
  }

  function updateScanQuantityInApi(scan) {
    // Capture the intended value now. The old implementation read scan.qty
    // later from a queue, which made rapid edits send an unintended value.
    return queuePendingQuantityEdit(scan);
  }

  function syncScanToApi(scan) {
    const scanSessionId = sessionId;
    const contextGeneration = accountContextGeneration;
    const scanKey = scanIdentity(scan)?.scanKey;
    scanSyncQueue = scanSyncQueue.then(async () => {
      if (contextGeneration !== accountContextGeneration || !apiAvailable || !scanSessionId) return;
      try {
        const response = await fetchApi('/audit-sessions/' + encodeURIComponent(scanSessionId) + '/scans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // One stable idempotency key per scan event. Retrying the same
            // event cannot create a duplicate scan_logs row.
            clientId: scan.clientScanId || (scannerClientId() + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8)),
            scan
          })
        });
        if (!response.ok) throw await apiResponseError(response, 'Scan sync failed.');
        const saved = await response.json();
        if (contextGeneration !== accountContextGeneration) return;
        scan.apiId = saved.scan && saved.scan.id ? saved.scan.id : null;
        // A user can delete a just-created local row before its POST returns.
        // Never let that delayed response put the removed row back on screen.
        const scanStillExists = !scanKey || scanLog.some(current => scanIdentity(current)?.scanKey === scanKey);
        if (sessionId === scanSessionId && scanStillExists && saved.session) applySharedSession(saved.session);
      } catch (error) {
        if (contextGeneration === accountContextGeneration) useOfflineFallback(error);
      }
    });
  }

  function deleteScanFromApi(scan) {
    const scanSessionId = sessionId;
    const contextGeneration = accountContextGeneration;
    const identity = scanIdentity(scan);
    const mutationTarget = identity ? scanSessionId + ':' + identity.scanKey : null;
    const queueDeletion = async () => {
      if (!scanSessionId || !identity || !mutationTarget) return false;
      const queued = await queuePendingMutation('scan-delete', mutationTarget, 'delete', {
        sessionId: scanSessionId,
        serverId: serverScanId(scan),
        clientScanId: identity.clientScanId,
        scanKey: identity.scanKey
      });
      if (queued) showPendingMutationOfflineNotice();
      return queued;
    };
    scanSyncQueue = scanSyncQueue.then(async () => {
      // A just-scanned row receives its server ID asynchronously. Resolve it
      // inside the queued work so a quick edit/delete still reaches the API.
      const scanId = scan.apiId || scan.id;
      if (contextGeneration !== accountContextGeneration || !scanSessionId) return;
      if (!apiAvailable || !scanId) {
        await queueDeletion();
        return;
      }
      try {
        const response = await fetchApi('/audit-sessions/' + encodeURIComponent(scanSessionId) + '/scans/' + encodeURIComponent(scanId), { method: 'DELETE' });
        if (!response.ok && response.status !== 404) throw await apiResponseError(response, 'Scan delete failed.');
        if (mutationTarget) await clearPendingMutation('scan-delete', mutationTarget);
      } catch (error) {
        if (contextGeneration === accountContextGeneration && useOfflineFallback(error)) await queueDeletion();
      }
    });
    return scanSyncQueue;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB is unavailable'));
      const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE, { keyPath: 'sessionId' });
        if (!db.objectStoreNames.contains(METADATA_STORE)) db.createObjectStore(METADATA_STORE, { keyPath: 'key' });
        // Authentication is server-only. Remove credentials left by older
        // browser-only versions of PDIAS.
        if (db.objectStoreNames.contains('accounts')) db.deleteObjectStore('accounts');
        if (!db.objectStoreNames.contains(FOLDERS_STORE)) db.createObjectStore(FOLDERS_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(PENDING_QTY_STORE)) db.createObjectStore(PENDING_QTY_STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(PENDING_MUTATION_STORE)) db.createObjectStore(PENDING_MUTATION_STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveDatabaseSession(session) {
    const owner = offlineCacheOwner();
    if (!owner) throw new Error('A signed-in account is required for offline storage.');
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      tx.objectStore(SESSION_STORE).put({ ...session, _cacheOwner: owner });
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function getDatabaseSessions() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readonly');
      const request = tx.objectStore(SESSION_STORE).getAll();
      let sessions = [];
      request.onsuccess = () => { sessions = request.result; };
      tx.oncomplete = () => { db.close(); resolve(sessions.filter(session => session._cacheOwner === offlineCacheOwner())); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function replaceDatabaseSessions(sessions, preservedSessionIds = new Set()) {
    const owner = offlineCacheOwner();
    if (!owner) return false;
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      const store = tx.objectStore(SESSION_STORE);
      const request = store.getAll();
      request.onsuccess = () => {
        request.result
          .filter(session => session._cacheOwner === owner && !preservedSessionIds.has(String(session.sessionId)))
          .forEach(session => store.delete(session.sessionId));
        sessions
          .filter(session => !preservedSessionIds.has(String(session.sessionId)))
          .forEach(session => store.put({ ...session, _cacheOwner: owner }));
      };
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function reconcileDatabaseSessions(remoteSessions) {
    const pending = await pendingMutationsForCurrentAccount();
    const pendingSessionMutations = pending.filter(record => record.kind === 'session');
    const preservedSessionIds = new Set(pendingSessionMutations.map(record => String(record.targetId)));
    const localSessions = await storageSafe(getDatabaseSessions, []);
    const localById = new Map(localSessions.map(session => [String(session.sessionId), session]));
    const merged = new Map((remoteSessions || []).map(session => [String(session.sessionId), session]));

    for (const mutation of pendingSessionMutations) {
      if (mutation.operation === 'delete') {
        merged.delete(String(mutation.targetId));
        continue;
      }
      const pendingSession = localById.get(String(mutation.targetId)) || mutation.payload?.session;
      if (pendingSession) merged.set(String(mutation.targetId), pendingSession);
    }

    await storageSafe(() => replaceDatabaseSessions(remoteSessions || [], preservedSessionIds), false);
    return [...merged.values()].sort((left, right) => Number(right.savedAt || 0) - Number(left.savedAt || 0));
  }

  async function deleteDatabaseSession(id) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      const store = tx.objectStore(SESSION_STORE);
      const request = store.get(id);
      let deleted = false;
      request.onsuccess = () => {
        if (request.result?._cacheOwner === offlineCacheOwner()) {
          store.delete(id);
          deleted = true;
        }
      };
      tx.oncomplete = () => { db.close(); resolve(deleted); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function getDatabaseSetting(key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(METADATA_STORE, 'readonly');
      const request = tx.objectStore(METADATA_STORE).get(key);
      let value;
      request.onsuccess = () => { value = request.result ? request.result.value : undefined; };
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function setDatabaseSetting(key, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(METADATA_STORE, 'readwrite');
      tx.objectStore(METADATA_STORE).put({ key, value });
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  function pendingQuantityStorageKey(owner, targetSessionId, scanKey) {
    return JSON.stringify([owner, String(targetSessionId), String(scanKey)]);
  }

  async function savePendingQuantityEdit(record) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_QTY_STORE, 'readwrite');
      tx.objectStore(PENDING_QTY_STORE).put(record);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function getPendingQuantityEdits(targetSessionId) {
    const owner = offlineCacheOwner();
    if (!owner) return [];
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_QTY_STORE, 'readonly');
      const request = tx.objectStore(PENDING_QTY_STORE).getAll();
      let records = [];
      request.onsuccess = () => { records = request.result; };
      tx.oncomplete = () => {
        db.close();
        resolve(records.filter(record => record.owner === owner && record.sessionId === String(targetSessionId)));
      };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  // Never let an acknowledgement delete a newer local edit for the same scan.
  async function deletePendingQuantityEditIfCurrent(record) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_QTY_STORE, 'readwrite');
      const store = tx.objectStore(PENDING_QTY_STORE);
      const request = store.get(record.key);
      let deleted = false;
      request.onsuccess = () => {
        const stored = request.result;
        if (stored && stored.owner === record.owner && stored.version === record.version) {
          store.delete(record.key);
          deleted = true;
        }
      };
      tx.oncomplete = () => { db.close(); resolve(deleted); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function deletePendingQuantityEditsForSession(targetSessionId) {
    const owner = offlineCacheOwner();
    if (!owner) return false;
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_QTY_STORE, 'readwrite');
      const store = tx.objectStore(PENDING_QTY_STORE);
      const request = store.getAll();
      request.onsuccess = () => {
        request.result
          .filter(record => record.owner === owner && record.sessionId === String(targetSessionId))
          .forEach(record => store.delete(record.key));
      };
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function deleteDependentPendingMutationsForSession(targetSessionId) {
    const owner = offlineCacheOwner();
    if (!owner) return false;
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_MUTATION_STORE, 'readwrite');
      const store = tx.objectStore(PENDING_MUTATION_STORE);
      const request = store.getAll();
      request.onsuccess = () => {
        request.result
          .filter(record => record?.owner === owner && (
            (record.kind === 'scan-delete' && String(record.payload?.sessionId || '') === String(targetSessionId)) ||
            (record.kind === 'folder-file' && String(record.payload?.auditSessionId || '') === String(targetSessionId))
          ))
          .forEach(record => store.delete(record.key));
      };
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function savePendingMutation(record) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_MUTATION_STORE, 'readwrite');
      tx.objectStore(PENDING_MUTATION_STORE).put(record);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function getPendingMutations(owner) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_MUTATION_STORE, 'readonly');
      const request = tx.objectStore(PENDING_MUTATION_STORE).getAll();
      let records = [];
      request.onsuccess = () => { records = request.result; };
      tx.oncomplete = () => {
        db.close();
        resolve(records
          .filter(record => record?.owner === owner && record.kind && record.targetId && record.operation)
          .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0)));
      };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function deletePendingMutation(key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_MUTATION_STORE, 'readwrite');
      tx.objectStore(PENDING_MUTATION_STORE).delete(key);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function deletePendingMutationIfCurrent(record) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_MUTATION_STORE, 'readwrite');
      const store = tx.objectStore(PENDING_MUTATION_STORE);
      const request = store.get(record.key);
      let deleted = false;
      request.onsuccess = () => {
        const stored = request.result;
        if (stored && stored.owner === record.owner && stored.version === record.version) {
          store.delete(record.key);
          deleted = true;
        }
      };
      tx.oncomplete = () => { db.close(); resolve(deleted); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function updatePendingMutationIfCurrent(record, payload) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_MUTATION_STORE, 'readwrite');
      const store = tx.objectStore(PENDING_MUTATION_STORE);
      const request = store.get(record.key);
      let updated = false;
      request.onsuccess = () => {
        const stored = request.result;
        if (stored && stored.owner === record.owner && stored.version === record.version) {
          store.put({ ...stored, payload: cloneForOutbox(payload), updatedAt: Date.now() });
          updated = true;
        }
      };
      tx.oncomplete = () => { db.close(); resolve(updated); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  function hasHostStorage() {
    return !!(window.storage && typeof window.storage.get === 'function' &&
      typeof window.storage.set === 'function' && typeof window.storage.list === 'function' &&
      typeof window.storage.delete === 'function');
  }

  async function purgeLegacyBrowserAuthentication() {
    // The current IndexedDB upgrade removes the old `accounts` object store.
    const db = await storageSafe(openDatabase, null);
    if (db) db.close();
    try { window.localStorage.removeItem('pdias-current-user'); } catch (error) {}
    if (!hasHostStorage()) return;
    try {
      const listing = await window.storage.list('account:', true);
      await Promise.all((listing.keys || []).map(key => window.storage.delete(key, true)));
    } catch (error) {}
  }

  /* ---------------- folders ---------------- */

  async function saveDatabaseFolder(folder) {
    const owner = offlineCacheOwner();
    if (!owner) throw new Error('A signed-in account is required for offline storage.');
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FOLDERS_STORE, 'readwrite');
      tx.objectStore(FOLDERS_STORE).put({ ...folder, _cacheOwner: owner });
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function getDatabaseFolders() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FOLDERS_STORE, 'readonly');
      const request = tx.objectStore(FOLDERS_STORE).getAll();
      let result = [];
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => { db.close(); resolve(result.filter(folder => folder._cacheOwner === offlineCacheOwner())); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function replaceDatabaseFolders(foldersToStore, preservedFolderIds = new Set()) {
    const owner = offlineCacheOwner();
    if (!owner) return false;
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FOLDERS_STORE, 'readwrite');
      const store = tx.objectStore(FOLDERS_STORE);
      const request = store.getAll();
      request.onsuccess = () => {
        request.result
          .filter(folder => folder._cacheOwner === owner && !preservedFolderIds.has(String(folder.id)))
          .forEach(folder => store.delete(folder.id));
        foldersToStore
          .filter(folder => !preservedFolderIds.has(String(folder.id)))
          .forEach(folder => store.put({ ...folder, _cacheOwner: owner }));
      };
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function reconcileDatabaseFolders(remoteFolders) {
    const pending = await pendingMutationsForCurrentAccount();
    const pendingFolderMutations = pending.filter(record => record.kind === 'folder');
    const pendingFolderFileMutations = pending.filter(record => record.kind === 'folder-file' && record.payload?.folderId);
    const preservedFolderIds = new Set([
      ...pendingFolderMutations.map(record => String(record.targetId)),
      ...pendingFolderFileMutations.map(record => String(record.payload.folderId))
    ]);
    const localFolders = await storageSafe(getDatabaseFolders, []);
    const localById = new Map(localFolders.map(folder => [String(folder.id), folder]));
    const merged = new Map((remoteFolders || []).map(folder => [String(folder.id), folder]));

    for (const mutation of pendingFolderMutations) {
      if (mutation.operation === 'delete') {
        merged.delete(String(mutation.targetId));
        continue;
      }
      const pendingFolder = localById.get(String(mutation.targetId)) || mutation.payload?.folder;
      if (pendingFolder) merged.set(String(mutation.targetId), pendingFolder);
    }
    for (const mutation of pendingFolderFileMutations) {
      const pendingFolder = localById.get(String(mutation.payload.folderId));
      if (pendingFolder) merged.set(String(mutation.payload.folderId), pendingFolder);
    }

    await storageSafe(() => replaceDatabaseFolders(remoteFolders || [], preservedFolderIds), false);
    return [...merged.values()].sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  }

  async function deleteDatabaseFolder(id) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FOLDERS_STORE, 'readwrite');
      const store = tx.objectStore(FOLDERS_STORE);
      const request = store.get(id);
      let deleted = false;
      request.onsuccess = () => {
        if (request.result?._cacheOwner === offlineCacheOwner()) {
          store.delete(id);
          deleted = true;
        }
      };
      tx.oncomplete = () => { db.close(); resolve(deleted); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  async function saveFolderRecord(folder) {
    if (apiAvailable) {
      try {
        const result = await requestApi('/folders/' + encodeURIComponent(folder.id), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(folder)
        });
        await clearPendingMutation('folder', folder.id);
        await storageSafe(() => saveDatabaseFolder(result.folder || folder), false);
        return true;
      } catch (error) { if (!useOfflineFallback(error)) return false; }
    }
    const saved = await storageSafe(() => saveDatabaseFolder(folder), false);
    if (!saved) return false;
    const queued = await queuePendingMutation('folder', folder.id, 'upsert', { folder });
    if (queued) showPendingMutationOfflineNotice();
    return queued;
  }

  async function uploadFolderSpreadsheet(folderId, file, auditSessionId, itemCount) {
    const queueUpload = async () => {
      const queued = await queuePendingMutation('folder-file', auditSessionId, 'upload', {
        folderId,
        file,
        fileName: file.name,
        auditSessionId,
        itemCount
      });
      if (queued) showPendingMutationOfflineNotice();
      return queued;
    };
    if (!apiAvailable) {
      return await queueUpload() ? null : false;
    }
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('sessionId', auditSessionId);
    form.append('itemCount', String(itemCount));
    try {
      const result = await requestApi('/folders/' + encodeURIComponent(folderId) + '/files', { method: 'POST', body: form });
      return result.file;
    } catch (error) {
      if (!useOfflineFallback(error)) throw error;
      return await queueUpload() ? null : false;
    }
  }

  async function createFolderRecord(section, name) {
    if (apiAvailable) {
      try {
        const result = await requestApi('/folders', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ section, name })
        });
        await storageSafe(() => saveDatabaseFolder(result.folder), false);
        return result.folder;
      } catch (error) {
        if (!useOfflineFallback(error)) return null;
      }
    }
    const folder = {
      id: 'folder_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      section, name, sessionId: null, fileName: null, itemCount: 0,
      files: [], createdAt: Date.now(), updatedAt: Date.now()
    };
    const saved = await storageSafe(() => saveDatabaseFolder(folder), false);
    if (!saved) return null;
    const queued = await queuePendingMutation('folder', folder.id, 'upsert', { folder });
    if (queued) showPendingMutationOfflineNotice();
    return queued ? folder : null;
  }

  async function loadFolderRecords() {
    if (apiAvailable) {
      try {
        const remoteFolders = (await requestApi('/folders')).folders || [];
        return await reconcileDatabaseFolders(remoteFolders);
      }
      catch (error) { if (!useOfflineFallback(error)) return []; }
    }
    return storageSafe(getDatabaseFolders, []);
  }

  async function removeFolderRecord(id) {
    if (apiAvailable) {
      try {
        await requestApi('/folders/' + encodeURIComponent(id), { method: 'DELETE' });
        await clearPendingMutation('folder', id);
        await storageSafe(() => deleteDatabaseFolder(id), false);
        return true;
      }
      catch (error) { if (!useOfflineFallback(error)) return null; }
    }
    const deleted = await storageSafe(() => deleteDatabaseFolder(id), null);
    if (!deleted) return deleted;
    const queued = await queuePendingMutation('folder', id, 'delete', null);
    if (queued) showPendingMutationOfflineNotice();
    return queued;
  }

  function queueSessionSave() {
    if (!sessionId) return Promise.resolve();
    const saveId = sessionId;
    const contextGeneration = accountContextGeneration;
    const payload = {
      sessionId: saveId,
      fileName,
      items: items.map(item => ({ ...item })),
      scanLog: scanLog.map(scan => ({ ...scan })),
      notFoundCount,
      noRecordEntries: noRecordEntries.map(entry => ({ ...entry })),
      deletedNoRecordIds: [...pendingNoRecordDeletes],
      batchName: batchNameInput.value,
      scannerName: currentScannerName(),
      savedAt: Date.now()
    };
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      if (contextGeneration !== accountContextGeneration) return false;
      const ok = await saveSessionRecord(payload);
      if (contextGeneration !== accountContextGeneration || saveId !== sessionId) return false;
      if (ok) {
        saveBadge.textContent = 'saved ' + new Date().toLocaleTimeString();
        saveBadge.classList.add('fresh');
        ledDot.classList.remove('off');
        setTimeout(() => saveBadge.classList.remove('fresh'), 600);
      } else {
        saveBadge.textContent = 'Autosave unavailable; export often.';
        ledDot.classList.add('off');
      }
    });
    return saveQueue;
  }

  function flushPendingAutosave() {
    if (!autosaveDebounceTimer) return null;
    window.clearTimeout(autosaveDebounceTimer);
    autosaveDebounceTimer = null;
    const waitingResolvers = autosaveDebounceResolvers;
    autosaveDebounceResolvers = [];
    const queuedSave = queueSessionSave();
    waitingResolvers.forEach(resolve => queuedSave.then(resolve));
    return queuedSave;
  }

  function enqueueSaveSession({ immediate = false } = {}) {
    if (!sessionId) return Promise.resolve();
    if (immediate) {
      const pendingSave = flushPendingAutosave();
      return pendingSave ? pendingSave.then(() => queueSessionSave()) : queueSessionSave();
    }
    return new Promise(resolve => {
      autosaveDebounceResolvers.push(resolve);
      if (autosaveDebounceTimer) window.clearTimeout(autosaveDebounceTimer);
      autosaveDebounceTimer = window.setTimeout(() => {
        autosaveDebounceTimer = null;
        const waitingResolvers = autosaveDebounceResolvers;
        autosaveDebounceResolvers = [];
        const queuedSave = queueSessionSave();
        waitingResolvers.forEach(waitingResolve => queuedSave.then(waitingResolve));
      }, 750);
    });
  }

  async function listSavedSessions() {
    const sessions = await getSessionRecords();
    sessions.sort((a, b) => b.savedAt - a.savedAt);
    return sessions;
  }

  function sessionSummary(session) {
    const itemList = Array.isArray(session?.items) ? session.items : [];
    return {
      sessionId: session?.sessionId,
      fileName: session?.fileName || '',
      itemCount: Number(session?.itemCount ?? itemList.length ?? 0),
      scannedTotal: Number(session?.scannedTotal ?? itemList.reduce((total, item) => total + Number(item.scanned || 0), 0)),
      savedAt: Number(session?.savedAt || 0)
    };
  }

  async function reconcileSessionSummaries(remoteSummaries) {
    const pending = await pendingMutationsForCurrentAccount();
    const sessionMutations = pending.filter(record => record.kind === 'session');
    const localSessions = await storageSafe(getDatabaseSessions, []);
    const localById = new Map(localSessions.map(session => [String(session.sessionId), session]));
    const merged = new Map((remoteSummaries || []).map(summary => [String(summary.sessionId), summary]));
    for (const mutation of sessionMutations) {
      const key = String(mutation.targetId);
      if (mutation.operation === 'delete') {
        merged.delete(key);
        continue;
      }
      const local = localById.get(key) || mutation.payload?.session;
      if (local) merged.set(key, sessionSummary(local));
    }
    return [...merged.values()].sort((left, right) => Number(right.savedAt || 0) - Number(left.savedAt || 0));
  }

  async function listResumableSessions() {
    if (apiAvailable) {
      if (!await canUseSharedApi()) return [];
      if (apiAvailable) {
        try {
          const summaries = [];
          let offset = 0;
          while (true) {
            const result = await requestApi('/audit-sessions/summaries?limit=200&offset=' + offset);
            const page = result.sessions || [];
            summaries.push(...page);
            if (!result.page?.hasMore || !page.length) break;
            offset += page.length;
          }
          return await reconcileSessionSummaries(summaries);
        } catch (error) {
          // A rolling deployment can briefly pair this frontend with an
          // older backend that has not registered the summaries endpoint.
          if (error?.status === 404) return listSavedSessions();
          if (!useOfflineFallback(error)) return [];
        }
      }
    }
    return listSavedSessions();
  }

  async function resumeSession(summary) {
    if (apiAvailable) {
      try {
        const result = await requestApi('/audit-sessions/' + encodeURIComponent(summary.sessionId));
        await storageSafe(() => saveDatabaseSession(result.session), false);
        loadSessionIntoUI(result.session);
        return;
      } catch (error) {
        if (!useOfflineFallback(error)) {
          showToast('Could not load this audit session.', 'error');
          return;
        }
      }
    }
    const sessions = await getSessionRecords();
    const localSession = sessions.find(session => session.sessionId === summary.sessionId);
    if (localSession) loadSessionIntoUI(localSession);
    else showToast('This audit session is not available offline.', 'error');
  }

  async function deleteSession(id) {
    const deleted = await deleteSessionRecord(id);
    if (deleted) {
      const owner = offlineCacheOwner();
      if (owner) await storageSafe(() => queuePendingQuantityStorage(() => deletePendingQuantityEditsForSession(id)), false);
      if (owner) await storageSafe(() => queuePendingMutationStorage(() => deleteDependentPendingMutationsForSession(id)), false);
      if (sessionId === id) pendingQuantityEdits.clear();
    }
    return deleted;
  }

  async function checkForResumableSessions(contextGeneration = accountContextGeneration) {
    const sessions = await listResumableSessions();
    if (contextGeneration !== accountContextGeneration || !signedInUser) return;
    if (!sessions.length) return;
    resumePanel.style.display = 'block';
    resumeList.innerHTML = '';
    sessions.forEach(s => {
      const itemCount = Number(s.itemCount ?? s.items?.length ?? 0);
      const scannedTotal = Number(s.scannedTotal ?? s.items?.reduce((total, item) => total + item.scanned, 0) ?? 0);
      if (!s.items) s.items = { length: itemCount };
      const row = document.createElement('div');
      row.className = 'resume-row';
      row.innerHTML =
        '<div><div>' + escapeHtml(s.fileName || 'Untitled audit') + '</div>' +
        '<div class="meta">' + s.items.length + ' SKUs · ' + scannedTotal + ' scanned · last saved ' + new Date(s.savedAt).toLocaleString() + '</div></div>' +
        '<div class="actions"><button type="button" class="btn-resume">Resume</button><button type="button" class="btn-discard">Discard</button></div>';
      row.querySelector('.btn-resume').addEventListener('click', () => resumeSession(s));
      row.querySelector('.btn-discard').addEventListener('click', async () => {
        await deleteSession(s.sessionId);
        row.remove();
        if (!resumeList.children.length) resumePanel.style.display = 'none';
      });
      resumeList.appendChild(row);
    });
  }

  function resetPendingQuantityEditState() {
    pendingQuantitySyncGeneration += 1;
    pendingQuantityEdits.clear();
    pendingQuantitySyncRequested = false;
    pendingQuantitySyncPromise = null;
    pendingQuantityOfflineNoticeShown = false;
    historyQtyEdit = null;
    deferredSharedSession = null;
    sessionQuantityRevision = 0;
    if (pendingQuantityRetryTimer) {
      window.clearTimeout(pendingQuantityRetryTimer);
      pendingQuantityRetryTimer = null;
    }
  }

  function resetPendingMutationState() {
    pendingMutationSyncPromise = null;
    pendingMutationSyncRequested = false;
    pendingMutationOfflineNoticeShown = false;
    if (pendingMutationRetryTimer) {
      window.clearTimeout(pendingMutationRetryTimer);
      pendingMutationRetryTimer = null;
    }
  }

  async function restorePendingQuantityEditsForSession(targetSessionId) {
    const owner = offlineCacheOwner();
    const contextGeneration = accountContextGeneration;
    const syncGeneration = pendingQuantitySyncGeneration;
    if (!owner || !targetSessionId) return;
    const stored = await storageSafe(() => getPendingQuantityEdits(targetSessionId), []);
    if (contextGeneration !== accountContextGeneration || syncGeneration !== pendingQuantitySyncGeneration || targetSessionId !== sessionId) return;
    const restored = new Map();
    stored.forEach(record => {
      const qty = Number(record?.qty);
      const scanKey = String(record?.scanKey || '');
      if (!scanKey || !Number.isSafeInteger(qty) || qty < 0 || qty > MAX_SCAN_QUANTITY) return;
      const version = Number.isSafeInteger(Number(record.version)) ? Number(record.version) : 0;
      const normalized = { ...record, owner, sessionId: String(targetSessionId), scanKey, qty, version };
      restored.set(scanKey, normalized);
      pendingQuantityEditVersion = Math.max(pendingQuantityEditVersion, version);
    });
    restored.forEach((record, scanKey) => {
      const current = pendingQuantityEdits.get(scanKey);
      // An edit may be made while IndexedDB is still loading. Keep the newer
      // in-memory version instead of replacing it with an older stored row.
      if (!current || record.version > current.version) pendingQuantityEdits.set(scanKey, record);
    });
    if (!pendingQuantityEdits.size) return;
    applyPendingQuantityEditsToCurrentSession();
    requestPendingQuantitySync({ recoverApi: true });
  }

  function loadSessionIntoUI(s) {
    resetPendingQuantityEditState();
    sessionId = s.sessionId;
    fileName = s.fileName;
    items = s.items;
    scanLog = s.scanLog || [];
    notFoundCount = s.notFoundCount || 0;
    noRecordEntries = s.noRecordEntries || [];
    pendingNoRecordDeletes = s.deletedNoRecordIds || [];
    batchNameInput.value = s.batchName || 'Box 1';
    lockScannerName();
    setPaused(false);
    setFileSubtitle(fileName + ' · ' + items.length + ' SKUs loaded');
    navigateToAudit('scan');
    readout.className = 'readout is-idle';
    readout.textContent = 'Ready. Start scanning.';
    renderTable();
    refreshBatchFilterOptions();
    renderHistory();
    renderNoRecordEntries();
    updateStats();
    updateBatchTracker();
    scanInput.value = '';
    void restorePendingQuantityEditsForSession(sessionId);
    startSharedSessionRefresh();
  }

  function applySharedSessionNow(s) {
    if (!s || s.sessionId !== sessionId) return;
    const nextItems = (s.items || []).map(item => ({ ...item, byOperator: { ...(item.byOperator || {}) } }));
    const nextScanLog = (s.scanLog || []).map(scan => ({ ...scan }));
    overlayPendingQuantityEdits(nextItems, nextScanLog);
    items = nextItems;
    scanLog = nextScanLog;
    notFoundCount = s.notFoundCount || 0;
    noRecordEntries = (s.noRecordEntries || []).map(entry => ({ ...entry }));
    fileName = s.fileName || fileName;
    renderTable();
    refreshBatchFilterOptions();
    renderHistory();
    renderNoRecordEntries();
    updateStats();
    updateBatchTracker();
    if (lastReadoutItemId != null) refreshReadoutForItem(lastReadoutItemId);
  }

  function applySharedSession(s) {
    if (!s || s.sessionId !== sessionId) return;
    if (historyQtyEdit && historyQtyEdit.sessionId === sessionId) {
      deferredSharedSession = s;
      return;
    }
    applySharedSessionNow(s);
  }

  function flushDeferredSharedSession() {
    const deferred = deferredSharedSession;
    deferredSharedSession = null;
    if (deferred) applySharedSessionNow(deferred);
  }

  async function refreshSharedSession() {
    if (!apiAvailable || !sessionId || document.hidden || sharedSessionRefreshPending) return;
    const contextGeneration = accountContextGeneration;
    sharedSessionRefreshPending = true;
    try {
      // Do not let an older GET response overwrite a scan that this device is
      // still appending or editing on the server.
      await scanSyncQueue.catch(() => {});
      if (contextGeneration !== accountContextGeneration) return;
      const quantityRevision = sessionQuantityRevision;
      const encodedSessionId = encodeURIComponent(sessionId);
      const sessionResult = await requestApi('/audit-sessions/' + encodedSessionId);
      if (contextGeneration !== accountContextGeneration || quantityRevision !== sessionQuantityRevision) return;
      // Keep live scanning compatible with a server that has not yet been
      // restarted after an update. The dedicated scan-history API remains
      // available for integrations; the active workstation safely derives
      // the same found-only history from its shared session response.
      const foundOnlyLog = (sessionResult.session.scanLog || []).filter(scan => scan.status === 'found');
      applySharedSession({ ...sessionResult.session, scanLog: foundOnlyLog });
    } catch (error) {
      if (contextGeneration === accountContextGeneration) useOfflineFallback(error);
    } finally {
      if (contextGeneration === accountContextGeneration) sharedSessionRefreshPending = false;
    }
  }

  function startSharedSessionRefresh() {
    refreshSharedSession();
    if (sharedSessionRefreshTimer) return;
    sharedSessionRefreshTimer = window.setInterval(refreshSharedSession, SHARED_SESSION_REFRESH_MS);
  }

  function stopSharedSessionRefresh() {
    if (!sharedSessionRefreshTimer) return;
    window.clearInterval(sharedSessionRefreshTimer);
    sharedSessionRefreshTimer = null;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function setFileSubtitle(message) {
    fileSub.replaceChildren(ledDot, document.createTextNode(message));
  }

  function searchText(value) {
    return String(value ?? '').toLowerCase();
  }

  function spreadsheetValue(value) {
    const text = String(value ?? '');
    return /^[=+\-@]/.test(text) ? "'" + text : text;
  }

  function ensureXlsx() {
    if (window.XLSX) return true;
    alert('The spreadsheet library failed to load. Check your connection and refresh the page.');
    return false;
  }

  function downloadWorkbook(workbook, fileName) {
    XLSX.writeFile(workbook, fileName, { compression: true });
  }

  /*file load*/

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', e => { if (e.target.files.length) handleFile(e.target.files[0]); });

  function findKey(headerRow, candidates) {
    const keys = Object.keys(headerRow);
    for (const c of candidates) {
      const hit = keys.find(k => k.toLowerCase().replace(/[^a-z]/g,'').includes(c));
      if (hit) return hit;
    }
    return null;
  }

  // Division columns are tricky: a master list often has BOTH a "Division"/
  // "Division Name" text column and a "Division ID"/"Division Number" code
  // column. A naive substring match can lock onto the numeric ID column and
  // the division name then shows up as a number. This picks the textual
  // name column first and only falls back to an ID-style column if nothing
  // else is available.
  function findDivisionKey(headerRow) {
    const keys = Object.keys(headerRow);
    const normalize = k => k.toLowerCase().replace(/[^a-z]/g, '');
    const divisionKeys = keys.filter(k => normalize(k).includes('division'));
    if (divisionKeys.length) {
      const namedKey = divisionKeys.find(k => normalize(k).includes('name'));
      if (namedKey) return namedKey;
      const isIdLike = k => /id|code|num|no$/.test(normalize(k).replace('division', ''));
      const labelKey = divisionKeys.find(k => !isIdLike(k));
      if (labelKey) return labelKey;
      return divisionKeys[0];
    }
    return keys.find(k => normalize(k).includes('category')) || null;
  }

  function cleanCode(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim().replace(/^'+/, '').toUpperCase();
  }

  function cleanDescription(v) {
    return String(v || '').trim().replace(/\s+/g, ' ').toUpperCase();
  }

  function scanMatchesItem(item, code, raw) {
    const codeMatches = [item.itemNumber, item.itemNumberDisplay, item.serial, item.serialDisplay]
      .some(value => cleanCode(value) === code);
    return codeMatches || (cleanDescription(item.desc) && cleanDescription(item.desc) === cleanDescription(raw));
  }

  function spreadsheetRowsFromMatrix(matrix) {
    if (!Array.isArray(matrix) || matrix.length < 2 || !Array.isArray(matrix[0])) return [];
    const seenHeaders = new Set();
    const headers = matrix[0].map((value, index) => {
      const base = String(value ?? '').trim() || ('Column ' + (index + 1));
      let header = base;
      let suffix = 2;
      while (seenHeaders.has(header)) header = base + ' ' + suffix++;
      seenHeaders.add(header);
      return header;
    });
    return matrix.slice(1).filter(Array.isArray).map(values => {
      // A null-prototype row makes hostile header names such as __proto__
      // ordinary data rather than a way to alter application objects.
      const row = Object.create(null);
      headers.forEach((header, index) => { row[header] = values[index] ?? ''; });
      return row;
    });
  }

  function parseSpreadsheetRows(rows, onParsed) {
    try {
      if (!rows.length) { alert('No rows found in that sheet.'); return; }
      const sample = rows[0];
      const itemKey = findKey(sample, ['itemnumber','itemno','sku','barcode']);
      const serialKey = findKey(sample, ['lotserialno','serialno','serial','lotno']);
      const descKey = findKey(sample, ['itemdesc','description','desc']);
      const qtyKey = findKey(sample, ['qty','quantity']);
      const divKey = findDivisionKey(sample);

      const parsedItems = rows
        .filter(r => (itemKey && r[itemKey] !== '') || (serialKey && r[serialKey] !== ''))
        .map((r, i) => ({
          id: i,
          division: divKey ? r[divKey] : '',
          itemNumber: itemKey ? cleanCode(r[itemKey]) : '',
          itemNumberDisplay: itemKey ? String(r[itemKey]).trim() : '',
          serial: serialKey ? cleanCode(r[serialKey]) : '',
          serialDisplay: serialKey ? String(r[serialKey]).trim() : '',
          desc: descKey ? r[descKey] : '',
          expected: qtyKey ? (parseFloat(r[qtyKey]) || 0) : 0,
          scanned: 0,
          byOperator: {}
        }));

      if (!parsedItems.length) {
        alert("Couldn't find item_number or lot_serial_no columns. Check your file's headers.");
        return;
      }
      onParsed(parsedItems);
    } catch (error) {
      alert('Could not read that file: ' + error.message);
    }
  }

  function parseSpreadsheetFile(file, onParsed) {
    const extension = '.' + String(file?.name || '').split('.').pop().toLowerCase();
    if (!file || !['.xlsx', '.xls', '.csv'].includes(extension)) {
      alert('Choose an .xlsx, .xls, or .csv master list.');
      return;
    }
    if (file.size > MAX_MASTER_SPREADSHEET_BYTES) {
      alert('This master list is larger than the 25 MB workstation limit. Split the file before importing it.');
      return;
    }
    if (typeof Worker !== 'function') {
      alert('This browser cannot securely parse spreadsheets. Use a current supported browser.');
      return;
    }
    let worker;
    let timeoutId;
    let finished = false;
    const finish = callback => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeoutId);
      worker?.terminate();
      callback?.();
    };
    try {
      worker = new Worker(new URL('xlsx-parser-worker.js', document.baseURI));
    } catch (error) {
      alert('The secure spreadsheet parser could not be started.');
      return;
    }
    timeoutId = window.setTimeout(() => finish(() => {
      alert('This spreadsheet took too long to parse and was stopped for safety.');
    }), SPREADSHEET_PARSE_TIMEOUT_MS);
    worker.addEventListener('message', event => {
      const result = event.data || {};
      if (result.type === 'rows') {
        finish(() => parseSpreadsheetRows(spreadsheetRowsFromMatrix(result.rows), onParsed));
      } else if (result.type === 'error' || result.type === 'startup-error') {
        finish(() => alert(result.message || 'Could not read that file.'));
      }
    });
    worker.addEventListener('error', () => finish(() => alert('Could not read that file with the secure spreadsheet parser.')));
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const buffer = reader.result;
      if (!(buffer instanceof ArrayBuffer)) return finish(() => alert('Could not read that file.'));
      worker.postMessage({ buffer }, [buffer]);
    });
    reader.addEventListener('error', () => finish(() => alert('Could not read that file.')));
    reader.readAsArrayBuffer(file);
  }

  function handleFile(file) {
    // Save any in-flight audit before replacing the active session with a
    // newly imported spreadsheet.
    flushPendingAutosave();
    parseSpreadsheetFile(file, (parsedItems) => {
      // Keep the prior session's durable outbox in IndexedDB, but never let
      // its in-memory entries apply to the newly imported audit.
      resetPendingQuantityEditState();
      items = parsedItems;
      notFoundCount = 0;
      scanLog = [];
      noRecordEntries = [];
      fileName = file.name;
      sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
      batchNameInput.value = 'Box 1';
      lockScannerName();
      setPaused(false);
      setFileSubtitle(fileName + ' · ' + items.length + ' SKUs loaded');
    navigateToAudit('scan');
      readout.className = 'readout is-idle';
      readout.textContent = 'Ready. Start scanning.';
      renderTable();
      renderHistory();
      renderNoRecordEntries();
      updateStats();
      updateBatchTracker();
      scanInput.value = '';
      enqueueSaveSession({ immediate: true });
      startSharedSessionRefresh();
    });
  }

  /*audio feedback*/
  function beep(kind) {
    try {
      const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextConstructor) return;
      if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextConstructor();
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.connect(gain); gain.connect(audioContext.destination);
      if (kind === 'ok') { osc.frequency.value = 1200; osc.type = 'sine'; }
      else if (kind === 'dup') { osc.frequency.value = 700; osc.type = 'triangle'; }
      else { osc.frequency.value = 300; osc.type = 'square'; }
      gain.gain.setValueAtTime(0.15, audioContext.currentTime);
      osc.start();
      osc.stop(audioContext.currentTime + (kind === 'err' ? 0.18 : 0.09));
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    } catch (e) {}
  }

  /*focus resilience*/
  function isEditingHistoryQuantity() {
    return Boolean(historyQtyEdit?.element && document.activeElement === historyQtyEdit.element);
  }

  function focusableModalElements(modal) {
    return [...modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.hidden && element.offsetParent !== null);
  }

  function keepFocusInModal(event, modal) {
    if (event.key !== 'Tab' || modal.style.display !== 'flex') return;
    const elements = focusableModalElements(modal);
    if (!elements.length) {
      event.preventDefault();
      modal.focus();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openNoRecordsDialog() {
    noRecordModalTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const scannedCode = scanInput.value.trim();
    if (scannedCode) noRecordCodeInput.value = scannedCode;
    noRecordsOverlay.style.display = 'flex';
    (scannedCode ? noRecordDescriptionInput : noRecordCodeInput).focus();
  }

  function closeNoRecordsDialog({ restoreFocus = true } = {}) {
    noRecordsOverlay.style.display = 'none';
    noRecordForm.reset();
    if (restoreFocus && noRecordModalTrigger?.isConnected) noRecordModalTrigger.focus();
    else focusScanInput();
    noRecordModalTrigger = null;
  }

  function focusScanInput() {
    const tabPanelScan = document.getElementById('tabPanelScan');
    if (isEditingHistoryQuantity()) return;
    const imageDialog = document.getElementById('imageLightbox');
    if (auditStage.style.display !== 'none' && tabPanelScan.style.display !== 'none' && !isPaused && !isBrowsingFolders && noRecordsOverlay.style.display === 'none' && imageDialog?.style.display !== 'flex') scanInput.focus();
  }

  scanInput.addEventListener('focus', () => { isBrowsingFolders = false; });

  document.addEventListener('click', (e) => {
    if (auditStage.style.display === 'none' || isPaused || isBrowsingFolders) return;
    if (e.target.closest('#search') || e.target.closest('#historySearch') || e.target.closest('#batchFilter') ||
        e.target.closest('.filters') || e.target.closest('.adj') ||
        e.target.closest('#exportBtn') || e.target.closest('#exportHistoryBtn') || e.target.closest('#printBtn') ||
        e.target.closest('#batchName') || e.target.closest('#operatorName') || e.target.closest('#pauseBtn') || e.target.closest('#newBatchBtn') ||
        e.target.closest('.boxfolders') || e.target.closest('#noRecordsOverlay') || e.target.closest('#historyBody')) return;
    focusScanInput();
  });
  window.addEventListener('focus', focusScanInput);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) focusScanInput(); });
  window.addEventListener('online', () => {
    requestPendingMutationSync({ recoverApi: true });
    requestPendingQuantitySync({ recoverApi: true });
  });
  window.addEventListener('beforeunload', (e) => {
    if (items.length && !exported && items.some(i => i.scanned > 0)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /*pause / resume */
  function updatePausedStats() {
    const total = scanLog.length + notFoundCount;
    const found = scanLog.filter(s => s.status === 'found').length;
    const currentBatch = batchNameInput.value.trim() || '(unnamed batch)';
    const batchScans = scanLog.filter(s => s.batch === currentBatch);
    pausedStats.innerHTML =
      'Total scans so far: <b>' + total + '</b> (' + found + ' found · ' + notFoundCount + ' not found)<br>' +
      'Current batch "' + escapeHtml(currentBatch) + '": <b>' + batchScans.length + '</b> scans<br>' +
      'Press Resume to keep scanning.';
  }

  function setPaused(paused) {
    isPaused = paused;
    if (isPaused) {
      scanInput.disabled = true;
      pausedOverlay.classList.add('show');
      updatePausedStats();
    } else {
      scanInput.disabled = false;
      pausedOverlay.classList.remove('show');
      focusScanInput();
    }
  }

  noRecordsBtn.addEventListener('click', openNoRecordsDialog);
  noRecordsOverlayClose.addEventListener('click', () => closeNoRecordsDialog());
  noRecordsOverlay.addEventListener('click', (e) => {
    if (e.target === noRecordsOverlay) closeNoRecordsDialog();
  });
  document.addEventListener('keydown', event => {
    if (noRecordsOverlay.style.display !== 'flex') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeNoRecordsDialog();
      return;
    }
    keepFocusInModal(event, noRecordsOverlay);
  });
  resumeOverlayBtn.addEventListener('click', () => setPaused(false));

  newBatchBtn.addEventListener('click', () => {
    const current = batchNameInput.value.trim();
    const m = current.match(/^(.*?)(\d+)\s*$/);
    if (m) {
      batchNameInput.value = m[1] + (parseInt(m[2], 10) + 1);
    } else {
      batchNameInput.value = current ? current + ' 2' : 'Box 1';
    }
    updateBatchTracker();
    enqueueSaveSession();
    focusScanInput();
  });

  batchNameInput.addEventListener('input', () => { updateBatchTracker(); enqueueSaveSession(); });

  function updateBatchTracker() {
    const name = batchNameInput.value.trim() || '(unnamed batch)';
    document.getElementById('trackerBatchName').textContent = name;
    const rows = scanLog.filter(s => s.batch === name);
    const scannedQty = rows.filter(s => s.status === 'found').reduce((sum, s) => sum + (s.qty != null ? s.qty : 1), 0);
    document.getElementById('trackerScanned').textContent = scannedQty;
    renderBoxFolders();
  }

  function renderBoxFolders() {
    const container = document.getElementById('boxFolders');
    const currentBox = batchNameInput.value.trim() || '(unnamed box)';
    const selectedBox = document.getElementById('batchFilter').value;
    const query = document.getElementById('historySearch').value.trim().toLowerCase();
    const filteredLog = scanLog.filter(s =>
      s.status === 'found' &&
      (!selectedBox || s.batch === selectedBox) &&
      (!query || searchText(s.code).includes(query) || searchText(s.desc).includes(query) || searchText(s.batch).includes(query) || searchText(s.operator).includes(query))
    );
    const filesByBox = new Map();
    for (const scan of filteredLog) {
      const boxFiles = filesByBox.get(scan.batch) || [];
      boxFiles.push(scan);
      filesByBox.set(scan.batch, boxFiles);
    }
    const boxes = [...new Set((selectedBox || query) ? filteredLog.map(s => s.batch) : [currentBox, ...scanLog.map(s => s.batch)])];

    container.innerHTML = boxes.map(box => {
      const files = (filesByBox.get(box) || []).slice().reverse();
      const isOpen = openBoxFolder === box;
      const fileRows = files.length ? '<table><thead><tr><th>#</th><th>Time</th><th>Scanner</th><th>Scanned Code</th><th>Item</th><th>Status</th></tr></thead><tbody>' + files.map(s => {
        const status = s.status === 'found' ? 'Found' : (s.status === 'notfound' ? 'Not found' : 'Duplicate');
        return '<tr class="h-' + s.status + '"><td>' + s.seq + '</td><td>' + new Date(s.ts).toLocaleTimeString() + '</td><td>' + escapeHtml(s.operator || 'Unassigned') + '</td>' +
          '<td>' + escapeHtml(s.code) + '</td><td>' + escapeHtml(s.desc || '—') + '</td>' +
          '<td class="statuscell">' + status + '</td></tr>';
      }).join('') + '</tbody></table>' : '<div class="empty">No scanned files in this box yet</div>';
      return '<div class="boxfolder' + (isOpen ? ' open' : '') + '">' +
        '<button class="boxfolder-toggle" type="button" data-box="' + escapeHtml(box) + '" aria-expanded="' + isOpen + '">' +
          '<span class="folder-name">' + (isOpen ? '▾' : '▸') + ' ' + escapeHtml(box) + '</span>' +
          '<span class="folder-meta">' + files.length + ' scanned file' + (files.length === 1 ? '' : 's') + '</span></button>' +
        '<div class="boxfolder-files">' + fileRows + '</div></div>';
    }).join('');

    container.querySelectorAll('.boxfolder-toggle').forEach(button => {
      button.addEventListener('click', () => {
        const box = button.dataset.box;
        openBoxFolder = openBoxFolder === box ? null : box;
        isBrowsingFolders = openBoxFolder !== null;
        renderBoxFolders();
      });
    });
  }

   /*scanning*/
  scanInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || isPaused) return;
    // Barcode scanners usually send Enter after the code. Prevent a browser
    // form/navigation default from handling that Enter after we process it.
    e.preventDefault();
    const raw = scanInput.value;
    scanInput.value = '';
    if (!raw.trim()) return;
    processScan(raw);
  });

  function logScan(raw, status, match) {
    // Scan History is an audit trail of verified inventory matches only.
    // Do not let duplicate or not-found feedback events enter persistence.
    if (status !== 'found' || !match) return null;
    const scan = {
      seq: nextScanSequence(),
      ts: Date.now(),
      batch: batchNameInput.value.trim() || '(unnamed batch)',
      operator: currentScannerName(),
      code: raw.trim(),
      itemNumber: match ? match.itemNumberDisplay : '',
      serial: match ? match.serialDisplay : '',
      desc: match ? match.desc : '',
      division: match ? match.division : '',
      itemId: match ? match.id : null,
      qty: status === 'found' ? 1 : 0,
      status,
      clientScanId: scannerClientId() + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8)
    };
    scanLog.push(scan);
    sessionQuantityRevision += 1;
    syncScanToApi(scan);
    refreshBatchFilterOptions();
    renderHistory();
    updateBatchTracker();
  }

  function nextScanSequence() {
    return scanLog.reduce((highest, scan) => Math.max(highest, Number(scan.seq) || 0), 0) + 1;
  }

  function processScan(raw) {
    const code = cleanCode(raw);
    const now = Date.now();

    if (code === lastScanCode && (now - lastScanTime) < DUPLICATE_WINDOW_MS) {
      beep('dup');
      readout.className = 'readout dup';
      readout.innerHTML =
        '<span class="k">STATUS:</span> <span class="v-dup">DUPLICATE IGNORED</span>\n' +
        '<span class="k">CODE:</span>  ' + escapeHtml(raw.trim()) + '\n' +
        'Same code scanned again within ' + DUPLICATE_WINDOW_MS + 'ms — not counted twice.';
      return;
    }
    lastScanCode = code;
    lastScanTime = now;

    const matches = items.filter(item => scanMatchesItem(item, code, raw));
    const match = matches.length === 1 ? matches[0] : null;

    if (match) {
      match.scanned += 1;
      if (!match.byOperator) match.byOperator = {};
      const scannerName = currentScannerName();
      match.byOperator[scannerName] = (match.byOperator[scannerName] || 0) + 1;
      exported = false;
      beep('ok');
      lastReadoutItemId = match.id;
      lastReadoutRawCode = raw.trim();
      readout.className = 'readout ok';
      readout.innerHTML =
        '<span class="k">STATUS:</span> <span class="v-ok">MATCH FOUND</span>\n' +
        '<span class="k">CODE:</span>  ' + escapeHtml(raw.trim()) + '\n' +
        '<span class="k">ITEM:</span>  ' + escapeHtml(match.desc || '(no description)') + '\n' +
        '<span class="k">COUNT:</span> ' + match.scanned + ' / ' + match.expected;
      renderTable();
      updateStats();
      flashRow(match);
      logScan(raw, 'found', match);
      enqueueSaveSession();
    } else {
      notFoundCount++;
      exported = false;
      beep('err');
      readout.className = 'readout err';
      readout.innerHTML =
        '<span class="k">STATUS:</span> <span class="v-err">TRY AGAIN — ITEM NOT FOUND</span>\n' +
        '<span class="k">CODE:</span>  ' + escapeHtml(raw.trim()) + '\n' +
        'No matching item_number or lot_serial_no in the master list.';
      if (matches.length > 1) {
        readout.innerHTML =
          '<span class="k">STATUS:</span> <span class="v-err">MORE THAN ONE ITEM MATCHES</span>\n' +
          '<span class="k">DESCRIPTION:</span>  ' + escapeHtml(raw.trim()) + '\n' +
          'This description belongs to more than one item. Enter the item number or serial number instead.';
      }
      updateStats();
      // Not-found scans stay off the Scan History log — the person just
      // sees the "TRY AGAIN" message above and can rescan. It still counts
      // toward the "Not-Found Scans" stat card.
      enqueueSaveSession();
    }
  }

  function flashRow(item) {
    const itemIndex = items.indexOf(item);
    const row = itemIndex >= 0
      ? document.querySelector('#tbody tr[data-item-index="' + itemIndex + '"]')
      : null;
    if (!row) return;
    row.style.transition = 'none';
    row.style.background = 'var(--green-dim)';
    requestAnimationFrame(() => {
      row.style.transition = 'background .8s';
      row.style.background = '';
    });
  }

  // The readout box only redraws itself when a new scan comes in, so an
  // edit made afterward (history Qty, or the +/- buttons) wouldn't show up
  // there. If the edited item is still the one the readout is displaying,
  // refresh its COUNT line so the two never disagree.
  function refreshReadoutForItem(itemId) {
    if (lastReadoutItemId == null || lastReadoutItemId !== itemId) return;
    if (readout.className.indexOf('readout ok') === -1) return;
    const it = items.find(i => i.id === itemId);
    if (!it) return;
    readout.innerHTML =
      '<span class="k">STATUS:</span> <span class="v-ok">MATCH FOUND</span>\n' +
      '<span class="k">CODE:</span>  ' + escapeHtml(lastReadoutRawCode) + '\n' +
      '<span class="k">ITEM:</span>  ' + escapeHtml(it.desc || '(no description)') + '\n' +
      '<span class="k">COUNT:</span> ' + it.scanned + ' / ' + it.expected;
  }

  function updateStats() {
    const skus = items.length;
    const expected = items.reduce((s, i) => s + i.expected, 0);
    const scanned = items.reduce((s, i) => s + i.scanned, 0);
    const under = items.filter(i => i.scanned < i.expected).length;
    document.getElementById('statSkus').textContent = skus;
    document.getElementById('statExpected').textContent = expected;
    document.getElementById('statScanned').textContent = scanned;
    document.getElementById('statUnder').textContent = under;
  }

  function rowStatus(it) {
    if (it.scanned === 0) return 'pending';
    if (it.scanned > it.expected) return 'over';
    if (it.scanned === it.expected) return 'match';
    return 'partial';
  }

  // The exported difference is the remaining quantity: expected minus the
  // combined total scanned by every operator.
  function exportStatusLabel(remainingQuantity) {
    if (remainingQuantity === 0) return 'Tally';
    if (remainingQuantity > 0) return 'Short';
    return 'Over';
  }

  function renderTable() {
    const tbody = document.getElementById('tbody');
    const headRow = document.getElementById('tableHeadRow');
    const q = document.getElementById('search').value.trim().toLowerCase();
    let rows = items.map((item, itemIndex) => ({ item, itemIndex }));

    if (currentFilter === 'scanned') rows = rows.filter(({ item }) => item.scanned > 0);
    if (currentFilter === 'pending') rows = rows.filter(({ item }) => item.scanned === 0);
    if (currentFilter === 'over') rows = rows.filter(({ item }) => item.scanned > item.expected);

    if (q) {
      rows = rows.filter(({ item }) =>
        searchText(item.itemNumberDisplay).includes(q) ||
        searchText(item.serialDisplay).includes(q) ||
        searchText(item.desc).includes(q) ||
        searchText(item.division).includes(q)
      );
    }

    const operators = getOperatorList();
    const colCount = 7 + operators.length;
    headRow.innerHTML =
      '<th>Division</th><th>Item No.</th><th>Serial No.</th><th>Description</th><th>Expected</th><th>Scanned</th>' +
      operators.map(op => '<th>' + escapeHtml(op) + '</th>').join('') +
      '<th></th>';

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="' + colCount + '"><div class="empty">No items match this view</div></td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(({ item: it, itemIndex }) => {
      const status = rowStatus(it);
      const cls = status === 'match' ? 'match' : (status === 'over' ? 'over' : (status === 'partial' ? 'under' : ''));
      const opCells = operators.map(op => {
        const n = it.byOperator ? (it.byOperator[op] || 0) : 0;
        return '<td class="qtycell">' + (n || '') + '</td>';
      }).join('');
      return '<tr class="' + cls + '" data-item-index="' + itemIndex + '">' +
        '<td>' + escapeHtml(it.division || '') + '</td>' +
        '<td>' + escapeHtml(it.itemNumberDisplay || '') + '</td>' +
        '<td>' + escapeHtml(it.serialDisplay || '') + '</td>' +
        '<td>' + escapeHtml(it.desc || '') + '</td>' +
        '<td class="qtycell">' + it.expected + '</td>' +
        '<td class="qtycell">' + it.scanned + '</td>' +
        opCells +
        '<td><button type="button" class="adj" data-item-index="' + itemIndex + '" data-adjust-delta="-1">−</button> <button type="button" class="adj" data-item-index="' + itemIndex + '" data-adjust-delta="1">+</button></td>' +
        '</tr>';
    }).join('');
  }

  function adjustItemAtIndex(itemIndex, delta) {
    const it = items[itemIndex];
    if (!it) return;
    if (!it.byOperator) it.byOperator = {};
    const scannerName = currentScannerName();
    const operatorQuantity = Number(it.byOperator[scannerName] || 0);
    const clampedDelta = delta < 0 ? Math.max(-operatorQuantity, delta) : delta;
    if (clampedDelta === 0) return;

    // Keep the Scan History Qty column in sync with this adjustment.
    // Find this item's most recent "found" scan row and nudge its qty by
    // the same amount; if it has never been scanned, log a row for it so
    // the two views always agree.
    let target = null;
    for (let i = scanLog.length - 1; i >= 0; i--) {
      const candidate = scanLog[i];
      const candidateQuantity = committedScanQuantity(candidate);
      if (String(candidate.itemId) === String(it.id) && candidate.status === 'found' && candidate.operator === scannerName && (clampedDelta > 0 || candidateQuantity > 0)) {
        target = candidate;
        break;
      }
    }
    if (target) {
      const currentQty = committedScanQuantity(target);
      const nextQty = Math.min(MAX_SCAN_QUANTITY, Math.max(0, currentQty + clampedDelta));
      // A single scan event is capped at the API's unsigned-integer limit.
      // Create a new event for another + rather than overflow this one.
      if (nextQty === currentQty && clampedDelta > 0) target = null;
      else {
        if (!applyScanQuantityToModels(items, target, nextQty)) return;
        sessionQuantityRevision += 1;
        exported = false;
        updateScanQuantityInApi(target);
      }
    }
    if (!target && clampedDelta > 0) {
      const manualScan = {
        seq: nextScanSequence(),
        ts: Date.now(),
        batch: batchNameInput.value.trim() || '(unnamed batch)',
        operator: scannerName,
        code: it.itemNumberDisplay || it.serialDisplay || '',
        itemNumber: it.itemNumberDisplay,
        serial: it.serialDisplay,
        desc: it.desc,
        division: it.division,
        itemId: it.id,
        qty: 0,
        status: 'found',
        clientScanId: scannerClientId() + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8)
      };
      scanLog.push(manualScan);
      applyScanQuantityToModels(items, manualScan, clampedDelta);
      sessionQuantityRevision += 1;
      exported = false;
      // A + adjustment creates a real scan-history event. Append that event
      // to the shared session too, rather than leaving the adjustment only
      // in this browser's IndexedDB copy.
      syncScanToApi(manualScan);
      refreshBatchFilterOptions();
    }

    refreshQuantityViews({ history: true });
    enqueueSaveSession();
  }

  document.getElementById('tbody').addEventListener('click', event => {
    const button = event.target.closest('.adj[data-item-index][data-adjust-delta]');
    if (!button) return;
    const itemIndex = Number(button.dataset.itemIndex);
    const delta = Number(button.dataset.adjustDelta);
    if (!Number.isInteger(itemIndex) || ![-1, 1].includes(delta)) return;
    adjustItemAtIndex(itemIndex, delta);
  });

  function getOperatorList() {
    const set = new Set();
    items.forEach(it => { if (it.byOperator) Object.keys(it.byOperator).forEach(op => set.add(op)); });
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  function getOperatorColumns() {
    return getOperatorList().map(name => ({ name, key: name }));
  }

  document.querySelectorAll('.filters button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filters button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderTable();
    });
  });

  document.getElementById('search').addEventListener('input', renderTable);

  document.getElementById('exportBtn').addEventListener('click', () => {
    if (!ensureXlsx()) return;
    const operatorColumns = getOperatorColumns();
    const statusOrder = { Short: 0, Over: 1, Tally: 2 };
    const exportRows = items.map(it => {
      const scannerQuantities = operatorColumns.map(column => ({
        ...column,
        quantity: Number(it.byOperator && it.byOperator[column.name]) || 0
      }));
      const totalScanned = scannerQuantities.reduce((sum, column) => sum + column.quantity, 0);
      const difference = Number(it.expected || 0) - totalScanned;
      const status = exportStatusLabel(difference);
      const row = {
        division_name: spreadsheetValue(it.division),
        item_number: spreadsheetValue(it.itemNumberDisplay),
        lot_serial_no: spreadsheetValue(it.serialDisplay),
        item_desc: spreadsheetValue(it.desc),
        expected_qty: it.expected,
        scanned_qty: totalScanned
      };
      scannerQuantities.forEach(column => { row[column.key] = column.quantity; });
      row.difference = difference;
      row.status = spreadsheetValue(status);
      row._sortKey = statusOrder[status];
      return row;
    }).sort((a, b) => a._sortKey - b._sortKey);
    exportRows.forEach(row => { delete row._sortKey; });

    // No Record scans have no master-list match, so there's nothing to
    // sort them against — just append them after everything else.
    noRecordEntries.forEach(entry => {
      const row = {
        division_name: '',
        item_number: spreadsheetValue(entry.code),
        lot_serial_no: '',
        item_desc: spreadsheetValue(entry.description),
        expected_qty: 0,
        scanned_qty: entry.actualCount
      };
      operatorColumns.forEach(column => { row[column.key] = 0; });
      row.difference = -entry.actualCount;
      row.status = spreadsheetValue('No Record');
      exportRows.push(row);
    });

    const header = ['division_name','item_number','lot_serial_no','item_desc','expected_qty', ...operatorColumns.map(column => column.key), 'scanned_qty','difference','status'];
    const ws = XLSX.utils.json_to_sheet(exportRows, { header });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Item Summary');
    try {
      downloadWorkbook(wb, 'AuditItemSummary_' + new Date().toISOString().slice(0,10) + '.xlsx');
      exported = true;
    } catch (error) {
      console.error(error);
      showToast('The Item Summary could not be downloaded.', 'error');
    }
  });

  /*(scan history)*/
  function refreshBatchFilterOptions() {
    const sel = document.getElementById('batchFilter');
    const current = sel.value;
    const batches = [...new Set(scanLog.filter(s => s.status === 'found').map(s => s.batch))];
    sel.innerHTML = '<option value="">All batches</option>' + batches.map(b => '<option value="' + escapeHtml(b) + '">' + escapeHtml(b) + '</option>').join('');
    if (batches.includes(current)) sel.value = current;
  }

  function getFilteredHistory() {
    const batchVal = document.getElementById('batchFilter').value;
    const q = document.getElementById('historySearch').value.trim().toLowerCase();
    // Older locally saved sessions may contain duplicate feedback events.
    // Filter at the display boundary too, so history remains found-only.
    let rows = scanLog.filter(s => s.status === 'found');
    if (batchVal) rows = rows.filter(s => s.batch === batchVal);
    if (q) {
      rows = rows.filter(s =>
        searchText(s.code).includes(q) ||
        searchText(s.desc).includes(q) ||
        searchText(s.batch).includes(q) ||
        searchText(s.operator).includes(q)
      );
    }
    return rows;
  }

  function renderHistory() {
    const tbody = document.getElementById('historyBody');
    const rows = getFilteredHistory().slice().reverse();
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty">No scans logged yet</div></td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(s => {
      const cls = s.status === 'found' ? 'h-found' : (s.status === 'notfound' ? 'h-notfound' : 'h-duplicate');
      const itemLabel = s.desc ? s.desc : '—';
      const qtyCell = s.status === 'found'
        ? '<input type="number" class="history-qty" name="scanQty_' + s.seq + '" min="0" max="' + MAX_SCAN_QUANTITY + '" step="1" inputmode="numeric" value="' + committedScanQuantity(s) + '" data-seq="' + s.seq + '">' 
        : '—';
      return '<tr class="' + cls + '">' +
        '<td>' + escapeHtml(s.batch) + '</td>' +
        '<td>' + escapeHtml(s.operator || 'Unassigned') + '</td>' +
        '<td>' + escapeHtml(s.code) + '</td>' +
        '<td>' + escapeHtml(itemLabel) + '</td>' +
        '<td class="statuscell">' + qtyCell + '</td>' +
        '<td><button type="button" class="btn history-delete" data-seq="' + s.seq + '">Delete</button></td>' +
        '</tr>';
    }).join('');
  }

  function findHistoryQtyEditEntry(edit) {
    if (!edit) return null;
    const byIdentity = scanLog.find(scan => scanIdentity(scan)?.scanKey === edit.scanKey);
    return byIdentity || scanLog.find(scan => Number(scan.seq) === edit.seq);
  }

  function beginHistoryQtyEdit(input) {
    const seq = Number(input.dataset.seq);
    const entry = scanLog.find(scan => Number(scan.seq) === seq);
    const identity = scanIdentity(entry);
    if (!entry || entry.status !== 'found' || !identity) return;
    historyQtyEdit = {
      sessionId,
      element: input,
      seq,
      scanKey: identity.scanKey,
      originalQty: committedScanQuantity(entry)
    };
  }

  function cancelHistoryQtyEdit(input) {
    const edit = historyQtyEdit;
    if (!edit || edit.element !== input) return;
    input.value = String(edit.originalQty);
    historyQtyEdit = null;
    flushDeferredSharedSession();
  }

  function commitHistoryQtyEdit(input) {
    const edit = historyQtyEdit;
    if (!edit || edit.element !== input) return false;
    const entry = findHistoryQtyEditEntry(edit);
    const nextQty = parseEditedScanQuantity(input.value);
    if (!entry || entry.status !== 'found' || nextQty == null) {
      input.value = String(edit.originalQty);
      historyQtyEdit = null;
      flushDeferredSharedSession();
      showToast('Qty must be a non-negative whole number.', 'error');
      return false;
    }
    historyQtyEdit = null;
    if (nextQty === committedScanQuantity(entry)) {
      flushDeferredSharedSession();
      return true;
    }
    // Reconcile a snapshot received during typing after the current event.
    // Pending Qty overlay keeps this edit intact while retaining other
    // operators' changes from that snapshot.
    const deferred = deferredSharedSession;
    deferredSharedSession = null;
    input.value = String(nextQty);
    applyScanQuantityToModels(items, entry, nextQty);
    sessionQuantityRevision += 1;
    const commitRevision = sessionQuantityRevision;
    exported = false;
    updateScanQuantityInApi(entry);
    // Do not rerender history here: replacing this input is the original
    // cursor-jump bug. The dependent table and totals can update safely.
    refreshQuantityViews();
    enqueueSaveSession();
    if (deferred) {
      window.setTimeout(() => {
        if (sessionId === edit.sessionId && !historyQtyEdit && sessionQuantityRevision === commitRevision) applySharedSession(deferred);
      }, 0);
    }
    return true;
  }

  const historyBody = document.getElementById('historyBody');
  historyBody.addEventListener('focusin', (e) => {
    if (e.target.classList?.contains('history-qty')) beginHistoryQtyEdit(e.target);
  });
  historyBody.addEventListener('focusout', (e) => {
    if (e.target.classList?.contains('history-qty')) commitHistoryQtyEdit(e.target);
  });
  historyBody.addEventListener('keydown', (e) => {
    if (!e.target.classList?.contains('history-qty')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelHistoryQtyEdit(e.target);
      e.target.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commitHistoryQtyEdit(e.target);
      e.target.blur();
    }
  });

  function discardPendingQuantityEdit(scan) {
    const identity = scanIdentity(scan);
    if (!identity) return;
    const record = pendingQuantityEdits.get(identity.scanKey);
    if (!record) return;
    pendingQuantityEdits.delete(identity.scanKey);
    void removePendingQuantityEditFromStorage(record);
  }

  function deleteHistoryScan(seq) {
    const index = scanLog.findIndex(s => s.seq === seq);
    if (index === -1) return;
    const entry = scanLog[index];
    if (entry.status === 'found') applyScanQuantityToModels(items, entry, 0);
    sessionQuantityRevision += 1;
    discardPendingQuantityEdit(entry);
    deleteScanFromApi(entry);
    scanLog.splice(index, 1);
    exported = false;
    refreshQuantityViews({ history: true });
    enqueueSaveSession();
    showToast('Scan deleted', 'success');
  }

  document.getElementById('historyBody').addEventListener('click', (e) => {
    const button = e.target.closest('.history-delete');
    if (button) deleteHistoryScan(parseInt(button.dataset.seq, 10));
  });

document.getElementById('batchFilter').addEventListener('change', () => { renderHistory(); renderBoxFolders(); });
document.getElementById('historySearch').addEventListener('input', () => { renderHistory(); renderBoxFolders(); });

  document.getElementById('exportHistoryBtn').addEventListener('click', () => {
    if (!ensureXlsx()) return;
    const foundScans = scanLog.filter(s => s.status === 'found');

    const operatorSet = new Set();
    foundScans.forEach(s => operatorSet.add(s.operator || 'Unassigned'));
    const operators = [...operatorSet].sort((a, b) => a.localeCompare(b));

    const groupedRows = new Map();
    foundScans.forEach(s => {
      const sourceItem = items.find(it =>
        it.itemNumberDisplay === s.itemNumber &&
        it.serialDisplay === s.serial &&
        it.desc === s.desc
      );
      const division = s.division || (sourceItem ? sourceItem.division : '');
      const key = JSON.stringify([division, s.itemNumber, s.desc, s.serial]);
      if (!groupedRows.has(key)) {
        const row = {
          division_name: spreadsheetValue(division),
          item_number: spreadsheetValue(s.itemNumber),
          item_desc: spreadsheetValue(s.desc),
          lot_serial_no: spreadsheetValue(s.serial),
          qty: 0
        };
        operators.forEach(op => { row[op] = 0; });
        groupedRows.set(key, row);
      }
      const row = groupedRows.get(key);
      const op = s.operator || 'Unassigned';
      const quantity = Number.isFinite(Number(s.qty)) ? Number(s.qty) : 1;
      row[op] = (row[op] || 0) + quantity;
      row.qty += quantity;
    });

    const rows = [...groupedRows.values()];
    const header = ['division_name','item_number','item_desc','lot_serial_no','qty', ...operators];
    const ws = XLSX.utils.json_to_sheet(rows, { header });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Scan Summary');
    try {
      downloadWorkbook(wb, 'ScanSummary_' + new Date().toISOString().slice(0,10) + '.xlsx');
    } catch (error) {
      console.error(error);
      showToast('The Scan Summary could not be downloaded.', 'error');
    }
  });

  document.getElementById('printBtn').addEventListener('click', () => {
    const rows = getFilteredHistory();
    document.getElementById('printTitle').textContent = 'Scan History — ' + (fileName || 'Audit');
    const batchVal = document.getElementById('batchFilter').value;
    document.getElementById('printMeta').textContent = (batchVal ? ('Batch: ' + batchVal + ' · ') : '') + rows.length + ' scans';
    document.getElementById('printBody').innerHTML = rows.map(s => {
      const statusLabel = s.status === 'found' ? 'Found' : (s.status === 'notfound' ? 'Not found' : 'Duplicate');
      const qty = s.status === 'found' ? (s.qty != null ? s.qty : 1) : 0;
      return '<tr><td>' + s.seq + '</td><td>' + escapeHtml(s.batch) + '</td><td>' + escapeHtml(s.code) + '</td><td>' + escapeHtml(s.desc || '-') + '</td><td>' + qty + '</td><td>' + statusLabel + '</td></tr>';
    }).join('');
    window.print();
  });

  /* ==================== DASHBOARD NAVIGATION ==================== */

  // Get dashboard elements
  const dashboardStage = document.getElementById('dashboardStage');
  const backToDrop = document.getElementById('backToDrop');
  const auditBackBtn = document.getElementById('auditBackBtn');
  const sidebarItems = document.querySelectorAll('.sidebar-item:not(.sidebar-logout)');
  const dashboardSections = document.querySelectorAll('.dashboard-section');
  const sectionTitle = document.getElementById('sectionTitle');
  const breadcrumbCurrent = document.getElementById('breadcrumbCurrent');

  // Section titles mapping (all-caps page heading + a friendlier Title Case
  // label for the breadcrumb trail next to it).
  const sectionTitles = {
    'pos-digital': 'POS DIGITAL',
    'blip': 'BLIP',
    'nirinsha': 'NIRINSHA',
    'tlpj': 'TLPJ',
    'no-records': 'NO RECORD ATTACHMENT',
    'initial-findings': 'INITIAL FINDINGS',
    'final-findings': 'FINAL FINDINGS',
    'manage-users': 'USER MANAGEMENT'
  };
  const sectionBreadcrumbs = {
    'pos-digital': 'POS Digital',
    'blip': 'BLIP',
    'nirinsha': 'Nirinsha',
    'tlpj': 'TLPJ',
    'no-records': 'No Record Attachment',
    'initial-findings': 'Initial Findings',
    'final-findings': 'Final Findings',
    'manage-users': 'User Management'
  };

  // Shows exactly one of the three top-level stages at a time (dashboard,
  // the upload dropzone, or the live scanning screen), so switching between
  // them never leaves a previous stage visible underneath.
  let currentTopLevelStage = null;

  function showStage(stage) {
    dashboardStage.style.display = stage === 'dashboard' ? 'flex' : 'none';
    dropStage.style.display = stage === 'drop' ? 'block' : 'none';
    auditStage.style.display = stage === 'audit' ? 'block' : 'none';
    if (stage !== currentTopLevelStage) {
      const enteringStage = stage === 'dashboard' ? dashboardStage : stage === 'drop' ? dropStage : auditStage;
      enteringStage.classList.remove('stage-enter');
      void enteringStage.offsetWidth;
      enteringStage.classList.add('stage-enter');
      currentTopLevelStage = stage;
    }
    if (stage === 'audit') switchWorkstationTab('scan');
  }

  // Toggles between the Scan (live scanning workstation), Inventory (item
  // summary), and No Record (logged no-record entries) tabs within the
  // audit stage.
  const workstationTabs = document.getElementById('workstationTabs');
  const tabPanelScan = document.getElementById('tabPanelScan');
  const tabPanelInventory = document.getElementById('tabPanelInventory');
  const tabPanelNoRecord = document.getElementById('tabPanelNoRecord');
  function switchWorkstationTab(tab) {
    tabPanelScan.style.display = tab === 'scan' ? 'block' : 'none';
    tabPanelInventory.style.display = tab === 'inventory' ? 'block' : 'none';
    tabPanelNoRecord.style.display = tab === 'norecord' ? 'block' : 'none';
    workstationTabs.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    if (tab === 'scan') focusScanInput();
  }

  const dashboardRouteSections = new Set([
    'pos-digital', 'blip', 'nirinsha', 'tlpj', 'no-records',
    'initial-findings', 'final-findings', 'manage-users'
  ]);

  function setBrowserPath(path, { replace = false } = {}) {
    if (window.location.pathname === path) return;
    window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
  }

  function navigateToUpload({ replace = false } = {}) {
    showStage('drop');
    setBrowserPath('/upload', { replace });
  }

  function navigateToDashboard(section = 'pos-digital', { replace = false } = {}) {
    const safeSection = dashboardRouteSections.has(section) ? section : 'pos-digital';
    showStage('dashboard');
    switchSection(safeSection);
    setBrowserPath(safeSection === 'pos-digital' ? '/dashboard' : '/dashboard/' + safeSection, { replace });
  }

  function navigateToAudit(tab = 'scan', { replace = false } = {}) {
    const safeTab = ['scan', 'inventory', 'norecord'].includes(tab) ? tab : 'scan';
    // Audit views require an active session; a direct URL without one should
    // lead the user to the upload screen instead of rendering empty controls.
    if (!sessionId) {
      navigateToUpload({ replace });
      return;
    }
    showStage('audit');
    switchWorkstationTab(safeTab);
    setBrowserPath(safeTab === 'norecord' ? '/audit/no-records' : '/audit/' + safeTab, { replace });
  }

  function applyBrowserRoute() {
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/upload') return navigateToUpload({ replace: true });
    if (path === '/audit/scan') return navigateToAudit('scan', { replace: true });
    if (path === '/audit/inventory') return navigateToAudit('inventory', { replace: true });
    if (path === '/audit/no-records') return navigateToAudit('norecord', { replace: true });
    if (path === '/dashboard' || path === '/') return navigateToDashboard('pos-digital', { replace: true });
    const dashboardMatch = path.match(/^\/dashboard\/([a-z-]+)$/);
    if (dashboardMatch && dashboardRouteSections.has(dashboardMatch[1])) {
      return navigateToDashboard(dashboardMatch[1], { replace: true });
    }
    // The backend serves the SPA shell for unknown paths. Normalize those
    // paths once instead of recursively reprocessing the same URL forever.
    return navigateToDashboard('pos-digital', { replace: true });
  }

  window.addEventListener('popstate', applyBrowserRoute);

  workstationTabs.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateToAudit(btn.dataset.tab));
  });

  // Function to navigate between dashboard sections
  function switchSection(sectionId) {
    if (sectionId === 'manage-users' && !isAdminUser()) {
      showToast('Only admin accounts can open User Management.', 'error');
      return;
    }

    // Update active sidebar item
    sidebarItems.forEach(item => {
      if (item.dataset.section === sectionId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    // Update active section
    dashboardSections.forEach(section => {
      if (section.id === `section-${sectionId}`) {
        section.classList.add('active');
      } else {
        section.classList.remove('active');
      }
    });

    // Update section title + breadcrumb
    sectionTitle.textContent = sectionTitles[sectionId] || 'Dashboard';
    if (breadcrumbCurrent) breadcrumbCurrent.textContent = sectionBreadcrumbs[sectionId] || 'Dashboard';
    closeAllFolderMenus();
    if (sectionId === 'manage-users') loadManagedUsers();
  }

  // Add event listeners to sidebar items
  sidebarItems.forEach(item => {
    item.addEventListener('click', (event) => {
      // These controls only change a dashboard panel. Explicitly suppress a
      // form submission if the page is ever embedded inside a form.
      event.preventDefault();
      const sectionId = item.dataset.section;
      navigateToDashboard(sectionId);
    });
  });

  // Back to upload button
  backToDrop.addEventListener('click', () => {
    navigateToUpload();
  });

  auditBackBtn.addEventListener('click', () => navigateToDashboard());
  // Folder and file management for dashboard sections
  let folders = {
    'pos-digital': [],
    'blip': [],
    'nirinsha': [],
    'tlpj': []
  };

  function folderFiles(folder) {
    if (Array.isArray(folder.files)) return folder.files;
    return folder.sessionId ? [{ sessionId: folder.sessionId, fileName: folder.fileName, itemCount: folder.itemCount || 0 }] : [];
  }

  function syncFolderPrimaryFile(folder) {
    folder.files = folderFiles(folder);
    const primary = folder.files[0];
    folder.sessionId = primary ? primary.sessionId : null;
    folder.fileName = primary ? primary.fileName : null;
    folder.itemCount = primary ? primary.itemCount : 0;
  }

  function folderStatusLine(folder) {
    const files = folderFiles(folder);
    if (!files.length) return 'No file yet';
    return files.length + (files.length === 1 ? ' file' : ' files');
  }

  /* ---------------- shared folder-card building blocks ----------------
     One card look, used both here (spreadsheet folders) and by the
     attachment-folder system further down (photo/file folders), so every
     dashboard section shares the same professional card grid. */
  function closeAllFolderMenus() {
    document.querySelectorAll('.folder-menu-dropdown').forEach(menu => menu.remove());
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('.folder-card-menu-wrap')) closeAllFolderMenus();
  });
  document.addEventListener('scroll', closeAllFolderMenus, true);

  function folderIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>';
  }
  function fileIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>';
  }
  function trashIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  }

  // A single row for a file inside an expanded folder card.
  function buildFileRow({ name, meta, onOpen, onContextMenu, extraClass }) {
    const row = document.createElement('div');
    row.className = 'file-explorer-entry' + (extraClass ? ' ' + extraClass : '');
    row.title = 'Click to open. Right-click for options.';
    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.innerHTML = fileIconSvg();
    const details = document.createElement('div');
    details.className = 'file-details';
    const nameEl = document.createElement('div');
    nameEl.className = 'file-name';
    nameEl.textContent = name;
    const metaEl = document.createElement('div');
    metaEl.className = 'file-meta';
    metaEl.textContent = meta;
    details.append(nameEl, metaEl);
    row.append(icon, details);
    if (onOpen) row.addEventListener('click', onOpen);
    if (onContextMenu) row.addEventListener('contextmenu', event => { event.preventDefault(); onContextMenu(event); });
    return row;
  }

  // One folder card: icon + name + meta opens the folder into the panel's
  // detail view (replacing the grid, like navigating into the folder), and
  // a "⋮" menu carries folder-level actions (add file, remove, etc.).
  function buildFolderCard({ name, meta, menuActions, onOpen }) {
    const card = document.createElement('div');
    card.className = 'folder-card';

    const menuWrap = document.createElement('div');
    menuWrap.className = 'folder-card-menu-wrap';
    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'folder-card-menu';
    menuBtn.setAttribute('aria-label', 'Folder options');
    menuBtn.setAttribute('aria-haspopup', 'true');
    menuBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
    menuBtn.addEventListener('click', event => {
      event.stopPropagation();
      const wasOpen = Boolean(menuWrap.querySelector('.folder-menu-dropdown'));
      closeAllFolderMenus();
      if (wasOpen) return;
      const dropdown = document.createElement('div');
      dropdown.className = 'folder-menu-dropdown';
      menuActions.forEach(action => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'folder-menu-item' + (action.danger ? ' danger' : '');
        item.innerHTML = action.icon + '<span>' + escapeHtml(action.label) + '</span>';
        item.addEventListener('click', async event2 => {
          event2.stopPropagation();
          closeAllFolderMenus();
          await action.onClick();
        });
        dropdown.appendChild(item);
      });
      menuWrap.appendChild(dropdown);
    });
    menuWrap.appendChild(menuBtn);

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'folder-card-open';
    const iconEl = document.createElement('div');
    iconEl.className = 'folder-card-icon';
    iconEl.innerHTML = folderIconSvg();
    const nameEl = document.createElement('div');
    nameEl.className = 'folder-card-name';
    nameEl.textContent = name;
    const metaEl = document.createElement('div');
    metaEl.className = 'folder-card-meta';
    metaEl.textContent = meta;
    openBtn.append(iconEl, nameEl, metaEl);
    openBtn.addEventListener('click', onOpen);

    card.append(menuWrap, openBtn);
    return card;
  }

  function folderEmptyState(filesDiv) {
    filesDiv.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'folder-empty';
    empty.innerHTML = `<div class="empty-icon">${folderIconSvg()}</div><p>No folders yet</p>`;
    filesDiv.appendChild(empty);
  }

  // Opening a folder swaps the grid+toggle out for a drill-down view inside
  // the same folders-panel (title + back button + that folder's contents),
  // rather than expanding the card in place — closer to opening a new page
  // than a dropdown. `contentBuilder` is called fresh both on open and any
  // time the panel re-renders while that folder stays open (e.g. after
  // adding a file), so it always reflects current data.
  function showFolderDetail(gridEl, folder, contentBuilder) {
    const panel = gridEl.closest('.folders-panel');
    if (!panel) return;
    const head = panel.querySelector('.folders-panel-head');
    const detail = panel.querySelector('.folder-detail');
    const titleEl = panel.querySelector('.folder-detail-title');
    const bodyEl = panel.querySelector('.folder-detail-body');
    const section = panel.closest('.dashboard-section');
    const tip = section && section.querySelector('.tip-banner');
    if (!detail || !titleEl || !bodyEl) return;
    detail.dataset.openFolderId = folder.id;
    titleEl.textContent = folder.name;
    bodyEl.innerHTML = '';
    bodyEl.appendChild(contentBuilder());
    if (head) head.hidden = true;
    if (tip) tip.hidden = true;
    gridEl.hidden = true;
    detail.hidden = false;
  }

  document.addEventListener('click', event => {
    const backBtn = event.target.closest('.folder-detail-back');
    if (!backBtn) return;
    const panel = backBtn.closest('.folders-panel');
    if (!panel) return;
    const head = panel.querySelector('.folders-panel-head');
    const grid = panel.querySelector('.folder-grid');
    const detail = panel.querySelector('.folder-detail');
    const section = panel.closest('.dashboard-section');
    const tip = section && section.querySelector('.tip-banner');
    if (head) head.hidden = false;
    if (grid) grid.hidden = false;
    if (tip) tip.hidden = false;
    if (detail) { detail.hidden = true; delete detail.dataset.openFolderId; }
  });

  // Function to render folders and upload interface
  function renderFolders(section) {
    const filesDiv = document.querySelector(`#section-${section} .uploaded-files-list`);
    if (!filesDiv) return;
    const panel = filesDiv.closest('.folders-panel');
    const detailEl = panel && panel.querySelector('.folder-detail');
    filesDiv.hidden = false;

    if (folders[section].length === 0) { folderEmptyState(filesDiv); return; }

    filesDiv.innerHTML = '';
    const visible = folders[section]
      .map((folder, index) => ({ folder, index }));

    if (!visible.length) { folderEmptyState(filesDiv); return; }

    function buildDetailContent(index, folder) {
      const wrap = document.createElement('div');
      const files = folderFiles(folder);
      if (!files.length) {
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'btn secondary';
        addBtn.textContent = 'Add File';
        addBtn.addEventListener('click', () => addFileToFolder(section, index));
        wrap.appendChild(addBtn);
      } else {
        const addFileButton = document.createElement('button');
        addFileButton.type = 'button';
        addFileButton.className = 'btn secondary';
        addFileButton.textContent = '+ Add File';
        addFileButton.addEventListener('click', () => addFileToFolder(section, index));
        wrap.appendChild(addFileButton);

        files.forEach((file, fileIndex) => {
          const row = buildFileRow({
            name: file.fileName || 'file',
            meta: (file.itemCount || 0) + ' SKUs loaded',
            extraClass: 'pos-blip-subfolder',
            onOpen: () => openFolderSession(section, index, fileIndex),
            onContextMenu: event => showFileContextMenu(event.clientX, event.clientY, folder, section, index, fileIndex)
          });
          wrap.appendChild(row);
        });
      }
      return wrap;
    }

    visible.forEach(({ folder, index }) => {
      const card = buildFolderCard({
        name: folder.name,
        meta: folderStatusLine(folder),
        onOpen: () => showFolderDetail(filesDiv, folder, () => buildDetailContent(index, folder)),
        menuActions: [
          { label: 'Add File', icon: fileIconSvg(), onClick: () => addFileToFolder(section, index) },
          { label: 'Remove Folder', icon: trashIconSvg(), danger: true, onClick: async () => {
              if (!confirm('Remove folder "' + folder.name + '"? This also deletes any scan data saved inside it.')) return;
              const [removed] = folders[section].splice(index, 1);
              renderFolders(section);
              if (removed) {
                await removeFolderRecord(removed.id);
                await Promise.all(folderFiles(removed).map(file => deleteSession(file.sessionId)));
              }
            } }
        ]
      });
      filesDiv.appendChild(card);
    });

    // If this folder was already open (e.g. we just re-rendered after
    // adding a file to it), stay on its detail view with fresh content
    // instead of dropping the person back to the grid.
    if (detailEl && detailEl.dataset.openFolderId) {
      const reopenIndex = folders[section].findIndex(f => f.id === detailEl.dataset.openFolderId);
      if (reopenIndex === -1) {
        detailEl.hidden = true;
        delete detailEl.dataset.openFolderId;
      } else {
        const folder = folders[section][reopenIndex];
        showFolderDetail(filesDiv, folder, () => buildDetailContent(reopenIndex, folder));
      }
    }
  }

  // Create a new folder
  async function createFolder(section) {
    const folderName = prompt('Enter folder name:');
    if (folderName && folderName.trim()) {
      const folder = await createFolderRecord(section, folderName.trim());
      if (!folder) { showToast('Could not create that folder.', 'error'); return; }
      folders[section].push(folder);
      renderFolders(section);
    }
  }

  // Opens a file picker, parses the chosen spreadsheet, and saves it as a
  // dedicated scan session tied to this folder (separate from every other
  // folder and from the main audit flow).
  function addFileToFolder(section, index, replaceFileIndex = null) {
    const folder = folders[section][index];
    if (!folder) return;
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.name = 'folderSpreadsheetFile';
    picker.accept = '.xlsx,.xls,.csv';
    picker.style.display = 'none';
    document.body.appendChild(picker);
    picker.addEventListener('change', () => {
      const file = picker.files[0];
      document.body.removeChild(picker);
      if (!file) return;
      parseSpreadsheetFile(file, async (parsedItems) => {
        const files = folderFiles(folder);
        const oldFile = replaceFileIndex === null ? null : files[replaceFileIndex];
        const newSessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const payload = {
          sessionId: newSessionId,
          folderId: folder.id,
          fileName: file.name,
          items: parsedItems,
          scanLog: [],
          notFoundCount: 0,
          batchName: 'Box 1',
          scannerName: currentScannerName(),
          savedAt: Date.now()
        };
        const ok = await saveSessionRecord(payload);
        if (!ok) { showToast('Could not save that file. Please try again.', 'error'); return; }
        let savedFile;
        try {
          savedFile = await uploadFolderSpreadsheet(folder.id, file, newSessionId, parsedItems.length);
        } catch (error) {
          await deleteSession(newSessionId);
          showToast('The spreadsheet could not be uploaded to the server.', 'error');
          return;
        }
        if (savedFile === false) {
          showToast('The spreadsheet is saved locally, but its upload retry could not be queued. Keep this browser open and export a backup.', 'error');
          return;
        }
        if (oldFile?.sessionId) await deleteSession(oldFile.sessionId);
        savedFile ||= { sessionId: newSessionId, fileName: file.name, itemCount: parsedItems.length, updatedAt: Date.now(), _pendingUpload: true };
        if (oldFile) files.splice(replaceFileIndex, 1, savedFile);
        else files.push(savedFile);
        folder.files = files;
        syncFolderPrimaryFile(folder);
        folder.updatedAt = Date.now();
        await saveFolderRecord(folder);
        renderFolders(section);
        showToast('Added ' + file.name + ' to "' + folder.name + '"', 'success');
      });
    });
    picker.click();
  }

  // Loads a folder's saved scan session into the shared scanning screen,
  // giving that folder its own progress, stats, and results table.
  async function openFolderSession(section, index, fileIndex = 0) {
    const folder = folders[section][index];
    const file = folder && folderFiles(folder)[fileIndex];
    if (!file || !file.sessionId) return;
    if (!signedInUser) return;
    let s;
    if (apiAvailable) {
      try {
        const result = await requestApi('/audit-sessions/' + encodeURIComponent(file.sessionId));
        s = result.session;
        await storageSafe(() => saveDatabaseSession(s), false);
      } catch (error) {
        if (!useOfflineFallback(error)) { showToast('Could not load that file\'s data.', 'error'); return; }
      }
    }
    if (!s) {
      const sessions = await getSessionRecords();
      s = sessions.find(session => session.sessionId === file.sessionId);
    }
    if (!s) { showToast('Could not find that file\'s data. Try re-adding it.', 'error'); return; }
    loadSessionIntoUI(s);
    showToast('Scanning "' + folder.name + '"', 'success');
  }

  function hideFileContextMenu() {
    const menu = document.getElementById('fileContextMenu');
    if (menu) menu.remove();
  }

  function showFileContextMenu(x, y, folder, section, index, fileIndex) {
    hideFileContextMenu();
    const file = folderFiles(folder)[fileIndex];
    if (!file) return;
    const menu = document.createElement('div');
    menu.id = 'fileContextMenu';
    menu.className = 'context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const actions = [
      ['Open', () => openFolderSession(section, index, fileIndex)],
      ['Delete', async () => {
        if (!confirm('Delete "' + (file.fileName || 'this file') + '"?')) return;
        const files = folderFiles(folder);
        files.splice(fileIndex, 1);
        folder.files = files;
        syncFolderPrimaryFile(folder);
        folder.updatedAt = Date.now();
        if (file.sessionId) await deleteSession(file.sessionId);
        await saveFolderRecord(folder);
        renderFolders(section);
      }],
      ['Replace File', () => addFileToFolder(section, index, fileIndex)],
      ['Copy', async () => {
        try {
          await navigator.clipboard.writeText(file.fileName || '');
          showToast('File name copied', 'success');
        } catch (error) {
          showToast('Could not copy the file name', 'error');
        }
      }],
      ['Properties', () => {
        const modified = folder.updatedAt ? new Date(folder.updatedAt).toLocaleString() : 'Unknown';
        alert('Name: ' + (file.fileName || 'Unknown') + '\nType: Spreadsheet\nItems: ' + (file.itemCount || 0) + '\nLast modified: ' + modified);
      }]
    ];

    actions.forEach(([label, handler]) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'context-menu-item';
      item.textContent = label;
      item.addEventListener('click', async () => {
        hideFileContextMenu();
        await handler();
      });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);
    requestAnimationFrame(() => {
      const bounds = menu.getBoundingClientRect();
      if (bounds.right > window.innerWidth) menu.style.left = Math.max(8, window.innerWidth - bounds.width - 8) + 'px';
      if (bounds.bottom > window.innerHeight) menu.style.top = Math.max(8, window.innerHeight - bounds.height - 8) + 'px';
    });
  }

  document.addEventListener('click', event => {
    if (!event.target.closest('#fileContextMenu')) hideFileContextMenu();
  });
  document.addEventListener('scroll', hideFileContextMenu, true);

  // Loads every saved folder (and its section) from local storage so
  // folders and their attached files survive a page reload.
  async function loadFoldersFromStorage(contextGeneration = accountContextGeneration) {
    const records = await loadFolderRecords();
    if (contextGeneration !== accountContextGeneration || !signedInUser) return;
    folders = { 'pos-digital': [], 'blip': [], 'nirinsha': [], 'tlpj': [] };
    records.forEach(f => {
      if (!folders[f.section]) folders[f.section] = [];
      f.files = folderFiles(f);
      syncFolderPrimaryFile(f);
      folders[f.section].push(f);
    });
    renderFolders('pos-digital');
    renderFolders('blip');
    renderFolders('nirinsha');
    renderFolders('tlpj');
  }

  let signedInDataLoad = Promise.resolve();
  const appSkeleton = document.getElementById('appSkeleton');
  const SKELETON_MINIMUM_MS = 420;

  function showAppSkeleton() {
    if (!appSkeleton) return;
    appSkeleton.hidden = false;
    appSkeleton.classList.add('is-visible');
  }

  function hideAppSkeleton(startedAt) {
    if (!appSkeleton) return Promise.resolve();
    const remaining = Math.max(0, SKELETON_MINIMUM_MS - (Date.now() - startedAt));
    return new Promise(resolve => {
      setTimeout(() => {
        appSkeleton.classList.remove('is-visible');
        setTimeout(() => {
          appSkeleton.hidden = true;
          resolve();
        }, 170);
      }, remaining);
    });
  }

  function loadSignedInData() {
    const contextGeneration = accountContextGeneration;
    const startedAt = Date.now();
    showAppSkeleton();
    signedInDataLoad = signedInDataLoad.then(async () => {
      if (contextGeneration !== accountContextGeneration || !signedInUser) return;
      await requestPendingMutationSync({ recoverApi: true });
      if (contextGeneration !== accountContextGeneration || !signedInUser) return;
      await checkForResumableSessions(contextGeneration);
      if (contextGeneration !== accountContextGeneration || !signedInUser) return;
      await loadFoldersFromStorage(contextGeneration);
      if (contextGeneration !== accountContextGeneration || !signedInUser) return;
      await Promise.all(attachmentFolderApis.map(api => api.load(contextGeneration)));
    }).catch(() => {}).finally(() => {
      if (contextGeneration === accountContextGeneration) return hideAppSkeleton(startedAt);
      return undefined;
    });
    return signedInDataLoad;
  }

  // No-record scans: item/serial number + description + actual count,
  // logged from the "No Records" button in the Active Workstation. These
  // are manual entries for items that have no matching record at all, so
  // they're kept separate from the No Record Attachment photo folders.
  const noRecordForm = document.getElementById('noRecordForm');
  const noRecordCodeInput = document.getElementById('noRecordCode');
  const noRecordDescriptionInput = document.getElementById('noRecordDescription');
  const noRecordActualCountInput = document.getElementById('noRecordActualCount');
  const noRecordEntriesList = document.getElementById('noRecordEntries');
  const noRecordScansCount = document.getElementById('noRecordScansCount');
  let noRecordEntries = [];
  let pendingNoRecordDeletes = [];

  function renderNoRecordEntries() {
    noRecordEntriesList.innerHTML = '';
    if (noRecordScansCount) {
      noRecordScansCount.textContent = noRecordEntries.length ? '(' + noRecordEntries.length + ')' : '';
    }
    const noRecordTabBadge = document.getElementById('noRecordTabBadge');
    if (noRecordTabBadge) {
      noRecordTabBadge.textContent = noRecordEntries.length ? String(noRecordEntries.length) : '';
    }
    updateNotifications();

    if (!noRecordEntries.length) return;

    noRecordEntries.forEach((entry, index) => {
      const row = document.createElement('div');
      row.className = 'norecord-columns norecord-row';

      const codeCell = document.createElement('div');
      codeCell.className = 'norecord-cell';
      codeCell.textContent = entry.code;

      const descCell = document.createElement('div');
      descCell.className = 'norecord-cell';
      descCell.textContent = entry.description;

      const countCell = document.createElement('div');
      countCell.className = 'norecord-cell';
      countCell.textContent = String(entry.actualCount);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'norecord-remove-btn';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', async () => {
        const [removedEntry] = noRecordEntries.splice(index, 1);
        if (removedEntry && !pendingNoRecordDeletes.includes(removedEntry.id)) pendingNoRecordDeletes.push(removedEntry.id);
        await enqueueSaveSession({ immediate: true });
        renderNoRecordEntries();
        showToast('No record scan removed', 'success');
      });

      row.append(codeCell, descCell, countCell, removeBtn);
      noRecordEntriesList.appendChild(row);
    });
  }

  noRecordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = noRecordCodeInput.value.trim();
    const description = noRecordDescriptionInput.value.trim();
    const actualCountRaw = noRecordActualCountInput.value;

    const actualCount = Number(actualCountRaw);
    if (!code || !description || actualCountRaw === '' || !Number.isFinite(actualCount)) {
      showToast('Fill in item/serial number, description, and actual count', 'error');
      return;
    }

    noRecordEntries.push({
      id: 'norecord_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      code,
      description,
      actualCount,
      createdAt: Date.now()
    });

    await enqueueSaveSession({ immediate: true });
    renderNoRecordEntries();
    closeNoRecordsDialog({ restoreFocus: false });
    showToast('No record scan logged', 'success');
  });

  /* ==================== SHARED ATTACHMENT FOLDER API ====================
     One reusable "create a folder, attach files inside it" system, used by
     every dashboard section that just needs simple folder + file storage:
     No Record Attachment (photos), Initial Findings, and Final Findings
     (any file type). Each instance keeps its own folder list, persisted to
     IndexedDB under its own storage key, with files stored as base64 data
     URLs so they survive a reload — unlike the old photo-only version,
     which lost everything on refresh.
  */
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function createAttachmentFolderApi(containerId, storageKey, opts) {
    const options = Object.assign({ accept: '*', multiple: true, kind: 'file', emptyHint: 'Create a folder to attach files.' }, opts || {});
    const container = document.getElementById(containerId);
    let folders = [];

    async function persist() {
      const contextGeneration = accountContextGeneration;
      try {
        const saved = await saveAttachmentCollection(storageKey, folders);
        if (contextGeneration !== accountContextGeneration) return false;
        if (!saved) showToast('Attachments could not be saved. Your changes remain in this browser; try again when the service is available.', 'error');
        return saved;
      } catch (error) {
        if (contextGeneration !== accountContextGeneration) return false;
        showToast(error.message || 'Attachments could not be saved. Please try again.', 'error');
        return false;
      }
    }

    async function create() {
      const contextGeneration = accountContextGeneration;
      const name = prompt('Enter a folder name:');
      if (!name || !name.trim()) return;
      folders.push({ id: 'folder_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), name: name.trim(), files: [] });
      await persist();
      if (contextGeneration !== accountContextGeneration) return;
      render();
    }

    function render() {
      const panel = container.closest('.folders-panel');
      const detailEl = panel && panel.querySelector('.folder-detail');
      container.hidden = false;

      if (!folders.length) { folderEmptyState(container); return; }
      container.innerHTML = '';
      const fileWord = options.kind === 'photo' ? 'photo' : 'file';

      function buildDetailContent(folder, index) {
        const wrap = document.createElement('div');
        const attachButton = document.createElement('button');
        attachButton.type = 'button';
        attachButton.className = 'btn secondary';
        attachButton.textContent = options.kind === 'photo' ? 'Attach Photos' : 'Attach Files';
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.name = 'attachmentFiles';
        picker.accept = options.accept;
        picker.multiple = options.multiple;
        picker.hidden = true;
        attachButton.addEventListener('click', () => picker.click());
        picker.addEventListener('change', async () => {
          const contextGeneration = accountContextGeneration;
          const chosen = Array.from(picker.files);
          picker.value = '';
          if (!chosen.length) return;
          const encoded = await Promise.all(chosen.map(async file => ({
            name: file.name,
            type: file.type,
            size: file.size,
            url: await fileToDataUrl(file)
          })));
          if (contextGeneration !== accountContextGeneration) return;
          folder.files.push(...encoded);
          await persist();
          if (contextGeneration !== accountContextGeneration) return;
          render();
        });
        wrap.append(attachButton, picker);

        if (folder.files.length) {
          if (options.kind === 'photo') {
            const grid = document.createElement('div');
            grid.className = 'photo-grid';
            grid.style.marginTop = '12px';
            const photoFiles = folder.files.filter(item => (item.type || '').startsWith('image/'));
            folder.files.forEach((file, fileIndex) => {
              if ((file.type || '').startsWith('image/')) {
                const figure = document.createElement('figure');
                figure.className = 'photo-card';
                figure.title = 'Click to view, copy, or download';
                const image = document.createElement('img');
                image.src = file.url;
                image.alt = file.name;
                const caption = document.createElement('figcaption');
                caption.textContent = file.name;
                figure.append(image, caption);
                figure.addEventListener('click', () => openImageLightbox(photoFiles, photoFiles.indexOf(file)));
                figure.addEventListener('contextmenu', event => {
                  event.preventDefault();
                  if (confirm('Remove "' + file.name + '"?')) {
                    const contextGeneration = accountContextGeneration;
                    folder.files.splice(fileIndex, 1);
                    persist().then(() => { if (contextGeneration === accountContextGeneration) render(); });
                  }
                });
                grid.appendChild(figure);
              } else {
                grid.appendChild(buildFileRow({
                  name: file.name,
                  meta: 'Right-click to remove',
                  onOpen: () => {
                    const link = document.createElement('a');
                    link.href = file.url;
                    link.download = file.name;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                  },
                  onContextMenu: () => {
                    if (!confirm('Remove "' + file.name + '"?')) return;
                    const contextGeneration = accountContextGeneration;
                    folder.files.splice(fileIndex, 1);
                    persist().then(() => { if (contextGeneration === accountContextGeneration) render(); });
                  }
                }));
              }
            });
            wrap.appendChild(grid);
          } else {
            folder.files.forEach((file, fileIndex) => {
              const row = buildFileRow({
                name: file.name,
                meta: 'Right-click to remove',
                onOpen: () => {
                  if (options.confirmDownloads && !confirm('Download "' + file.name + '"?')) return;
                  const link = document.createElement('a');
                  link.href = file.url;
                  link.download = file.name;
                  document.body.appendChild(link);
                  link.click();
                  link.remove();
                },
                onContextMenu: () => {
                  if (!confirm('Remove "' + file.name + '"?')) return;
                  const contextGeneration = accountContextGeneration;
                  folder.files.splice(fileIndex, 1);
                  persist().then(() => { if (contextGeneration === accountContextGeneration) render(); });
                }
              });
              wrap.appendChild(row);
            });
          }
        }
        return wrap;
      }

      folders.forEach((folder, index) => {
        const card = buildFolderCard({
          name: folder.name,
          meta: folder.files.length + ' ' + fileWord + (folder.files.length === 1 ? '' : 's'),
          onOpen: () => showFolderDetail(container, folder, () => buildDetailContent(folder, index)),
          menuActions: [
            { label: options.kind === 'photo' ? 'Attach Photos' : 'Attach Files', icon: fileIconSvg(), onClick: () => {
                showFolderDetail(container, folder, () => buildDetailContent(folder, index));
                container.closest('.folders-panel').querySelector('.folder-detail-body input[type="file"]')?.click();
            } },
            { label: 'Remove Folder', icon: trashIconSvg(), danger: true, onClick: async () => {
                if (!confirm('Remove folder "' + folder.name + '"? This also deletes its attached files.')) return;
                const contextGeneration = accountContextGeneration;
                folders.splice(index, 1);
                await persist();
                if (contextGeneration !== accountContextGeneration) return;
                render();
              } }
          ]
        });
        container.appendChild(card);
      });

      // Stay on the open folder's detail view across a re-render (e.g.
      // right after attaching or removing a file) instead of bouncing back
      // to the grid.
      if (detailEl && detailEl.dataset.openFolderId) {
        const reopenIndex = folders.findIndex(f => f.id === detailEl.dataset.openFolderId);
        if (reopenIndex === -1) {
          detailEl.hidden = true;
          delete detailEl.dataset.openFolderId;
        } else {
          const folder = folders[reopenIndex];
          showFolderDetail(container, folder, () => buildDetailContent(folder, reopenIndex));
        }
      }
    }

    async function load(contextGeneration = accountContextGeneration) {
      const loadedFolders = (await getAttachmentCollection(storageKey)) || [];
      if (contextGeneration !== accountContextGeneration || !signedInUser) return;
      folders = loadedFolders;
      render();
    }

    function clear() {
      folders = [];
      render();
    }

    return { render, load, create, clear, containerId };
  }

  const attachmentFolderApis = [
    createAttachmentFolderApi('noRecordsFolders', 'noRecordFolders', {
      accept: 'image/*', multiple: true, kind: 'photo',
      emptyHint: 'Create a folder to attach no-record photos.'
    }),
    createAttachmentFolderApi('initialFindingsFolders', 'initialFindingsFolders', {
      accept: '*', multiple: true, kind: 'file',
      emptyHint: 'Create a folder to attach initial findings files.',
      confirmDownloads: true
    }),
    createAttachmentFolderApi('finalFindingsFolders', 'finalFindingsFolders', {
      accept: '*', multiple: true, kind: 'file',
      emptyHint: 'Create a folder to attach final findings files.',
      confirmDownloads: true
    })
  ];

  function resetFolderDetailViews() {
    document.querySelectorAll('.folders-panel').forEach(panel => {
      const head = panel.querySelector('.folders-panel-head');
      const grid = panel.querySelector('.folder-grid');
      const detail = panel.querySelector('.folder-detail');
      const section = panel.closest('.dashboard-section');
      const tip = section && section.querySelector('.tip-banner');
      if (head) head.hidden = false;
      if (grid) grid.hidden = false;
      if (detail) { detail.hidden = true; delete detail.dataset.openFolderId; }
      if (tip) tip.hidden = false;
    });
  }

  // Do not carry a previous user's in-memory audit or queued writes into the
  // next authenticated session. IndexedDB is deliberately left intact: its
  // data is account-scoped and remains available when that account returns.
  function clearActiveAuditState() {
    accountContextGeneration += 1;
    stopSharedSessionRefresh();
    sharedSessionRefreshPending = false;
    authorizationRefreshPending = false;
    if (autosaveDebounceTimer) window.clearTimeout(autosaveDebounceTimer);
    autosaveDebounceTimer = null;
    const waitingResolvers = autosaveDebounceResolvers;
    autosaveDebounceResolvers = [];
    waitingResolvers.forEach(resolve => resolve());
    saveQueue = Promise.resolve();
    scanSyncQueue = Promise.resolve();
    resetPendingQuantityEditState();
    resetPendingMutationState();
    signedInDataLoad = Promise.resolve();
    attachmentCollectionRevisions.clear();

    sessionId = null;
    fileName = '';
    items = [];
    scanLog = [];
    noRecordEntries = [];
    pendingNoRecordDeletes = [];
    notFoundCount = 0;
    currentFilter = 'all';
    exported = true;
    lastScanCode = null;
    lastScanTime = 0;
    lastReadoutItemId = null;
    lastReadoutRawCode = '';
    isPaused = false;
    openBoxFolder = null;
    isBrowsingFolders = false;
    apiAvailable = true;
    signedInUser = null;

    batchNameInput.value = 'Box 1';
    operatorNameInput.value = '';
    scanInput.value = '';
    scanInput.disabled = false;
    pausedOverlay.classList.remove('show');
    noRecordsOverlay.style.display = 'none';
    noRecordForm.reset();
    noRecordModalTrigger = null;
    closeImageLightbox({ restoreFocus: false });
    if (appSkeleton) {
      appSkeleton.classList.remove('is-visible');
      appSkeleton.hidden = true;
    }
    setFileSubtitle('No master list loaded');
    ledDot.classList.remove('off');
    readout.className = 'readout is-idle';
    readout.textContent = 'Waiting for first scan...';

    resumePanel.style.display = 'none';
    resumeList.replaceChildren();
    resetFolderDetailViews();
    folders = { 'pos-digital': [], 'blip': [], 'nirinsha': [], 'tlpj': [] };
    renderFolders('pos-digital');
    renderFolders('blip');
    renderFolders('nirinsha');
    renderFolders('tlpj');
    attachmentFolderApis.forEach(api => api.clear());
    document.querySelectorAll('.filters button').forEach(button => {
      button.classList.toggle('active', button.dataset.filter === 'all');
    });
    refreshBatchFilterOptions();
    renderTable();
    renderHistory();
    renderNoRecordEntries();
    updateStats();
    updateBatchTracker();
  }

  // Every "Create Folder" button in a section header is static markup (not
  // regenerated on every render), so it's wired once here. A button either
  // targets a spreadsheet-folder section (data-section) or an attachment
  // folder API (data-attach).
  document.querySelectorAll('.create-folder-trigger').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.section) { createFolder(btn.dataset.section); return; }
      const api = attachmentFolderApis.find(a => a.containerId === btn.dataset.attach);
      if (api) api.create();
    });
  });

  // Grid/List view toggle: each folders panel has its own pair of buttons:
  // toggling one just swaps a class on that panel's own folder grid.
  document.addEventListener('click', event => {
    const toggleBtn = event.target.closest('.view-toggle-btn');
    if (!toggleBtn) return;
    const panel = toggleBtn.closest('.folders-panel');
    const grid = panel && panel.querySelector('.folder-grid');
    if (!panel || !grid) return;
    panel.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.toggle('active', b === toggleBtn));
    grid.classList.toggle('list-view', toggleBtn.dataset.view === 'list');
  });

  // Header hamburger: collapses the sidebar to give the dashboard content
  // more room (mainly useful on narrower desktop windows).
  const sidebarToggleBtn = document.getElementById('sidebarToggle');
  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', () => {
      const collapsed = dashboardStage.classList.toggle('sidebar-collapsed');
      sidebarToggleBtn.setAttribute('aria-pressed', String(collapsed));
    });
  }

  // Notifications bell: surfaces the no-record scans logged in the current
  // audit session (the same count already shown on the No Record tab), so
  // it stays tied to something real instead of being purely decorative.
  const notifBtn = document.getElementById('notifBtn');
  const notifDropdown = document.getElementById('notifDropdown');
  const notifBadge = document.getElementById('notifBadge');
  const notifDropdownBody = document.getElementById('notifDropdownBody');
  function updateNotifications() {
    const count = noRecordEntries.length;
    if (notifBadge) {
      notifBadge.textContent = count > 9 ? '9+' : String(count);
      notifBadge.style.display = count ? 'flex' : 'none';
    }
    if (notifDropdownBody) {
      notifDropdownBody.innerHTML = count
        ? '<p>' + count + ' no-record scan' + (count === 1 ? '' : 's') + ' logged in this session need review.</p><button type="button" class="btn" id="notifReviewBtn">Review no-record scans</button>'
        : '<p>You\'re all caught up.</p>';
      const reviewBtn = document.getElementById('notifReviewBtn');
      if (reviewBtn) reviewBtn.addEventListener('click', () => { notifDropdown.style.display = 'none'; navigateToAudit('norecord'); });
    }
  }
  if (notifBtn && notifDropdown) {
    notifBtn.addEventListener('click', event => {
      event.stopPropagation();
      const isOpen = notifDropdown.style.display === 'block';
      notifDropdown.style.display = isOpen ? 'none' : 'block';
      notifBtn.setAttribute('aria-expanded', String(!isOpen));
    });
    document.addEventListener('click', event => {
      if (!event.target.closest('.notif-wrap')) { notifDropdown.style.display = 'none'; notifBtn.setAttribute('aria-expanded', 'false'); }
    });
  }
  updateNotifications();

  // Image lightbox: view a No Record photo full-size with Copy/Download.
  const imageLightbox = document.getElementById('imageLightbox');
  const lightboxImage = document.getElementById('lightboxImage');
  const lightboxCaption = document.getElementById('lightboxCaption');
  const lightboxHint = document.getElementById('lightboxHint');
  const lightboxCopyBtn = document.getElementById('lightboxCopyBtn');
  const lightboxDownloadBtn = document.getElementById('lightboxDownloadBtn');
  const lightboxCloseBtn = document.getElementById('lightboxCloseBtn');
  const lightboxPrevBtn = document.getElementById('lightboxPrevBtn');
  const lightboxNextBtn = document.getElementById('lightboxNextBtn');
  const lightboxCounter = document.getElementById('lightboxCounter');
  let lightboxFile = null;
  let lightboxFiles = [];
  let lightboxIndex = -1;
  let lightboxModalTrigger = null;

  // The Clipboard API's write() (needed to copy an actual image rather than
  // just its file name) only works in a secure context — https, localhost,
  // or 127.0.0.1. A plain http://<lan-ip> connection, which this app's own
  // docs describe as a supported setup, is not secure, so the browser
  // blocks it outright regardless of anything this code does.
  function canCopyImages() {
    return Boolean(window.isSecureContext && navigator.clipboard && window.ClipboardItem);
  }

  function showLightboxPhoto(index) {
    if (!lightboxFiles.length || index < 0 || index >= lightboxFiles.length) return;
    lightboxIndex = index;
    const file = lightboxFiles[lightboxIndex];
    lightboxFile = file;
    lightboxImage.src = file.url;
    lightboxImage.alt = file.name || '';
    lightboxCaption.textContent = file.name || '';
    if (lightboxCounter) lightboxCounter.textContent = lightboxFiles.length > 1 ? (lightboxIndex + 1) + ' of ' + lightboxFiles.length : '';
    if (lightboxPrevBtn) lightboxPrevBtn.disabled = lightboxIndex === 0;
    if (lightboxNextBtn) lightboxNextBtn.disabled = lightboxIndex === lightboxFiles.length - 1;
    if (lightboxHint) lightboxHint.hidden = canCopyImages();
  }

  function openImageLightbox(files, selectedIndex) {
    if (!imageLightbox) return;
    lightboxFiles = (Array.isArray(files) ? files : [files]).filter(file => file?.url);
    if (!lightboxFiles.length) return;
    lightboxModalTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const index = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < lightboxFiles.length ? selectedIndex : 0;
    showLightboxPhoto(index);
    imageLightbox.style.display = 'flex';
    lightboxCloseBtn?.focus();
  }
  function closeImageLightbox({ restoreFocus = true } = {}) {
    if (!imageLightbox) return;
    imageLightbox.style.display = 'none';
    lightboxFile = null;
    lightboxFiles = [];
    lightboxIndex = -1;
    if (restoreFocus && lightboxModalTrigger?.isConnected) lightboxModalTrigger.focus();
    lightboxModalTrigger = null;
  }
  if (imageLightbox) {
    lightboxCloseBtn.addEventListener('click', closeImageLightbox);
    imageLightbox.addEventListener('click', event => { if (event.target === imageLightbox) closeImageLightbox(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && imageLightbox.style.display === 'flex') {
        event.preventDefault();
        closeImageLightbox();
      }
      if (imageLightbox.style.display !== 'flex') return;
      keepFocusInModal(event, imageLightbox);
      if (event.key === 'ArrowLeft') { event.preventDefault(); showLightboxPhoto(lightboxIndex - 1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); showLightboxPhoto(lightboxIndex + 1); }
    });
    lightboxPrevBtn?.addEventListener('click', () => showLightboxPhoto(lightboxIndex - 1));
    lightboxNextBtn?.addEventListener('click', () => showLightboxPhoto(lightboxIndex + 1));
    lightboxDownloadBtn.addEventListener('click', () => {
      if (!lightboxFile) return;
      const link = document.createElement('a');
      link.href = lightboxFile.url;
      link.download = lightboxFile.name || 'photo';
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
    lightboxCopyBtn.addEventListener('click', async () => {
      if (!lightboxFile) return;
      if (!canCopyImages()) {
        showToast('This connection isn\'t secure (https), so the clipboard is off-limits — right-click the photo and choose "Copy Image" instead', 'error');
        return;
      }
      try {
        // Passing the blob as an unresolved promise (rather than awaiting
        // it first) keeps this call tied to the click that triggered it,
        // which Safari in particular requires for clipboard writes to work.
        const blobPromise = fetch(lightboxFile.url).then(response => response.blob());
        await navigator.clipboard.write([new ClipboardItem({ [lightboxFile.type || 'image/png']: blobPromise })]);
        showToast('Image copied to clipboard', 'success');
      } catch (error) {
        showToast('Could not copy the image — right-click it and choose "Copy Image" instead', 'error');
      }
    });
  }

  /* ==================== AUTHENTICATION ==================== */

  const authStage = document.getElementById('authStage');
  const appWrap = document.getElementById('appWrap');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const authStatus = document.getElementById('authStatus');
  const logoutBtn = document.getElementById('logoutBtn');
  const profileBlock = document.getElementById('profileBlock');
  const profileDropdown = document.getElementById('profileDropdown');
  const logoutOverlay = document.getElementById('logoutOverlay');
  const logoutConfirmBtn = document.getElementById('logoutConfirmBtn');
  const logoutCancelBtn = document.getElementById('logoutCancelBtn');
  const manageUsersNav = document.getElementById('manageUsersNav');
  const createUserForm = document.getElementById('createUserForm');
  const createUserError = document.getElementById('createUserError');
  const usersList = document.getElementById('usersList');
  const usersListCount = document.getElementById('usersListCount');
  const pwToggle = document.getElementById('pwToggle');
  const loginPasswordInput = document.getElementById('loginPassword');
  const toastEl = document.getElementById('toast');
  const forcePasswordChangeForm = document.getElementById('forcePasswordChangeForm');
  const forcePasswordChangeError = document.getElementById('forcePasswordChangeError');
  const resetPasswordOverlay = document.getElementById('resetPasswordOverlay');
  const resetPasswordForm = document.getElementById('resetPasswordForm');
  const resetPasswordMessage = document.getElementById('resetPasswordMessage');
  const resetPasswordInput = document.getElementById('resetPasswordInput');
  const resetPasswordConfirm = document.getElementById('resetPasswordConfirm');
  const resetPasswordError = document.getElementById('resetPasswordError');
  const resetPasswordCancel = document.getElementById('resetPasswordCancel');
  const resetPasswordSubmit = document.getElementById('resetPasswordSubmit');

  let signedInUser = null;
  let resetPasswordTarget = null;

  function isAdminUser(user = signedInUser) {
    return String(user?.role || '').toLowerCase() === 'admin';
  }

  function formatScannerName(username) {
    return String(username || '').trim().split(/[._-]+/).filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(' ');
  }

  function currentScannerName() {
    return formatScannerName(signedInUser?.username) || 'Unassigned';
  }

  function lockScannerName() {
    if (operatorNameInput) operatorNameInput.value = currentScannerName();
  }

  function formatAccountDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : 'Created ' + date.toLocaleDateString();
  }

  function renderManagedUsers(users) {
    usersList.replaceChildren();
    usersListCount.textContent = users.length + (users.length === 1 ? ' account' : ' accounts');
    if (!users.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No accounts have been created yet.';
      usersList.append(empty);
      return;
    }
    users.forEach(user => {
      const row = document.createElement('div');
      row.className = 'user-row';
      const details = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'user-name';
      name.textContent = user.username;
      details.append(name);
      const created = formatAccountDate(user.createdAt);
      if (created) {
        const meta = document.createElement('div');
        meta.className = 'user-meta';
        meta.textContent = created;
        details.append(meta);
      }
      if (user.mustChangePassword) {
        const passwordNotice = document.createElement('div');
        passwordNotice.className = 'user-meta';
        passwordNotice.textContent = 'Password change required';
        details.append(passwordNotice);
      }
      const actions = document.createElement('div');
      actions.className = 'user-actions';
      const role = document.createElement('span');
      role.className = 'user-role';
      role.textContent = user.role;
      actions.append(role);
      if (isAdminUser() && user.username.toLowerCase() !== signedInUser.username.toLowerCase()) {
        const changeRole = document.createElement('button');
        changeRole.type = 'button';
        changeRole.className = 'user-edit';
        changeRole.textContent = user.role === 'admin' ? 'Make user' : 'Make admin';
        changeRole.setAttribute('aria-label', 'Change account role for ' + user.username);
        changeRole.addEventListener('click', () => changeManagedUserRole(user));
        actions.append(changeRole);
        const resetPassword = document.createElement('button');
        resetPassword.type = 'button';
        resetPassword.className = 'user-edit';
        resetPassword.textContent = 'Reset password';
        resetPassword.setAttribute('aria-label', 'Reset password for ' + user.username);
        resetPassword.addEventListener('click', () => openResetPassword(user));
        actions.append(resetPassword);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'user-delete';
        remove.textContent = 'Delete';
        remove.setAttribute('aria-label', 'Delete account ' + user.username);
        remove.addEventListener('click', () => deleteManagedUser(user));
        actions.append(remove);
      }
      row.append(details, actions);
      usersList.append(row);
    });
  }

  async function changeManagedUserRole(user) {
    const role = user.role === 'admin' ? 'user' : 'admin';
    if (!window.confirm('Change ' + user.username + ' to ' + role + '?')) return;
    try {
      const response = await fetchApi('/auth/users/' + encodeURIComponent(user.username), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role })
      });
      if (!response.ok) throw await apiResponseError(response, 'Unable to change account.');
      await loadManagedUsers();
      showToast('Updated ' + user.username + ' to ' + role + '.', 'success');
    } catch (error) {
      useOfflineFallback(error);
      createUserError.textContent = error.message || 'Unable to change account.';
      showToast(createUserError.textContent, 'error');
    }
  }

  async function loadManagedUsers() {
    if (!isAdminUser()) return;
    usersListCount.textContent = 'Loading…';
    try {
      const response = await fetchApi('/auth/users');
      if (!response.ok) throw await apiResponseError(response, 'Unable to load accounts.');
      const result = await response.json();
      apiAvailable = true;
      renderManagedUsers(result.users || []);
    } catch (error) {
      useOfflineFallback(error);
      const message = error.message || 'Unable to load accounts.';
      usersListCount.textContent = '';
      usersList.innerHTML = '<p class="empty-state">' + escapeHtml(message) + '</p>';
      showToast(message, 'error');
    }
  }

  async function deleteManagedUser(user) {
    if (!window.confirm('Delete the account for ' + user.username + '? This cannot be undone.')) return;
    try {
      const response = await fetchApi('/auth/users/' + encodeURIComponent(user.username), {
        method: 'DELETE'
      });
      if (!response.ok) throw await apiResponseError(response, 'Unable to delete account.');
      await loadManagedUsers();
      showToast('Account deleted for ' + user.username + '.', 'success');
    } catch (error) {
      useOfflineFallback(error);
      createUserError.textContent = error.message || 'Unable to delete account.';
      showToast(createUserError.textContent, 'error');
    }
  }

  function closeResetPassword() {
    resetPasswordTarget = null;
    resetPasswordForm?.reset();
    resetPasswordError.textContent = '';
    resetPasswordOverlay.style.display = 'none';
  }

  function openResetPassword(user) {
    if (!isAdminUser() || !user || user.username.toLowerCase() === signedInUser.username.toLowerCase()) return;
    resetPasswordTarget = user;
    resetPasswordForm.reset();
    resetPasswordError.textContent = '';
    resetPasswordMessage.textContent = 'Set a temporary password for ' + user.username + '. They must change it at their next sign-in.';
    resetPasswordOverlay.style.display = 'flex';
    setTimeout(() => resetPasswordInput.focus(), 0);
  }

  let toastTimer = null;
  let logoutInProgress = false;
  function showToast(message, type) {
    toastEl.textContent = message;
    toastEl.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.classList.remove('show'); }, 2800);
  }

  pwToggle.addEventListener('click', () => {
    const revealed = loginPasswordInput.type === 'text';
    loginPasswordInput.type = revealed ? 'password' : 'text';
    pwToggle.querySelector('.icon-eye').style.display = revealed ? 'block' : 'none';
    pwToggle.querySelector('.icon-eye-off').style.display = revealed ? 'none' : 'block';
    pwToggle.setAttribute('aria-label', revealed ? 'Show password' : 'Hide password');
  });

  function showAuthStage() {
    authStage.style.display = 'flex';
    appWrap.style.display = 'none';
    loginForm.style.display = '';
    if (forcePasswordChangeForm) forcePasswordChangeForm.style.display = 'none';
    loginForm.reset();
    loginError.textContent = '';
  }

  function showApp(user) {
    signedInUser = user;
    // Password-rotation policy comes from the authenticated server record.
    if (user.mustChangePassword && forcePasswordChangeForm) {
      showForcedPasswordChange();
      return;
    }
    enterApp(user);
  }

  function enterApp(user) {
    const username = user.username;
    authStage.style.display = 'none';
    appWrap.style.display = 'block';
    authStatus.style.display = 'block';
    authStatus.textContent = username;
    const avatarEl = document.getElementById('userAvatar');
    if (avatarEl) avatarEl.textContent = username.charAt(0).toUpperCase();
    const roleLabelEl = document.getElementById('userRoleLabel');
    if (roleLabelEl) roleLabelEl.textContent = isAdminUser(user) ? 'Administrator' : 'User';
    logoutBtn.style.display = 'flex';
    // Account management and the account directory are administrator-only.
    manageUsersNav.style.display = isAdminUser(user) ? 'flex' : 'none';
    createUserForm.style.display = isAdminUser(user) ? 'block' : 'none';
    lockScannerName();
    // Respect a valid deep link that was opened before authentication rather
    // than always forcing the dashboard root after a successful sign-in.
    applyBrowserRoute();
    loadSignedInData();
    focusScanInput();
  }

  function showForcedPasswordChange() {
    authStage.style.display = 'flex';
    appWrap.style.display = 'none';
    loginForm.style.display = 'none';
    forcePasswordChangeForm.style.display = 'flex';
    forcePasswordChangeForm.reset();
    document.getElementById('forcePasswordChangeUsername').value = signedInUser?.username || '';
    forcePasswordChangeError.textContent = '';
  }

  if (forcePasswordChangeForm) {
    forcePasswordChangeForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      forcePasswordChangeError.textContent = '';
      const currentPassword = document.getElementById('forceCurrentPassword').value;
      const newPassword = document.getElementById('forceNewPassword').value;
      const confirmPassword = document.getElementById('forceConfirmPassword').value;
      if (newPassword.length < 8) {
        forcePasswordChangeError.textContent = 'New password must be at least 8 characters.';
        return;
      }
      if (newPassword !== confirmPassword) {
        forcePasswordChangeError.textContent = 'New passwords do not match.';
        return;
      }
      const submitBtn = forcePasswordChangeForm.querySelector('.auth-submit');
      submitBtn.disabled = true;
      try {
        const response = await fetchApi('/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        if (!response.ok) throw await apiResponseError(response, 'Unable to update password.');
        const result = await response.json();
        signedInUser = result.user;
        apiAvailable = true;
        loginForm.style.display = '';
        forcePasswordChangeForm.style.display = 'none';
        showToast('Password updated.', 'success');
        enterApp(signedInUser);
      } catch (error) {
        if (['AUTH_REQUIRED', 'AUTH_REVOKED'].includes(error?.code)) useOfflineFallback(error);
        forcePasswordChangeError.textContent = error.message || 'Unable to update password.';
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  async function restoreAuthentication() {
    try {
      const response = await fetchApi('/auth/me');
      if (!response.ok) throw await apiResponseError(response, 'Authentication service unavailable.');
      const result = await response.json();
      apiAvailable = true;
      if (!result.user) return false;
      showApp(result.user);
      return true;
    } catch (error) {
      useOfflineFallback(error);
      return false;
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!username || !password) {
      loginError.textContent = 'Enter your username and password.';
      showToast('Enter your username and password.', 'error');
      return;
    }
    const submitBtn = loginForm.querySelector('.auth-submit');
    submitBtn.disabled = true;
    try {
      const response = await fetchApi('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Unable to sign in.');
      apiAvailable = true;
      showToast('Welcome back, ' + result.user.username + '!', 'success');
      showApp(result.user);
    } catch (err) {
      const message = err.message || 'Something went wrong. Please try again.';
      loginError.textContent = message;
      showToast(message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  function closeProfileMenu() {
    if (profileDropdown) profileDropdown.style.display = 'none';
    if (profileBlock) profileBlock.setAttribute('aria-expanded', 'false');
  }

  function closeLogoutConfirmation() {
    if (logoutOverlay) logoutOverlay.style.display = 'none';
  }

  function showLogoutConfirmation() {
    closeProfileMenu();
    if (logoutOverlay) {
      logoutOverlay.style.display = 'flex';
      logoutConfirmBtn?.focus();
    }
  }

  async function completeLogout() {
    if (logoutInProgress) return;
    logoutInProgress = true;
    if (logoutConfirmBtn) logoutConfirmBtn.disabled = true;
    if (logoutCancelBtn) logoutCancelBtn.disabled = true;

    // Invalidate local work before awaiting the request. The login form stays
    // hidden until the request settles, so a new account cannot inherit an
    // old account's cookie while outstanding work is being discarded.
    clearActiveAuditState();
    let logoutError = null;
    try {
      const response = await fetchApi('/auth/logout', { method: 'POST' });
      if (!response.ok) throw await apiResponseError(response, 'Unable to end the server session.');
    } catch (error) {
      logoutError = error;
    } finally {
      authStatus.style.display = 'none';
      closeProfileMenu();
      closeLogoutConfirmation();
      logoutBtn.style.display = 'none';
      manageUsersNav.style.display = 'none';
      showAuthStage();
      if (logoutConfirmBtn) logoutConfirmBtn.disabled = false;
      if (logoutCancelBtn) logoutCancelBtn.disabled = false;
      logoutInProgress = false;
    }
    if (logoutError) showToast('Signed out locally, but the server session could not be closed. Please close this browser if the problem continues.', 'error');
  }

  if (profileBlock && profileDropdown) {
    profileBlock.addEventListener('click', event => {
      event.stopPropagation();
      const isOpen = profileDropdown.style.display === 'block';
      profileDropdown.style.display = isOpen ? 'none' : 'block';
      profileBlock.setAttribute('aria-expanded', String(!isOpen));
    });
    document.addEventListener('click', event => {
      if (!event.target.closest('.profile-wrap')) closeProfileMenu();
    });
  }

  logoutBtn.addEventListener('click', showLogoutConfirmation);
  logoutConfirmBtn?.addEventListener('click', completeLogout);
  logoutCancelBtn?.addEventListener('click', closeLogoutConfirmation);
  logoutOverlay?.addEventListener('click', event => {
    if (event.target === logoutOverlay) closeLogoutConfirmation();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (logoutOverlay?.style.display === 'flex') closeLogoutConfirmation();
      else if (resetPasswordOverlay?.style.display === 'flex') closeResetPassword();
      else closeProfileMenu();
    }
  });

  resetPasswordCancel?.addEventListener('click', closeResetPassword);
  resetPasswordOverlay?.addEventListener('click', event => {
    if (event.target === resetPasswordOverlay) closeResetPassword();
  });
  resetPasswordForm?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!resetPasswordTarget) return;
    resetPasswordError.textContent = '';
    const password = resetPasswordInput.value;
    if (password.length < 8) {
      resetPasswordError.textContent = 'Temporary passwords must be at least 8 characters.';
      return;
    }
    if (password !== resetPasswordConfirm.value) {
      resetPasswordError.textContent = 'Passwords do not match.';
      return;
    }
    resetPasswordSubmit.disabled = true;
    try {
      const response = await fetchApi('/auth/users/' + encodeURIComponent(resetPasswordTarget.username), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
      });
      if (!response.ok) throw await apiResponseError(response, 'Unable to reset password.');
      const username = resetPasswordTarget.username;
      closeResetPassword();
      await loadManagedUsers();
      showToast('Password reset for ' + username + '.', 'success');
    } catch (error) {
      useOfflineFallback(error);
      resetPasswordError.textContent = error.message || 'Unable to reset password.';
    } finally {
      resetPasswordSubmit.disabled = false;
    }
  });

  createUserForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!isAdminUser()) return;
    createUserError.textContent = '';
    const submitBtn = createUserForm.querySelector('.auth-submit');
    submitBtn.disabled = true;
    try {
      const newUsername = document.getElementById('newUsername').value.trim();
      const newPassword = document.getElementById('newUserPassword').value;
      const newRole = document.getElementById('newUserRole').value;
      if (!/^[a-z0-9._-]{3,50}$/i.test(newUsername)) throw new Error('Use 3–50 letters, numbers, dots, hyphens, or underscores for the username.');
      if (newPassword.length < 8) throw new Error('Password must be at least 8 characters.');

      let response;
      try {
        response = await fetchApi('/auth/users', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole })
        });
      } catch (error) {
        apiAvailable = false;
        throw new Error('Account service is unavailable. Check that WAIS is running, then try again.');
      }
      if (!response.ok) throw await apiResponseError(response, 'Unable to create account.');
      const result = await response.json();
      apiAvailable = true;
      const createdUser = result.user;
      createUserForm.reset();
      await loadManagedUsers();
      showToast('Account created for ' + createdUser.username + '. Password change required at first sign-in.', 'success');
    } catch (error) {
      if (error?.status) useOfflineFallback(error);
      createUserError.textContent = error.message || 'Unable to create account.';
    } finally { submitBtn.disabled = false; }
  });

  (async function bootAuth() {
    try {
      await purgeLegacyBrowserAuthentication();
      const restored = await restoreAuthentication();
      // A manual login can complete while this startup check is in flight.
      if (!restored && !signedInUser) {
        showAuthStage();
      }
    } catch (error) {
      // If startup sign-in restoration fails for any reason, fall back to a
      // plain login screen rather than leaving the page half-initialized.
      showAuthStage();
    }
  })(); 
