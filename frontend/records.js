window.createRecordsPage = function createRecordsPage(api) {
  const byId = id => document.getElementById(id);
  const body = byId('recordsBody');
  const message = byId('recordsMessage');
  const search = byId('recordsSearch');
  const dialog = byId('recordDialog');
  const form = byId('recordForm');
  const formError = byId('recordFormError');
  const saveButton = byId('recordSaveBtn');
  const cancelButton = byId('recordCancelBtn');
  const excelButton = byId('recordsExcelBtn');
  const printButton = byId('recordsPrintBtn');
  const previousButton = byId('recordsPreviousBtn');
  const nextButton = byId('recordsNextBtn');
  const pageSize = 50;
  let records = [];
  let offset = 0;
  let total = 0;
  let loadVersion = 0;
  let searchTimer;
  let editingId = null;
  let saving = false;
  let loading = false;
  let exporting = false;
  let dialogGeneration = null;

  function setMessage(text, error = false) {
    message.textContent = text;
    message.classList.toggle('is-error', error);
  }

  function updateControls() {
    previousButton.disabled = loading || offset === 0;
    nextButton.disabled = loading || offset + pageSize >= total;
    excelButton.disabled = printButton.disabled = loading || exporting || total === 0;
    byId('recordsPageInfo').textContent = total ? (offset + 1) + '–' + Math.min(offset + records.length, total) + ' of ' + total : '0 records';
  }

  function dateLabel(value) {
    return new Date(value).toLocaleString();
  }

  function appendCell(row, value) {
    const cell = document.createElement('td');
    cell.textContent = value == null || value === '' ? '—' : String(value);
    row.appendChild(cell);
    return cell;
  }

  function renderRows() {
    body.replaceChildren();
    for (const record of records) {
      const row = document.createElement('tr');
      [record.description, record.itemNumber, record.serialNumber, record.quantity, dateLabel(record.createdAt)].forEach(value => appendCell(row, value));
      const actions = document.createElement('td');
      const group = document.createElement('div');
      group.className = 'records-actions';
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'user-edit'; edit.textContent = 'Edit';
      edit.addEventListener('click', () => openForm(record));
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'user-delete'; remove.textContent = 'Delete';
      remove.addEventListener('click', () => removeRecord(record, remove));
      group.append(edit, remove); actions.appendChild(group); row.appendChild(actions); body.appendChild(row);
    }
    if (!records.length) {
      const row = document.createElement('tr');
      const cell = appendCell(row, search.value.trim() ? 'No records match your search.' : 'No records yet. Select + Add Record to create one.');
      cell.colSpan = 6;
      body.appendChild(row);
    }
    updateControls();
  }

  async function load({ resetPage = false } = {}) {
    if (!api.getUser()) return;
    if (resetPage) offset = 0;
    const version = ++loadVersion;
    const generation = api.getGeneration();
    loading = true;
    setMessage('Loading records…'); updateControls();
    try {
      const result = await api.requestApi('/records?search=' + encodeURIComponent(search.value.trim()) + '&limit=' + pageSize + '&offset=' + offset);
      if (generation !== api.getGeneration() || version !== loadVersion) return;
      records = result.records || [];
      total = Number(result.page?.total || 0);
      if (offset && offset >= total) { offset = Math.max(0, Math.floor((total - 1) / pageSize) * pageSize); return load(); }
      setMessage(total + (total === 1 ? ' record' : ' records') + (search.value.trim() ? ' found. Excel and Print include all matching records.' : '. Excel and Print include all records.'));
    } catch (error) {
      if (generation !== api.getGeneration() || version !== loadVersion) return;
      records = []; total = 0;
      api.useOfflineFallback(error);
      setMessage(error.message || 'Could not load records. Select Refresh to try again.', true);
    } finally {
      if (generation === api.getGeneration() && version === loadVersion) { loading = false; renderRows(); }
    }
  }

  function openForm(record = null) {
    if (!api.getUser() || saving) return;
    editingId = record?.id || null;
    dialogGeneration = api.getGeneration();
    form.reset(); formError.textContent = '';
    byId('recordDialogTitle').textContent = editingId ? 'Edit Record' : 'Add Record';
    byId('recordDescription').value = record?.description || '';
    byId('recordItemNumber').value = record?.itemNumber || '';
    byId('recordSerialNumber').value = record?.serialNumber || '';
    byId('recordQuantity').value = record?.quantity ?? 1;
    dialog.showModal();
    byId('recordDescription').focus();
  }

  async function saveRecord(event) {
    event.preventDefault();
    if (saving || !api.getUser() || dialogGeneration !== api.getGeneration()) return;
    const payload = {
      description: byId('recordDescription').value.trim(),
      itemNumber: byId('recordItemNumber').value.trim() || null,
      serialNumber: byId('recordSerialNumber').value.trim() || null,
      quantity: Number(byId('recordQuantity').value)
    };
    if (!payload.description) { formError.textContent = 'Description is required.'; return; }
    if (!Number.isSafeInteger(payload.quantity) || payload.quantity < 1 || payload.quantity > 4294967295) { formError.textContent = 'Qty must be a whole number from 1 to 4,294,967,295.'; return; }
    const generation = dialogGeneration;
    const id = editingId;
    saving = true; saveButton.disabled = cancelButton.disabled = true;
    saveButton.textContent = 'Saving…'; formError.textContent = '';
    try {
      await api.requestApi('/records' + (id ? '/' + encodeURIComponent(id) : ''), {
        method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (generation !== api.getGeneration()) return;
      dialog.close();
      api.showToast(id ? 'Record updated.' : 'Record created.', 'success');
      await load({ resetPage: !id });
    } catch (error) {
      if (generation !== api.getGeneration()) return;
      api.useOfflineFallback(error);
      formError.textContent = error.message || 'Could not save this record. Please try again.';
    } finally {
      if (generation === api.getGeneration()) { saving = false; saveButton.disabled = cancelButton.disabled = false; saveButton.textContent = 'Save Record'; }
    }
  }

  async function removeRecord(record, button) {
    if (!api.getUser() || !window.confirm('Delete “' + record.description + '”? This cannot be undone.')) return;
    const generation = api.getGeneration();
    button.disabled = true;
    try {
      await api.requestApi('/records/' + encodeURIComponent(record.id), { method: 'DELETE' });
      if (generation !== api.getGeneration()) return;
      api.showToast('Record deleted.', 'success');
      await load();
    } catch (error) {
      if (generation !== api.getGeneration()) return;
      api.useOfflineFallback(error);
      setMessage(error.message || 'Could not delete this record.', true);
    } finally { if (generation === api.getGeneration()) button.disabled = false; }
  }

  async function exportRecords(print) {
    if (exporting || !api.getUser() || (!print && !api.ensureXlsx())) return;
    const generation = api.getGeneration();
    const query = search.value.trim();
    exporting = true; updateControls(); setMessage(print ? 'Preparing records for printing…' : 'Preparing Excel download…');
    try {
      const rows = [];
      for (let pageOffset = 0; ; pageOffset += 200) {
        const page = await api.requestApi('/records?search=' + encodeURIComponent(query) + '&limit=200&offset=' + pageOffset);
        if (generation !== api.getGeneration()) return;
        rows.push(...page.records);
        if (!page.records.length || pageOffset + page.records.length >= page.page.total) break;
      }
      if (!rows.length) { setMessage('No records to export.'); return; }
      if (print) {
        const printBody = byId('recordsPrintBody');
        printBody.replaceChildren();
        for (const record of rows) {
          const row = document.createElement('tr');
          [record.description, record.itemNumber, record.serialNumber, record.quantity, dateLabel(record.createdAt)].forEach(value => appendCell(row, value));
          printBody.appendChild(row);
        }
        byId('recordsPrintMeta').textContent = rows.length + ' records' + (query ? ' · Search: ' + query : '') + ' · ' + new Date().toLocaleString();
        document.body.classList.add('print-records');
        window.print();
      } else {
        const exportedRows = rows.map(record => ({
          Description: api.spreadsheetValue(record.description), 'Item Number': api.spreadsheetValue(record.itemNumber || ''),
          'Serial Number': api.spreadsheetValue(record.serialNumber || ''), Qty: record.quantity, 'Date Created': dateLabel(record.createdAt)
        }));
        const workbook = window.XLSX.utils.book_new();
        const sheet = window.XLSX.utils.json_to_sheet(exportedRows);
        sheet['!cols'] = [{ wch: 45 }, { wch: 22 }, { wch: 22 }, { wch: 10 }, { wch: 25 }];
        window.XLSX.utils.book_append_sheet(workbook, sheet, 'Records');
        api.downloadWorkbook(workbook, 'WAIS_Records_' + new Date().toISOString().slice(0, 10) + '.xlsx');
      }
      setMessage(rows.length + (print ? ' records ready to print.' : ' records exported to Excel.'));
    } catch (error) {
      if (generation !== api.getGeneration()) return;
      api.useOfflineFallback(error); setMessage(error.message || 'Could not export records.', true);
    } finally {
      if (generation === api.getGeneration()) { exporting = false; updateControls(); }
    }
  }

  function clear() {
    ++loadVersion; window.clearTimeout(searchTimer);
    records = []; total = offset = 0; editingId = dialogGeneration = null;
    saving = loading = exporting = false; saveButton.disabled = cancelButton.disabled = false;
    saveButton.textContent = 'Save Record'; search.value = ''; form.reset(); formError.textContent = '';
    if (dialog.open) dialog.close();
    byId('recordsPrintBody').replaceChildren(); byId('recordsPrintMeta').textContent = '';
    document.body.classList.remove('print-records');
    renderRows(); setMessage('');
  }

  byId('addRecordBtn').addEventListener('click', () => openForm());
  form.addEventListener('submit', saveRecord);
  cancelButton.addEventListener('click', () => { if (!saving) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  byId('recordsRefreshBtn').addEventListener('click', () => load());
  search.addEventListener('input', () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => load({ resetPage: true }), 250); });
  previousButton.addEventListener('click', () => { offset = Math.max(0, offset - pageSize); load(); });
  nextButton.addEventListener('click', () => { offset += pageSize; load(); });
  excelButton.addEventListener('click', () => exportRecords(false));
  printButton.addEventListener('click', () => exportRecords(true));
  window.addEventListener('afterprint', () => document.body.classList.remove('print-records'));
  return { load, clear };
};
