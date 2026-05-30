// Settings store — mirrors the on-disk JSON document owned by
// `app::settings::SettingsService`. `load()` should be called once at app
// startup; `update()` does a full-replace (the backend persists to disk
// and returns the canonical document, including the stamped version).

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { invokeCommand } from '@/ipc/invoke';
import {
  LAYOUT_SCHEMA_VERSION,
  type ComposerSubmitKeybinding,
  type Layout,
  type NotificationPrefs,
  type ReasoningVisibility,
  type Settings,
  type TerminalPrefs,
  type ThemeChoice,
} from '@/ipc/types';
import { useToastStore } from '@/stores/app/toastStore';
import { toErrorMessage } from '@/lib/errorMessage';

function defaultSettings(): Settings {
  return {
    version: 15,
    appearance: {
      theme: 'system',
      reasoningVisibility: 'compact',
      defaultModelId: 'auto',
      defaultReasoningEffort: null,
      streaming: false,
      enableMermaid: false,
    },
    layout: { dockview: null, schemaVersion: LAYOUT_SCHEMA_VERSION },
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
  };
}

/// Hard upper bound on the workspace MRU; matches the backend constant
/// `WORKSPACES_MRU_LIMIT`. Anything past this is trimmed off the tail.
const WORKSPACES_MRU_LIMIT = 10;

