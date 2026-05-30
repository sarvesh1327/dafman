// Unit tests for the composer submit keybinding (issue #88).
//
// Two layers:
//   1. `resolveEnterAction` — the pure decision matrix, tested directly
//      with plain chord literals (no editor needed).
//   2. `registerSubmitOnEnter` — the real Lexical command registration,
//      driven by dispatching `KEY_ENTER_COMMAND` against a live editor so
//      the consume/insert-paragraph/defer behaviour is exercised
//      end-to-end (including the menu-active defer via the per-editor
//      `composerMenuState` registry).

import { afterEach, describe, expect, test } from 'bun:test';
import {
  createEditor,
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {
  resolveEnterAction,
  registerSubmitOnEnter,
  type ComposerSubmitPayload,
  type EnterChord,
} from '@/lexical/plugins';
import { setComposerMenuActive } from '@/lexical/composerMenuState';

function chord(overrides: Partial<EnterChord> = {}): EnterChord {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides };
}

describe('resolveEnterAction', () => {
  describe("mode 'enter' (plain Enter sends)", () => {
    test('plain Enter submits default when no menu is active', () => {
      expect(resolveEnterAction(chord(), 'enter', false)).toEqual({
        type: 'submit',
        mode: 'default',
      });
    });

    test('plain Enter defers (passthrough) when a menu is active', () => {
      expect(resolveEnterAction(chord(), 'enter', true)).toEqual({ type: 'passthrough' });
    });

    test('Ctrl+Enter inserts a paragraph (does NOT submit)', () => {
      expect(resolveEnterAction(chord({ ctrlKey: true }), 'enter', false)).toEqual({
        type: 'insertParagraph',
      });
    });

    test('Cmd+Enter (metaKey) inserts a paragraph, even with a menu open', () => {
      expect(resolveEnterAction(chord({ metaKey: true }), 'enter', true)).toEqual({
        type: 'insertParagraph',
      });
    });

    test('Shift+Enter passes through (soft line break)', () => {
      expect(resolveEnterAction(chord({ shiftKey: true }), 'enter', false)).toEqual({
        type: 'passthrough',
      });
    });

    test('Ctrl+Shift+Enter submits interrupt', () => {
      expect(resolveEnterAction(chord({ ctrlKey: true, shiftKey: true }), 'enter', false)).toEqual({
        type: 'submit',
        mode: 'interrupt',
      });
    });

    test('Alt+Enter submits queue', () => {
      expect(resolveEnterAction(chord({ altKey: true }), 'enter', false)).toEqual({
        type: 'submit',
        mode: 'queue',
      });
    });
  });

  describe("mode 'mod-enter' (Ctrl+Enter sends)", () => {
    test('Ctrl+Enter submits default', () => {
      expect(resolveEnterAction(chord({ ctrlKey: true }), 'mod-enter', false)).toEqual({
        type: 'submit',
        mode: 'default',
      });
    });

    test('plain Enter passes through (newline), menu active or not', () => {
      expect(resolveEnterAction(chord(), 'mod-enter', false)).toEqual({ type: 'passthrough' });
      expect(resolveEnterAction(chord(), 'mod-enter', true)).toEqual({ type: 'passthrough' });
    });

    test('Ctrl+Shift+Enter submits interrupt; Alt+Enter submits queue', () => {
      expect(
        resolveEnterAction(chord({ ctrlKey: true, shiftKey: true }), 'mod-enter', false),
      ).toEqual({ type: 'submit', mode: 'interrupt' });
      expect(resolveEnterAction(chord({ altKey: true }), 'mod-enter', false)).toEqual({
        type: 'submit',
        mode: 'queue',
      });
    });
  });
});

interface EnterEventInit extends Partial<EnterChord> {
  isComposing?: boolean;
  key?: string;
}

