// Runs in <head> before the app bundle, so the first frame already has the chosen mode and a
// dark start never flashes light. The app re-applies the saved choice once it has loaded.
(function () {
  var dark = false;
  try {
    var saved = localStorage.getItem('pomi.theme.v1');
    dark = saved === 'dark' || (saved !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (error) {
    dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0e0f11' : '#fafafa');
})();
