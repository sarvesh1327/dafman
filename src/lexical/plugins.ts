// In-repo Lexical helper plugins.
//
// These are tiny Vue components rendered as children of `LexicalComposer`
// that use `useLexicalComposer()` to drive imperative editor APIs the
// `lexical-vue` package doesn't expose declaratively. They render nothing
// (return `null`) and exist only for their setup-time side effects.

import {
  $convertToMarkdownString,
  TRANSFORMERS,
  registerMarkdownShortcuts,
} from '@lexical/markdown';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  INSERT_PARAGRAPH_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import { defineComponent, onBeforeUnmount, onMounted, watch, type PropType } from 'vue';
import { useLexicalComposer } from 'lexical-vue/LexicalComposer';
import { rendererLog } from '@/ipc/rendererLog';
import { $isAttachmentNode } from '@/lexical/AttachmentNode';
import { isComposerMenuActive } from '@/lexical/composerMenuState';
import type { ComposerSubmitKeybinding, SendMessageAttachment } from '@/ipc/types';
import { toErrorMessage } from '@/lib/errorMessage';

/// Extract the editor content as a markdown string, trim it, clear the
/// editor, and return the result. Returns `null` when the buffer was
/// empty/whitespace-only. Shared between the Enter keybinding and the
/// click-to-send button so there's a single submit code path.
///
/// We round-trip through `$convertToMarkdownString` so any rich
/// formatting the user produced via `registerMarkdownShortcuts`
/// (`**bold**`, `# heading`, fenced code, lists, links, etc.) survives
/// the send and is rendered consistently by `MessageContent` on the
/// other end.
export function consumeComposerText(
  editor: LexicalEditor,
): { text: string; attachments: SendMessageAttachment[] } | null {
  const state = editor.getEditorState();
  const plain = state.read(() => $getRoot().getTextContent());

  if (plain.trim().length === 0) return null;

  const markdown = state.read(() => $convertToMarkdownString(TRANSFORMERS));
  // Walk in document order picking up every AttachmentNode payload.
  // This is read OUTSIDE the editor.update() so the editor state is
  // still intact when we walk; the clear() below then discards
  // everything we already captured.
  const attachments: SendMessageAttachment[] = [];

  state.read(() => {
    const visit = (node: LexicalNode): void => {
      if ($isAttachmentNode(node)) {
        attachments.push(node.getAttachment());

        return;
      }

      if ($isElementNode(node)) {
        for (const child of node.getChildren()) visit(child);
      }
    };

    visit($getRoot());
  });
  editor.update(() => {
    $getRoot().clear();
  });
  const trimmed = markdown.trim();
  const text = trimmed.length === 0 ? plain.trim() : trimmed;

  return { text, attachments };
}

/// Registers the built-in markdown keystroke shortcuts (`# `, `** **`,
/// fenced code, lists, blockquote, link, hr, etc.) on the editor. Mounts
/// inside `LexicalComposer` so it has access to the provided editor.
export const RegisterMarkdownShortcuts = defineComponent({
  name: 'RegisterMarkdownShortcuts',
  setup() {
    const editor = useLexicalComposer();
    const unregister = registerMarkdownShortcuts(editor, TRANSFORMERS);

    onBeforeUnmount(() => unregister());

    return () => null;
  },
});

/// Keeps `editor.setEditable` in sync with a reactive prop. Lexical only
/// reads `initialConfig.editable` on mount, so without this the composer
/// would stay editable forever even after `disabled` flips to `true`.
export const EditableSync = defineComponent({
  name: 'EditableSync',
  props: { editable: { type: Boolean, required: true } },
  setup(props) {
    const editor = useLexicalComposer();

    watch(
      () => props.editable,
      (next) => editor.setEditable(next),
      { immediate: true },
    );

    return () => null;
  },
});

