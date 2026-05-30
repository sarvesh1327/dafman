<script setup lang="ts">
/// Diagnostics edge-panel: live tail of the bun JSON log, with level
/// filter + search + "Export diagnostics bundle" button.
///
/// Subscribes via `logStore` on mount. The store keeps a renderer-side
/// ring buffer (4000) independent of the bun-side ring (1000). The
/// bun-side log level is mutable from this panel's "Active level"
/// dropdown; the display-level dropdown is a renderer-only filter that
/// lets the user temporarily widen or narrow what they see without
/// changing what reaches disk.

import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import SelectButton from 'primevue/selectbutton';
import { useLogStore, LEVEL_NAMES } from '@/stores/observability/logStore';
import { useAuditStore } from '@/stores/observability/auditStore';
import { useToastStore } from '@/stores/app/toastStore';
import { revealPath } from '@/lib/pathActions';
import type { AuditEntry, LogLevel, LogRecord } from '@/ipc/types';
import { toErrorMessage } from '@/lib/errorMessage';

const logStore = useLogStore();
const auditStore = useAuditStore();
const toasts = useToastStore();

type Tab = 'logs' | 'activity';
const tab = ref<Tab>('logs');
const tabOptions = [
  { label: 'Logs', value: 'logs' as Tab },
  { label: 'Activity', value: 'activity' as Tab },
];

const listEl = ref<HTMLElement | null>(null);
const followTail = ref(true);

const levelOptions = LEVEL_NAMES.map((name) => ({
  label: name.charAt(0).toUpperCase() + name.slice(1),
  value: name,
}));

const bunLevel = computed<LogLevel>({
  get: () => logStore.level,
  set: (v) => {
    logStore.setLevel(v).catch((err: unknown) => {
      toasts.error('Failed to set log level', toErrorMessage(err));
    });
  },
});

const displayLevel = computed<LogLevel>({
  get: () => logStore.displayLevel,
  set: (v) => logStore.setDisplayLevel(v),
});

const searchModel = computed<string>({
  get: () => logStore.search,
  set: (v) => logStore.setSearch(v),
});

const filtered = computed<LogRecord[]>(() => logStore.filtered);

onMounted(() => {
  void logStore.ensureInitialised();
  void auditStore.ensureInitialised();
  // Tail-on-mount: scroll to bottom once the initial fill renders.
  void nextTick(() => scrollToBottom());
});

onBeforeUnmount(() => {
  // We intentionally DON'T dispose the store on unmount — the panel
  // may be re-opened and we want continuity. The subscription stays
  // alive until the app shuts down.
});

watch(filtered, () => {
  if (!followTail.value) return;

  void nextTick(() => scrollToBottom());
});

function scrollToBottom(): void {
  const el = listEl.value;

  if (el) el.scrollTop = el.scrollHeight;
}

function onScroll(): void {
  const el = listEl.value;

  if (!el) return;

  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;

  followTail.value = atBottom;
}

async function exportNow(): Promise<void> {
  try {
    const result = await logStore.exportBundle();

    toasts.success(
      'Diagnostics ready',
      `${result.files.length} file(s), ${(result.totalBytes / 1024).toFixed(1)} KiB`,
    );

    // Reveal the directory so the user can zip it up for a bug report.
    await revealPath(result.path);
  } catch (err) {
    toasts.error('Diagnostics export failed', toErrorMessage(err));
  }
}

function clearAll(): void {
  if (tab.value === 'logs') logStore.clear();
  else auditStore.clear();
}

function fmtTime(ts: string): string {
  const t = ts.slice(11, 23);

  return t || ts;
}

function auditLabel(entry: AuditEntry): string {
  if (entry.kind === 'permission') {
    const verb =
      entry.decision === 'reject'
        ? 'rejected'
        : entry.decision === 'approveOnce'
          ? 'approved once'
          : 'approved for session';
    const scope = entry.approvalDomain
      ? `domain ${entry.approvalDomain}`
      : (entry.approvalKind ?? '');
    const tail = scope ? ` · ${scope}` : '';

    return `${entry.permissionKind} ${verb}${tail}`;
  }

  if (entry.kind === 'command') {
    const exit = typeof entry.exitCode === 'number' ? ` · exit ${entry.exitCode}` : '';

    return `${entry.status} · ${entry.command}${exit}`;
  }

  if (entry.kind === 'mcp') {
    const keys = entry.argKeys?.length ? ` · ${entry.argKeys.join(', ')}` : '';

    return `${entry.serverName} · ${entry.toolName}${keys}`;
  }

  if (entry.kind === 'toolFailure') {
    return `${entry.toolName} failed · ${entry.error}`;
  }

  return `${entry.allowed ? 'opened' : 'blocked'} · ${entry.url}`;
}

