/**
 * "Add to Proton Calendar" button + calendar picker.
 *
 * Invoked from popup/calendar-utils.js when an inbound .ics carries
 * METHOD:PUBLISH (or other non-REQUEST methods that represent
 * one-way publication: flight confirmations, hotel bookings, etc.).
 *
 * Renders a button (or button + dropdown if the user has more than
 * one writable calendar) into the same container as the rest of the
 * calendar invite UI. On click, dispatches ADD_ICS_TO_CALENDAR with
 * the raw ICS text; the background handles parsing, encryption, and
 * the API POST.
 */
const PopupCalendarAdd = (() => {
  // Cache the in-flight promise (not just the resolved array) per
  // account: when a message has multiple .ics attachments, every card
  // calls render() concurrently and would otherwise all race-fetch
  // before any has populated a value-cache. Storing the promise
  // collapses the duplicate calls. Cache is reset on each popup open
  // (module re-evaluated), which is fine: calendars are long-lived.
  const _calendarsByAccount = new Map();

  // Build the calendar webmail URL pointing at a specific day so the
  // user lands on (or near) the event after clicking "Open". The
  // path layout `/u/<slot>/day/<year>/<month>/<day>` is the same one
  // Proton's WebUI uses internally. See WebClients/applications/
  // calendar/src/app/containers/calendar/getUrlHelper.ts. If we
  // don't have a slot mapping or the event has no dtstart, fall back
  // to the slot-less calendar root.
  async function _getCalendarUrl(accountId, dtstart) {
    let slotSegment = '';
    try {
      const mailUrl = await browser.runtime.sendMessage({
        type: 'GET_MAIL_URL', accountId,
      });
      if (typeof mailUrl === 'string') {
        const m = mailUrl.match(/^https?:\/\/mail\.proton\.me\/(u\/\d+\/)?/);
        if (m && m[1]) slotSegment = m[1];
      }
    } catch (_) { /* fall through */ }

    let dateSegment = '';
    if (dtstart instanceof Date && !isNaN(dtstart.getTime())) {
      const y = dtstart.getUTCFullYear();
      const mo = dtstart.getUTCMonth() + 1;
      const d = dtstart.getUTCDate();
      dateSegment = `day/${y}/${mo}/${d}`;
    }
    return 'https://calendar.proton.me/' + slotSegment + dateSegment;
  }

  function _renderOpenButton(host, accountId, event) {
    const group = document.createElement('div');
    group.className = 'calendar-action-group';
    const btn = document.createElement('button');
    btn.className = 'calendar-invite-btn';
    btn.type = 'button';
    btn.textContent = ProtonI18n.t('openInProtonCalendar');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const url = await _getCalendarUrl(accountId, event && event.dtstart);
        await browser.tabs.create({ url });
        window.close();
      } catch (_) {
        btn.disabled = false;
      }
    });
    group.appendChild(btn);
    host.appendChild(group);
  }

  function _getCalendars(accountId) {
    if (_calendarsByAccount.has(accountId)) return _calendarsByAccount.get(accountId);
    const p = browser.runtime
      .sendMessage({ type: 'GET_CALENDARS', accountId })
      .then(res => (res && res.calendars) || []);
    _calendarsByAccount.set(accountId, p);
    return p;
  }

  /**
   * Render the add-to-calendar UI into `host`.
   *
   * Mirrors Proton's WebUI behaviour: when the event is already saved
   * (matched by UID across all the user's calendars), show an "Open
   * in Proton Calendar" button instead of "Add to Proton Calendar".
   * If multiple writable calendars exist and the event isn't saved
   * yet, also show a picker to choose which calendar to add to.
   *
   * @param {object} event - Parsed event from PopupCalendar.parseICS().
   * @param {string} icsText - Raw ICS source.
   * @param {string} accountId - Owner account.
   * @param {HTMLElement} host - Container the UI is rendered into.
   * @param {{ showToast: (msg:string)=>void }} ctx
   */
  async function render(event, icsText, accountId, host, ctx) {
    // Existence check + calendar list run in parallel: we'll only use
    // the calendar list if the event doesn't exist yet, but starting
    // both now keeps render latency dominated by the slower of the two.
    const [existenceRes, calendars] = await Promise.all([
      browser.runtime.sendMessage({
        type: 'CHECK_CALENDAR_EVENT_EXISTS', accountId, uid: event.uid,
      }).catch(() => ({ exists: false })),
      _getCalendars(accountId),
    ]);

    if (existenceRes && existenceRes.exists) {
      _renderOpenButton(host, accountId, event);
      return;
    }

    if (!calendars.length) {
      // No writable calendars: nothing to add to. Show a static note
      // so the user understands why no button appears.
      const note = document.createElement('div');
      note.className = 'calendar-invite-status';
      note.textContent = ProtonI18n.t('noWritableCalendar');
      host.appendChild(note);
      return;
    }

    // Render the Add button + optional picker as a single
    // split-button-style group. The group becomes one child of the
    // shared .calendar-invite-actions flex row owned by calendar-utils.
    const group = document.createElement('div');
    group.className = 'calendar-action-group';

    const btn = document.createElement('button');
    btn.className = 'calendar-invite-btn';
    btn.type = 'button';
    btn.textContent = ProtonI18n.t('addToProtonCalendar');

    // Pick the default calendar (Priority 1) when there's a single
    // choice or when the user has many. The picker overrides it.
    let selected = calendars.find(c => c.isDefault) || calendars[0];

    let picker = null;
    if (calendars.length > 1) {
      picker = document.createElement('select');
      picker.className = 'calendar-add-picker';
      picker.setAttribute('aria-label', ProtonI18n.t('selectCalendar'));
      for (const c of calendars) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name || c.id;
        if (c.isDefault) opt.title = ProtonI18n.t('defaultCalendarBadge');
        if (c === selected) opt.selected = true;
        picker.appendChild(opt);
      }
      picker.addEventListener('change', () => {
        selected = calendars.find(c => c.id === picker.value) || selected;
      });
    }

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      if (picker) picker.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = ProtonI18n.t('addingToCalendar');
      try {
        const res = await browser.runtime.sendMessage({
          type: 'ADD_ICS_TO_CALENDAR',
          accountId,
          calendarId: selected.id,
          icsText,
        });
        if (res && res.success) {
          ctx.showToast && ctx.showToast(ProtonI18n.t('addedToCalendarToast'));
          // Swap our group for the Open button so the user can jump
          // straight to the event they just saved (and so they don't
          // re-click and create a duplicate: Proton's API doesn't
          // dedupe by UID on the sync endpoint).
          const parent = group.parentNode;
          parent.removeChild(group);
          _renderOpenButton(parent, accountId, event);
          // Put the Open button before the trailing Open-in-Mail icon
          // so the primary action stays leftmost.
          const inserted = parent.lastChild;
          const firstChild = parent.firstChild;
          if (inserted && firstChild && inserted !== firstChild) {
            parent.insertBefore(inserted, firstChild);
          }
        } else {
          const errMsg = (res && res.error) || ProtonI18n.t('addToCalendarFailed');
          btn.textContent = originalText;
          btn.disabled = false;
          if (picker) picker.disabled = false;
          ctx.showToast && ctx.showToast(errMsg);
        }
      } catch (e) {
        btn.textContent = originalText;
        btn.disabled = false;
        if (picker) picker.disabled = false;
        ctx.showToast && ctx.showToast(ProtonI18n.t('addToCalendarFailed'));
        console.warn('[CalendarAdd] failed:', e.message);
      }
    });

    group.appendChild(btn);
    if (picker) group.appendChild(picker);
    host.appendChild(group);
  }

  return { render };
})();
