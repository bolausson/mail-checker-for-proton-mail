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
  // invitationCalendarId
  // ------------------------------------------------------------------
  //
  // The calendar an answered invitation is saved to, picked the way
  // Proton's Mail app picks it (getDefaultCalendar): the user's default
  // calendar (CalendarUserSettings.DefaultCalendarID) when it is an active
  // personal calendar the user owns, otherwise the first such calendar in
  // the user's own order. A calendar shared with the user, a subscription
  // and a disabled calendar never qualify. Returns the ID, or null.
  async function invitationCalendarId(accountId) {
    const [listResult, settingsResult] = await Promise.all([
      ProtonAccounts.request(accountId, 'GET', 'calendar/v1', { params: { ReturnFlags: 1 } }),
      ProtonAccounts.request(accountId, 'GET', 'settings/calendar').catch(() => null),
    ]);
    const defaultCalendarId =
      (settingsResult && settingsResult.CalendarUserSettings &&
       settingsResult.CalendarUserSettings.DefaultCalendarID) || null;
    // CALENDAR_FLAGS (constants.ts): ACTIVE=1, SELF_DISABLED=32,
    // SUPER_OWNER_DISABLED=64. Flags live on Members[0].
    const ACTIVE = 1;
    const DISABLED = 32 | 64;
    const WRITE = 16;
    const owned = ((listResult && listResult.Calendars) || []).filter((c) => {
      const member = c.Members && c.Members[0];
      if (c.Type !== 0 || !member) return false;
      const owner = String((c.Owner && c.Owner.Email) || '').toLowerCase();
      if (!owner || owner !== String(member.Email || '').toLowerCase()) return false;
      if (typeof member.Flags === 'number' && (!(member.Flags & ACTIVE) || (member.Flags & DISABLED))) return false;
      return typeof member.Permissions !== 'number' || (member.Permissions & WRITE) !== 0;
    }).sort((a, b) => (a.Members[0].Priority || 0) - (b.Members[0].Priority || 0));
    const pick = owned.find((c) => c.ID === defaultCalendarId) || owned[0];
    return pick ? pick.ID : null;
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
  //
  // opts.invitee: the payload is an invited attendee's copy of an answered
  // invitation (it sets IsOrganizer and Permissions itself). Proton's Mail
  // app saves those without IsImport, which is meant for .ics imports.
  async function createEvent(accountId, calendarId, memberId, payload, opts) {
    const invitee = !!(opts && opts.invitee);
    const body = {
      MemberID: memberId,
      Events: [{
        Overwrite: 0,
        // Permissions is an ATTENDEE permission in Proton's model (SEE=1,
        // INVITE=2, SEE_AND_INVITE=3). Imports keep the 3 they always sent.
        Event: invitee ? { ...payload } : { ...payload, Permissions: 3 },
      }],
    };
    // IsImport=1 tells the server we're importing an external event
    // rather than the user creating one from scratch: the .ics-attachment
    // use case of the "Add to Proton Calendar" button.
    if (!invitee) body.IsImport = 1;
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

  return { listCalendars, invitationCalendarId, createEvent };
})();
