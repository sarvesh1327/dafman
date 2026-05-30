<script setup lang="ts">
/// @-trigger file/dir picker for the composer.
///
/// Detects `@` in the editor via Lexical's `TypeaheadMenuPlugin`,
/// then mounts FilePicker as the menu UI. On select we replace the
/// typed `@query` TextNode with an AttachmentNode pill carrying
/// either `type: "file"` or `type: "directory"`.
///
/// Wire-up:
///   1. TypeaheadMenuPlugin watches the editor for `@`. When it
///      matches, it provides an anchorElement + a `selectOptionAndCleanUp`
///      callback that closes the menu and gives us the textNode
///      containing the query.
///   2. We render FilePicker into the anchor with `externalQuery`
///      driven by the plugin's query-change events.
///   3. ArrowUp/Down keystrokes from the editor are captured at the
///      window level (since editor keeps focus, not the picker) and
///      forwarded to FilePicker's imperative `moveHighlight`.
///   4. Enter from the editor fires the plugin's `select-option` —
///      we pick the picker's currently highlighted match.
///   5. Mouse-click on a picker item OR clicking "Browse…" routes
///      via `selectOptionAndCleanUp(sentinel)` so the plugin gives
///      us the textNode, then we insert the pill using the
///      attachment cached in `pendingAttachment`.

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { TextNode, $createTextNode, $isTextNode } from 'lexical';
import {
  TypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from 'lexical-vue/LexicalTypeaheadMenuPlugin';
import { useLexicalComposer } from 'lexical-vue/LexicalComposer';
import { $createAttachmentNode } from '@/lexical/AttachmentNode';
import { setComposerMenuActive } from '@/lexical/composerMenuState';
import type { SendMessageAttachment } from '@/ipc/types';
import FilePicker from '@/components/shared/FilePicker.vue';
import { useEventListener } from '@vueuse/core';

class SentinelOption extends MenuOption {
  constructor() {
    super('file-picker-sentinel');
  }
}

const props = defineProps<{
  sessionId: string;
}>();

const editor = useLexicalComposer();
const query = ref('');
const menuParent = ref<HTMLElement | null>(null);
const pickerRef = ref<InstanceType<typeof FilePicker> | null>(null);
/// Tunnel: set by click handlers, consumed by onSelectOption.
const pendingAttachment = ref<SendMessageAttachment | null>(null);
/// Whether the `@` typeahead is currently matching (query non-null).
const menuOpen = ref(false);
/// Latest FilePicker result count + in-flight state, mirrored from its
/// `results-state` event so the menu-active decision is reactive.
const resultCount = ref(0);
const resultsLoading = ref(false);

/// Report mention menu-active synchronously to the per-editor registry
/// `SubmitOnEnter` reads on each Enter keystroke (issue #88).
///
/// Decision (the rubber-duck "no-result" open question): mention-active
/// while the menu is open AND it either has a selectable result OR is
/// still loading. A SETTLED empty result set (`@nomatch`) is NOT active,
/// so plain Enter SENDS the raw `@nomatch` text — matching slash-command
/// zero-match semantics. Treating "loading" as active avoids the async
/// race where Enter pressed before the (sub-ms, cached) file search
/// returns would otherwise send `@query` instead of selecting the
/// result that was about to appear.
function syncMentionActive(): void {
  setComposerMenuActive(
    editor,
    'mention',
    menuOpen.value && (resultsLoading.value || resultCount.value > 0),
  );
}

function onResultsState(payload: { count: number; loading: boolean }): void {
  resultCount.value = payload.count;
  resultsLoading.value = payload.loading;
  syncMentionActive();
}

onBeforeUnmount(() => setComposerMenuActive(editor, 'mention', false));

onMounted(() => {
  if (typeof document !== 'undefined') menuParent.value = document.body;
});

const sentinelOptions = computed(() => [new SentinelOption()]);

const triggerFn = useBasicTypeaheadTriggerMatch('@', {
  minLength: 0,
  allowWhitespace: false,
  // Default `punctuation` excludes `.`, `/`, `~`, `\`, `-`, `:` from
  // the match — which means typing `@.` or `@/abs` or `@~/foo` would
  // exit the menu instantly. We need path-nav chars allowed; passing
  // an empty string lets any non-whitespace, non-`@` char extend the
  // match. fileSearch.ts handles whatever the user types from there.
  punctuation: '',
});

function onQueryChange(q: string | null) {
  query.value = q ?? '';
  menuOpen.value = q !== null;

  if (!menuOpen.value) {
    resultCount.value = 0;
    resultsLoading.value = false;
  }

  syncMentionActive();
}

function replaceTriggerWith(
  textNodeContainingQuery: TextNode | null,
  attachment: SendMessageAttachment,
): void {
  if (!textNodeContainingQuery) return;

  editor.update(() => {
    if ($isTextNode(textNodeContainingQuery)) {
      const pill = $createAttachmentNode(attachment);

      textNodeContainingQuery.replace(pill);
      const space = $createTextNode(' ');

      pill.insertAfter(space);
      space.selectEnd();
    }
  });
}

function onSelectOption(payload: {
  option: SentinelOption;
  textNodeContainingQuery: TextNode | null;
  closeMenu: () => void;
}) {
  const { textNodeContainingQuery, closeMenu } = payload;
  // Click path: pendingAttachment is set. Enter-from-editor path:
  // pendingAttachment is null, pull from the picker's highlight.
  const attachment = pendingAttachment.value ?? pickerRef.value?.pickCurrent?.() ?? null;

  pendingAttachment.value = null;

  if (attachment) {
    replaceTriggerWith(textNodeContainingQuery, attachment);
  }

  closeMenu();
  menuOpen.value = false;
  setComposerMenuActive(editor, 'mention', false);
}

function onWindowKey(e: KeyboardEvent): void {
  if (!pickerRef.value?.hasResults?.()) return;

  if (e.key === 'ArrowDown') {
    pickerRef.value.moveHighlight(1);
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    pickerRef.value.moveHighlight(-1);
    e.preventDefault();
  }
}

useEventListener(window, 'keydown', onWindowKey, true);
</script>

<template>
  <TypeaheadMenuPlugin
    v-if="menuParent"
    :options="sentinelOptions"
    :trigger-fn="triggerFn"
    :parent="menuParent"
    @query-change="onQueryChange"
    @select-option="onSelectOption"
  >
    <template #default="{ anchorElementRef, itemProps }">
      <Teleport
        v-if="itemProps.options.length > 0 && anchorElementRef"
        :to="anchorElementRef"
      >
        <div class="mention-menu-anchor">
          <FilePicker
            ref="pickerRef"
            :session-id="props.sessionId"
            :external-query="query"
            :show-search-input="false"
            initial-focus="none"
            @results-state="onResultsState"
            @select="
              (att: SendMessageAttachment) => {
                pendingAttachment = att;
                itemProps.selectOptionAndCleanUp(itemProps.options[0]);
              }
            "
            @dismiss="() => {}"
          />
        </div>
      </Teleport>
    </template>
  </TypeaheadMenuPlugin>
</template>

<style scoped>
.mention-menu-anchor {
  /* Lexical positions anchorElementRef at the caret's BOTTOM. To put
   * the menu above the caret line we translate up by its own height
   * plus a small gap. Matches the original MentionPlugin's idiom.
   *
   * `transform: translateY(...)` creates a NEW stacking context here,
   * so any z-index set on `.file-picker` (the child) is confined to
   * this local context. Without `z-index` set HERE, this element
   * competes against dockview's edge groups (z-index: 999) at "auto",
   * losing the z-fight when the picker overlaps the left sidebar.
   * Setting z-index on the stacking-context root fixes it once: the
   * picker's own z-index inside this element doesn't matter then. */
  position: absolute;
  z-index: 1200;
  transform: translateY(calc(-100% - 2rem));
}
</style>