/// Per-kind CSS class for an audit row. A function (not an inline
/// template ternary) so adding kinds stays a flat switch instead of
/// a nested 4-way ternary.
function auditRowClass(entry: AuditEntry): string {
  switch (entry.kind) {
    case 'permission':
      return `audit-perm-${entry.decision}`;
    case 'command':
      return `audit-command-${entry.status}`;
    case 'mcp':
      return 'audit-mcp';
    case 'toolFailure':
      return 'audit-tool-failure';
    default:
      return entry.allowed ? 'audit-url-ok' : 'audit-url-blocked';
  }
}

function formatTime(ts: string): string {
  // Strip date for compactness; full ISO available via tooltip.
  const t = ts.slice(11, 23);

  return t || ts;
}

function fieldsFor(record: LogRecord): Record<string, unknown> {
  const { ts: _ts, level: _level, message: _msg, ...rest } = record;

  return rest;
}

function formatFields(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields);

  if (keys.length === 0) return '';

  try {
    return JSON.stringify(fields);
  } catch {
    return '[object]';
  }
}
</script>

<template>
  <div class="logviewer">
    <header class="logviewer-header">
      <div class="logviewer-row logviewer-row-tabs">
        <SelectButton
          v-model="tab"
          :options="tabOptions"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          size="small"
          aria-label="Diagnostics tab"
        />
      </div>
      <template v-if="tab === 'logs'">
        <div class="logviewer-row">
          <label class="logviewer-field">
            <span class="logviewer-label">Active level</span>
            <Select
              v-model="bunLevel"
              :options="levelOptions"
              option-label="label"
              option-value="value"
              size="small"
              aria-label="Bun-side log level"
            />
          </label>
          <label class="logviewer-field">
            <span class="logviewer-label">Display</span>
            <Select
              v-model="displayLevel"
              :options="levelOptions"
              option-label="label"
              option-value="value"
              size="small"
              aria-label="Display filter"
            />
          </label>
          <label class="logviewer-field logviewer-field-search">
            <span class="logviewer-label">Search</span>
            <InputText
              v-model="searchModel"
              size="small"
              placeholder="Filter (substring; matches JSON)…"
              aria-label="Filter log records"
            />
          </label>
        </div>
      </template>
      <div class="logviewer-row logviewer-row-actions">
        <span
          v-if="tab === 'logs'"
          class="logviewer-count"
        >
          {{ filtered.length }} shown / {{ logStore.records.length }} buffered
          <span
            v-if="!followTail"
            class="logviewer-not-tailing"
            >· paused</span
          >
        </span>
        <span
          v-else
          class="logviewer-count"
        >
          {{ auditStore.entries.length }} audit entr{{
            auditStore.entries.length === 1 ? 'y' : 'ies'
          }}
        </span>
        <Button
          icon="pi pi-trash"
          label="Clear"
          severity="secondary"
          size="small"
          @click="clearAll"
        />
        <Button
          v-if="tab === 'logs'"
          icon="pi pi-download"
          label="Export bundle"
          size="small"
          @click="exportNow"
        />
      </div>
    </header>
    <div
      v-if="tab === 'logs'"
      ref="listEl"
      class="logviewer-list"
      tabindex="0"
      role="log"
      aria-live="polite"
      @scroll.passive="onScroll"
    >
      <div
        v-if="filtered.length === 0"
        class="logviewer-empty"
      >
        No log records match the current filter.
      </div>
      <article
        v-for="(record, idx) in filtered"
        :key="`${record.ts}-${idx}`"
        class="logviewer-row-record"
        :class="`logviewer-record-${record.level}`"
        :title="record.ts"
      >
        <span class="logviewer-ts">{{ formatTime(record.ts) }}</span>
        <span class="logviewer-level">{{ record.level.toUpperCase() }}</span>
        <span class="logviewer-message">{{ record.message }}</span>
        <span
          v-if="Object.keys(fieldsFor(record)).length > 0"
          class="logviewer-fields"
        >
          {{ formatFields(fieldsFor(record)) }}
        </span>
      </article>
    </div>
    <div
      v-else
      class="logviewer-list"
      tabindex="0"
      role="log"
      aria-live="polite"
    >
      <div
        v-if="auditStore.entries.length === 0"
        class="logviewer-empty"
      >
        No audit entries yet. Permission decisions, URL opens, and MCP tool calls land here as they
        happen.
      </div>
      <article
        v-for="(entry, idx) in auditStore.entries"
        :key="`${entry.ts}-${idx}`"
        class="logviewer-row-record"
        :class="auditRowClass(entry)"
        :title="entry.ts"
      >
        <span class="logviewer-ts">{{ fmtTime(entry.ts) }}</span>
        <span class="logviewer-level">{{ entry.kind.toUpperCase() }}</span>
        <span class="logviewer-message">{{ auditLabel(entry) }}</span>
        <span
          v-if="entry.kind === 'permission' && entry.summary"
          class="logviewer-fields"
        >
          {{ entry.summary }}
        </span>
        <span
          v-else-if="entry.kind === 'command'"
          class="logviewer-fields"
        >
          {{ entry.cwd }}
        </span>
        <span
          v-else-if="
            entry.kind === 'mcp' &&
            entry.argKeyCount &&
            entry.argKeyCount > (entry.argKeys?.length ?? 0)
          "
          class="logviewer-fields"
        >
          +{{ entry.argKeyCount - (entry.argKeys?.length ?? 0) }} more arg(s)
        </span>
      </article>
    </div>
  </div>
