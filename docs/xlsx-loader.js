(() => {
  // Production workstations serve the audited local copy. Keeping the CDN
  // fallback only for a direct file:// preview preserves the lightweight
  // design-time workflow without making deployed scanning internet-dependent.
  const source = window.location.protocol === 'file:'
    ? 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
    : 'vendor/xlsx.full.min.js';
  document.write('<script src="' + source + '"></script>');
})();
