const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Uint8Array: 'readonly',
        ArrayBuffer: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        URLSearchParams: 'readonly',
        AudioContext: 'readonly',
        MutationObserver: 'readonly',
        localStorage: 'readonly',
        URL: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        Image: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        HTMLElement: 'readonly',
        Event: 'readonly',
        KeyboardEvent: 'readonly',
        ClipboardEvent: 'readonly',
        DOMParser: 'readonly',
        MouseEvent: 'readonly',
        FileReader: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        Node: 'readonly',
        Notification: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        webkitAudioContext: 'readonly',
        SharedArrayBuffer: 'readonly',
        globalThis: 'readonly',

        // Firefox extension API
        browser: 'readonly',
        // Chrome alias (used by the chrome→browser polyfill and chrome.scripting
        // MAIN-world calls in the Chrome MV3 build).
        chrome: 'readonly',

        // Third-party libraries (loaded via manifest.json)
        openpgp: 'readonly',
        dcodeIO: 'readonly',

        // Our own globals (loaded via manifest.json background scripts, the
        // popup/options HTML <script> tags, and lib/* shared modules). Each
        // file wraps itself in an IIFE and exposes exactly one of these.
        debugLog: 'readonly',
        isDebugLoggingEnabled: 'readonly',
        ProtonBinary: 'readonly',
        ProtonPqc: 'readonly',
        ProtonBrowserInfo: 'readonly',
        ProtonImageResize: 'readonly',
        ProtonEditorHistory: 'readonly',
        ProtonLabels: 'readonly',
        ProtonConfig: 'readonly',
        getSettings: 'readonly',
        ProtonAuth: 'readonly',
        ProtonUrlDetection: 'readonly',
        ProtonCSPShim: 'readonly',
        ExtEncryption: 'readonly',
        ProtonAccounts: 'readonly',
        ProtonTombstones: 'readonly',
        ProtonMonitoredIds: 'readonly',
        ProtonDiag: 'readonly',
        ProtonAIAssistant: 'readonly',
        ProtonContacts: 'readonly',
        ProtonBadge: 'readonly',
        ProtonNotifier: 'readonly',
        ProtonDND: 'readonly',
        ProtonPremium: 'readonly',
        ProtonDrive: 'readonly',
        ProtonPoller: 'readonly',
        ProtonAudioBridge: 'readonly',
        ProtonCalendarICS: 'readonly',
        ProtonCalendarSerialize: 'readonly',
        ProtonCalendarAPI: 'readonly',
        ProtonScripting: 'readonly',
        ProtonCodePatterns: 'readonly',
        ProtonEmailCanvas: 'readonly',
        ProtonAccountLimit: 'readonly',
        ProtonNotificationRules: 'readonly',
        ProtonProSettings: 'readonly',
        ProtonLicenseEntry: 'readonly',
        ProtonI18n: 'readonly',
        ProtonDialog: 'readonly',
        module: 'readonly',
        PopupColorPicker: 'readonly',
        PopupCalendar: 'readonly',
        PopupCalendarAdd: 'readonly',
        PopupAttachments: 'readonly',
        PopupEditorToolbar: 'readonly',
        PopupSendOptions: 'readonly',
        PopupDriveShare: 'readonly',
        PopupScribe: 'readonly',
      },
    },
    rules: {
      // Relax rules that conflict with the codebase style
      'no-redeclare': ['error', { builtinGlobals: false }],
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        // Proton*/Ext*/Popup* are IIFE module exports consumed in OTHER files;
        // getSettings + debugLog + isDebugLoggingEnabled are defined in
        // constants.js and used cross-file. Under sourceType:script eslint
        // can't see those cross-file uses.
        varsIgnorePattern: '^(_|Proton|Ext|Popup|getSettings$|debugLog$|isDebugLoggingEnabled$)',
        caughtErrors: 'none', // catch params intentionally unused (errors logged in comments or swallowed by design)
      }],
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'no-var': 'warn',
      'eqeqeq': ['warn', 'smart'],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    // Ignore minified libraries and build artifacts
    ignores: [
      'lib/openpgp.min.js',
      'lib/bcrypt.min.js',
      'node_modules/**',
      'web-ext-artifacts/**',
    ],
  },
];
