<script setup lang="ts">
/// Pure popup body for the composer's @file / paperclip picker.
///
/// Owns: search input (optional), TWO independent toggles (show
/// dotfiles, show ignored dirs), results list, native-dialog escape
/// hatch, keyboard navigation + shortcuts.
///
/// Doesn't own: positioning (parent renders this inside a Teleport
/// or PrimeVue Popover). Doesn't know about Lexical (parent listens
/// for `select` + inserts the AttachmentNode).
///
/// Persistence: toggle prefs live in localStorage so they survive
/// app restart. Falls back gracefully when localStorage isn't
/// available (e.g. SSR / restricted contexts).
///
/// Two surfaces consume this:
///   1. MentionPlugin (the @-trigger path) — `showSearchInput=false`,
///      query comes from props (the text after the @).
///   2. The paperclip button — `showSearchInput=true`, picker owns
///      its own focused input.
///
/// Single-pick per spec: select dismisses the popup. Multi-select
/// can be re-opened. Directories attach as `directory` pills.

import { computed, onMounted, ref, watch } from 'vue';
import { invokeCommand } from '@/ipc/invoke';
import { useToastStore } from '@/stores/app/toastStore';
import { useEventListener } from '@vueuse/core';
import type { WorkspaceFileMatch, SendMessageAttachment } from '@/ipc/types';
import { toErrorMessage } from '@/lib/errorMessage';

const props = withDefaults(
  defineProps<{
    sessionId: string;
    /// External query (from the @ trigger). Ignored when
    /// `showSearchInput` is true (then the internal input drives).
    externalQuery?: string;
    /// When true, render a search input inside the popup and use it.
    /// When false, the parent (TypeaheadMenuPlugin) drives the query
    /// via `externalQuery` and the user types in the editor.
    showSearchInput?: boolean;
    /// Where to send initial focus on mount. Paperclip path wants
    /// `"input"`; the @-trigger path wants `"none"`.
    initialFocus?: 'input' | 'none';
  }>(),
  {
    externalQuery: '',
    showSearchInput: false,
    initialFocus: 'none',
  },
);

const emit = defineEmits<{
  (e: 'select', attachment: SendMessageAttachment): void;
  (e: 'dismiss'): void;
  /// Fired whenever the result set or in-flight state changes. The
  /// `@`-mention surface uses this to decide whether plain Enter should
  /// select a result or fall through to send (issue #88): a menu with
  /// pending or non-empty results is "active" and defers Enter; a
  /// settled empty result set lets Enter send the raw `@query` text.
  (e: 'results-state', payload: { count: number; loading: boolean }): void;
}>();

const LS_HIDDEN = 'dafman.filePicker.showHidden';
const LS_IGNORED = 'dafman.filePicker.showIgnored';

function readPref(key: string): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writePref(key: string, value: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value ? '1' : '0');
    }
  } catch {
    // Storage may be disabled in restricted contexts — keep the
    // in-memory state regardless.
  }
}

const internalQuery = ref('');
const showHidden = ref(readPref(LS_HIDDEN));
const showIgnored = ref(readPref(LS_IGNORED));
const results = ref<WorkspaceFileMatch[]>([]);
const highlightedIndex = ref(0);
const searchInputRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);

const effectiveQuery = computed(() =>
  props.showSearchInput ? internalQuery.value : props.externalQuery,
);

/// Stale-fetch guard via incrementing tag. The bun-side index is
/// cached so calls are sub-ms in steady state.
let fetchTag = 0;

async function fetchResults(): Promise<void> {
  const tag = ++fetchTag;

  emit('results-state', { count: results.value.length, loading: true });

  try {
    const r = await invokeCommand('searchWorkspaceFiles', {
      sessionId: props.sessionId,
      query: effectiveQuery.value,
      limit: 40,
      includeHidden: showHidden.value,
      includeIgnored: showIgnored.value,
    });

    if (tag !== fetchTag) return;

    results.value = r;
    highlightedIndex.value = 0;
    emit('results-state', { count: r.length, loading: false });
  } catch {
    if (tag !== fetchTag) return;

    results.value = [];
    highlightedIndex.value = 0;
    emit('results-state', { count: 0, loading: false });
  }
}

watch(effectiveQuery, fetchResults, { immediate: true });
watch(showHidden, (v) => {
  writePref(LS_HIDDEN, v);
  void fetchResults();
});
watch(showIgnored, (v) => {
  writePref(LS_IGNORED, v);
  void fetchResults();
});

