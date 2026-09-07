(() => {
  // Asset URLs need to work from an SPA deep link and when Index.html is
  // opened directly for a local preview.
  if (document.querySelector('base')) return;
  const base = document.createElement('base');
  base.href = window.location.protocol === 'file:' ? './' : '/';
  document.head.appendChild(base);
})();
