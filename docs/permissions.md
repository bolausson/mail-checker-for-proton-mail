# Permission justifications (AMO / CWS reviewer reference)

Last updated: 2026-10-18 (v2.0.0)

Every permission in `manifest.json`, what it is used for, and where in the code.

| Permission | Why it is needed | Code |
|---|---|---|
| `alarms` | All scheduling: mail polling (survives MV3 service-worker shutdown), an hourly token-refresh safety check (rotates only after 12 h), DND expiry, the licence check (shortly after each billing date and at most 30 days apart; daily while a payment is outstanding or the subscription is paused; a few times in the two hours after the user goes to update the payment method; retries every 1 to 6 hours while the licence server cannot be reached), key-unlock retries, blob-URL revocation. | `background/poller.js`, `accounts.js`, `dnd.js`, `premium.js`, `background.js` |
| `storage` | Account state (AES-256-GCM-encrypted credentials in `storage.local`), unsent compose/reply drafts incl. attachments (also AES-256-GCM-encrypted), `storage.session` (memory only, this browser run, never written to disk): the poll snapshot, the IDs already notified, and a 30-minute copy of the account's user and address data (armored keys stay passphrase-protected) so a background restart does not refetch it; settings sync (`storage.sync`: display metadata plus the Pro licence key, gated on the user's sync toggle; never Proton credentials). | `background/encryption.js`, `accounts.js`, `background.js` (SAVE_DRAFT), `options/options.js` |
| `notifications` | New-mail desktop notifications and one-time auth-failure alerts. | `background/notifier.js` |
| `declarativeNetRequestWithHostAccess` | CSP shim: removes `Content-Security-Policy` and `X-Frame-Options` on `account.proton.me`, `verify.proton.me` and `verify-api.proton.me` so Proton's own hCaptcha iframe can render during human verification. Armed **only** on the human-verification branch of login, never for 2FA or mailbox-password, and removed as soon as the flow ends (or after 15 minutes if the CAPTCHA is abandoned). Session rules: kept in memory, never written to disk. Scoped by host permission. | `background/csp-shim.js`, armed at `background/background.js` (`_setPendingLogin`) |
| `scripting` | Injects the FIDO2 bridge when a security-key login is in progress (page context needed for `navigator.credentials` with proton.me rpId). Also reads, via an open `mail.proton.me` tab, the web client's session slots (localStorage `ps-*`) and its per-client conversation-grouping setting (`GET /api/mail/v4/settings` with the tab's own session) so "Open in Proton Mail" links use the URL form the web UI expects. | `lib/scripting-shim.js`, `fido2/`, `background/url-detection.js`, `background/accounts.js` (`refreshWebViewModes`) |
| `offscreen` (Chrome build only) | Notification sound playback: Chrome MV3 service workers have no `AudioContext`. | `background/audio-bridge.js`, `offscreen/` |
| Host `*://*.proton.me/*` | All mail/calendar API traffic plus the two content scripts (captcha relay, FIDO2 bridge) which only activate during sign-in flows. | `manifest.json` |

Notes for reviewers:

- The extension's own API requests go **only** to `*.proton.me`, plus `mcpm-license.olausson.de` for premium license validation while a license key is set (no mail data, no PII beyond the license key). Other hosts are reached only through user choices or Proton's own pages: a message's remote content once the user loads it, the sender's favicon when the opt-in favicon fallback is on, and hCaptcha inside Proton's human-verification page.
- Content scripts run at `document_start` on `*.proton.me` but are inert except during an extension-initiated CAPTCHA or security-key sign-in.
- `content_security_policy.extension_pages` is set explicitly (`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`), same policy as Proton Pass.
- No remote code, no analytics, no telemetry. Vendored libraries: OpenPGP.js v6.3.1, bcrypt.js.
