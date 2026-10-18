/**
 * Thin wrapper over Proton's Calendar API endpoints used by the
 * "Add to Proton Calendar" flow. All requests go through
 * ProtonAccounts.request so they share auth/refresh handling.
 *
 * Wire format references (cross-checked against Proton's WebClients):
 *   - List:  GET  calendar/v1                       → { Calendars: [...] }
 *     (NOT calendar/v1/calendars, see queryCalendars in
 *      packages/shared/lib/api/calendars.ts)
 *   - Bootstrap: GET calendar/v2/<id>/bootstrap     → handled by accounts.js
 *   - Create: PUT calendar/v1/<id>/events/sync      → batch event sync
 */
const ProtonCalendarAPI = (() => {
  // ------------------------------------------------------------------
  // listCalendars
  // ------------------------------------------------------------------
  //
  // Returns the user's *writable, personal* calendars (Type === 0,
  // Permissions admin/owner). Subscribed and holiday calendars are
  // read-only and rejected by the Create-Event endpoint, so we
  // filter them out client-side instead of surfacing them in the
  // picker and then erroring on save.
  async function listCalendars(accountId) {
    // Proton's WebClient calls GET calendar/v1 (NOT calendar/v1/calendars)
    // with OrderBy=ASCENDING (1) and ReturnFlags=YES (1). See
    // packages/shared/lib/api/calendars.ts:queryCalendars.
    // We also fetch the user's calendar settings in parallel for the
    // DefaultCalendarID, which is the source of truth for the "default"
    // marker shown in the Proton WebUI (member.Priority is unrelated).
    const [listResult, settingsResult] = await Promise.all([
      ProtonAccounts.request(accountId, 'GET', 'calendar/v1', {
        params: { OrderBy: 1, ReturnFlags: 1 },
      }),
      ProtonAccounts.request(accountId, 'GET', 'settings/calendar').catch(() => null),
    ]);

    const all = (listResult && listResult.Calendars) || [];
    const defaultCalendarId =
      (settingsResult && settingsResult.CalendarUserSettings &&
       settingsResult.CalendarUserSettings.DefaultCalendarID) || null;

    // CALENDAR_PERMISSIONS bits (constants.ts):
    //   SUPER_OWNER=1, OWNER=2, ADMIN=4, READ_MEMBER_LIST=8,
    //   WRITE=16, READ=32, AVAILABILITY=64
    // Permissions lives on Members[0] (VisualCalendar flattens it).
    const WRITE = 16;
    const TYPE_PERSONAL = 0;

    const writable = all
      .filter(c => {
        if (c.Type !== TYPE_PERSONAL) return false;
        const member = c.Members && c.Members[0];
        if (!member || typeof member.Permissions !== 'number') return true;
        return (member.Permissions & WRITE) !== 0;
      })
      .map(c => {
        const member = (c.Members && c.Members[0]) || {};
        return {
          id: c.ID,
          name: member.Name || '(unnamed)',
          color: member.Color || '',
          isDefault: c.ID === defaultCalendarId,
        };
      });

    // Sort the default calendar to the top so it's the pre-selected
    // option in the popup's dropdown.
    writable.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
    return writable;
  }

  // ------------------------------------------------------------------
  // createEvent
  // ------------------------------------------------------------------
  //
  // Creates an event via PUT calendar/v1/<calendarId>/events/sync,
  // the same endpoint Proton's own WebClient uses (syncMultipleEvents
  // in packages/shared/lib/api/calendars.ts). Even single creates go
  // through the batch endpoint; there is no POST .../events route.
  //
  // The request wraps the serialized payload inside a Events[] array
  // alongside the MemberID identifying the user's membership in that
  // calendar. The response carries a Responses[] array with one entry
  // per submitted event.
  async function createEvent(accountId, calendarId, memberId, payload) {
    const body = {
      MemberID: memberId,
      // IsImport=1 tells the server we're importing an external event
      // rather than the user creating one from scratch. It relaxes
      // a couple of "you're the organizer" invariants and matches the
      // .ics-attachment use case here.
      IsImport: 1,
      Events: [{
        Overwrite: 0,
        Event: {
          ...payload,
          // Permissions = 3 (read + write) is what Proton's WebClient
          // sends for the creator's own event.
          Permissions: 3,
        },
      }],
    };
    const result = await ProtonAccounts.request(accountId, 'PUT',
      `calendar/v1/${calendarId}/events/sync`, { data: body });

    const first = result && result.Responses && result.Responses[0];
    if (!first || !first.Response) {
      throw new Error('Empty calendar sync response');
    }
    const r = first.Response;
    // Code 1000 = success per Proton's API convention. Anything else
    // is an error and r.Error usually carries the human-readable
    // message we can surface.
    if (r.Code !== 1000) {
      throw new Error(r.Error || ('Calendar API error (code ' + r.Code + ')'));
    }
    return r.Event;
  }

  return { listCalendars, createEvent };
})();
