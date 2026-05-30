<script setup lang="ts">
// Lexical-backed chat composer.
//
// Plain-text input today; the EditorState model leaves room for future
// custom nodes (slash commands, @mentions, #hashtags, inline images)
// without changing the parent contract. The display side (assistant /
// reasoning / user messages) renders full markdown via `MessageContent`.
//
// Wire contract: emits `submit` with the trimmed plain-text content
// when the send chord is pressed or the send button is clicked. The
// send chord is governed by `composer.submitKeybinding` (#88): in the
// default `'enter'` mode plain Enter sends and Ctrl/Cmd+Enter inserts a
// newline; in `'mod-enter'` mode that's reversed. Shift+Enter always
// inserts a soft line break. Disabled state flows through `EditableSync`
// since `lexical-vue`'s composer only reads `editable` once on mount.
//
// Markdown keystroke shortcuts (`# ` -> heading, `**bold**`, fenced
// code, etc. auto-formatting AS YOU TYPE) are gated behind
// `enableMarkdownShortcuts` so we can ship typing reliably even if a
// plugin combo destabilises input under WebView2. When the gate is on
// we mount `RichTextPlugin` + the markdown plugin stack and register
// shortcuts; when off we use plain text. Either way the same Enter +
// SubmitButton path applies.

import { computed, ref, useTemplateRef } from 'vue';
import Popover from 'primevue/popover';
import type { MenuItem } from 'primevue/menuitem';
import { LexicalComposer } from 'lexical-vue/LexicalComposer';
import { ContentEditable } from 'lexical-vue/LexicalContentEditable';
import { PlainTextPlugin } from 'lexical-vue/LexicalPlainTextPlugin';
import { RichTextPlugin } from 'lexical-vue/LexicalRichTextPlugin';
import { HistoryPlugin } from 'lexical-vue/LexicalHistoryPlugin';
import { AutoFocusPlugin } from 'lexical-vue/LexicalAutoFocusPlugin';
import { ListPlugin } from 'lexical-vue/LexicalListPlugin';
import { LinkPlugin } from 'lexical-vue/LexicalLinkPlugin';
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $createParagraphNode,
  $createTextNode,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import {
  EditableSync,
  RegisterMarkdownShortcuts,
  SubmitOnEnter,
  TypingDiagnostic,
  consumeComposerText,
  type ComposerSubmitMode,
  type ComposerSubmitPayload,
} from '@/lexical/plugins';
import { markdownNodes } from '@/lexical/nodes';
import { $createAttachmentNode } from '@/lexical/AttachmentNode';
import { lexicalTheme } from '@/lexical/theme';
import type { DefaultSendMode } from '@/stores/chat/sessionsStore';
import type { SendMessageAttachment } from '@/ipc/types';
import { useToastStore } from '@/stores/app/toastStore';
import { useSettingsStore } from '@/stores/app/settingsStore';
import { storeToRefs } from 'pinia';
import { runLocalSlashCommand } from '@/lib/sessionCommands';
import SlashCommandPlugin from '@/components/chat/SlashCommandPlugin.vue';
import MentionPlugin from '@/components/chat/MentionPlugin.vue';
import FilePicker from '@/components/shared/FilePicker.vue';
import ModeButtonGroup from '@/components/chat/ModeButtonGroup.vue';
import TerminalPanel from '@/components/terminal/TerminalPanel.vue';
import ComposerSubmitButton from '@/components/chat/composer/ComposerSubmitButton';
import ComposerEditorBridge from '@/components/chat/composer/ComposerEditorBridge';
import {
  applyEditorFormat,
  computeFormatState,
  INITIAL_FORMAT_STATE,
  type EditorFormatAction,
  type EditorFormatState,
} from '@/composables/composerFormat';
import { useComposerToolbarLayout } from '@/composables/useComposerToolbarLayout';
import { useComposerAttachments } from '@/composables/useComposerAttachments';
import { useComposerCommandMode } from '@/composables/useComposerCommandMode';

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    placeholder?: string;
    enableMarkdownShortcuts?: boolean;
    /// Per-session default for the primary send button + send chord.
    /// Defaults to "steer".
    defaultMode?: DefaultSendMode;
    /// When provided, mounts the slash-command typeahead bound to
    /// this session. Omit on synthetic / playground composers that
    /// shouldn't fire real session commands.
    sessionId?: string;
    commandTerminalId?: string;
  }>(),
  {
    disabled: false,
    placeholder: 'Ask anything — use @ to attach files, / for commands.',
    enableMarkdownShortcuts: true,
    defaultMode: 'steer',
    sessionId: undefined,
    commandTerminalId: undefined,
  },
);

