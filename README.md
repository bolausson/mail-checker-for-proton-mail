# Mail Checker for Proton Mail

**Mail Checker for Proton Mail** is a browser extension for Firefox and Chrome that shows
your unread Proton Mail count on the toolbar, notifies you of new mail and lets you read it
in a popup, without keeping Proton Mail open in a tab. Messages are decrypted locally in
your browser. No analytics, no telemetry.

This repository contains the extension's **source code**, updated with every release, so
you can read, audit or build it yourself. Signed builds come from Firefox Add-ons and the
Chrome Web Store; this repository has no installable packages.

[![Latest version](https://img.shields.io/github/v/tag/bolausson/mail-checker-for-proton-mail?label=latest&sort=semver)](https://github.com/bolausson/mail-checker-for-proton-mail/tags)

**[Install for Firefox](https://addons.mozilla.org/firefox/addon/mail-checker-for-proton-mail/)** or **[Install for Chrome](https://chromewebstore.google.com/detail/aapmapnnolfpdnmcekhofnjcnfpnbohp)**, then pin it to the toolbar from the browser's Extensions menu (the puzzle-piece icon) and sign in with your Proton account.

## Requirements

- Firefox 142 or newer on the desktop, or Chrome 121 or newer
- A Proton account (free Proton plans work)
- Optional, for Pro features: **14-day free trial**, then €2.38 / month or €26.18 / year
  (including German VAT; other countries may differ; see *Free & Pro* below)

## Install from Firefox Add-ons

[Firefox Add-ons](https://addons.mozilla.org/firefox/addon/mail-checker-for-proton-mail/) installs the signed extension and keeps it up to date:

<a href="https://addons.mozilla.org/firefox/addon/mail-checker-for-proton-mail/"><img src="https://blog.mozilla.org/addons/files/2020/04/get-the-addon-fx-apr-2020.svg" alt="Get the add-on for Firefox" height="54"></a>

## Install from the Chrome Web Store

The [Chrome Web Store](https://chromewebstore.google.com/detail/aapmapnnolfpdnmcekhofnjcnfpnbohp) installs the signed extension and keeps it up to date:

<a href="https://chromewebstore.google.com/detail/aapmapnnolfpdnmcekhofnjcnfpnbohp"><img src="https://developer.chrome.com/static/docs/webstore/branding/image/iNEddTyWiMfLSwFD6qGq.png" alt="Available in the Chrome Web Store" height="54"></a>

## Free & Pro

The free version covers one account. **Pro** (called Premium inside the extension) adds
the rest; the [pricing page](https://apps.olausson.de/mail_checker_for_proton/#pricing)
compares the two.

**Free:**

- Unread count on the toolbar icon and desktop notifications for new mail
- A check every 15 minutes, and whenever you click **Refresh**
- Message list and plain-text reading in the popup
- Verification codes (2FA/OTP) in new mail shown as a click-to-copy badge
- Open in Proton Mail, mark as read or unread, export as `.eml` (attachments included
  with Pro)
- Sign-in with a password, a separate mailbox password, an authenticator app or a
  security key
- Keyboard navigation, 28 interface languages, and the Classic theme, light or dark to
  match your system

**Pro adds:**

- Unlimited accounts, each with its own label, color, notifications and folders, checked
  as often as every 30 seconds
- HTML view (remote content stays blocked until you allow it), attachments and a pop-out
  window
- Reply, reply all and forward in the popup, and compose in the popup or in Proton Mail:
  rich-text editor, contact autocomplete, encrypted drafts, scheduled send and expiring
  messages
- Calendar invitations with RSVP, and adding `.ics` bookings to Proton Calendar
- File sharing through Proton Drive links instead of attachments
- AI writing assistant (Proton Scribe)
- Quick and bulk actions (archive, move, label, star, snooze, spam and more), quiet mail
  rules, Do Not Disturb, notification sounds and click actions
- 18 more themes, your choice of light or dark, popup size, density and custom CSS
- Your own verification-code patterns, and settings export, import and sync

The AI assistant also needs Proton Scribe on your Proton account, set to run on Proton's
servers.

**14-day free trial:** click **Start 14-Day Free Trial** at the top of the extension's
settings. It needs no payment details and is offered once. When it ends, the free limits
return. Pro settings go back to their defaults, and your own choices return when you
subscribe.

## Subscribing / activating

Pro is bought on the website and activated in the extension:

1. Subscribe at **<https://apps.olausson.de/mail_checker_for_proton/checkout.html>**
   (monthly or yearly; Paddle handles the payment).
2. After checkout, the page shows your **subscription ID** (starts with `sub_`). Copy it.
3. In the extension: **Settings → Premium & License**, paste the ID into **License key**,
   click **Activate**.
4. Keep the subscription ID somewhere safe (a password manager): you may need it to
   activate Pro again after reinstalling or in another browser.

To change the payment method or cancel, use **Update payment method** or **Cancel
subscription** under **Premium & License**.

## Updates & signing

The source of each store release is tagged here with its version (for example `v2.0.0`).
A copy loaded from this source is **unsigned**: release versions of Firefox load it only as
a temporary add-on, and Chrome only in developer mode.

## Run from source

**Firefox** needs no build step:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and pick `manifest.json` in the repository root.

It stays loaded until Firefox restarts. It has the same add-on ID as the store version, so
use a separate Firefox profile if the store version is installed.

**Chrome** needs a build first:

1. Run `node scripts/build-chrome.js`. It writes an unpacked extension to `dist/chrome`.
   Without the publisher's signing key it skips the signed package, which you don't need.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick
   the `dist/chrome` folder.

**Tests and checks** run on Node.js 22.13+ or 24+. Run `npm ci` once, then `npm test`
(Vitest) and `npm run lint` (ESLint). `npm run lint:amo` runs Mozilla's addons-linter on
the Firefox files (needs bash and 7-Zip's `7z`).

## Privacy

- Mail is decrypted locally with OpenPGP.js. There are no analytics and no telemetry.
- Sign-in uses Proton's SRP protocol, so your password never leaves your device.
- Besides Proton (`*.proton.me`), the extension contacts the license server only when you
  activate or hold a Pro license key, hCaptcha only during Proton's human verification,
  and other servers only when you load a message's remote content (once, or always through
  a setting) or turn on the sender-favicon fallback.

Details: the [privacy policy](https://apps.olausson.de/privacy-policy.txt), and
[docs/permissions.md](docs/permissions.md) for what each permission is used for.

## License

Mail Checker for Proton Mail is **source-available** under the
[PolyForm Shield License 1.0.0](LICENSE.md): you may use, study, modify and share it for
any purpose except providing a product that competes with it (or with another product the
licensor provides using it), even a free one. The license file has the full terms and the
required notice.

Third-party components keep their own licenses: OpenPGP.js (LGPL-3.0-or-later, with
bundled packages under MIT and the Unlicense), bcrypt.js (Apache-2.0), and the Bootstrap
Icons and Feather icons (MIT). See [lib/THIRD-PARTY-NOTICES.md](lib/THIRD-PARTY-NOTICES.md).

Mail Checker for Proton Mail is an independent project, not affiliated with or endorsed by
Proton AG. "Proton" and "Proton Mail" are trademarks of Proton AG.

## Support

Development happens in a private repository, so pull requests can't be merged here. For
questions, bug reports and suggestions, open an
[issue](https://github.com/bolausson/mail-checker-for-proton-mail/issues) or email
<support+mcpm@olausson.de>. A diagnostic log helps with bug reports: **Settings → Data →
Export diagnostic log**. It contains your account email addresses, your browser version and
technical events (with debug logging on, also sender addresses), never passwords or full
tokens, so please send it by email only, never in a public issue.

## Links

- Website: <https://apps.olausson.de/>
- Pricing: <https://apps.olausson.de/mail_checker_for_proton/#pricing>
- Privacy policy: <https://apps.olausson.de/privacy-policy.txt>
- Terms and conditions: <https://apps.olausson.de/terms-and-conditions.txt>
