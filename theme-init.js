/* Theme init — runs synchronously in <head> BEFORE the stylesheet loads.
 *
 * Why a separate file (instead of inline in dashboard.html)? Manifest V3's
 * default extension_pages CSP forbids inline <script> tags. So we ship this
 * as a tiny external script and load it without defer/async so it blocks
 * parsing until the theme attributes are set on <html>. By the time the
 * stylesheet's [data-theme="..."][data-mode="..."] CSS variables are applied,
 * the correct palette is already chosen — no white-flash on dark reloads.
 *
 * Two orthogonal axes:
 *   data-theme = palette name (default | ocean | lavender | rose |
 *                              mocha | benilde | slate | plain)
 *   data-mode  = "light" | "dark"
 *
 * Kept dependency-free (no imports) so it runs as a classic script and stays
 * tiny enough that the synchronous-load cost is invisible. */
(function () {
  var VALID_THEMES = ['default', 'ocean', 'lavender', 'rose', 'mocha', 'benilde', 'slate', 'plain'];
  var VALID_MODES = ['light', 'dark'];

  function read(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, val); } catch (_) { }
  }
  function remove(key) {
    try { localStorage.removeItem(key); } catch (_) { }
  }

  /* Legacy migration: before themes existed, smallsky-theme stored "light"/"dark"
   * (i.e. the mode). Move that value to smallsky-mode and reset smallsky-theme
   * to the default palette. Runs once per install. */
  var legacy = read('smallsky-theme');
  if (legacy === 'light' || legacy === 'dark') {
    if (!read('smallsky-mode')) write('smallsky-mode', legacy);
    remove('smallsky-theme');
  }

  var savedTheme = read('smallsky-theme');
  var savedMode = read('smallsky-mode');

  var theme = (VALID_THEMES.indexOf(savedTheme) >= 0) ? savedTheme : 'default';

  var mode;
  if (VALID_MODES.indexOf(savedMode) >= 0) {
    mode = savedMode;
  } else {
    try {
      mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) {
      mode = 'light';
    }
  }

  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-mode', mode);
  // Stylesheets are render-blocking, so once dashboard.css finishes loading
  // it'll paint with the correct --bg from the start. color-scheme lives in
  // CSS so it stays in sync with theme/mode toggles after boot.
})();