const isDev = import.meta.env.DEV;
const diagEnabled =
  isDev && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('diag');

/// Pending attachments are now stored INLINE in the editor itself —
/// each chip is an `AttachmentNode` (a token-mode TextNode subclass)
/// inserted at the cursor. We extract them in document order at submit
/// time via `collectAttachments(editor)`. This keeps "pill position in
/// text" === "attachment index in array" naturally without a parallel
/// ref array drifting from the editor state.
const toasts = useToastStore();
const settingsStore = useSettingsStore();
const { settings } = storeToRefs(settingsStore);
/// #88: which keystroke sends. Read reactively so a Settings change
/// re-keys `SubmitOnEnter`'s keybinding getter without remounting.
const submitKeybinding = computed(() => settings.value.composer?.submitKeybinding ?? 'enter');
const commandMode = ref(false);

const toolbarRef = useTemplateRef<HTMLElement>('toolbarRef');
const { inlineFormatActions, overflowFormatActions } = useComposerToolbarLayout(toolbarRef);

function addAttachment(a: SendMessageAttachment): void {
  const editor = editorRef.value as LexicalEditor | null;

  if (!editor) return;

  editor.update(
    () => {
      const node = $createAttachmentNode(a);
      const space = $createTextNode(' ');
      const sel = $getSelection();

      if ($isRangeSelection(sel)) {
        sel.insertNodes([node, space]);
      } else {
        // No active selection (drag-drop before the editor has focus).
        // Ensure there's a paragraph to append to, then append both nodes.
        const root = $getRoot();
        let last = root.getLastChild();

        if (!$isElementNode(last)) {
          last = $createParagraphNode();
          root.append(last);
        }

        (last as ElementNode).append(node);
        (last as ElementNode).append(space);
      }

      // Place caret AFTER the trailing space so the next keystroke
      // continues plain typing.
      space.selectEnd();
    },
    {
      // Focus AFTER the reconcile so the contenteditable DOM exists
      // and the caret-from-space-selectEnd is mounted. Plain
      // `editor.focus()` outside the update can race with reconcile
      // (especially on drag-drop where the drag source had focus and
      // we need to claim it back).
      onUpdate: () => {
        editor.focus(undefined, { defaultSelection: 'rootEnd' });
      },
    },
  );
}

function clearEditor(): void {
  const editor = editorRef.value as LexicalEditor | null;

  if (!editor) return;

  editor.update(() => {
    $getRoot().clear();
  });
}

const { onDrop, onPaste } = useComposerAttachments({
  addAttachment,
  toasts,
});

/// Emits a discriminated submit payload identifying which send mode
/// the user invoked. The parent (`ChatWindow`) maps it to the
/// session-store action.
const emit = defineEmits<{
  submit: [payload: ComposerSubmitPayload & { attachments?: SendMessageAttachment[] }];
  requestCommandTerminal: [];
  openFullTerminal: [];
  'update:defaultMode': [mode: DefaultSendMode];
}>();

/// Imperatively focus the editor. Used by ChatWindow when an external
/// surface (e.g. the Sessions sidebar) asks to bring the composer
/// into focus without going through normal click-to-focus.
function focusComposer(): void {
  const editor = editorRef.value as LexicalEditor | null;

  if (!editor) return;

  editor.focus();
}