type TerminalPrefsPatch = Omit<Partial<TerminalPrefs>, 'addons' | 'theme'> & {
  addons?: Partial<TerminalPrefs['addons']>;
  theme?: Partial<TerminalPrefs['theme']>;
};

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>(defaultSettings());
  const loaded = ref(false);
  const isSaving = ref(false);

  async function load(): Promise<Settings> {
    try {
      const next = await invokeCommand('getSettings', {});

      settings.value = next;
      loaded.value = true;

      return next;
    } catch (err) {
      const message = toErrorMessage(err);

      useToastStore().error('Failed to load settings', message);
      throw err;
    }
  }

  async function update(next: Settings): Promise<Settings> {
    isSaving.value = true;

    try {
      const written = await invokeCommand('updateSettings', { next });

      settings.value = written;

      return written;
    } catch (err) {
      const message = toErrorMessage(err);

      useToastStore().error('Failed to save settings', message);
      throw err;
    } finally {
      isSaving.value = false;
    }
  }

  async function setTheme(theme: ThemeChoice): Promise<Settings> {
    return update({
      ...settings.value,
      appearance: { ...settings.value.appearance, theme },
    });
  }

  async function setReasoningVisibility(
    reasoningVisibility: ReasoningVisibility,
  ): Promise<Settings> {
    return update({
      ...settings.value,
      appearance: { ...settings.value.appearance, reasoningVisibility },
    });
  }

  async function setDefaultModel(
    defaultModelId: string,
    defaultReasoningEffort: string | null,
  ): Promise<Settings> {
    return update({
      ...settings.value,
      appearance: {
        ...settings.value.appearance,
        defaultModelId,
        defaultReasoningEffort,
      },
    });
  }

  /// Partial update for the streaming toggle. Takes effect on the
  /// NEXT session created — existing sessions keep their mode.
  async function setStreaming(streaming: boolean): Promise<void> {
    try {
      await update({
        ...settings.value,
        appearance: { ...settings.value.appearance, streaming },
      });
    } catch {
      /* toast already shown by `update()` */
    }
  }

  /// Opt-in mermaid diagram rendering. Mermaid is ~800 KB minified;
  /// keeping this default-off means users who don't need diagrams
  /// never pay the bundle cost.
  async function setEnableMermaid(enableMermaid: boolean): Promise<void> {
    try {
      await update({
        ...settings.value,
        appearance: { ...settings.value.appearance, enableMermaid },
      });
    } catch {
      /* toast already shown by `update()` */
    }
  }

  /// Partial update for OS-notification toggles. Either key can be
  /// omitted to leave the existing value intact.
  async function setNotifications(next: Partial<NotificationPrefs>): Promise<void> {
    try {
      await update({
        ...settings.value,
        notifications: {
          ...settings.value.notifications,
          ...next,
        },
      });
    } catch {
      /* toast already shown by `update()` */
    }
  }

  /// Persists a v3 grouped layout (with `outer`, `groups`, `innerBodies`,
  /// `activeGroupId`). The full `Layout` object is produced by
  /// `composePersistLayout` at the call site (via
  /// `groupsStore.serialize(outer.toJSON())`) and written through
  /// debounced via `lib/persistScheduler.schedulePersist`.
  ///
  /// Errors are intentionally swallowed — a layout-save failure should
  /// not disrupt the user's workflow.
  async function persistGroupedLayout(layout: Layout): Promise<void> {
    try {
      await update({
        ...settings.value,
        layout,
      });
    } catch {
      /* toast already shown by `update()` */
    }
  }

  /// Promotes a workspace path to the head of the MRU list and
  /// persists. Empty / whitespace inputs are ignored. The list is
  /// deduped (case-sensitive — keeping the freshly-cased version) and
  /// capped at WORKSPACES_MRU_LIMIT.
  async function recordWorkspaceUse(path: string): Promise<void> {
    const trimmed = path.trim();

    if (!trimmed) return;

    const prev = settings.value.workspaces.recent;
    const filtered = prev.filter((p) => p !== trimmed);
    const next = [trimmed, ...filtered].slice(0, WORKSPACES_MRU_LIMIT);

    // Avoid a write if nothing changed (same head, same length).
    if (prev.length === next.length && prev.every((p, i) => p === next[i])) {
      return;
    }

    try {
      await update({
        ...settings.value,
        workspaces: { ...settings.value.workspaces, recent: next },
      });
    } catch {
      /* toast already shown */
    }
  }

  /// Updates the default workspace (used to pre-populate the new-session
  /// form). Empty string clears it. Caller decides whether the path is
  /// real — the backend doesn't validate at this layer.
  async function setDefaultWorkspace(path: string): Promise<void> {
    const trimmed = path.trim();

    try {
      await update({
        ...settings.value,
        workspaces: {
          ...settings.value.workspaces,
          defaultWorkspace: trimmed,
        },
      });
    } catch {
      /* toast already shown */
    }
  }

  /// 22c: persists the global default for `approveAll` on new sessions.
  /// The per-session toggle in the rail continues to drive the runtime
  /// state; this only affects what NEW sessions start with.
  async function setDefaultApproveAll(value: boolean): Promise<void> {
    try {
      await update({
        ...settings.value,
        permissions: {
          ...settings.value.permissions,
          defaultApproveAll: value,
        },
      });
    } catch {
      /* toast already shown */
    }
  }

  async function setDefaultTerminalProfile(defaultProfileId: string): Promise<void> {
    try {
      await update({
        ...settings.value,
        terminal: { ...settings.value.terminal, defaultProfileId },
      });
    } catch {
      /* toast already shown */
    }
  }

  async function setTerminalPrefs(next: TerminalPrefsPatch): Promise<void> {
    try {
      await update({
        ...settings.value,
        terminal: {
          ...settings.value.terminal,
          ...next,
          theme: { ...settings.value.terminal.theme, ...(next.theme ?? {}) },
          addons: { ...settings.value.terminal.addons, ...(next.addons ?? {}) },
        },
      });
    } catch {
      /* toast already shown by `update()` */
    }
  }

  /// #88: persists which keystroke submits the composer. Takes effect
  /// live — `MessageComposer` reads the setting reactively and re-keys
  /// the `SubmitOnEnter` plugin's keybinding getter.
  async function setComposerSubmitKeybinding(
    submitKeybinding: ComposerSubmitKeybinding,
  ): Promise<void> {
    try {
      await update({
        ...settings.value,
        composer: { ...settings.value.composer, submitKeybinding },
      });
    } catch {
      /* toast already shown by `update()` */
    }
  }

  return {
    settings,
    loaded,
    isSaving,
    load,
    update,
    setTheme,
    setReasoningVisibility,
    setDefaultModel,
    setStreaming,
    setEnableMermaid,
    setNotifications,
    persistGroupedLayout,
    recordWorkspaceUse,
    setDefaultWorkspace,
    setDefaultApproveAll,
    setDefaultTerminalProfile,
    setTerminalPrefs,
    setComposerSubmitKeybinding,
  };
});
