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
    reportSize();
  });
  // After the page is written, tell the parent how tall it is, so a frame sized
  // to its content (HtmlFrame's autoHeight) can follow it. The observer watches
  // the new document's root, which document.open() replaced.
  function reportSize() {
    var root = document.documentElement;
    if (!root) return;
    var last = -1;
    var post = function () {
      // The root's own box, not scrollHeight: scrollHeight never drops below the
      // frame's viewport, so a frame sized from it could grow but never shrink.
      var height = Math.ceil(root.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      window.parent.postMessage({ type: 'lines-html-preview-size', height: height }, '*');
    };
    post();
    if (typeof ResizeObserver === 'function') new ResizeObserver(post).observe(root);
    window.addEventListener('load', post);
  }
  // '*': the parent is the app, but from an opaque origin there is nothing to
  // check it against; the message carries no data.
  window.parent.postMessage({ type: 'lines-html-preview-ready' }, '*');
})();