/// Replace the composer's current text with `value`. Used by the
/// message action bar's Edit action (load message text into the
/// composer for amendment). Plain-text only — markdown features
/// (mentions, code fences) round-trip via SubmitOnEnter's
/// consumeComposerText pass that we don't shortcut here.
function setText(value: string): void {
  const editor = editorRef.value as LexicalEditor | null;

  if (!editor) return;

  editor.update(() => {
    const root = $getRoot();

    root.clear();
    const para = $createParagraphNode();

    if (value.length > 0) para.append($createTextNode(value));

    root.append(para);
  });
  // Move caret to the end so the user can keep typing.
  setTimeout(() => editor.focus(), 0);
}

/// Append text to the current composer contents on a new line.
/// Used by Quote (insert message text as a blockquote) and Retry-
/// style flows that build up multi-line prompts.
function appendText(value: string): void {
  const editor = editorRef.value as LexicalEditor | null;

  if (!editor) return;

  editor.update(() => {
    const root = $getRoot();
    const lines = value.split('\n');

    for (const line of lines) {
      const para = $createParagraphNode();

      if (line.length > 0) para.append($createTextNode(line));

      root.append(para);
    }
  });
  setTimeout(() => editor.focus(), 0);
}

/// Toggle the file picker popover anchored on the paperclip button.
/// The popover hosts the same FilePicker the @-trigger uses, with
/// its own search input (since the editor isn't the source of the
/// query here) and the native Browse… escape hatch.
const filePickerPopover = ref<InstanceType<typeof Popover> | null>(null);
const formatPopover = ref<InstanceType<typeof Popover> | null>(null);

function openFilePicker(event: Event): void {
  filePickerPopover.value?.toggle(event);
}

function toggleFormatPopover(event: Event): void {
  formatPopover.value?.toggle(event);
}

function onPickerSelect(att: SendMessageAttachment): void {
  addAttachment(att);
  filePickerPopover.value?.hide();
}

function formatEditor(action: EditorFormatAction): void {
  const editor = editorRef.value as LexicalEditor | null;

  if (!editor || props.disabled) return;

  applyEditorFormat(editor, action);
}

const editorFormatState = ref<EditorFormatState>({ ...INITIAL_FORMAT_STATE });

function readEditorFormatState(): void {
  editorFormatState.value = computeFormatState();
}

const { enterCommandMode, exitCommandMode, onCommandModeKeydown, onComposerKeydown } =
  useComposerCommandMode({
    commandMode,
    getEditorText: () => {
      const editor = editorRef.value as LexicalEditor | null;

      if (!editor) return '';

      return editor.getEditorState().read(() => $getRoot().getTextContent());
    },
    clearEditor,
    focusComposer,
    emitRequestCommandTerminal: () => emit('requestCommandTerminal'),
    isDisabled: () => props.disabled,
  });

defineExpose({
  focus: focusComposer,
  setText,
  appendText,
  addAttachment,
  enterCommandMode,
  exitCommandMode,
});

const editable = computed(() => !props.disabled);
const richText = computed(() => props.enableMarkdownShortcuts);

const initialConfig = computed(() => ({
  namespace: 'DafmanComposer',
  editable: true,
  nodes: markdownNodes,
  theme: lexicalTheme,
  onError(error: Error) {
    // `installRendererLogBridge` (`src/ipc/rendererLog.ts`) already
    // intercepts `console.error` and mirrors it to the bun JSON log,
    // so a single `console.error` reaches both surfaces. Don't also
    // call `rendererLog` here — that would double-log.
    console.error('[lexical composer]', error);
  },
}));

async function onSubmit(payload: ComposerSubmitPayload) {
  if (props.sessionId && (await runLocalSlashCommand(props.sessionId, payload.text))) {
    return;
  }

  emit('submit', payload);
}

