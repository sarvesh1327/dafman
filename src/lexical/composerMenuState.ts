// Per-editor "is a composer typeahead menu currently active?" registry.
//
// The composer mounts two `TypeaheadMenuPlugin` menus — slash commands
// (`SlashCommandPlugin.vue`) and `@`-file mentions (`MentionPlugin.vue`).
// lexical-vue's menu plugin registers `KEY_ENTER_COMMAND` at
// `COMMAND_PRIORITY_LOW` to select the highlighted option while a menu is
// open. `SubmitOnEnter` registers `KEY_ENTER_COMMAND` at
// `COMMAND_PRIORITY_HIGH` and runs first.
//
// In the `'enter'` submit mode (plain Enter sends) the HIGH handler must
// DEFER to an open menu — otherwise `/model<Enter>` and `@file<Enter>`
// would send a message instead of selecting the highlighted option. The
// HIGH handler reads this registry synchronously on each keystroke to
// decide whether to defer.
//
// Keyed by `LexicalEditor` via a `WeakMap` so it's multi-session safe
// (every composer has its own editor; entries are GC'd with the editor)
// and so reads are a synchronous map lookup — NOT a `window` event
// (rule 18) and NOT routed through Vue reactivity (which flushes on a
// microtask and could be stale when a synchronous `keydown` fires).

import type { LexicalEditor } from 'lexical';

export type ComposerMenuKey = 'slash' | 'mention';

const activeMenus = new WeakMap<LexicalEditor, Set<ComposerMenuKey>>();

/// Mark a composer typeahead menu as active/inactive for `editor`.
/// Call this synchronously from the menu plugin's open/close/query
/// callbacks so the state is current when `KEY_ENTER_COMMAND` fires in
/// the same event-loop tick.
export function setComposerMenuActive(
  editor: LexicalEditor,
  key: ComposerMenuKey,
  active: boolean,
): void {
  let set = activeMenus.get(editor);

  if (active) {
    if (!set) {
      set = new Set<ComposerMenuKey>();
      activeMenus.set(editor, set);
    }

    set.add(key);

    return;
  }

  if (!set) return;

  set.delete(key);

  if (set.size === 0) activeMenus.delete(editor);
}

/// True when any composer typeahead menu (slash or mention) is open with
/// a selectable option for `editor`.
export function isComposerMenuActive(editor: LexicalEditor): boolean {
  const set = activeMenus.get(editor);

  return set !== undefined && set.size > 0;
}
