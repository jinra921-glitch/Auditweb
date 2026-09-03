(() => {
  // Asset URLs need to work from an SPA deep link and when Index.html is
  // opened directly for a local preview.
  const base = document.createElement('base');
  // Resolve assets alongside this script. This works for a GitHub Pages
  // project URL such as /Auditweb/ as well as the local WAIS server.
  const scriptUrl = document.currentScript?.src;
  base.href = scriptUrl ? new URL('./', scriptUrl).href : './';
  document.head.appendChild(base);
})();
