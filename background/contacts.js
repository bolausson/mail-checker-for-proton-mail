/**
 * Contact email management for Proton Mail Checker.
 *
 * Provides contact email fetching and search for compose autocomplete.
 * Uses a per-account cache with 5-minute TTL to minimize API calls.
 *
 * Extracted from accounts.js to reduce that module's size.
 * Depends on ProtonAccounts.request() for authenticated API calls.
 */

const ProtonContacts = (() => {
  const _cache = {}; // accountId -> { emails: [], fetchedAt }
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Fetch all contact emails for an account (paginated, cached).
   * @param {string} accountId
   * @returns {Array<{ email: string, name: string, contactId: string }>}
   */
  async function getContactEmails(accountId) {
    const cached = _cache[accountId];
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      return cached.emails;
    }

    const contacts = [];
    let page = 0;
    const pageSize = 1000;

    // Fetch all contact emails (paginated)
    while (true) {
      const result = await ProtonAccounts.request(accountId, 'GET', 'contacts/v4/contacts/emails', {
        params: { Page: page, PageSize: pageSize },
      });
      const items = result.ContactEmails || [];
      for (const c of items) {
        contacts.push({
          email: c.Email,
          name: c.Name || '',
          contactId: c.ContactID,
        });
      }
      if (items.length < pageSize) break;
      page++;
    }

    _cache[accountId] = { emails: contacts, fetchedAt: Date.now() };
    return contacts;
  }

  /**
   * Search contacts by query string (matches name or email, max 10 results).
   * @param {string} accountId
   * @param {string} query - Search string (min 1 char).
   * @returns {Array<{ email: string, name: string, contactId: string }>}
   */
  async function searchContacts(accountId, query) {
    if (!query || query.length < 1) return [];
    const contacts = await getContactEmails(accountId);
    const q = query.toLowerCase();
    return contacts.filter(c =>
      c.email.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q)
    ).slice(0, 10);
  }

  return {
    getContactEmails,
    searchContacts,
  };
})();
