import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SETTINGS_VERSION,
  SettingsService,
  defaultSettings,
  migrate,
} from '../app/config/settings';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dafman-settings-'));
  tempDirs.push(dir);
  return dir;
}

describe('SettingsService', () => {
  test('defaults when file is missing', () => {
    const svc = SettingsService.loadOrDefault(join(newTempDir(), 'settings.json'));
    expect(svc.get()).toEqual(defaultSettings());
  });

  test('defaults when file is malformed', () => {
    const dir = newTempDir();
    const path = join(dir, 'settings.json');
    writeFileSync(path, 'not json {{{');
    const svc = SettingsService.loadOrDefault(path);
    expect(svc.get()).toEqual(defaultSettings());
  });

  test('update persists and round-trips on reload', async () => {
    const dir = newTempDir();
    const path = join(dir, 'settings.json');
    const svc = SettingsService.loadOrDefault(path);
    const next = {
      version: SETTINGS_VERSION,
      appearance: {
        theme: 'dark' as const,
        reasoningVisibility: 'compact' as const,
        defaultModelId: 'auto',
        defaultReasoningEffort: null,
        streaming: false,
        enableMermaid: false,
      },
      layout: { dockview: null },
      workspaces: { recent: ['D:\\repo\\dafman'], defaultWorkspace: '' },
      notifications: { turnEnd: false, waitingForInput: true },
      tools: { defaultExcluded: [], defaultAllowed: [] },
      permissions: { defaultApproveAll: false },
      terminal: defaultSettings().terminal,
      composer: { submitKeybinding: 'enter' as const },
    };
    const written = await svc.update(next);
    expect(written).toEqual(next);

    const reloaded = SettingsService.loadOrDefault(path);
    expect(reloaded.get().appearance.theme).toBe('dark');
    expect(reloaded.get().workspaces.recent).toEqual(['D:\\repo\\dafman']);
  });

  test('update persists an opaque dockview layout blob', async () => {
    const dir = newTempDir();
    const path = join(dir, 'settings.json');
    const svc = SettingsService.loadOrDefault(path);
    // We never inspect the dockview blob — just verify it round-trips
    // as-is. Real dockview JSON would have `grid` + `panels`, but the
    // service stays agnostic.
    const blob = {
      grid: { root: {}, height: 600, width: 800, orientation: 'HORIZONTAL' },
      panels: { 'sess-1': { id: 'sess-1', contentComponent: 'chat' } },
      activeGroup: 'g1',
    };
    await svc.update({
      version: SETTINGS_VERSION,
      appearance: {
        theme: 'system',
        reasoningVisibility: 'compact',
        streaming: false,
        enableMermaid: false,
        defaultModelId: 'auto',
        defaultReasoningEffort: null,
      },
      layout: { dockview: blob },
      workspaces: { recent: [], defaultWorkspace: '' },
      notifications: { turnEnd: false, waitingForInput: true },
      tools: { defaultExcluded: [], defaultAllowed: [] },
      permissions: { defaultApproveAll: false },
      terminal: {
        defaultProfileId: 'platform-default',
        fontFamily: 'Cascadia Mono, Consolas, ui-monospace, monospace',
        fontSize: 13,
        scrollback: 10_000,
        theme: { background: '#111827', foreground: '#d1d5db' },
        addons: {
          search: true,
          webLinks: true,
          clipboard: true,
          unicode11: true,
          webFonts: true,
          progress: true,
          ligatures: true,
          image: true,
          unicodeGraphemes: true,
          webgl: true,
          serialize: true,
        },
      },
      composer: { submitKeybinding: 'enter' },
    });
    const reloaded = SettingsService.loadOrDefault(path);
    expect(reloaded.get().layout.dockview).toEqual(blob);
  });

  test('v3 grouped layout round-trips through update + reload', async () => {
    // Regression for the 'Restoring the session still doesn't work' bug
    // (2026-05-27): coerceLayout was stripping every layout field
    // except `dockview`, silently erasing groups v3 data on every save.
    const dir = newTempDir();
    const path = join(dir, 'settings.json');
    const svc = SettingsService.loadOrDefault(path);
    const v3 = {
      schemaVersion: 3,
      outer: {
        grid: { root: { type: 'branch', data: [] }, width: 1, height: 1 },
        panels: { 'grp-default': { id: 'grp-default', contentComponent: 'group' } },
      },
      groups: [
        { id: 'grp-default', name: 'Default', color: '#3b82f6' },
        { id: 'grp-work', name: 'Work', color: '#f59e0b' },
      ],
      activeGroupId: 'grp-default',
      innerBodies: {
        'grp-default': {
          grid: { root: { type: 'branch', data: [] } },
          panels: { 'sess-1': { id: 'sess-1', contentComponent: 'chat' } },
        },
        'grp-work': {
          grid: { root: { type: 'branch', data: [] } },
          panels: { 'sess-2': { id: 'sess-2', contentComponent: 'chat' } },
        },
      },
    };
    await svc.update({
      ...svc.get(),
      layout: v3,
    });
    const reloaded = SettingsService.loadOrDefault(path);
    const layout = reloaded.get().layout;
    expect(layout.schemaVersion).toBe(3);
    expect(layout.outer).toEqual(v3.outer);
    expect(layout.groups).toEqual(v3.groups);
    expect(layout.activeGroupId).toBe('grp-default');
    expect(layout.innerBodies).toEqual(v3.innerBodies);
  });

  test('unknown version is stamped to current', () => {
    const dir = newTempDir();
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ version: 999, appearance: { theme: 'light' } }));
    const svc = SettingsService.loadOrDefault(path);
    expect(svc.get().version).toBe(SETTINGS_VERSION);
    expect(svc.get().appearance.theme).toBe('light');
  });

  test('v1 document migrates with default reasoningVisibility', () => {
    const dir = newTempDir();
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ version: 1, appearance: { theme: 'dark' } }));
    const svc = SettingsService.loadOrDefault(path);
    const settings = svc.get();
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.appearance.theme).toBe('dark');
    expect(settings.appearance.reasoningVisibility).toBe('compact');
  });

  test('v2 document migrates with an empty layout', () => {
    const dir = newTempDir();
    const path = join(dir, 'settings.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        appearance: { theme: 'dark', reasoningVisibility: 'expanded' },
      }),
    );
    const svc = SettingsService.loadOrDefault(path);
    const settings = svc.get();
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.appearance.theme).toBe('dark');
    expect(settings.appearance.reasoningVisibility).toBe('expanded');
    expect(settings.layout).toEqual({ dockview: null });
    expect(settings.workspaces).toEqual({ recent: [], defaultWorkspace: '' });
  });

  test('v3 document migrates with an empty workspaces MRU', () => {
    const dir = newTempDir();
    const path = join(dir, 'settings.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 3,
        appearance: { theme: 'light', reasoningVisibility: 'compact' },
        layout: { dockview: null },
      }),
    );
    const svc = SettingsService.loadOrDefault(path);
    const settings = svc.get();
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.workspaces).toEqual({ recent: [], defaultWorkspace: '' });
  });

  test('v5 document migrates to v6 with default notification prefs', () => {
    const dir = newTempDir();
    const path = join(dir, 'settings.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 5,
        appearance: { theme: 'system', reasoningVisibility: 'compact' },
        layout: { dockview: null },
        workspaces: { recent: [], defaultWorkspace: '/tmp' },
      }),
    );
    const svc = SettingsService.loadOrDefault(path);
    const settings = svc.get();
    expect(settings.version).toBe(SETTINGS_VERSION);
    // v6 added notifications, v7 adds appearance.streaming —
    // defaults: turnEnd OFF, waitingForInput ON, streaming OFF.
    expect(settings.notifications).toEqual({
      turnEnd: false,
      waitingForInput: true,
    });
    expect(settings.appearance.streaming).toBe(false);
    // Existing fields untouched.
    expect(settings.workspaces.defaultWorkspace).toBe('/tmp');
  });

  test('v6 document migrates to v7 with default streaming = false', () => {
    const dir = newTempDir();
    const path = join(dir, 'settings.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 6,
        appearance: { theme: 'dark', reasoningVisibility: 'compact' },
        layout: { dockview: null },
        workspaces: { recent: [], defaultWorkspace: '' },
        notifications: { turnEnd: true, waitingForInput: true },
      }),
    );
    const svc = SettingsService.loadOrDefault(path);
    const settings = svc.get();
    expect(settings.version).toBe(SETTINGS_VERSION);
    // streaming defaults OFF — repeated-words bug at the SDK
    // delta layer made the feature unreliable. Users can opt in
    // from Settings → Appearance.
    expect(settings.appearance.streaming).toBe(false);
    // Existing notifications + theme untouched.
    expect(settings.notifications.turnEnd).toBe(true);
    expect(settings.appearance.theme).toBe('dark');
  });

  test('streaming coercion: explicit true preserved, non-boolean drops to false', () => {
    const yes = migrate({
      version: SETTINGS_VERSION,
      appearance: {
        theme: 'system',
        reasoningVisibility: 'compact',
        streaming: true,
        enableMermaid: false,
      },
      layout: { dockview: null },
      workspaces: { recent: [], defaultWorkspace: '' },
      notifications: { turnEnd: false, waitingForInput: true },
    });
    expect(yes.appearance.streaming).toBe(true);

    const bogus = migrate({
      version: SETTINGS_VERSION,
      appearance: {
        theme: 'system',
        reasoningVisibility: 'compact',
        streaming: 'on' as unknown as boolean,
      },
      layout: { dockview: null },
      workspaces: { recent: [], defaultWorkspace: '' },
      notifications: { turnEnd: false, waitingForInput: true },
    });
    expect(bogus.appearance.streaming).toBe(false);
  });

  test('notifications coercion drops non-boolean fields', () => {
    const settings = migrate({
      version: SETTINGS_VERSION,
      appearance: {
        theme: 'system',
        reasoningVisibility: 'compact',
        streaming: false,
        enableMermaid: false,
      },
      layout: { dockview: null },
      workspaces: { recent: [], defaultWorkspace: '' },
      notifications: {
        turnEnd: 'yes' as unknown as boolean,
        waitingForInput: 0 as unknown as boolean,
      },
    });
    // Non-booleans fall back to the defaultSettings() values.
    expect(settings.notifications).toEqual({
      turnEnd: false,
      waitingForInput: true,
    });
  });

  test('notifications: partial overrides preserve missing fields', () => {
    const settings = migrate({
      version: SETTINGS_VERSION,
      appearance: {
        theme: 'system',
        reasoningVisibility: 'compact',
        streaming: false,
        enableMermaid: false,
      },
      layout: { dockview: null },
      workspaces: { recent: [], defaultWorkspace: '' },
      notifications: { turnEnd: true },
    });
    // turnEnd explicitly set; waitingForInput falls back to the
    // default (true).
    expect(settings.notifications).toEqual({
      turnEnd: true,
      waitingForInput: true,
    });
  });

  test('workspaces.recent coerces: drops non-strings, trims, dedupes, caps to limit', () => {
    const tooMany = Array.from({ length: 25 }, (_, i) => `/path/${i}`);
    const settings = migrate({
      version: SETTINGS_VERSION,
      appearance: { theme: 'system', reasoningVisibility: 'compact' },
      layout: { dockview: null },
      workspaces: {
        recent: [
          '  D:\\repo  ',
          'D:\\repo', // duplicate post-trim
          42, // non-string
          null, // non-string
          '',
          '   ',
          'C:\\code\\demo',
          ...tooMany,
        ],
      },
    });
    expect(settings.workspaces.recent[0]).toBe('D:\\repo');
    expect(settings.workspaces.recent[1]).toBe('C:\\code\\demo');
    expect(settings.workspaces.recent.length).toBeLessThanOrEqual(10);
  });

  test('workspaces malformed (non-array / non-object) coerces to empty list', () => {
    expect(
      migrate({
        version: SETTINGS_VERSION,
        appearance: { theme: 'system', reasoningVisibility: 'compact' },
        layout: { dockview: null },
        workspaces: { recent: 'not-an-array' },
      }).workspaces,
    ).toEqual({ recent: [], defaultWorkspace: '' });
    expect(
      migrate({
        version: SETTINGS_VERSION,
        appearance: { theme: 'system', reasoningVisibility: 'compact' },
        layout: { dockview: null },
        workspaces: 42,
      }).workspaces,
    ).toEqual({ recent: [], defaultWorkspace: '' });
  });

  test('malformed layout coerces to a safe default', () => {
    const settings = migrate({
      version: 3,
      appearance: { theme: 'system' },
      layout: { dockview: 'not an object' },
    });
    expect(settings.layout).toEqual({ dockview: null });
  });

  test('array-shaped layout.dockview is rejected', () => {
    const settings = migrate({
      version: 3,
      appearance: { theme: 'system' },
      layout: { dockview: [] },
    });
    expect(settings.layout).toEqual({ dockview: null });
  });

  test('v9/v10 document migrates to current with default permissions + tools.defaultAllowed', () => {
    // 22c added permissions; 22b added tools.defaultAllowed.
    // A document missing both fields must fall back to safe
    // defaults (approve-all off, empty allowlist = no
    // restriction) so existing users never silently flip
    // approve-all on or have their toolset narrowed.
    const dir = newTempDir();
    const path = join(dir, 'settings.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 9,
        appearance: {
          theme: 'system',
          reasoningVisibility: 'compact',
          streaming: false,
          enableMermaid: false,
        },
        layout: { dockview: null },
        workspaces: { recent: [], defaultWorkspace: '' },
        notifications: { turnEnd: false, waitingForInput: true },
        tools: { defaultExcluded: ['bash'] },
      }),
    );
    const svc = SettingsService.loadOrDefault(path);
    const settings = svc.get();
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.permissions).toEqual({ defaultApproveAll: false });
    expect(settings.tools.defaultAllowed).toEqual([]);
    // Existing fields untouched.
    expect(settings.tools.defaultExcluded).toEqual(['bash']);
    expect(settings.appearance.theme).toBe('system');
  });

  test('tools.defaultAllowed coercion: drops non-strings, trims, dedupes', () => {
    // 22b: allowlist gets the same coercion as defaultExcluded.
    // Real-world bad data: stray nulls, numeric entries, leading
    // whitespace, dupes. All must be cleaned.
    const settings = migrate({
      version: SETTINGS_VERSION,
      appearance: {
        theme: 'system',
        reasoningVisibility: 'compact',
        streaming: false,
        enableMermaid: false,
      },
      layout: { dockview: null },
      workspaces: { recent: [], defaultWorkspace: '' },
      notifications: { turnEnd: false, waitingForInput: true },
      tools: {
        defaultExcluded: [],
        defaultAllowed: [
          '  bash  ',
          'bash', // duplicate post-trim
          42, // non-string
          null,
          '',
          '   ',
          'playwright/navigate',
        ],
      },
    });
    expect(settings.tools.defaultAllowed).toEqual(['bash', 'playwright/navigate']);
  });

  test('permissions coercion: explicit true preserved, non-boolean falls back to default', () => {
    const yes = migrate({
      version: SETTINGS_VERSION,
      appearance: {
        theme: 'system',
        reasoningVisibility: 'compact',
        streaming: false,
        enableMermaid: false,
      },
      layout: { dockview: null },
      workspaces: { recent: [], defaultWorkspace: '' },
      notifications: { turnEnd: false, waitingForInput: true },
      permissions: { defaultApproveAll: true },
    });
    expect(yes.permissions.defaultApproveAll).toBe(true);

    const bogus = migrate({
      version: SETTINGS_VERSION,
      appearance: {
        theme: 'system',
        reasoningVisibility: 'compact',
        streaming: false,
        enableMermaid: false,
      },
      layout: { dockview: null },
      workspaces: { recent: [], defaultWorkspace: '' },
      notifications: { turnEnd: false, waitingForInput: true },
      permissions: { defaultApproveAll: 'yes' as unknown as boolean },
    });
    expect(bogus.permissions.defaultApproveAll).toBe(false);
  });

  test('v14 document migrates to v15 with default composer.submitKeybinding = enter', () => {
    // #88: the composer section was added in v15. A v14 document lacks
    // it entirely, so migration must backfill the new default
    // ('enter' = plain Enter sends).
    const dir = newTempDir();
    const path = join(dir, 'settings.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 14,
        appearance: {
          theme: 'dark',
          reasoningVisibility: 'compact',
          streaming: false,
          enableMermaid: false,
        },
        layout: { dockview: null },
        workspaces: { recent: [], defaultWorkspace: '' },
        notifications: { turnEnd: false, waitingForInput: true },
        tools: { defaultExcluded: [], defaultAllowed: [] },
        permissions: { defaultApproveAll: false },
      }),
    );
    const svc = SettingsService.loadOrDefault(path);
    const settings = svc.get();
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.composer).toEqual({ submitKeybinding: 'enter' });
    // Existing fields untouched.
    expect(settings.appearance.theme).toBe('dark');
  });

  test('composer coercion: explicit mod-enter preserved, invalid falls back to enter', () => {
    const modEnter = migrate({
      version: SETTINGS_VERSION,
      appearance: {
        theme: 'system',
        reasoningVisibility: 'compact',
        streaming: false,
        enableMermaid: false,
      },
      layout: { dockview: null },
      workspaces: { recent: [], defaultWorkspace: '' },
      notifications: { turnEnd: false, waitingForInput: true },
      composer: { submitKeybinding: 'mod-enter' },
    });
    expect(modEnter.composer.submitKeybinding).toBe('mod-enter');

    const bogus = migrate({
      version: SETTINGS_VERSION,
      appearance: {
        theme: 'system',
        reasoningVisibility: 'compact',
        streaming: false,
        enableMermaid: false,
      },
      layout: { dockview: null },
      workspaces: { recent: [], defaultWorkspace: '' },
      notifications: { turnEnd: false, waitingForInput: true },
      composer: { submitKeybinding: 'ctrl-shift-enter' as unknown as 'enter' },
    });
    expect(bogus.composer.submitKeybinding).toBe('enter');

    // Missing section entirely → default.
    const missing = migrate({
      version: SETTINGS_VERSION,
      appearance: {
        theme: 'system',
        reasoningVisibility: 'compact',
        streaming: false,
        enableMermaid: false,
      },
      layout: { dockview: null },
      workspaces: { recent: [], defaultWorkspace: '' },
      notifications: { turnEnd: false, waitingForInput: true },
    });
    expect(missing.composer.submitKeybinding).toBe('enter');
  });
});
