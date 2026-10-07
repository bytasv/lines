// The HTML preview shell's half of the handshake — see html-preview.html.
// Announces itself to the embedding app, takes exactly one page from it and
// replaces this document with that page. The written document keeps this
// response's CSP, so it stays in the opaque-origin sandbox.
(function () {
  if (window.parent === window) return;
  var done = false;
  window.addEventListener('message', function (event) {
    if (done || event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'lines-html-preview' || typeof data.html !== 'string') return;
    done = true;
    document.open();
    document.write(data.html);
    document.close();
  });
  // '*': the parent is the app, but from an opaque origin there is nothing to
  // check it against; the message carries no data.
  window.parent.postMessage({ type: 'lines-html-preview-ready' }, '*');
})();
