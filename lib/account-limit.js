/**
 * ProtonAccountLimit: free-tier "one account" rule.
 *
 * The free plan includes a single Proton account, so a login that would ADD a
 * second one is refused. The subtlety this module exists for: signing in again
 * to an account you already have is NOT adding one.
 *
 * When a session dies server-side the account stays in the list with
 * `authError: 'reauth'` and the popup offers "Sign in". That re-login goes
 * through the same ADD_ACCOUNT message, so a naive `accounts.length >= 1`
 * check permanently locked free users out of their own mailbox. The advertised
 * free tier became unusable after the first session expiry (reported
 * 2026-07-27). Account completion has always handled re-auth correctly
 * (it updates the existing account in place); the gate simply never let it
 * get there.
 *
 * Identity is only known for certain AFTER authenticating, so the rule is
 * applied twice: cheaply here on the typed identifier before the network
 * round-trip, and authoritatively in accounts.js once the server has told us
 * who logged in. Both use findByLogin() so they can never disagree and let a
 * duplicate account slip through.
 */
const ProtonAccountLimit = (() => {
  'use strict';

  const FREE_ACCOUNT_LIMIT = 1;

  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

  /** Does this account answer to the given login identifier (Proton username
   *  or any of its addresses)? Case-insensitive: Proton treats addresses
   *  case-insensitively, and the account list stores whatever casing the
   *  server or the user first supplied. */
  function matchesLogin(account, identifier) {
    const id = norm(identifier);
    if (!id || !account) return false;
    return norm(account.username) === id || norm(account.email) === id;
  }

  /** The account a login identifier refers to, or null. */
  function findByLogin(accounts, identifier) {
    if (!Array.isArray(accounts) || !norm(identifier)) return null;
    return accounts.find((a) => matchesLogin(a, identifier)) || null;
  }

  /** An account that currently can't be used: its session is dead and it is
   *  waiting for exactly the re-login this module must not block. */
  function isUnusable(account) {
    return !!(account && account.authError);
  }

  /**
   * Should this login attempt be refused because of the free-tier limit?
   *
   * Allowed when: the user is premium, the identifier belongs to an account
   * they already have (re-auth), they are below the limit, or every account
   * they have is unusable (they have no working mailbox, so this is a recovery
   * attempt rather than a second account: accounts.js makes the final call
   * once the real identity is known).
   *
   * @param {{accounts: Array, identifier: string, isPremium: boolean}} o
   * @returns {boolean}
   */
  function blocksFreeLogin(o) {
    const accounts = Array.isArray(o && o.accounts) ? o.accounts : [];
    if (o && o.isPremium) return false;
    if (accounts.length < FREE_ACCOUNT_LIMIT) return false;
    if (findByLogin(accounts, o && o.identifier)) return false;
    if (accounts.every(isUnusable)) return false;
    return true;
  }

  /**
   * Authoritative rule, applied once the server has confirmed the login is for
   * an account we do NOT already hold: would storing it exceed the free tier?
   *
   * Deliberately stricter than blocksFreeLogin: it has no "all accounts are
   * broken" exception. That exception exists only to let a recovery attempt
   * reach the network; letting it through here too would hand a free user two
   * accounts (add a second while the first is expired, then re-auth the first).
   *
   * @param {{accounts: Array, isPremium: boolean}} o
   * @returns {boolean}
   */
  function blocksNewAccount(o) {
    const accounts = Array.isArray(o && o.accounts) ? o.accounts : [];
    if (o && o.isPremium) return false;
    return accounts.length >= FREE_ACCOUNT_LIMIT;
  }

  return {
    matchesLogin, findByLogin, isUnusable,
    blocksFreeLogin, blocksNewAccount, FREE_ACCOUNT_LIMIT,
  };
})();

if (typeof window !== 'undefined') window.ProtonAccountLimit = ProtonAccountLimit;