/// Dropdown items for the SplitButton — let the user change the
/// session's default send mode (the action attached to the primary
/// button + the send chord). Interrupt is intentionally NOT eligible
/// as a default — it always aborts the current turn, which is a
/// destructive choice that should require an explicit modifier.
const defaultModeItems = computed<MenuItem[]>(() => [
  {
    label: 'Steer (immediate)',
    icon: props.defaultMode === 'steer' ? 'pi pi-check' : 'pi pi-bolt',
    command: () => emit('update:defaultMode', 'steer'),
  },
  {
    label: 'Queue (wait for current turn)',
    icon: props.defaultMode === 'queue' ? 'pi pi-check' : 'pi pi-clock',
    command: () => emit('update:defaultMode', 'queue'),
  },
  { separator: true },
  {
    label: 'Send & interrupt current turn',
    icon: 'pi pi-stop-circle',
    command: () => triggerSubmit('interrupt'),
  },
]);

/// Imperative send trigger used by the SplitButton's "interrupt" menu
/// entry. Reaches into the editor via the editor-ref established by
/// `ComposerEditorBridge` below captures the active editor.
const editorRef = ref<unknown>(null);

function triggerSubmit(mode: ComposerSubmitMode) {
  const editor = editorRef.value as LexicalEditor | null;

  if (!editor || props.disabled) return;

  const result = consumeComposerText(editor);

  if (result === null) return;

  emit('submit', {
    text: result.text,
    mode,
    ...(result.attachments.length > 0 ? { attachments: result.attachments } : {}),
  });
}

/// Captures the active editor instance so external menu items
/// (e.g. the SplitButton's interrupt entry) can submit through the
/// same code path as the in-editor button. Stored as `unknown` because
/// `lexical-vue`'s `useLexicalComposer()` is typed against a slightly
/// older `LexicalEditor` shape than the one exported by `lexical`;
/// we cast at the call site where we actually use it.
function onEditorReady(editor: LexicalEditor): void {
  editorRef.value = editor;
}

const primaryLabel = computed(() => '');
const primaryIcon = computed(() => (props.defaultMode === 'queue' ? 'pi pi-clock' : 'pi pi-send'));
/// The chord that sends, and the one that inserts a newline, depend on
/// the `composer.submitKeybinding` setting (#88).
const sendChord = computed(() => (submitKeybinding.value === 'enter' ? 'Enter' : 'Ctrl+Enter'));
const newlineChord = computed(() => (submitKeybinding.value === 'enter' ? 'Ctrl+Enter' : 'Enter'));
const primaryTooltip = computed(() =>
  props.defaultMode === 'queue'
    ? `Queue (${sendChord.value}) — wait behind current turn. ${newlineChord.value} inserts a newline. Alt+Enter forces queue; Ctrl+Shift+Enter interrupts.`
    : `Steer (${sendChord.value}) — send immediately into current turn. ${newlineChord.value} inserts a newline. Alt+Enter queues; Ctrl+Shift+Enter interrupts.`,
);

/// SplitButton-style submit. Primary action runs the session's
/// `defaultSendMode` (Steer by default). The dropdown lets the user
/// pick a different default or trigger an explicit interrupt. The
/// shortcut hints in the dropdown labels match the bindings registered
/// by `SubmitOnEnter`. Implementation moved to
/// `./composer/ComposerSubmitButton.ts`.
</script>