</template>

<style scoped>
.logviewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  container-type: inline-size;
  background: var(--p-content-background);
  color: var(--p-text-color);
}

.logviewer-header {
  flex: 0 0 auto;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--p-content-border-color);
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.logviewer-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: flex-end;
}

.logviewer-row-actions {
  justify-content: flex-end;
  align-items: center;
}

.logviewer-field {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.logviewer-field-search {
  flex: 1 1 10rem;
  min-width: min(10rem, 100%);
}

.logviewer-label {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.logviewer-count {
  flex: 1 1 auto;
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
}

.logviewer-not-tailing {
  color: var(--p-yellow-500, #d97706);
}

.logviewer-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0.25rem 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  font-size: 0.78rem;
  line-height: 1.35;
}

.logviewer-list:focus {
  outline: 2px solid var(--p-primary-color);
  outline-offset: -2px;
}

.logviewer-empty {
  padding: 1rem;
  text-align: center;
  color: var(--p-text-muted-color);
  font-family: inherit;
  font-style: italic;
}

.logviewer-row-record {
  display: grid;
  grid-template-columns: minmax(4.5rem, 6rem) minmax(3rem, 4rem) minmax(0, 1fr);
  align-items: baseline;
  gap: 0.4rem;
  padding: 0.15rem 0.75rem;
  border-bottom: 1px solid color-mix(in srgb, var(--p-content-border-color) 30%, transparent);
}

@container (max-width: 24rem) {
  .logviewer-row-record {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.15rem;
  }

  .logviewer-message,
  .logviewer-fields {
    grid-column: 1 / -1;
  }
}

.logviewer-row-record:hover {
  background: color-mix(in srgb, var(--p-text-color) 4%, transparent);
}

.logviewer-ts {
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

.logviewer-level {
  font-weight: 600;
  font-size: 0.68rem;
  letter-spacing: 0.04em;
}

.logviewer-record-trace .logviewer-level {
  color: var(--p-text-muted-color);
}
.logviewer-record-debug .logviewer-level {
  color: var(--p-text-muted-color);
}
.logviewer-record-info .logviewer-level {
  color: var(--p-primary-color);
}
.logviewer-record-warn .logviewer-level {
  color: var(--p-yellow-500, #d97706);
}
.logviewer-record-error .logviewer-level {
  color: var(--p-red-500, #ef4444);
}

.logviewer-row-record.logviewer-record-warn {
  background: color-mix(in srgb, var(--p-yellow-500, #d97706) 7%, transparent);
}
.logviewer-row-record.logviewer-record-error {
  background: color-mix(in srgb, var(--p-red-500, #ef4444) 8%, transparent);
}

.logviewer-row-record.audit-perm-reject {
  background: color-mix(in srgb, var(--p-red-500, #ef4444) 8%, transparent);
}
.logviewer-row-record.audit-perm-approveOnce {
  background: color-mix(in srgb, var(--p-text-color) 3%, transparent);
}
.logviewer-row-record.audit-perm-approveForSession {
  background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
}
.logviewer-row-record.audit-url-blocked {
  background: color-mix(in srgb, var(--p-red-500, #ef4444) 7%, transparent);
}
.logviewer-row-record.audit-url-ok {
  background: color-mix(in srgb, var(--p-text-color) 3%, transparent);
}
.logviewer-row-record.audit-mcp {
  background: color-mix(in srgb, var(--p-primary-color) 5%, transparent);
}
.logviewer-row-record.audit-tool-failure {
  background: color-mix(in srgb, var(--p-red-500, #ef4444) 8%, transparent);
}

.logviewer-row-tabs {
  padding-bottom: 0.25rem;
}

.logviewer-message {
  grid-column: 3 / 4;
  word-break: break-word;
}

.logviewer-fields {
  grid-column: 3 / 4;
  grid-row: 2 / 3;
  color: var(--p-text-muted-color);
  font-size: 0.72rem;
  word-break: break-all;
  white-space: pre-wrap;
}
</style>