onMounted(() => {
  if (props.initialFocus === 'input') {
    setTimeout(() => searchInputRef.value?.focus(), 0);
  }
});

function toAttachment(match: WorkspaceFileMatch): SendMessageAttachment {
  return match.kind === 'directory'
    ? { type: 'directory', path: match.absolutePath, displayName: match.path }
    : { type: 'file', path: match.absolutePath, displayName: match.path };
}

function selectAt(index: number): void {
  const match = results.value[index];

  if (!match) return;

  emit('select', toAttachment(match));
}

function onInputKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    highlightedIndex.value = Math.min(results.value.length - 1, highlightedIndex.value + 1);
    scrollHighlightIntoView();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    highlightedIndex.value = Math.max(0, highlightedIndex.value - 1);
    scrollHighlightIntoView();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    selectAt(highlightedIndex.value);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    emit('dismiss');
  }
}

/// Window-level keyboard shortcuts (work even when editor has focus,
/// which is the @-trigger case). Alt+H / Alt+I flip the two
/// toggles; we suppress them outside the open lifecycle to avoid
/// fighting other surfaces.
function onWindowKey(e: KeyboardEvent): void {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;

  const k = e.key.toLowerCase();

  if (k === 'h') {
    e.preventDefault();
    showHidden.value = !showHidden.value;
  } else if (k === 'i') {
    e.preventDefault();
    showIgnored.value = !showIgnored.value;
  }
}

useEventListener(window, 'keydown', onWindowKey, true);

/// Exposed so the @-trigger surface can forward keystrokes from the
/// editor (where focus actually lives) without re-implementing nav.
defineExpose({
  moveHighlight(direction: 1 | -1): void {
    if (results.value.length === 0) return;

    if (direction > 0) {
      highlightedIndex.value = Math.min(results.value.length - 1, highlightedIndex.value + 1);
    } else {
      highlightedIndex.value = Math.max(0, highlightedIndex.value - 1);
    }

    scrollHighlightIntoView();
  },
  pickCurrent(): SendMessageAttachment | null {
    const match = results.value[highlightedIndex.value];

    return match ? toAttachment(match) : null;
  },
  hasResults(): boolean {
    return results.value.length > 0;
  },
});

function scrollHighlightIntoView(): void {
  const list = listRef.value;

  if (!list) return;

  const child = list.querySelector<HTMLElement>(`[data-index="${highlightedIndex.value}"]`);

  child?.scrollIntoView({ block: 'nearest' });
}

async function browse(kind: 'file' | 'directory'): Promise<void> {
  try {
    const picked = await invokeCommand('pickAttachment', { kind });

    if (!picked) return;

    emit(
      'select',
      picked.kind === 'directory'
        ? { type: 'directory', path: picked.path, displayName: picked.path }
        : { type: 'file', path: picked.path, displayName: picked.path },
    );
  } catch (err) {
    useToastStore().error('Picker failed', toErrorMessage(err));
  }
}
</script>

