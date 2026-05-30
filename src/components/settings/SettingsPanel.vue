<script setup lang="ts">
/// Settings — left edge-group panel.
///
/// Thin orchestrator that owns:
///   - per-section collapse state (in-memory; user can browse)
///   - the model catalogue load on mount
///   - the styles that apply to all sections via :deep
///
/// Each section is a self-contained component that owns its own
/// reactive bindings and IPC calls — see AppearanceSettingsSection,
/// TerminalSettingsSection, WorkspaceSettingsSection,
/// NotificationSettingsSection. Smaller categories (Permissions /
/// Diagnostics / About) remain inline via the shared SettingsGroup
/// chrome.
///
/// Adding a new category: either drop a `<NewSection>` here or add
/// another inline `<SettingsGroup>` block + add its id to the
/// `collapsed` reactive map default keys.

import { computed, onMounted, reactive } from 'vue';
import { storeToRefs } from 'pinia';
import Button from 'primevue/button';
import ToggleSwitch from 'primevue/toggleswitch';
import { useSettingsStore } from '@/stores/app/settingsStore';
import { useModelsStore } from '@/stores/library/modelsStore';
import { useToastStore } from '@/stores/app/toastStore';
import { openLogFolder as openLogFolderAction } from '@/lib/pathActions';
import SettingsGroup from '@/components/settings/SettingsGroup.vue';
import AppearanceSettingsSection from '@/components/settings/AppearanceSettingsSection.vue';
import ComposerSettingsSection from '@/components/settings/ComposerSettingsSection.vue';
import TerminalSettingsSection from '@/components/settings/TerminalSettingsSection.vue';
import WorkspaceSettingsSection from '@/components/settings/WorkspaceSettingsSection.vue';
import NotificationSettingsSection from '@/components/settings/NotificationSettingsSection.vue';

const settingsStore = useSettingsStore();
const modelsStore = useModelsStore();
const { settings, isSaving } = storeToRefs(settingsStore);

onMounted(() => {
  void modelsStore.load().catch(() => {
    /* toast already shown by the store */
  });
});

/// Collapse state per section id. In-memory only — defaults to all
/// expanded so a fresh open shows every option, matching how a
/// search UI will eventually surface them.
/// All known section ids, each defaulting to `false` (expanded) so a
/// fresh open shows every option. Listed explicitly so v-model:collapsed
/// can write directly to `collapsed[id]` without an `?? false` fallback
/// in the template (which would un-couple read and write paths).
const collapsed = reactive<Record<string, boolean>>({
  appearance: false,
  composer: false,
  workspaces: false,
  terminal: false,
  notifications: false,
  permissions: false,
  diagnostics: false,
  about: false,
});

async function openLogFolder() {
  const ok = await openLogFolderAction();

  if (!ok) useToastStore().warn('Log folder not available yet');
}

/// 22c: Bound to settings.permissions.defaultApproveAll.
/// Drives the global default for new-session approve-all.
const defaultApproveAll = computed<boolean>({
  get: () => settings.value.permissions?.defaultApproveAll ?? false,
  set: (value) => {
    void settingsStore.setDefaultApproveAll(value);
  },
});
</script>