<template>
  <div
    class="lex-composer"
    @dragover.prevent
    @drop="onDrop"
  >
    <div class="lex-composer-frame">
      <LexicalComposer :initial-config="initialConfig">
        <EditableSync :editable="editable" />
        <SubmitOnEnter
          :submit-keybinding="submitKeybinding"
          @submit="onSubmit"
        />
        <TypingDiagnostic v-if="diagEnabled" />
        <SlashCommandPlugin
          v-if="props.sessionId"
          :session-id="props.sessionId"
        />
        <MentionPlugin
          v-if="props.sessionId"
          :session-id="props.sessionId"
        />
        <div
          class="lex-composer-shell"
          :class="{ 'is-command-mode': commandMode }"
          @paste="onPaste"
          @keydown.capture="onComposerKeydown"
        >
          <div
            v-if="commandMode"
            class="lex-command-mode"
            @keydown.capture="onCommandModeKeydown"
          >
            <TerminalPanel
              v-if="props.commandTerminalId"
              :params="{ terminalId: props.commandTerminalId, compact: true }"
            />
            <p
              v-else
              class="lex-command-loading"
            >
              Starting session terminal…
            </p>
          </div>
          <div
            v-show="!commandMode"
            class="lex-composer-editor"
          >
            <template v-if="richText">
              <RichTextPlugin>
                <template #contentEditable>
                  <ContentEditable
                    class="lex-content lex-composer-input"
                    role="textbox"
                    :aria-multiline="true"
                    :aria-disabled="props.disabled"
                    :aria-label="placeholder"
                  />
                </template>
                <template #placeholder>
                  <div class="lex-composer-placeholder">{{ placeholder }}</div>
                </template>
              </RichTextPlugin>
              <ListPlugin />
              <LinkPlugin />
              <RegisterMarkdownShortcuts />
            </template>
            <template v-else>
              <PlainTextPlugin>
                <template #contentEditable>
                  <ContentEditable
                    class="lex-content lex-composer-input"
                    role="textbox"
                    :aria-multiline="true"
                    :aria-disabled="props.disabled"
                    :aria-label="placeholder"
                  />
                </template>
                <template #placeholder>
                  <div class="lex-composer-placeholder">{{ placeholder }}</div>
                </template>
              </PlainTextPlugin>
            </template>
            <HistoryPlugin />
            <AutoFocusPlugin />
          </div>
          <div class="lex-composer-send">
            <ComposerSubmitButton
              :disabled="props.disabled || commandMode"
              :label="primaryLabel"
              :icon="primaryIcon"
              :tooltip="primaryTooltip"
              :model="defaultModeItems"
              @submit="onSubmit"
            />
          </div>
        </div>
        <footer
          ref="toolbarRef"
          class="lex-composer-toolbar"
        >
          <div class="lex-toolbar-left">
            <ModeButtonGroup
              v-if="props.sessionId"
              :session-id="props.sessionId"
            />
            <slot name="session-left-controls" />
          </div>
          <div class="lex-toolbar-center">
            <button
              v-if="props.sessionId"
              type="button"
              class="lex-toolbar-btn lex-command-trigger"
              :class="{ 'is-active': commandMode }"
              :title="commandMode ? 'Exit command mode' : 'Open embedded session terminal'"
              :aria-label="commandMode ? 'Exit command mode' : 'Open embedded session terminal'"
              :aria-pressed="commandMode"
              :disabled="props.disabled"
              @click="commandMode ? exitCommandMode() : enterCommandMode()"
            >
              <i
                class="pi pi-chevron-right"
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              class="lex-toolbar-btn"
              title="Attach files or folders"
              aria-label="Attach files or folders"
              :disabled="props.disabled"
              @click="openFilePicker"
            >
              <i
                class="pi pi-paperclip"
                aria-hidden="true"
              />
            </button>
            <Popover
              ref="filePickerPopover"
              class="lex-attach-popover"
              :pt="{ content: { style: 'padding: 0' } }"
            >
              <FilePicker
                v-if="props.sessionId"
                :session-id="props.sessionId"
                :show-search-input="true"
                initial-focus="input"
                @select="onPickerSelect"
                @dismiss="filePickerPopover?.hide()"
              />
            </Popover>
            <button
              type="button"
              class="lex-toolbar-btn lex-format-overflow"
              title="Formatting"
              aria-label="Formatting"
              :disabled="props.disabled || overflowFormatActions.length === 0"
              @click="toggleFormatPopover"
            >
              <i
                class="pi pi-ellipsis-h"
                aria-hidden="true"
              />
            </button>
            <Popover
              ref="formatPopover"
              class="lex-format-popover"
            >
              <div
                class="lex-format-menu"
                aria-label="Formatting commands"
              >
                <button
                  v-for="action in overflowFormatActions"
                  :key="`menu-${action.label}`"
                  type="button"
                  class="lex-format-menu-item"
                  :class="{ 'is-active': editorFormatState[action.action] }"
                  :aria-pressed="editorFormatState[action.action]"
                  :disabled="props.disabled"
                  @click="
                    () => {
                      formatEditor(action.action);
                      formatPopover?.hide();
                    }
                  "
                >
                  <i
                    v-if="action.icon"
                    class="pi"
                    :class="action.icon"
                    aria-hidden="true"
                  />
                  <span
                    v-else
                    class="lex-format-glyph"
                    :class="`lex-format-glyph-${action.action}`"
                    aria-hidden="true"
                  >
                    {{ action.glyph }}
                  </span>
                  <span>{{ action.label }}</span>
                </button>
              </div>
            </Popover>
            <div
              class="lex-markdown-tools"
              aria-label="Markdown shortcuts"
            >
              <button
                v-for="action in inlineFormatActions"
                :key="action.label"
                type="button"
                class="lex-toolbar-btn"
                :class="[{ 'is-active': editorFormatState[action.action] }]"
                :title="action.title"
                :aria-label="action.title"
                :aria-pressed="editorFormatState[action.action]"
                :disabled="props.disabled"
                @click="formatEditor(action.action)"
              >
                <i
                  v-if="action.icon"
                  class="pi"
                  :class="action.icon"
                  aria-hidden="true"
                />
                <span
                  v-else
                  class="lex-format-glyph"
                  :class="`lex-format-glyph-${action.action}`"
                  aria-hidden="true"
                >
                  {{ action.glyph }}
                </span>
              </button>
            </div>
          </div>
          <div class="lex-toolbar-right">
            <slot name="session-right-controls" />
          </div>
          <slot name="session-controls" />
        </footer>
        <ComposerEditorBridge
          :on-editor="onEditorReady"
          :on-format-state-read="readEditorFormatState"
        />
      </LexicalComposer>
    </div>
  </div>