/// Submit-on-Enter behaviour for the composer, driven by the
/// `composer.submitKeybinding` user setting (issue #88).
///
/// Two modes:
///
/// `'enter'` (default — conventional chat):
///   * `Enter`              -> submit `default` (unless a slash/mention
///                             typeahead menu is open with a selectable
///                             option, in which case we DEFER so Enter
///                             selects the menu item)
///   * `Ctrl/Cmd+Enter`     -> insert a newline (paragraph break). We
///                             consume at HIGH and dispatch
///                             `INSERT_PARAGRAPH_COMMAND` explicitly,
///                             because while a menu is open the LOW menu
///                             handler ignores modifiers and would
///                             otherwise SELECT an option instead of
///                             inserting a newline.
///   * `Shift+Enter`        -> not consumed (Lexical soft line break)
///   * `Ctrl+Shift+Enter`   -> submit `interrupt`
///   * `Alt+Enter`          -> submit `queue`
///
/// `'mod-enter'` (legacy IDE convention):
///   * `Ctrl/Cmd+Enter`     -> submit `default`
///   * `Ctrl+Shift+Enter`   -> submit `interrupt`
///   * `Alt+Enter`          -> submit `queue`
///   * `Enter` / `Shift+Enter` -> not consumed (Lexical paragraph /
///                             soft break)
///
/// IME composition (`event.isComposing` / `key === 'Process'`) is never
/// consumed in either mode.
///
/// Lexical command priority: HIGH, so we run before the default Enter
/// handler and before the typeahead menus' LOW handler. We `return true`
/// (consume) when we submit or insert a newline; `return false`
/// (passthrough/defer) otherwise.
///
/// `mode` (submit) semantics:
///   "default"   -> use the session's `defaultSendMode` (Steer by default)
///   "queue"     -> force the queue mode regardless of default
///   "interrupt" -> abort then send (force, regardless of default)
export type ComposerSubmitMode = 'default' | 'queue' | 'interrupt';
export interface ComposerSubmitPayload {
  text: string;
  mode: ComposerSubmitMode;
  attachments?: SendMessageAttachment[];
}

/// The action a given Enter keystroke should produce. Split out as a
/// pure function so the keybinding decision matrix is unit-testable
/// without mounting a Lexical editor, and so the command handler stays
/// well under the ESLint complexity cap.
export type EnterAction =
  | { type: 'submit'; mode: ComposerSubmitMode }
  | { type: 'insertParagraph' }
  | { type: 'passthrough' };

