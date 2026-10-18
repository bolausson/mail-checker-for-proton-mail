/**
 * Attachment preview page (Chrome MV3 only).
 *
 * Service-worker-created blob URLs aren't accessible from a regular tab
 * on Chrome MV3: they're scoped to the SW process. This page runs in a
 * normal renderer context where blob URLs work as expected. It fetches
 * the bytes from the background via runtime.sendMessage (single-use,
 * keyed by the ?id= query param), reconstitutes a Blob locally, and
 * renders it via <embed> so Chrome's built-in viewers (PDF, images,
 * etc.) can display it inline.
 */
(async () => {
  const fallback = document.getElementById('fallback');
  const frame = document.getElementById('frame');

  function showFallback(msg) {
    if (frame) frame.remove();
    fallback.style.display = 'block';
    fallback.textContent = msg;
  }

  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id) return showFallback('No attachment id supplied.');

  let resp;
  try {
    resp = await browser.runtime.sendMessage({ type: 'GET_PREVIEW_BLOB', id });
  } catch (e) {
    return showFallback('Could not contact extension: ' + e.message);
  }
  if (!resp || resp.error) {
    return showFallback('Attachment not available: ' + ((resp && resp.error) || 'unknown'));
  }

  // Decode the base64 payload into bytes.
  const bin = atob(resp.bytesB64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);

  const mimeType = resp.mimeType || 'application/octet-stream';
  const blob = new Blob([u8], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const filename = resp.filename || 'attachment';

  document.title = filename;

  // The background reduces anything it will not render inline to
  // application/octet-stream (see _inlineSafeMimeType), because a blob URL here
  // carries the extension's own origin and a scriptable type would run with it.
  // <embed> on that type paints a blank frame, which looks like a bug, so hand
  // the user the file instead. An <a download> needs no extra permission.
  if (mimeType === 'application/octet-stream') {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showFallback('This file type is not shown here for safety. It has been downloaded instead: ' + filename);
    window.addEventListener('pagehide', () => URL.revokeObjectURL(url));
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
    return;
  }

  frame.type = mimeType;
  frame.src = url;

  // Revoke the blob URL once the page is closed/navigated. Belt-and-
  // suspenders: also drop it after 10 minutes in case unload doesn't fire.
  window.addEventListener('pagehide', () => URL.revokeObjectURL(url));
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
})();
