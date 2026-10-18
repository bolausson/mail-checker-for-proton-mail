#!/usr/bin/env bash
#
# Run AMO's own validator (addons-linter) locally on a freshly-built Firefox
# .xpi: the same check addons.mozilla.org performs server-side at upload.
# Catches innerHTML / eval / permission / manifest issues before you upload,
# instead of discovering them in the AMO queue.
#
# Usage:  npm run lint:amo   (or: bash scripts/lint-amo.sh)
# Exits non-zero if addons-linter reports errors (warnings are shown, not fatal).
set -euo pipefail
cd "$(dirname "$0")/.."

# The file set packed into the Firefox .xpi (the extension ships the source
# verbatim, no node_modules / tests / scripts).
FILES=(manifest.json background/ captcha/ fido2/ icons/ lib/ options/ popup/ README.md LICENSE.md)

XPI="$(mktemp -u).xpi"
trap 'rm -f "$XPI"' EXIT

zip_args=()
for f in "${FILES[@]}"; do
  [[ -e "$f" ]] && zip_args+=("$f")
done
7z a -tzip -mx9 "$XPI" "${zip_args[@]}" > /dev/null

echo "Linting $(basename "$XPI") with addons-linter (AMO's validator)…"
npx addons-linter "$XPI"
