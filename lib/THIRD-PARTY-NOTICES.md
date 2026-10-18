# Third-party software

Mail Checker for Proton Mail includes the third-party software listed below. It
is not covered by the extension's own license (LICENSE.md) but by its own
licenses, whose full texts are in lib/licenses/.

## OpenPGP.js

- Files: lib/openpgp.min.js, lib/openpgp.min.js.map
- Version: 6.3.1 of @protontech/openpgp, Proton's fork of OpenPGP.js, identical
  to dist/ in the npm package (built from commit
  36198c3369ab8d4a02d70372d62f1aa8bc247dcb)
- License: GNU Lesser General Public License v3.0 or later
  (lib/licenses/LGPL-3.0.txt), which supplements the GNU General Public
  License v3.0 (lib/licenses/GPL-3.0.txt)
- Source: https://github.com/ProtonMail/openpgpjs and https://openpgpjs.org/

The extension loads lib/openpgp.min.js as a separate file, so it can be
replaced with any compatible build of the library.

### Packages bundled inside lib/openpgp.min.js

| Package | Version | License | Copyright |
|---|---|---|---|
| @noble/ciphers | 1.3.0 | MIT | Copyright (c) 2022 Paul Miller (https://paulmillr.com); Copyright (c) 2016 Thomas Pornin <pornin@bolet.org> |
| @noble/curves | 1.9.7 | MIT | Copyright (c) 2022 Paul Miller (https://paulmillr.com) |
| @noble/hashes | 1.8.0 and 1.6.0 | MIT | Copyright (c) 2022 Paul Miller (https://paulmillr.com) |
| @noble/post-quantum | 0.2.1 | MIT | Copyright (c) 2024 Paul Miller (https://paulmillr.com) |
| @openpgp/web-stream-tools | 0.3.1 | MIT | Copyright (c) 2018 Proton Technologies A.G. |
| @openpgp/unbzip2-stream | 2.0.0 | MIT | Copyright (c) 2017 by Jan Boelsche (jan@lagomorph.de); Copyright 2011 by antimatter15 (antimatter15@gmail.com); based on micro-bunzip by Rob Landley (rob@landley.net) |
| argon2id, including its two WebAssembly modules | 1.0.1 | MIT | Copyright (c) 2022, Proton AG; Copyright (c) 2017, Emil Bay github@tixz.dk (for original blake2b code from https://github.com/emilbayes/blake2b) |
| fflate | 0.8.3 | MIT | Copyright (c) 2026 Arjun Barrett |
| @openpgp/tweetnacl | 1.0.4-2 | Unlicense (public domain) | Ported in 2014 by Dmitry Chestnykh and Devi Mandiri. Public domain. |

The MIT text is in lib/licenses/MIT.txt and the Unlicense text in
lib/licenses/Unlicense.txt.

### Notices from OpenPGP.js's own source files

OpenPGP.js contains older code under the following notices, quoted from its
source files.

src/encoding/base64.js:

```
OpenPGP radix-64/base64 string encoding/decoding
Copyright 2005 Herbert Hanewinkel, www.haneWIN.de
version 1.0, check www.haneWIN.de for the latest version

This software is provided as-is, without express or implied warranty.
Permission to use, copy, modify, distribute or sell this software, with or
without fee, for any purpose and by any individual or organization, is hereby
granted, provided that the above copyright notice and this paragraph appear
in all copies. Distribution as a part of an application or binary must
include the above copyright notice in the documentation and/or other materials
provided with the application or distribution.
```

src/crypto/cipherMode/cfb.js (a modified version of
https://www.hanewin.net/encrypt/PGdecode.js):

```
OpenPGP encryption using RSA/AES
Copyright 2005-2006 Herbert Hanewinkel, www.haneWIN.de
version 2.0, check www.haneWIN.de for the latest version

This software is provided as-is, without express or implied warranty.
Permission to use, copy, modify, distribute or sell this software, with or
without fee, for any purpose and by any individual or organization, is hereby
granted, provided that the above copyright notice and this paragraph appear
in all copies. Distribution as a part of an application or binary must
include the above copyright notice in the documentation and/or other materials
provided with the application or distribution.
```

src/crypto/public_key/prime.ts includes the Miller-Rabin primality test:
"Copyright Fedor Indutny, 2014. This software is licensed under the MIT
License."

src/crypto/cipher/cast5.js: "Copyright 2010 pjacobs@xeekr.com . All rights
reserved. Use of this source code is governed by a BSD-style license."

src/crypto/cipher/twofish.js: "Copyright(c) 2009 Atsushi Oka
[ http://oka.nu/ ]. This script file is distributed under the LGPL. The main
subroutines are written by Michiel van Everdingen. All rights for these
routines are reserved to Michiel van Everdingen."

src/crypto/cipher/des.js: "Paul Tero, July 2001, http://www.tero.co.uk/des/.
Optimised for performance with large blocks by Michael Hayworth, November
2001." Provided as is, without warranties.

src/crypto/cipher/blowfish.js: "Originally written by nklein software
(nklein.com)."

## bcrypt.js

- File: lib/bcrypt.min.js
- Copyright (c) 2013 Daniel Wirtz
- License: Apache License 2.0 (lib/licenses/Apache-2.0.txt)
- Source: https://github.com/dcodeIO/bcrypt.js

## Bootstrap Icons

- Several inline SVG icons in the user interface (popup/)
- Copyright (c) 2019-2024 The Bootstrap Authors
- License: MIT (lib/licenses/MIT.txt)
- Source: https://github.com/twbs/icons

## Feather

- Several inline SVG icons in the user interface (popup/)
- Copyright (c) 2013-2023 Cole Bemis
- License: MIT (lib/licenses/MIT.txt)
- Source: https://github.com/feathericons/feather
