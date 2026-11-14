// Thème posé avant le premier rendu (script bloquant dans <head>) : pas de flash sombre pour qui a choisi le clair.
// Même clé et mêmes valeurs que l'appli (app.js : loadTheme / applyTheme).
(function () {
  var t = 'system';
  try { t = localStorage.getItem('theme') || 'system'; } catch (e) {}
  var light = t === 'light' || (t === 'system' && !!window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
})();
