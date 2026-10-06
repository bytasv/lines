// Hides the boot splash before first paint on the pages it is not for — see the
// comment beside the <script> tag in index.html. Served as a file, not inline,
// so the deployed CSP needs no 'unsafe-inline' for scripts.
(function () {
  var splash = document.getElementById('lines-splash');
  if (!splash) return;
  var clerkKey = splash.dataset.clerk || '';
  if (!clerkKey || clerkKey.charAt(0) === '%') return;
  var path = location.pathname;
  var landing =
    path === '/welcome' || path.indexOf('/join/') === 0 || path.indexOf('/sign-in') === 0;
  var signedIn = /(?:^|; )__client_uat(?:_[^=]*)?=[1-9]/.test(document.cookie);
  if (landing || !signedIn) splash.dataset.state = 'hidden';
})();