</template>

<style scoped>
.lex-composer-frame {
  display: flex;
  flex-direction: column;
  border: 1px solid
    color-mix(
      in srgb,
      var(--accent, var(--p-content-border-color)) 50%,
      var(--p-content-border-color)
    );
  border-radius: var(--p-border-radius-md, 8px);
  background: var(--p-content-background);
  overflow: hidden;
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease;
  margin: 0.5rem;
}

.lex-composer-frame:focus-within {
  border-color: var(--accent, var(--p-primary-color));
  box-shadow: 0 0 0 1px var(--accent, var(--p-primary-color));
}

.lex-composer-placeholder {
  right: 0.75rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lex-composer-toolbar {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  gap: 0.45rem;
  padding: 0.25rem 0.4rem;
  min-height: 2.3rem;
  border-top: 1px solid color-mix(in srgb, var(--p-content-border-color) 60%, transparent);
  background: color-mix(in srgb, var(--p-content-background) 95%, var(--p-text-color));
  /* SessionHeaderControls uses container queries to shrink its
   * children. Give it a container context here so it reacts to the
   * toolbar's width, not the page width. */
  container-type: inline-size;
  /* No overlap, ever: the three groups are sized to their (already
   * container-query-collapsed) content and are not allowed to shrink
   * below it — see the `min-width` note on the groups below. When even
   * the collapsed content can't fit on one line, the toolbar WRAPS to a
   * second row rather than letting a group spill over its neighbour
   * (the #66 / #17 regression). Never show a horizontal scrollbar in
   * the composer chrome. */
  flex-wrap: wrap;
  row-gap: 0.3rem;
  overflow-x: hidden;
  overflow-y: visible;
}

/* `min-width: auto` (the default — i.e. do NOT set `min-width: 0`) is
 * load-bearing here: it stops the flex algorithm from shrinking a group
 * below its min-content width. With `min-width: 0` a group's box could
 * shrink under its rigid content, which then painted OVER the adjacent
 * group (#66). Wrapping (above) is the intended fallback instead. */
.lex-toolbar-left,
.lex-toolbar-center,
.lex-toolbar-right {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.lex-toolbar-left {
  justify-content: flex-start;
  flex: 0 1 auto;
  overflow: visible;
}

.lex-toolbar-center {
  justify-content: center;
  flex: 0 1 auto;
  position: relative;
  z-index: 1;
}

.lex-toolbar-right {
  justify-content: flex-end;
  flex: 0 1 auto;
  margin-left: auto;
  position: relative;
  z-index: 1;
}

.lex-markdown-tools {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
  flex: 0 0 auto;
  padding: 0 0.2rem;
  border-left: 1px solid color-mix(in srgb, var(--p-content-border-color) 70%, transparent);
  border-right: 1px solid color-mix(in srgb, var(--p-content-border-color) 70%, transparent);
}

.lex-format-overflow {
  display: inline-flex;
}

.lex-format-overflow:disabled {
  display: none;
}

.lex-format-menu {
  display: grid;
  min-width: 11rem;
  padding: 0.25rem;
  gap: 0.1rem;
}

.lex-format-menu-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  border: 0;
  border-radius: var(--p-border-radius-sm, 4px);
  background: transparent;
  color: var(--p-text-color);
  padding: 0.4rem 0.55rem;
  text-align: left;
  cursor: pointer;
}

.lex-format-menu-item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--p-text-color) 8%, transparent);
}

