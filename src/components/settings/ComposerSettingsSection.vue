<script setup lang="ts">
/// Composer keybindings section of the SettingsPanel (issue #88).
/// Owns the binding to `settings.composer.submitKeybinding` via the
/// typed `setComposerSubmitKeybinding` setter on `settingsStore`.
///
/// The section exists as its own category so the composer-keybinding
/// surface can grow later (per-OS defaults, more chords) without
/// re-homing the control.

import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import Select from 'primevue/select';
import { useSettingsStore } from '@/stores/app/settingsStore';
import type { ComposerSubmitKeybinding } from '@/ipc/types';
import SettingsGroup from '@/components/settings/SettingsGroup.vue';

defineProps<{ collapsed: boolean }>();
const emit = defineEmits<{ (e: 'update:collapsed', value: boolean): void }>();

const settingsStore = useSettingsStore();
const { settings } = storeToRefs(settingsStore);

const submitOptions: { label: string; value: ComposerSubmitKeybinding }[] = [
  { label: 'Enter sends, Ctrl+Enter newline', value: 'enter' },
  { label: 'Ctrl+Enter sends, Enter newline', value: 'mod-enter' },
];

const submitKeybinding = computed<ComposerSubmitKeybinding>({
  get: () => settings.value.composer?.submitKeybinding ?? 'enter',
  set: (value) => {
    void settingsStore.setComposerSubmitKeybinding(value);
  },
});
</script>

<template>
  <SettingsGroup
    id="composer"
    icon="pi-pencil"
    label="Composer"
    :collapsed="collapsed"
    @update:collapsed="(v) => emit('update:collapsed', v)"
  >
    <label
      class="field"
      for="composer-submit-select"
    >
      <span class="field-label">Send message with</span>
      <Select
        id="composer-submit-select"
        v-model="submitKeybinding"
        :options="submitOptions"
        option-label="label"
        option-value="value"
        size="small"
        class="field-control"
      />
      <p class="field-hint">
        <strong>Enter sends</strong> (default): press Enter to send, Ctrl/Cmd+Enter for a newline.
        <strong>Ctrl+Enter sends</strong>: press Ctrl/Cmd+Enter to send, Enter for a newline. In
        both modes Ctrl+Shift+Enter interrupts and Alt+Enter queues; Shift+Enter inserts a soft line
        break. While a <code>/</code> or <code>@</code> menu is open, Enter still selects the
        highlighted item.
      </p>
    </label>
  </SettingsGroup>
</template>