<template>
  <div class="settings-panel">
    <AppearanceSettingsSection v-model:collapsed="collapsed.appearance" />

    <ComposerSettingsSection v-model:collapsed="collapsed.composer" />

    <WorkspaceSettingsSection v-model:collapsed="collapsed.workspaces" />

    <TerminalSettingsSection v-model:collapsed="collapsed.terminal" />

    <NotificationSettingsSection v-model:collapsed="collapsed.notifications" />

    <!-- Permissions (Phase 22c) -->
    <SettingsGroup
      id="permissions"
      v-model:collapsed="collapsed.permissions"
      icon="pi-shield"
      label="Permissions"
    >
      <div class="field field-inline">
        <label class="field-inline-label">
          <ToggleSwitch v-model="defaultApproveAll" />
          <span>Default to approve all for new sessions</span>
        </label>
        <p class="field-hint">
          When ON, brand-new sessions automatically approve every privileged tool call (file write,
          shell, network, etc.) without prompting. Off by default — explicit user choice. The
          per-session toggle in the session rail continues to drive runtime state; this only sets
          the starting value.
        </p>
      </div>
      <div class="field">
        <p class="field-hint">
          To reset remembered approvals for an open session, use "Reset approvals" in the session's
          right-rail Session section.
        </p>
      </div>
    </SettingsGroup>

    <!-- Diagnostics -->
    <SettingsGroup
      id="diagnostics"
      v-model:collapsed="collapsed.diagnostics"
      icon="pi-info-circle"
      label="Diagnostics"
    >
      <div class="field">
        <Button
          label="Open log folder"
          icon="pi pi-folder-open"
          severity="secondary"
          size="small"
          class="field-control"
          @click="openLogFolder"
        />
        <p class="field-hint">
          Daily JSON log. Set <code>DAFMAN_LOG=debug</code> to capture full event payloads.
        </p>
      </div>
    </SettingsGroup>

    <!-- About -->
    <SettingsGroup
      id="about"
      v-model:collapsed="collapsed.about"
      icon="pi-tag"
      label="About"
    >
      <p class="field-hint">
        Schema version <strong>{{ settings.version }}</strong> — stored under
        <code>userData/settings.json</code>.
      </p>
    </SettingsGroup>

    <p
      v-if="isSaving"
      class="saving-state"
    >
      Saving…
    </p>
  </div>
</template>

<style scoped>
.settings-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--p-content-background);
  color: var(--p-text-color);
  overflow-y: auto;
  padding: 0.25rem 0 0.5rem;
}

/* Group chrome lives in SettingsGroup.vue; these are the global field
 * styles that apply across all sections via :deep on the Vue scoped
 * selector. Keeping them here means each section component doesn't
 * have to re-declare them. */

:deep(.settings-group) {
  border-bottom: 1px solid color-mix(in srgb, var(--p-text-color) 6%, transparent);
}

:deep(.group-header) {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  padding: 0.45rem 0.6rem;
  color: var(--p-text-color);
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border: none;
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}

:deep(.group-header:hover) {
  background: color-mix(in srgb, var(--p-text-color) 5%, transparent);
}

:deep(.group-header:focus-visible) {
  outline: 2px solid var(--p-primary-color);
  outline-offset: -2px;
}

:deep(.group-chevron) {
  font-size: 0.65rem;
  width: 0.75rem;
  text-align: center;
  flex: 0 0 auto;
  color: var(--p-text-muted-color);
}

:deep(.group-icon) {
  font-size: 0.8rem;
  flex: 0 0 auto;
  color: var(--p-text-muted-color);
}

:deep(.group-label) {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.group-body) {
  padding: 0.3rem 0.6rem 0.6rem 1.95rem;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

:deep(.field) {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

:deep(.field-inline) {
  gap: 0.4rem;
}

:deep(.field-inline-label) {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.9rem;
  color: var(--p-text-color);
  cursor: pointer;
}

:deep(.field-label) {
  font-size: 0.78rem;
  color: var(--p-text-color);
}

:deep(.field-control) {
  width: 100%;
  max-width: 100%;
}

/* Default-workspace row: input + pick + reveal buttons inline. */
:deep(.workspace-row) {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
:deep(.workspace-row .p-inputtext) {
  flex: 1 1 auto;
  min-width: 0;
}

:deep(.settings-grid) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.55rem;
}

:deep(.addon-grid) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.4rem 0.6rem;
}

:deep(.addon-toggle),
:deep(.color-row) {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
}

:deep(.addon-toggle) {
  font-size: 0.82rem;
}

:deep(.color-row code) {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* PrimeVue Select fills its container — let it shrink with the
 * sidebar instead of demanding a fixed minimum width. */
:deep(.field-control .p-select) {
  width: 100%;
}

:deep(.field-hint) {
  margin: 0;
  font-size: 0.72rem;
  color: var(--p-text-muted-color);
  line-height: 1.4;
}

:deep(.field-hint code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85em;
  padding: 0.02em 0.3em;
  border-radius: 3px;
  background: color-mix(in srgb, var(--p-text-color) 10%, transparent);
}

.saving-state {
  margin: 0;
  padding: 0.4rem 0.6rem;
  font-size: 0.72rem;
  color: var(--p-text-muted-color);
}
</style>
