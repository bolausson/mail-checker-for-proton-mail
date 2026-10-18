/**
 * Attachment handling utilities for the popup.
 *
 * Provides file icon mapping, size formatting, attachment list rendering,
 * attachment download, and info modal display.
 *
 * Extracted from popup.js to reduce that file's size.
 * Dependencies (ProtonI18n, showToast, _setHTML) are injected via function
 * parameters where needed.
 */

const PopupAttachments = (() => {

  /**
   * Format a byte count as a human-readable size string.
   *
   * Uses TWO decimal places (e.g. "1.23 KB") for the attachment list. The file
   * picker (popup/filepicker.js) has its own one-decimal copy on purpose: the
   * two surfaces show different precision, so the duplication is intentional.
   * @param {number} bytes
   * @returns {string} e.g. "1.23 KB", "4.56 MB"
   */
  /**
   * True when the message body draws this attachment itself, via a cid:
   * reference. Proton marks these `Content-Disposition: inline` and gives them
   * a Content-ID; header casing varies by sending client, so check both.
   */
  function isEmbeddedAttachment(att) {
    const h = (att && att.Headers) || {};
    const disp = String(h['content-disposition'] || h['Content-Disposition'] || '').toLowerCase();
    const cid = String(h['content-id'] || h['Content-ID'] || '').trim();
    return !!cid && disp.indexOf('inline') === 0;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  /**
   * Get an emoji icon for a file based on MIME type or filename.
   * @param {string} mimeOrName - MIME type string or filename.
   * @returns {string} Emoji character.
   */
  function getFileIcon(mimeOrName) {
    const s = (mimeOrName || '').toLowerCase();
    if (s.includes('image')) return '\uD83D\uDDBC';
    if (s.includes('pdf')) return '\uD83D\uDCC4';
    if (s.includes('zip') || s.includes('archive') || s.includes('compressed')) return '\uD83D\uDDDC';
    if (s.includes('audio') || s.includes('mp3') || s.includes('wav')) return '\uD83C\uDFB5';
    if (s.includes('video') || s.includes('mp4')) return '\uD83C\uDFA5';
    if (s.includes('spreadsheet') || s.includes('excel') || s.includes('.xls')) return '\uD83D\uDCCA';
    if (s.includes('presentation') || s.includes('powerpoint') || s.includes('.ppt')) return '\uD83D\uDCCA';
    if (s.includes('document') || s.includes('word') || s.includes('.doc')) return '\uD83D\uDCC3';
    if (s.includes('text')) return '\uD83D\uDCC4';
    return '\uD83D\uDCCE';
  }

  /**
   * Download an attachment via the background script.
   *
   * @param {object} att - Attachment object with ID, Name, MIMEType, KeyPackets.
   * @param {string} accountId
   * @param {HTMLElement} btn - Download button (shows spinner during download).
   * @param {Function} showToast - Toast notification function.
   */
  async function downloadAttachment(att, accountId, btn, showToast, senderAddress) {
    const origText = btn.textContent;
    btn.textContent = '\u23F3';
    btn.disabled = true;

    const keyPackets = att.KeyPackets || null;

    try {
      const result = await browser.runtime.sendMessage({
        type: 'GET_ATTACHMENT',
        attachmentId: att.ID,
        accountId,
        keyPackets,
        signature: att.Signature || null,
        senderAddress: senderAddress || null,
      });

      if (result.error) {
        showToast(ProtonI18n.t('downloadFailed'));
        return;
      }

      // We sent key packets, so the bytes were supposed to come back
      // decrypted. decrypted === false means they are still PGP ciphertext.
      // Saving those under att.Name would hand the user a file that looks
      // right and is unreadable, which is worse than a visible failure, so
      // refuse the download instead.
      if (keyPackets && result.decrypted === false) {
        showToast(ProtonI18n.t('downloadFailed'));
        return;
      }

      // Convert base64 to blob and trigger download
      const binary = atob(result.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: att.MIMEType || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.Name || 'attachment';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(ProtonI18n.t('downloadFailed'));
    } finally {
      btn.textContent = origText;
      btn.disabled = false;
    }
  }

  /**
   * Open an attachment in a new browser tab (blob URL, served from the
   * background page so it survives popup close).
   */
  async function openAttachment(att, accountId, item, showToast, senderAddress) {
    item.classList.add('loading');
    try {
      const result = await browser.runtime.sendMessage({
        type: 'OPEN_ATTACHMENT',
        attachmentId: att.ID,
        accountId,
        keyPackets: att.KeyPackets || null,
        signature: att.Signature || null,
        senderAddress: senderAddress || null,
        mimeType: att.MIMEType || 'application/octet-stream',
        filename: att.Name || 'attachment',
      });
      if (result && result.error) {
        showToast(ProtonI18n.t('downloadFailed'));
        return;
      }
      // Tab opened. Close the popup so the new tab has focus.
      window.close();
    } catch (err) {
      showToast(ProtonI18n.t('downloadFailed'));
    } finally {
      item.classList.remove('loading');
    }
  }

  /**
   * Render the attachment list for a message preview.
   *
   * @param {object} fullMsg - Message object with Attachments array.
   * @param {string} accountId
   * @param {Function} showToast - Toast notification function.
   * @param {Map<string,string>} [inlined] - Embedded images already displayed in
   */
  function renderAttachmentList(fullMsg, accountId, showToast) {
    const container = document.getElementById('preview-attachments');
    container.textContent = '';
    container.classList.add('hidden');

    // Embedded images are listed too, exactly as Proton's own web client does:
    // being drawn in the body does not make a file unreachable. Hiding them
    // once meant a message whose only attachment was embedded looked as if it
    // had none.
    const attachments = fullMsg.Attachments || [];
    if (attachments.length === 0) return;

    container.classList.remove('hidden');

    const embedded = attachments.filter(isEmbeddedAttachment).length;
    const plain = attachments.length - embedded;
    const totalSize = attachments.reduce((s, a) => s + (a.Size || 0), 0);

    const header = document.createElement('div');
    header.className = 'attachments-header';
    const total = document.createElement('span');
    total.className = 'attachments-total';
    total.textContent = formatSize(totalSize);
    header.appendChild(total);
    const counts = [];
    if (plain > 0) counts.push(ProtonI18n.plural('attachmentsCount', plain));
    if (embedded > 0) counts.push(ProtonI18n.plural('embeddedImagesCount', embedded));
    if (counts.length) {
      const detail = document.createElement('span');
      detail.className = 'attachments-detail';
      detail.textContent = counts.join(', ');
      header.appendChild(detail);
    }
    container.appendChild(header);

    const list = document.createElement('div');
    list.className = 'attachments-list';

    for (const att of attachments) {
      const item = document.createElement('div');
      item.className = 'attachment-item';
      item.title = ProtonI18n.t('openInTab') || 'Open in new tab';

      const icon = document.createElement('span');
      icon.className = 'attachment-icon';
      icon.textContent = getFileIcon(att.MIMEType || att.Name || '');

      const info = document.createElement('div');
      info.className = 'attachment-info';
      const name = document.createElement('span');
      name.className = 'attachment-name';
      name.textContent = att.Name || ProtonI18n.t('unnamed');
      const size = document.createElement('span');
      size.className = 'attachment-size';
      size.textContent = formatSize(att.Size || 0);
      info.appendChild(name);
      info.appendChild(size);

      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'attachment-download';
      downloadBtn.title = ProtonI18n.t('download');
      downloadBtn.textContent = '\u2B07';
      const senderAddress = (fullMsg.Sender && fullMsg.Sender.Address) || null;
      downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadAttachment(att, accountId, downloadBtn, showToast, senderAddress);
      });

      item.addEventListener('click', () => {
        openAttachment(att, accountId, item, showToast, senderAddress);
      });

      item.appendChild(icon);
      item.appendChild(info);
      item.appendChild(downloadBtn);
      list.appendChild(item);
    }

    container.appendChild(list);
  }

  /**
   * Show a modal overlay with content (used for message headers/details).
   *
   * @param {string} title - Modal title.
   * @param {string} content - Body content (HTML or plain text).
   * @param {boolean} isPlainText - If true, content is rendered in a <pre> tag.
   * @param {Function} setHTMLFn - Safe HTML setter function.
   */
  function showInfoModal(title, content, isPlainText, setHTMLFn) {
    const existing = document.getElementById('info-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'info-modal';
    overlay.className = 'info-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'info-modal';

    const header = document.createElement('div');
    header.className = 'info-modal-header';
    const h2 = document.createElement('h2');
    h2.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'info-modal-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(h2);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'info-modal-body';
    if (isPlainText) {
      const pre = document.createElement('pre');
      pre.textContent = content;
      body.appendChild(pre);
    } else {
      setHTMLFn(body, content);
    }

    modal.appendChild(header);
    modal.appendChild(body);
    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  return {
    formatSize,
    isEmbeddedAttachment,
    getFileIcon,
    downloadAttachment,
    openAttachment,
    renderAttachmentList,
    showInfoModal,
  };
})();