.lex-format-menu-item.is-active {
  background: color-mix(in srgb, var(--p-primary-color) 16%, transparent);
  color: var(--p-primary-color);
}

.lex-toolbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: var(--p-border-radius-sm, 4px);
  border: 0;
  background: transparent;
  color: var(--p-text-muted-color);
  cursor: pointer;
  flex: 0 0 auto;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}

.lex-toolbar-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--p-text-color) 8%, transparent);
  color: var(--p-text-color);
}

.lex-toolbar-btn.is-active {
  background: color-mix(in srgb, var(--p-primary-color) 18%, transparent);
  color: var(--p-primary-color);
}

.lex-toolbar-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.lex-toolbar-btn .pi {
  font-size: 0.95rem;
}

.lex-format-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1rem;
  height: 1rem;
  font-size: 0.78rem;
  line-height: 1;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
}

.lex-format-glyph-bold {
  font-weight: 800;
}

.lex-format-glyph-italic {
  font-family: Georgia, 'Times New Roman', serif;
  font-style: italic;
  font-weight: 700;
}

.lex-format-glyph-underline {
  text-decoration: underline;
  font-weight: 700;
}

.lex-format-glyph-strikethrough {
  text-decoration: line-through;
  font-weight: 700;
}

/* Send button inside the editor row: icon-only, taller + narrower
 * pill that vertically centers in the input shell. */
.lex-submit-button :deep(.p-button) {
  height: 2.4rem;
  min-height: 2.4rem;
  padding: 0 0.45rem;
  font-size: 0.85rem;
}

.lex-submit-button :deep(.p-button .pi) {
  font-size: 1rem;
}

.lex-submit-button :deep(.p-splitbutton-dropdown) {
  padding: 0 0.25rem;
  min-width: 1.4rem;
}

/* Flatten the SessionHeaderControls inside the composer footer — drop
 * the workspace chip + inline reasoning visibility (already lives in
 * the gear popover) and remove visible select borders so picker labels
 * read as chevron-text buttons à la Copilot's composer. */
.lex-composer-toolbar :deep(.session-header-controls) {
  gap: 0.2rem;
  padding: 0;
  height: 1.75rem;
  flex: 0 1 auto;
  min-width: 0;
}

