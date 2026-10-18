/**
 * One-shot migration of the "Image attachments" setting.
 *
 * imageAttachMode was stored, synced and exported from long before anything
 * read it. The options page preselected "Embed inline" whenever nothing was
 * stored (options.js: `s.imageAttachMode || 'inline'`), and saveSettings()
 * persists whatever the dropdown shows, so opening Settings once for any
 * unrelated reason wrote 'inline'. When 1.12.7 finally read the setting, those
 * users had embedding switched on without ever choosing it, which the 1.12.7
 * release notes flatly denied. Nobody could have chosen it meaningfully anyway,
 * because the setting did nothing at the time.
 *
 * The marker deliberately lives OUTSIDE `settings`: options saveSettings()
 * rebuilds that object from its form fields, so a marker inside it is dropped
 * on the next save and the migration would later undo a real choice.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'background', 'background.js'), 'utf-8');

function lift(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function not found in background.js: ' + name);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

let migrate;
beforeAll(() => {
  migrate = new Function(lift('_migrateSettings') + '\nreturn _migrateSettings;')();
});

describe('resetting an inline mode nobody chose', () => {
  it('rewrites a stored inline to attachment on update', () => {
    const p = migrate({ settings: { imageAttachMode: 'inline' } }, 'update');
    expect(p.settings.imageAttachMode).toBe('attachment');
    expect(p.markImageMigrated).toBe(true);
  });

  it('leaves "both" alone, which could only have been chosen deliberately', () => {
    const p = migrate({ settings: { imageAttachMode: 'both' } }, 'update');
    expect(p.settings).toBeNull();
    expect(p.markImageMigrated).toBe(true);
  });

  it('leaves an explicit attachment alone', () => {
    expect(migrate({ settings: { imageAttachMode: 'attachment' } }, 'update').settings).toBeNull();
  });

  it('runs on update, not only on install, which is where the damage is', () => {
    expect(migrate({ settings: { imageAttachMode: 'inline' } }, 'update').settings).not.toBeNull();
  });
});

describe('it only ever runs once', () => {
  it('does nothing when the marker is already set', () => {
    const p = migrate({ settings: { imageAttachMode: 'inline' }, imageAttachModeMigrated: true }, 'update');
    expect(p.settings).toBeNull();
    expect(p.markImageMigrated).toBe(false);
  });

  it('respects inline chosen AFTER the migration ran', () => {
    // The whole point of the marker: from 1.12.8 on, inline is a real choice.
    const p = migrate({ settings: { imageAttachMode: 'inline' }, imageAttachModeMigrated: true }, 'update');
    expect(p.settings).toBeNull();
  });

  it('keeps the marker out of the settings object it returns', () => {
    // If it landed in `settings`, the next options save would drop it and the
    // migration would run again, undoing a genuine choice.
    const p = migrate({ settings: { imageAttachMode: 'inline' } }, 'update');
    expect(p.settings.imageAttachModeMigrated).toBeUndefined();
  });
});

describe('the existing install-time theme default still works', () => {
  it('sets the hud theme on a fresh install', () => {
    expect(migrate({}, 'install').settings.theme).toBe('hud');
  });

  it('does not impose a theme on update', () => {
    const p = migrate({ settings: { imageAttachMode: 'both' } }, 'update');
    expect(p.settings).toBeNull();
  });

  it('does not overwrite a theme the user picked', () => {
    const p = migrate({ settings: { theme: 'modern', imageAttachMode: 'inline' } }, 'install');
    expect(p.settings.theme).toBe('modern');
  });
});

describe('it never mutates what it was given', () => {
  it('copies the settings object rather than editing storage in place', () => {
    const stored = { settings: { imageAttachMode: 'inline' } };
    migrate(stored, 'update');
    expect(stored.settings.imageAttachMode).toBe('inline');
  });

  it('survives empty or missing storage', () => {
    expect(() => migrate({}, 'update')).not.toThrow();
    expect(() => migrate(undefined, 'update')).not.toThrow();
    expect(() => migrate({ settings: null }, undefined)).not.toThrow();
  });
});