<template>
  <div
    class="file-picker"
    role="dialog"
    aria-label="Attach file or folder"
  >
    <div
      v-if="props.showSearchInput"
      class="file-picker-search"
    >
      <i
        class="pi pi-search file-picker-search-icon"
        aria-hidden="true"
      />
      <input
        ref="searchInputRef"
        v-model="internalQuery"
        class="file-picker-search-input"
        type="text"
        placeholder="Search files / dirs, or type / ~ ./ ../"
        aria-label="Search workspace"
        @keydown="onInputKey"
      />
    </div>
    <div class="file-picker-toolbar">
      <div class="file-picker-toggles">
        <label
          class="file-picker-toggle"
          title="Alt+H"
        >
          <input
            v-model="showHidden"
            type="checkbox"
            aria-label="Show hidden (dotfiles)"
          />
          <span>Hidden</span>
          <span class="file-picker-shortcut">Alt+H</span>
        </label>
        <label
          class="file-picker-toggle"
          title="Alt+I"
        >
          <input
            v-model="showIgnored"
            type="checkbox"
            aria-label="Show ignored (node_modules, dist, …)"
          />
          <span>Ignored</span>
          <span class="file-picker-shortcut">Alt+I</span>
        </label>
      </div>
      <div class="file-picker-browse-group">
        <button
          type="button"
          class="file-picker-browse"
          title="Open native file picker"
          @click="browse('file')"
        >
          <i
            class="pi pi-file"
            aria-hidden="true"
          />
          File…
        </button>
        <button
          type="button"
          class="file-picker-browse"
          title="Open native folder picker"
          @click="browse('directory')"
        >
          <i
            class="pi pi-folder-open"
            aria-hidden="true"
          />
          Folder…
        </button>
      </div>
    </div>
    <div
      ref="listRef"
      class="file-picker-list"
      role="listbox"
      aria-label="Matching files and directories"
    >
      <template v-if="results.length === 0">
        <div class="file-picker-empty">No matches.</div>
      </template>
      <template v-else>
        <button
          v-for="(r, i) in results"
          :key="`${r.absolutePath}::${r.kind}`"
          type="button"
          class="file-picker-item"
          :class="{ 'is-highlighted': i === highlightedIndex }"
          :data-index="i"
          role="option"
          :aria-selected="i === highlightedIndex"
          @mousedown.prevent
          @click="selectAt(i)"
          @mouseenter="highlightedIndex = i"
        >
          <i
            class="pi file-picker-item-icon"
            :class="r.kind === 'directory' ? 'pi-folder' : 'pi-file'"
            aria-hidden="true"
          />
          <span class="file-picker-item-text">
            <span class="file-picker-item-name">{{ r.name }}</span>
            <span class="file-picker-item-path">{{ r.path }}</span>
          </span>
          <span class="file-picker-item-kind">{{ r.kind === 'directory' ? 'dir' : 'file' }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.file-picker {
  display: flex;
  flex-direction: column;
  width: min(36rem, calc(100vw - 1rem));
  min-width: min(28rem, calc(100vw - 1rem));
  max-width: calc(100vw - 1rem);
  max-height: 22rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-surface-border);
  border-radius: var(--p-border-radius-md);
  box-shadow: 0 -6px 22px rgba(0, 0, 0, 0.28);
  overflow: hidden;
  /* Local z-index for the paperclip-button mode (rendered as a
   * PrimeVue Popover at z-index 1100). When the mention plugin
   * teleports this into Lexical's typeahead containerDiv, the
   * outer `.mention-menu-anchor` owns the stacking-context z-index
   * — see MentionPlugin.vue. */
  position: relative;
  z-index: 1200;
}

.file-picker-search {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--p-surface-border);
}

.file-picker-search-icon {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.file-picker-search-input {
  flex: 1;
  background: transparent;
  border: 0;
  outline: none;
  color: var(--p-text-color);
  font: inherit;
  font-size: 0.9rem;
}

.file-picker-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  padding: 0.35rem 0.6rem;
  border-bottom: 1px solid var(--p-surface-border);
  background: color-mix(in srgb, var(--p-content-hover-background) 35%, transparent);
}

.file-picker-toggles {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.7rem;
}

.file-picker-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  cursor: pointer;
  user-select: none;
}

.file-picker-toggle input {
  accent-color: var(--p-primary-color);
  margin: 0;
}

.file-picker-shortcut {
  font-family: var(--p-font-family-mono, ui-monospace, monospace);
  font-size: 0.65rem;
  padding: 0.05rem 0.3rem;
  background: color-mix(in srgb, var(--p-text-muted-color) 18%, transparent);
  border-radius: 3px;
  color: var(--p-text-muted-color);
}

.file-picker-browse-group {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
}

.file-picker-browse {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.5rem;
  background: transparent;
  border: 1px solid var(--p-surface-border);
  border-radius: var(--p-border-radius-sm);
  color: var(--p-text-color);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}

.file-picker-browse:hover {
  background: var(--p-content-hover-background);
}

.file-picker-list {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 0.25rem;
  max-height: 16rem;
  flex: 1;
}

.file-picker-empty {
  padding: 0.6rem 0.7rem;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}

.file-picker-item {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.35rem 0.55rem;
  background: transparent;
  border: 0;
  border-radius: var(--p-border-radius-sm);
  font: inherit;
  color: var(--p-text-color);
  text-align: left;
  cursor: pointer;
  width: 100%;
}

.file-picker-item.is-highlighted,
.file-picker-item:hover {
  background: var(--p-content-hover-background);
}

.file-picker-item-icon {
  font-size: 0.9rem;
  color: var(--p-text-muted-color);
  width: 1.2em;
  text-align: center;
  flex-shrink: 0;
}

.file-picker-item-text {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  min-width: 0;
  flex: 1;
}

.file-picker-item-name {
  font-size: 0.85rem;
  color: var(--p-text-color);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-picker-item-path {
  font-family: var(--p-font-family-mono, ui-monospace, monospace);
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-picker-item-kind {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color);
  flex-shrink: 0;
}
</style>