/// Minimal shape we read off the Enter `KeyboardEvent`. Declared so the
/// resolver can be tested with plain object literals.
export interface EnterChord {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/// The modifier combination of an Enter keystroke, normalized so the
/// action resolver can `switch` instead of chaining boolean guards
/// (keeps each function well under the ESLint complexity cap).
export type EnterChordKind = 'ctrl' | 'ctrl-shift' | 'alt' | 'shift' | 'plain' | 'other';

/// Classify an Enter chord. `ctrl` folds in `metaKey` (macOS Cmd).
/// Unrecognized combinations (e.g. Ctrl+Alt) map to `'other'`, which
/// always passes through to Lexical's default handling.
export function classifyEnterChord(e: EnterChord): EnterChordKind {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = `${ctrl ? 'c' : ''}${e.shiftKey ? 's' : ''}${e.altKey ? 'a' : ''}`;

  switch (key) {
    case 'cs':
      return 'ctrl-shift';
    case 'c':
      return 'ctrl';
    case 'a':
      return 'alt';
    case 's':
      return 'shift';
    case '':
      return 'plain';
    default:
      return 'other';
  }
}

/// Decide what an Enter keystroke does given the active keybinding and
/// whether a composer typeahead menu is currently open with a
/// selectable option. Pure — no editor access, no side effects.
export function resolveEnterAction(
  e: EnterChord,
  keybinding: ComposerSubmitKeybinding,
  menuActive: boolean,
): EnterAction {
  const chord = classifyEnterChord(e);

  // Interrupt / queue chords are identical in both modes.
  if (chord === 'ctrl-shift') return { type: 'submit', mode: 'interrupt' };

  if (chord === 'alt') return { type: 'submit', mode: 'queue' };

  if (keybinding === 'mod-enter') {
    // Ctrl/Cmd+Enter sends; plain / Shift+Enter fall through to
    // Lexical's paragraph / soft break.
    return chord === 'ctrl' ? { type: 'submit', mode: 'default' } : { type: 'passthrough' };
  }

  // keybinding === 'enter': Ctrl/Cmd+Enter inserts a newline.
  if (chord === 'ctrl') return { type: 'insertParagraph' };

  // Shift+Enter (soft break) and unrecognized combos fall through.
  if (chord !== 'plain') return { type: 'passthrough' };

  // Plain Enter: defer to an open typeahead menu, else submit.
  return menuActive ? { type: 'passthrough' } : { type: 'submit', mode: 'default' };
}

/// Registers the Enter keybinding command on `editor`. `getKeybinding`
/// is read on every keystroke so a live settings change takes effect
/// without remounting. Returns the unregister callback.
export function registerSubmitOnEnter(
  editor: LexicalEditor,
  getKeybinding: () => ComposerSubmitKeybinding,
  onSubmit: (payload: ComposerSubmitPayload) => void,
): () => void {
  return editor.registerCommand(
    KEY_ENTER_COMMAND,
    (event) => {
      const e = event;

      if (!e) return false;

      if (e.isComposing || e.key === 'Process') return false;

      const action = resolveEnterAction(e, getKeybinding(), isComposerMenuActive(editor));

      if (action.type === 'passthrough') return false;

      e.preventDefault();

      if (action.type === 'insertParagraph') {
        editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);

        return true;
      }

      const result = consumeComposerText(editor);

      if (result !== null) {
        const payload: ComposerSubmitPayload = {
          text: result.text,
          mode: action.mode,
          ...(result.attachments.length > 0 ? { attachments: result.attachments } : {}),
        };

        onSubmit(payload);
      }

      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}

export const SubmitOnEnter = defineComponent({
  name: 'SubmitOnEnter',
  props: {
    submitKeybinding: {
      type: String as PropType<ComposerSubmitKeybinding>,
      default: 'enter',
    },
  },
  emits: ['submit'],
  setup(props, { emit }) {
    const editor = useLexicalComposer();
    const unregister = registerSubmitOnEnter(
      editor,
      () => props.submitKeybinding,
      (payload) => emit('submit', payload),
    );

    onBeforeUnmount(() => unregister());

    return () => null;
  },
});

/// One-way binding from a markdown `text` prop into the editor state.
///
export { useLexicalComposer };

/// Dev-only diagnostic: on mount, log enough state to bun's JSON log so
/// we can figure out why typing might not work without needing WebView2
/// devtools open. Mount this inside `LexicalComposer`. Only fires when
/// the URL has `?diag=1`.
///
/// Logs:
/// - editor.isEditable() result
/// - root node count + first paragraph's text
/// - whether the contentEditable has `contenteditable=true`
/// - the result of programmatically inserting a test character through
///   `editor.update` + `selection.insertText` (bypasses the browser
///   input pipeline)
export const TypingDiagnostic = defineComponent({
  name: 'TypingDiagnostic',
  setup() {
    const editor = useLexicalComposer();

    function probe() {
      try {
        const root = editor.getRootElement();

        rendererLog('info', 'typing-diagnostic probe', {
          editable: editor.isEditable(),
          rootElement: root
            ? {
                tagName: root.tagName,
                contenteditable: root.getAttribute('contenteditable'),
                role: root.getAttribute('role'),
                ariaDisabled: root.getAttribute('aria-disabled'),
                dataLexicalEditor: root.getAttribute('data-lexical-editor'),
                hasChildren: root.childElementCount,
                outerSnippet: root.outerHTML.slice(0, 400),
              }
            : null,
        });

        // Programmatic insert. If this succeeds, the editor itself
        // works; any typing issue is in the browser input pipeline.
        editor.update(() => {
          const r = $getRoot();

          if (r.getChildrenSize() === 0) {
            const p = $createParagraphNode();

            r.append(p);
          }

          const para = r.getFirstChild();

          if (para && 'select' in para && typeof para.select === 'function') {
            (para as { select: () => unknown }).select();
          }

          const sel = $getSelection();

          if ($isRangeSelection(sel)) {
            sel.insertText('X');
          } else {
            const p = r.getFirstChild();

            if (p && 'append' in p && typeof p.append === 'function') {
              (p as { append: (n: ReturnType<typeof $createTextNode>) => unknown }).append(
                $createTextNode('X'),
              );
            }
          }
        });

        setTimeout(() => {
          editor.getEditorState().read(() => {
            const text = $getRoot().getTextContent();

            rendererLog('info', 'typing-diagnostic post-insert', {
              text,
              charCount: text.length,
            });
          });
          // Clean up so the diagnostic doesn't leave junk in the composer.
          editor.update(() => {
            $getRoot().clear();
            $getRoot().append($createParagraphNode());
          });
        }, 50);
      } catch (err) {
        rendererLog('error', 'typing-diagnostic threw', {
          message: toErrorMessage(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    }

    onMounted(() => {
      // Wait one frame so the contenteditable is mounted by the
      // ContentEditableElement's own onMounted handler.
      setTimeout(probe, 100);
    });

    return () => null;
  },
});
