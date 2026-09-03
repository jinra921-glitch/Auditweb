// This file is used only by the GitHub Pages build. It labels the site as a
// public preview because the private WAIS API is not deployed with it.
window.WAIS_STATIC_PREVIEW = true;

window.addEventListener('DOMContentLoaded', () => {
  const notice = document.getElementById('githubPagesNotice');
  if (notice) notice.hidden = false;
});