.lex-composer-toolbar :deep(.session-header-controls .workspace-chip) {
  /* keep it, but tighten — composer toolbar is shorter than the old tab strip */
  height: 1.5rem;
  font-size: 0.72rem;
  padding: 0 0.45rem;
}

.lex-composer-toolbar :deep(.compact-select-reasoning) {
  display: none;
}

.lex-composer-toolbar :deep(.compact-select .p-select),
.lex-composer-toolbar :deep(.compact-select .p-treeselect) {
  height: 1.75rem;
  min-height: 1.75rem;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.lex-composer-toolbar :deep(.compact-select .p-select:hover),
.lex-composer-toolbar :deep(.compact-select .p-treeselect:hover) {
  background: color-mix(in srgb, var(--p-text-color) 8%, transparent);
}

.lex-composer-toolbar :deep(.compact-select .p-select-label),
.lex-composer-toolbar :deep(.compact-select .p-treeselect-label) {
  padding: 0 0.45rem;
  font-size: 0.78rem;
  color: var(--p-text-color);
}

.lex-composer-toolbar :deep(.compact-select .p-select-dropdown),
.lex-composer-toolbar :deep(.compact-select .p-treeselect-dropdown) {
  width: 1.1rem;
  color: var(--p-text-muted-color);
}

/* ── Responsive toolbar via container queries ──
 * The toolbar has `container-type: inline-size`, so @container
 * rules react to the actual toolbar width, not the viewport. */

/* Below 760px: shrink approve-all to icon-only */
@container (max-width: 760px) {
  .lex-composer-toolbar
    :deep(.session-header-controls.area-composer-left .approve-all-button .p-button-label) {
    display: none;
  }
  .lex-composer-toolbar :deep(.session-header-controls.area-composer-left .approve-all-button) {
    width: 1.75rem;
    padding-inline: 0;
    white-space: nowrap;
  }
}

/* Below 620px: compact the session-terminal-button to icon-only.
 *
 * Historically this also hid `.mode-button-group` and was supposed
 * to swap in a `.mode-select-shell` Select fallback — but the
 * fallback was never rendered, so the mode picker silently
 * vanished on narrow panes. The 3-icon SelectButton is ~90 px;
 * fits without the swap. (Issue: problems.md "modes button no
 * longer shrinks to a select - it's just gone".) */
@container (max-width: 620px) {
  .lex-composer-toolbar
    :deep(.session-header-controls.area-composer-right .session-terminal-button .p-button-label) {
    display: none;
  }
  .lex-composer-toolbar
    :deep(.session-header-controls.area-composer-right .session-terminal-button) {
    width: 1.75rem;
    min-width: 1.75rem;
    padding-inline: 0;
  }
}

/* Below 500px: shrink workspace chip to icon-only */
@container (max-width: 500px) {
  .lex-composer-toolbar
    :deep(.session-header-controls.area-composer-left .workspace-chip .p-chip-label) {
    display: none;
  }
  .lex-composer-toolbar :deep(.session-header-controls.area-composer-left .workspace-chip) {
    width: 1.75rem;
    padding-inline: 0;
    justify-content: center;
  }
}

/* Below 390px: hide approve-all, workspace, model select; compact everything */
@container (max-width: 390px) {
  .lex-composer-toolbar :deep(.session-header-controls.area-composer-left .approve-all-button),
  .lex-composer-toolbar :deep(.session-header-controls.area-composer-left .workspace-chip) {
    display: none;
  }
  .lex-composer-toolbar :deep(.session-header-controls.area-composer-right .compact-select) {
    display: none;
  }
  .lex-composer-toolbar :deep(.session-header-controls.area-composer-right) {
    gap: 0;
  }
  .lex-composer-toolbar .lex-toolbar-btn {
    width: 1.35rem;
    height: 1.45rem;
    padding: 0;
  }
  .lex-composer-toolbar {
    gap: 0.2rem;
    padding-inline: 0.25rem;
  }
}
</style>
