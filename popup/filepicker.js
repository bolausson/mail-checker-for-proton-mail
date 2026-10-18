/**
 * File picker page: opened in a tab when the user clicks the attach button.
 * Extension popups close on focus loss, so native file dialogs can't work there.
 *
 * Two modes:
 *  - attach (default): reads picked files as base64, hands them to the
 *    background (SAVE_PENDING_ATTACHMENTS, encrypted at rest) and closes; the
 *    popup then picks the attachments up from storage.
 *  - drive (?mode=drive&uploadId=...): "Share via Proton Drive". The tab KEEPS
 *    the File objects and streams 4 MiB slices to the background over a
 *    long-lived runtime.Port on demand (pull model: nothing is pre-read, so
 *    arbitrarily large files never sit in memory or storage). The tab stays
 *    open as the progress surface; the open port also keeps the Chrome MV3
 *    service worker alive. Finished share links are persisted by the
 *    background and inserted into the draft when the popup reopens.
 */
(function () {
  'use strict';

  const fileInput = document.getElementById('file-input');
  const dropZone = document.getElementById('drop-zone');
  const fileList = document.getElementById('file-list');
  const btnDone = document.getElementById('btn-done');
  const btnCancel = document.getElementById('btn-cancel');

  const urlParams = new URLSearchParams(location.search);
  const driveMode = urlParams.get('mode') === 'drive';
  const uploadId = urlParams.get('uploadId') || '';

  const pendingFiles = []; // attach mode: { name, type, size, data (base64) }
  const pickedFiles = [];  // drive mode: File objects (never pre-read)
  let uploading = false;
  let port = null;
  let pingTimer = null;
  let helloAckTimer = null;

  const t = (k) => ProtonI18n.t(k);

  // Apply the user's language to the static page text (data-i18n attributes)
  ProtonI18n.loadLanguage().then(() => {
    ProtonI18n.applyTranslations();
    if (driveMode) {
      // Retitle the shared markup for Drive mode.
      document.title = t('driveShareTitle');
      const h2 = document.querySelector('h2');
      if (h2) h2.textContent = t('driveShareTitle');
      const hint = document.querySelector('.hint');
      if (hint) hint.textContent = t('drivePickerHint');
      btnDone.textContent = t('drivePickerDone');
    }
  });

  // Open the keepalive port right away in drive mode so the background service
  // worker stays alive for the whole file-selection session (see _connectPort).
  if (driveMode && uploadId) {
    try { _connectPort(); } catch (_) { /* connected lazily on upload if this fails */ }
  }

  // File-picker byte formatter: ONE decimal place (e.g. "1.2 KB"), intentionally
  // coarser than PopupAttachments.formatSize (two decimals). Kept as a separate
  // local copy so the picker's precision can differ from the attachment list's;
  // do not "deduplicate" the two without an explicit UI decision, since merging
  // would change one surface's displayed precision.
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function renderFileList() {
    const items = driveMode ? pickedFiles : pendingFiles;
    fileList.textContent = '';
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      const item = document.createElement('div');
      item.className = 'file-item';
      item.dataset.index = String(i);

      const row = document.createElement('div');
      row.className = 'file-row';

      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = f.name;

      const size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = formatSize(f.size);

      row.append(name, size);

      if (!uploading) {
        const remove = document.createElement('button');
        remove.className = 'file-remove';
        remove.textContent = '×';
        const idx = i;
        remove.addEventListener('click', () => {
          items.splice(idx, 1);
          renderFileList();
        });
        row.appendChild(remove);
      } else {
        const status = document.createElement('span');
        status.className = 'file-status';
        row.appendChild(status);
      }

      item.appendChild(row);

      if (uploading) {
        const barWrap = document.createElement('div');
        barWrap.className = 'file-bar';
        const bar = document.createElement('div');
        bar.className = 'file-bar-fill';
        barWrap.appendChild(bar);
        item.appendChild(barWrap);

        const result = document.createElement('div');
        result.className = 'file-result hidden';
        item.appendChild(result);
      }

      fileList.appendChild(item);
    }
    btnDone.disabled = items.length === 0;
  }

  async function addFiles(files) {
    if (uploading) return;
    if (driveMode) {
      for (const file of files) pickedFiles.push(file);
      renderFileList();
      return;
    }
    for (const file of files) {
      // Read as base64
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      pendingFiles.push({
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        data,
      });
    }
    renderFileList();
  }

  // Click to browse
  dropZone.addEventListener('click', () => { if (!uploading) fileInput.click(); });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) addFiles(fileInput.files);
    fileInput.value = '';
  });

  // Drag and drop
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  });

  // --- drive mode: port-driven chunk streaming + progress UI ---

  function _fileItem(i) {
    return fileList.querySelector(`.file-item[data-index="${i}"]`);
  }
  function _setStatus(i, text, cls) {
    const item = _fileItem(i);
    if (!item) return;
    const status = item.querySelector('.file-status');
    if (status) { status.textContent = text; status.className = 'file-status' + (cls ? ' ' + cls : ''); }
  }
  function _setBar(i, fraction) {
    const item = _fileItem(i);
    const bar = item && item.querySelector('.file-bar-fill');
    if (bar) bar.style.width = Math.round(fraction * 100) + '%';
  }
  function _showResult(i, url) {
    const item = _fileItem(i);
    const result = item && item.querySelector('.file-result');
    if (!result) return;
    result.textContent = '';
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = url;
    result.appendChild(a);
    result.classList.remove('hidden');
  }

  /** Answer a background NEED_CHUNK with a base64 slice of the kept File. */
  function _sendChunk(fileIndex, offset, length) {
    const file = pickedFiles[fileIndex];
    if (!file) {
      port.postMessage({ type: 'CHUNK', fileIndex, offset, error: 'No such file' });
      return;
    }
    const blob = file.slice(offset, offset + length);
    const reader = new FileReader();
    reader.onload = () => {
      const dataB64 = String(reader.result).split(',')[1] || '';
      port.postMessage({ type: 'CHUNK', fileIndex, offset, dataB64 });
    };
    reader.onerror = () => {
      port.postMessage({ type: 'CHUNK', fileIndex, offset, error: 'Read failed' });
    };
    reader.readAsDataURL(blob);
  }

  async function _reopenPopupAndClose() {
    // Both browsers are MV3, so this is always browser.action; the old
    // browserAction fallback could never have fired.
    const action = browser.action;
    try { await action.openPopup(); } catch (_) {}
    window.close();
  }

  // Connect the keepalive port as soon as the picker loads (NOT on upload
  // click): file selection can take longer than Chrome's ~30 s MV3 idle
  // timeout, and an open port + periodic PING keeps the background service
  // worker, which owns the (memory-only) upload job, alive throughout.
  function _connectPort() {
    if (port) return;
    port = browser.runtime.connect({ name: 'mcpm-drive-upload' });
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      // Any reply means the background bound our HELLO. Clear the ack timer.
      if (helloAckTimer) { clearTimeout(helloAckTimer); helloAckTimer = null; }
      switch (msg.type) {
        case 'BOUND':
          break; // HELLO acknowledged; per-file PROGRESS follows
        case 'NEED_CHUNK':
          _sendChunk(msg.fileIndex, msg.offset, msg.length);
          break;
        case 'PROGRESS':
          if (msg.phase === 'share') _setStatus(msg.fileIndex, t('driveCreatingLink'));
          else _setStatus(msg.fileIndex, t('driveUploading'));
          _setBar(msg.fileIndex, msg.fraction || 0);
          break;
        case 'FILE_DONE':
          _setStatus(msg.fileIndex, msg.editorDenied
            ? t('driveEditorNeedsPaidProton') : t('driveUploadDone'), 'ok');
          _setBar(msg.fileIndex, 1);
          _showResult(msg.fileIndex, msg.url);
          break;
        case 'ERROR':
          if (msg.fileIndex == null) {
            for (let i = 0; i < pickedFiles.length; i++) _setStatus(i, t('driveUploadFailed'), 'err');
            uploading = false;
          } else {
            _setStatus(msg.fileIndex, msg.code === 'DRIVE_QUOTA'
              ? t('driveQuotaExceeded') : t('driveUploadFailed'), 'err');
          }
          break;
        case 'ALL_DONE':
          clearInterval(pingTimer);
          if (msg.cancelled) break;
          if (msg.failed > 0) {
            // At least one file failed. Keep the tab open so the per-file
            // error stays visible (the Cancel button becomes the way out).
            // Any links that DID succeed are already parked and get inserted
            // the next time the popup opens.
            uploading = false;
          } else {
            // All succeeded. Hand back to the popup, which inserts the links.
            setTimeout(_reopenPopupAndClose, 700);
          }
          break;
      }
    });
    port.onDisconnect.addListener(() => {
      clearInterval(pingTimer);
      if (helloAckTimer) { clearTimeout(helloAckTimer); helloAckTimer = null; }
      // A disconnect mid-upload means the background/SW went away: surface it
      // rather than leaving the rows stuck on a spinner.
      if (uploading) {
        for (let i = 0; i < pickedFiles.length; i++) {
          const item = _fileItem(i);
          const s = item && item.querySelector('.file-status');
          if (s && !s.classList.contains('ok') && !s.classList.contains('err')) {
            _setStatus(i, t('driveUploadFailed'), 'err');
          }
        }
        uploading = false;
      }
    });
    pingTimer = setInterval(() => {
      try { port.postMessage({ type: 'PING' }); } catch (_) { clearInterval(pingTimer); }
    }, 20000);
  }

  function startDriveUpload() {
    uploading = true;
    btnDone.classList.add('hidden');
    btnCancel.textContent = t('cancel');
    dropZone.classList.add('hidden');
    renderFileList();
    for (let i = 0; i < pickedFiles.length; i++) _setStatus(i, t('driveQueued'));

    _connectPort(); // usually already open from load; reconnects if the SW died
    // If HELLO gets no reply (e.g. the job was lost to an SW teardown before
    // the port reconnected), surface an error instead of hanging on "Queued".
    helloAckTimer = setTimeout(() => {
      for (let i = 0; i < pickedFiles.length; i++) _setStatus(i, t('driveUploadFailed'), 'err');
      uploading = false;
    }, 15000);

    port.postMessage({
      type: 'HELLO',
      uploadId,
      files: pickedFiles.map((f) => ({
        name: f.name,
        size: f.size,
        type: f.type || 'application/octet-stream',
        modTime: f.lastModified || Date.now(),
      })),
    });
  }

  // Done: attach mode saves to storage; drive mode starts the streamed upload.
  btnDone.addEventListener('click', async () => {
    if (driveMode) {
      if (pickedFiles.length > 0) startDriveUpload();
      return;
    }
    btnDone.disabled = true;
    btnDone.textContent = ProtonI18n.t('saving');

    // Hand the files to the background, which stores them encrypted until
    // the popup picks them up (attachment bytes must not rest in plaintext)
    const res = await browser.runtime.sendMessage({
      type: 'SAVE_PENDING_ATTACHMENTS', attachments: pendingFiles,
    }).catch(() => null);
    if (!res || !res.success) {
      // Encrypt/storage failed (e.g. storage quota with large files). Keep
      // the picker open instead of silently dropping the files.
      btnDone.disabled = false;
      btnDone.textContent = ProtonI18n.t('filepickerSaveFailed');
      return;
    }

    await _reopenPopupAndClose();
  });

  // Cancel: during a drive upload this aborts the background job (the port
  // disconnect on tab close would too; the message is just more direct).
  btnCancel.addEventListener('click', () => {
    if (driveMode && uploading && uploadId) {
      browser.runtime.sendMessage({ type: 'DRIVE_UPLOAD_CANCEL', uploadId }).catch(() => {});
    }
    window.close();
  });
})();
