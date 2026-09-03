// Spreadsheet parsing runs away from the workstation UI. This contains any
// parser-side prototype pollution and lets the main thread terminate a file
// that takes too long to process.
const MAX_SPREADSHEET_ROWS = 50_000;
const xlsxSource = self.location.protocol === 'file:'
  ? 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
  : '/vendor/xlsx.full.min.js';

try {
  importScripts(xlsxSource);
} catch (error) {
  self.postMessage({ type: 'startup-error', message: 'The secure spreadsheet parser could not be loaded.' });
}

self.addEventListener('message', event => {
  try {
    if (!self.XLSX) throw new Error('The secure spreadsheet parser is unavailable.');
    const data = new Uint8Array(event.data?.buffer || new ArrayBuffer(0));
    const workbook = self.XLSX.read(data, { type: 'array', sheetRows: MAX_SPREADSHEET_ROWS + 1, bookVBA: false });
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName && workbook.Sheets[sheetName];
    if (!sheet) throw new Error('No worksheet was found in that file.');
    // Send a matrix rather than header-keyed objects. It avoids carrying an
    // untrusted __proto__ header from the parser into the main app context.
    const rows = self.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false, raw: true });
    if (rows.length > MAX_SPREADSHEET_ROWS + 1) {
      throw new Error(`The spreadsheet exceeds the ${MAX_SPREADSHEET_ROWS.toLocaleString()}-row workstation limit.`);
    }
    self.postMessage({ type: 'rows', rows });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || 'Could not read that file.' });
  }
});
