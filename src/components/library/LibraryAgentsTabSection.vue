<template>
  <section
    v-if="entries.length > 0"
    class="agents-group"
  >
    <h3 class="group-title">{{ title }} ({{ entries.length }})</h3>
    <ul class="agents-list">
      <li
        v-for="entry in entries"
        :key="`${keyPrefix}:${entry.name}`"
        class="agent-row"
        :class="{
          'agent-row-selected': currentAgentName === entry.name,
          'agent-row-rejected': entry.loadStatus === 'rejected',
        }"
      >
        <div class="agent-line">
          <span class="agent-name">{{ entry.name }}</span>
          <small
            v-if="!entry.canonical"
            class="warn-tag"
            title="File ends with .md (not .agent.md)"
          >
            .md
          </small>
          <small
            v-if="entry.loadStatus === 'rejected'"
            class="error-tag"
            :title="entry.loadMessage ?? 'The SDK rejected this agent file'"
          >
            SDK rejected
          </small>
          <small
            v-else-if="entry.loadWarnings?.length"
            class="warn-tag"
            :title="entry.loadWarnings.join('\n')"
          >
            warning
          </small>
          <span
            v-if="currentAgentName === entry.name"
            class="agent-current-chip"
            :title="`This agent is selected for the active session`"
          >
            Selected
          </span>
        </div>
        <div
          class="agent-path"
          :title="entry.path"
        >
          {{ entry.path }}
        </div>
        <div
          v-if="entry.loadStatus === 'rejected'"
          class="agent-load-message"
          :title="entry.loadMessage"
        >
          {{
            entry.loadMessage ??
            'The Copilot SDK did not load this file. Fix the frontmatter and refresh agents.'
          }}
        </div>
        <div class="agent-actions">
          <Button
            v-if="currentAgentName === entry.name"
            size="small"
            severity="secondary"
            :loading="visibleAgentBusyName === '__deselect__'"
            :disabled="!activeSession || !!agentBusyName"
            label="Deselect"
            :aria-label="`Deselect agent ${entry.name}`"
            @click="$emit('deselect')"
          />
          <Button
            v-else
            size="small"
            :loading="visibleAgentBusyName === entry.name"
            :disabled="!activeSession || !!agentBusyName"
            :severity="entry.loadStatus === 'rejected' ? 'danger' : undefined"
            :label="entry.loadStatus === 'rejected' ? 'Fix' : 'Select'"
            :aria-label="
              entry.loadStatus === 'rejected'
                ? `Show load error for agent ${entry.name}`
                : `Select agent ${entry.name}`
            "
            @click="
              entry.loadStatus === 'rejected'
                ? $emit('selectRejected', entry)
                : $emit('select', entry.name)
            "
          />
          <Button
            size="small"
            text
            icon="pi pi-pencil"
            :disabled="!activeSession"
            :aria-label="`Edit ${entry.name}`"
            @click="$emit('edit', entry)"
          />
          <Button
            size="small"
            text
            icon="pi pi-external-link"
            :aria-label="`Reveal ${entry.name} in file manager`"
            @click="$emit('reveal', entry.path)"
          />
          <Button
            size="small"
            severity="danger"
            text
            icon="pi pi-trash"
            :disabled="!activeSession"
            :aria-label="`Delete ${entry.name}`"
            @click="$emit('delete', entry)"
          />
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useTimeoutFn } from '@vueuse/core';
import Button from 'primevue/button';
import type { AgentFileEntry } from '@/ipc/types';

const LOADING_AFFORDANCE_DELAY_MS = 180;

const props = defineProps<{
  title: string;
  keyPrefix: string;
  entries: AgentFileEntry[];
  currentAgentName: string | null;
  agentBusyName: string | null;
  activeSession: boolean;
}>();

const visibleAgentBusyName = ref<string | null>(null);
const { start, stop } = useTimeoutFn(
  () => {
    visibleAgentBusyName.value = props.agentBusyName;
  },
  LOADING_AFFORDANCE_DELAY_MS,
  { immediate: false },
);

watch(
  () => props.agentBusyName,
  (name) => {
    stop();
    visibleAgentBusyName.value = null;

    if (name) start();
  },
  { immediate: true },
);

defineEmits<{
  (e: 'select' | 'reveal', payload: string): void;
  (e: 'deselect'): void;
  (e: 'selectRejected' | 'edit' | 'delete', entry: AgentFileEntry): void;
}>();
</script>

<style scoped>
/* Row + section styles. Live HERE (not in the parent LibraryAgentsTab)
 * because Vue scoped CSS attribute selectors are bound to the file
 * rendering the element. When this section was extracted from
 * LibraryAgentsTab the row CSS stayed behind and silently broke all
 * card styling. Keep these here. */

.agents-group {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.group-title {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  color: var(--p-text-muted-color);
  margin: 0;
}

.agents-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.agent-row {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  gap: 0.2rem 0.5rem;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--p-surface-border);
  border-radius: var(--p-border-radius-sm);
  background: color-mix(in srgb, var(--p-content-hover-background) 25%, transparent);
  min-width: 0;
  align-items: center;
  border-left: 3px solid transparent;
}

/* Selected agent gets a tinted left rail in the primary color so the
 * row reads as "this is the active one" at a glance, matching the
 * palette's selected-item visual language. */
.agent-row-selected {
  border-left-color: var(--p-primary-color);
  background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
}

.agent-row-rejected {
  border-left-color: var(--p-red-500, #ef4444);
  background: color-mix(in srgb, var(--p-red-500, #ef4444) 8%, transparent);
}

.agent-current-chip {
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0.1rem 0.4rem;
  background: color-mix(in srgb, var(--p-primary-color) 22%, transparent);
  color: var(--p-primary-color);
  border-radius: 0.25rem;
  font-weight: 600;
}

.agent-line {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  min-width: 0;
}

.agent-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.warn-tag {
  text-transform: uppercase;
  font-size: 0.55rem;
  padding: 0.05rem 0.3rem;
  background: color-mix(in srgb, var(--p-yellow-500, #eab308) 18%, transparent);
  color: var(--p-yellow-500, #eab308);
  border-radius: 0.2rem;
}

.error-tag {
  text-transform: uppercase;
  font-size: 0.55rem;
  padding: 0.05rem 0.3rem;
  background: color-mix(in srgb, var(--p-red-500, #ef4444) 16%, transparent);
  color: var(--p-red-500, #ef4444);
  border-radius: 0.2rem;
}

.agent-path {
  grid-row: 2;
  grid-column: 1 / 2;
  font-size: 0.65rem;
  color: var(--p-text-muted-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.agent-load-message {
  grid-row: 3;
  grid-column: 1 / 2;
  font-size: 0.68rem;
  color: var(--p-red-500, #ef4444);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.agent-actions {
  grid-row: 1 / 4;
  grid-column: 2;
  display: flex;
  gap: 0.2rem;
}
</style>