function makeEnterEvent(init: EnterEventInit = {}): KeyboardEvent {
  let prevented = false;

  return {
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    isComposing: init.isComposing ?? false,
    key: init.key ?? 'Enter',
    preventDefault() {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  } as unknown as KeyboardEvent;
}

function makeEditor(): LexicalEditor {
  const editor = createEditor({
    namespace: 'SubmitOnEnterTest',
    onError: (e) => {
      throw e;
    },
  });

  editor.setEditable(true);

  return editor;
}

function seedText(editor: LexicalEditor, text: string): void {
  editor.update(
    () => {
      const root = $getRoot();

      root.clear();
      const p = $createParagraphNode();

      p.append($createTextNode(text));
      root.append(p);
    },
    { discrete: true },
  );
}

describe('registerSubmitOnEnter', () => {
  let editor: LexicalEditor;
  let unregister: (() => void) | null = null;
  let submissions: ComposerSubmitPayload[];

  function register(keybinding: 'enter' | 'mod-enter'): void {
    submissions = [];
    unregister = registerSubmitOnEnter(
      editor,
      () => keybinding,
      (payload) => submissions.push(payload),
    );
  }

  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  test("'enter': plain Enter submits the trimmed text", () => {
    editor = makeEditor();
    register('enter');
    seedText(editor, 'hello world');

    const handled = editor.dispatchCommand(KEY_ENTER_COMMAND, makeEnterEvent());

    expect(handled).toBe(true);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toEqual({ text: 'hello world', mode: 'default' });
  });

  test("'enter': Ctrl+Enter inserts a paragraph and does NOT submit", () => {
    editor = makeEditor();
    register('enter');
    seedText(editor, 'keep typing');

    const handled = editor.dispatchCommand(KEY_ENTER_COMMAND, makeEnterEvent({ ctrlKey: true }));

    expect(handled).toBe(true);
    expect(submissions).toHaveLength(0);
    // Text is preserved (not consumed/cleared).
    const text = editor.getEditorState().read(() => $getRoot().getTextContent());
    expect(text).toContain('keep typing');
  });

  test("'enter': plain Enter defers (does not submit) while a menu is active", () => {
    editor = makeEditor();
    register('enter');
    seedText(editor, '/model');
    setComposerMenuActive(editor, 'slash', true);

    const handled = editor.dispatchCommand(KEY_ENTER_COMMAND, makeEnterEvent());

    expect(handled).toBe(false);
    expect(submissions).toHaveLength(0);

    setComposerMenuActive(editor, 'slash', false);
  });

  test("'enter': Ctrl+Enter still inserts (consumes) even while a menu is active", () => {
    editor = makeEditor();
    register('enter');
    seedText(editor, '@file');
    setComposerMenuActive(editor, 'mention', true);

    const handled = editor.dispatchCommand(KEY_ENTER_COMMAND, makeEnterEvent({ ctrlKey: true }));

    expect(handled).toBe(true);
    expect(submissions).toHaveLength(0);

    setComposerMenuActive(editor, 'mention', false);
  });

  test("'enter': empty composer + plain Enter is a no-op (consumed, no submit)", () => {
    editor = makeEditor();
    register('enter');
    seedText(editor, '   ');

    const handled = editor.dispatchCommand(KEY_ENTER_COMMAND, makeEnterEvent());

    expect(handled).toBe(true);
    expect(submissions).toHaveLength(0);
  });

  test("'mod-enter': Ctrl+Enter submits", () => {
    editor = makeEditor();
    register('mod-enter');
    seedText(editor, 'send me');

    const handled = editor.dispatchCommand(KEY_ENTER_COMMAND, makeEnterEvent({ ctrlKey: true }));

    expect(handled).toBe(true);
    expect(submissions).toEqual([{ text: 'send me', mode: 'default' }]);
  });

  test("'mod-enter': plain Enter passes through (no submit)", () => {
    editor = makeEditor();
    register('mod-enter');
    seedText(editor, 'newline please');

    const handled = editor.dispatchCommand(KEY_ENTER_COMMAND, makeEnterEvent());

    expect(handled).toBe(false);
    expect(submissions).toHaveLength(0);
  });

  test('IME composition Enter is never consumed', () => {
    editor = makeEditor();
    register('enter');
    seedText(editor, 'こんにち');

    const handled = editor.dispatchCommand(
      KEY_ENTER_COMMAND,
      makeEnterEvent({ isComposing: true }),
    );

    expect(handled).toBe(false);
    expect(submissions).toHaveLength(0);
  });
});
