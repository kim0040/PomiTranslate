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
  // The saved text size (100, 115 or 130 percent) also applies before the first paint.
  try {
    var size = Number(localStorage.getItem('pomi.fontscale.v1'));
    if (size === 115 || size === 130) document.documentElement.style.setProperty('--font-scale', String(size / 100));
  } catch (error) { /* the default size applies */ }
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#120f0b' : '#f9f8f7');
})();
