import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, splitBlock } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { Fragment, Slice } from 'prosemirror-model';
import 'prosemirror-view/style/prosemirror.css';
import { docToText, schema, textBeforeCaret, textToDoc, textToSlice } from './messageDoc';
import { registerEditor } from './editorRegistry';


// The message box: a small ProseMirror editor whose value is message text (see messageDoc),
// with draft attachments as chips, custom emoji as images and mentions as `@name` inline.
//
// Props are read when needed, so they can change freely:
// - onChange({ text, beforeCaret, docChanged }) after every edit or cursor move.
// - onKeyDown(event): runs first; preventDefault() to handle a key yourself.
// - submitOnEnter + onSubmit(): Enter sends (Shift+Enter is a new line). Otherwise Enter is a
//   new line (mobile).
// - maxLength: edits that would make the text longer are refused.
// - onPasteFiles(files): pasted files. Dropped files are left to the page (Composer).
// - mentionNames ({ id: username }): who `<@id>` in initial or pasted text is.
// - onFocus / onBlur, placeholder, id, ariaLabel, className, initialText, autoFocus.
//
// The ref gives: focus(), blur(), isComposing(), getText(), setText(text), clear(), insertText(text,
// { focus }), insertAttachments([{ id, name }]), insertCustomEmoji({ id, name, url }),
// replaceBeforeCaret(count, text, { focus }), replaceBeforeCaretWithCustomEmoji(count, emoji),
// replaceBeforeCaretWithMention(count, { id, name }), removeAttachment(id), and element.
const MessageEditor = forwardRef(function MessageEditor(props, ref) {
  const mountRef = useRef(null);
  const viewRef = useRef(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  // How text becomes the document: mentions get the names given.
  const parseOptions = () => ({ resolveMention: (id) => propsRef.current.mentionNames?.[id] });

  useEffect(() => {
    const current = () => propsRef.current;

    const enter = (state, dispatch) => {
      if (current().submitOnEnter) {
        current().onSubmit?.();
        return true;
      }
      return splitBlock(state, dispatch);
    };

    const lengthLimit = new Plugin({
      filterTransaction(tr, state) {
        const max = current().maxLength;
        if (!max || !tr.docChanged || tr.getMeta('ignoreLength')) return true;
        const next = docToText(tr.doc).length;
        return next <= max || next <= docToText(state.doc).length;
      },
    });

    const isEmpty = (state) => state.doc.childCount === 1 && state.doc.firstChild.content.size === 0;
    const emptyState = new Plugin({
      props: {
        attributes: (state) => ({ class: `message-editor${isEmpty(state) ? ' is-empty' : ''}` }),
        // The placeholder, shown on the empty first line (see dms.css).
        decorations: (state) => (isEmpty(state) && current().placeholder
          ? DecorationSet.create(state.doc, [
            Decoration.node(0, state.doc.firstChild.nodeSize, { 'data-placeholder': current().placeholder }),
          ])
          : null),
      },
    });

    const view = new EditorView(mountRef.current, {
      state: EditorState.create({
        doc: textToDoc(current().initialText, parseOptions()),
        // With initial text (editing a message), the cursor starts at the end.
        selection: TextSelection.atEnd(textToDoc(current().initialText, parseOptions())),
        plugins: [
          history(),
          keymap({ Enter: enter, 'Shift-Enter': splitBlock, 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo }),
          keymap(baseKeymap),
          lengthLimit,
          emptyState,
        ],
      }),
      handleKeyDown(v, event) {
        if (event.isComposing) return false;
        current().onKeyDown?.(event);
        return event.defaultPrevented;
      },
      handlePaste(v, event) {
        const files = Array.from(event.clipboardData?.files || []);
        if (files.length > 0) {
          current().onPasteFiles?.(files);
          return true;
        }
        // Always plain text: formatting from elsewhere means nothing in a message.
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return true;
        v.dispatch(v.state.tr.replaceSelection(textToSlice(text.replace(/\r\n?/g, '\n'), parseOptions())).scrollIntoView());
        return true;
      },
      handleDrop(v, event) {
        // Files are attached by the page around the editor.
        return Array.from(event.dataTransfer?.types || []).includes('Files');
      },
      handleDOMEvents: {
        focus: () => { current().onFocus?.(); return false; },
        blur: () => { current().onBlur?.(); return false; },
      },
      dispatchTransaction(tr) {
        const state = view.state.apply(tr);
        view.updateState(state);
        if (tr.docChanged || tr.selectionSet) {
          current().onChange?.({
            text: docToText(state.doc),
            beforeCaret: textBeforeCaret(state),
            docChanged: tr.docChanged,
          });
        }
      },
    });
    viewRef.current = view;
    registerEditor(view.dom, handleRef.current);
    if (current().autoFocus) view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Attributes that can change: set straight on the editable element.
  useEffect(() => {
    const dom = viewRef.current?.dom;
    if (!dom) return;
    const attrs = {
      id: props.id,
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-label': props.ariaLabel,
      'aria-placeholder': props.placeholder,
    };
    for (const [name, value] of Object.entries(attrs)) {
      if (value == null) dom.removeAttribute(name);
      else dom.setAttribute(name, value);
    }
    // Redraw the placeholder with the new text.
    const view = viewRef.current;
    view.dispatch(view.state.tr.setMeta('placeholder', props.placeholder));
  }, [props.id, props.ariaLabel, props.placeholder]);

  const handleRef = useRef(null);
  if (!handleRef.current) handleRef.current = (() => {
    const view = () => viewRef.current;
    const run = (build, { focus = true } = {}) => {
      const v = view();
      if (!v) return;
      const tr = build(v.state.tr, v.state);
      if (tr) v.dispatch(tr.scrollIntoView());
      if (focus) v.focus();
    };
    const handle = {
      get element() {
        return view()?.dom ?? null;
      },
      focus: () => view()?.focus(),
      // Mid-composition (IME, some phone keyboards): the text isn't final yet.
      isComposing: () => Boolean(view()?.composing),
      blur: () => view()?.dom.blur(),
      getText: () => (view() ? docToText(view().state.doc) : ''),
      setText(text) {
        run((tr, state) => {
          tr.replaceWith(0, state.doc.content.size, textToDoc(text, parseOptions()).content).setMeta('ignoreLength', true);
          return tr.setSelection(TextSelection.atEnd(tr.doc));
        }, { focus: false });
      },
      clear() {
        handle.setText('');
      },
      insertText(text, options) {
        run((tr) => (text.includes('\n') ? tr.replaceSelection(textToSlice(text, parseOptions())) : tr.insertText(text)), options);
      },
      // Chips, separated by spaces; they may take the text over the length limit (Composer
      // checks the final length on send).
      insertAttachments(attachments, options) {
        const nodes = [];
        attachments.forEach((a, i) => {
          if (i > 0) nodes.push(schema.text(' '));
          nodes.push(schema.nodes.attachment.create({ id: a.id, name: a.name }));
        });
        run((tr) => tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)).setMeta('ignoreLength', true), options);
      },
      insertCustomEmoji(emoji, options) {
        run((tr) => tr.replaceSelectionWith(schema.nodes.customEmoji.create(emoji), false), options);
      },
      // Replaces the `count` characters before the cursor (a ":blob" or ":blob:" being
      // completed) with a custom emoji ({ id, name, url }) and a space.
      replaceBeforeCaretWithCustomEmoji(count, emoji, options) {
        run((tr, state) => {
          const { from } = state.selection;
          const start = Math.max(from - count, state.selection.$from.start());
          const nodes = Fragment.from([schema.nodes.customEmoji.create(emoji), schema.text(' ')]);
          return tr.replaceWith(start, from, nodes);
        }, options);
      },
      // Replaces the `count` characters before the cursor (an "@na" being completed) with a
      // mention ({ id, name }) and a space.
      replaceBeforeCaretWithMention(count, person, options) {
        run((tr, state) => {
          const { from } = state.selection;
          const start = Math.max(from - count, state.selection.$from.start());
          const nodes = Fragment.from([schema.nodes.mention.create({ id: String(person.id), name: person.name }), schema.text(' ')]);
          return tr.replaceWith(start, from, nodes);
        }, options);
      },
      // Replaces the `count` characters before the cursor (e.g. a ":smi" being completed).
      replaceBeforeCaret(count, text, options) {
        run((tr, state) => {
          const { from } = state.selection;
          return tr.insertText(text, Math.max(from - count, state.selection.$from.start()), from);
        }, options);
      },
      removeAttachment(id) {
        run((tr, state) => {
          const positions = [];
          state.doc.descendants((node, pos) => {
            if (node.type === schema.nodes.attachment && node.attrs.id === id) positions.push([pos, node.nodeSize]);
          });
          positions.reverse().forEach(([pos, size]) => tr.delete(pos, pos + size));
          return positions.length ? tr : null;
        }, { focus: false });
      },
    };
    return handle;
  })();
  useImperativeHandle(ref, () => handleRef.current, []);

  return <div ref={mountRef} className={props.className} />;
});

export default MessageEditor;
