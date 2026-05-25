import {
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType,
  keymap,
} from "@codemirror/view";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";

// ── Widgets ────────────────────────────────────────────────────────

class CheckboxWidget extends WidgetType {
  constructor(checked, lineFrom) {
    super();
    this.checked = checked;
    this.lineFrom = lineFrom;
  }
  eq(other) {
    return this.checked === other.checked && this.lineFrom === other.lineFrom;
  }
  toDOM(view) {
    // Wrap in a span so the widget's visual width includes the right gap.
    // CM6 draws the cursor at the widget range's end position — margin on the
    // <input> itself doesn't move the cursor, but the span's padding-right does.
    const wrap = document.createElement("span");
    wrap.className = "cm-cb-wrap";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = this.checked;
    cb.className = "cm-cb";
    cb.tabIndex = -1;
    cb.addEventListener("mousedown", (e) => e.preventDefault());
    cb.addEventListener("change", () => {
      const line = view.state.doc.lineAt(this.lineFrom);
      const newText = cb.checked
        ? line.text.replace(/\[ \] ?/, "[x] ")
        : line.text.replace(/\[x\] ?/i, "[ ] ");
      view.dispatch({ changes: { from: line.from, to: line.to, insert: newText } });
      view.focus();
    });
    wrap.appendChild(cb);
    return wrap;
  }
  ignoreEvent() {
    // Return true for all events so CM6 doesn't move the cursor into
    // the hidden range when the user clicks the checkbox.
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(src, alt, view) {
    super();
    this.src = src;
    this.alt = alt;
    this._view = view;
  }
  eq(other) { return this.src === other.src && this.alt === other.alt; }

  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-img-wrap';

    const img = document.createElement('img');
    img.src = this.src;
    img.className = 'cm-img-widget';

    // Parse stored width: alt "w=400" → 400px, otherwise scale to editor width
    const wMatch = this.alt.match(/^w=(\d+)$/);
    if (wMatch) {
      img.style.width = wMatch[1] + 'px';
      img.style.maxWidth = '100%';
    } else {
      img.style.maxWidth = '100%';
    }

    const handle = document.createElement('div');
    handle.className = 'cm-img-resize-handle';

    let startX, startW;
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startW = img.offsetWidth;
      const onMove = ev => {
        img.style.width = Math.max(50, startW + (ev.clientX - startX)) + 'px';
      };
      const onUp = ev => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        this._updateWidth(Math.round(Math.max(50, startW + (ev.clientX - startX))));
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    wrap.appendChild(img);
    wrap.appendChild(handle);
    return wrap;
  }

  _updateWidth(w) {
    const view = this._view;
    if (!view) return;
    const doc = view.state.doc.toString();
    const escaped = this.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`!\\[[^\\]\\n]*\\]\\(${escaped}\\)`);
    const m = doc.match(re);
    if (!m) return;
    const pos = doc.indexOf(m[0]);
    if (pos < 0) return;
    view.dispatch({ changes: { from: pos, to: pos + m[0].length, insert: `![w=${w}](${this.src})` } });
  }

  ignoreEvent() { return true; }
}

class HrWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-hr-widget";
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

// ── Inline decoration helpers ──────────────────────────────────────

function noOverlap(arr, s, e) {
  return !arr.some((r) => r.s < e && r.e > s);
}

function collectInline(text) {
  const found = [];
  const add = (s, e, dlen, cls, extra = {}) => {
    if (noOverlap(found, s, e)) found.push({ s, e, dlen, cls, ...extra });
  };

  // Highest priority: inline code (nothing parsed inside)
  for (const m of text.matchAll(/`([^`\n]+)`/g))
    add(m.index, m.index + m[0].length, 1, "cm-ic");
  // Images and links before bold/italic — URLs often contain _ or * which would
  // otherwise be consumed by italic/bold regexes, blocking link detection.
  // Images ![alt](url) — must come before links to consume the ! prefix
  for (const m of text.matchAll(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g))
    add(m.index, m.index + m[0].length, 0, "cm-img", { imgAlt: m[1], imgSrc: m[2] });
  // Links [text](url)
  for (const m of text.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g))
    add(m.index, m.index + m[0].length, 0, "cm-link", { linkText: m[1] });
  // Colored text {#rrggbb text} or {#rgb text}
  for (const m of text.matchAll(/\{#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\s+([^}\n]+)\}/g))
    add(m.index, m.index + m[0].length, 0, "cm-color", {
      color: "#" + m[1],
      prefixLen: m[0].length - m[2].length - 1,
    });
  // Bold + italic
  for (const m of text.matchAll(/\*\*\*(.+?)\*\*\*/g))
    add(m.index, m.index + m[0].length, 3, "cm-bi");
  // Bold
  for (const m of text.matchAll(/\*\*(.+?)\*\*/g))
    add(m.index, m.index + m[0].length, 2, "cm-bold");
  // Italic *
  for (const m of text.matchAll(/\*([^*\n]+?)\*/g))
    add(m.index, m.index + m[0].length, 1, "cm-em");
  // Italic _
  for (const m of text.matchAll(/_([^_\n]+?)_/g))
    add(m.index, m.index + m[0].length, 1, "cm-em");
  // Strikethrough
  for (const m of text.matchAll(/~~(.+?)~~/g))
    add(m.index, m.index + m[0].length, 2, "cm-del");

  found.sort((a, b) => a.s - b.s);
  return found;
}


function pushInline(builder, base, inlines, view) {
  for (const il of inlines) {
    const f = base + il.s;
    const t = base + il.e;
    if (il.cls === "cm-img") {
      // ![alt](url) → replace entire span with an image widget
      builder.add(f, t, Decoration.replace({ widget: new ImageWidget(il.imgSrc, il.imgAlt, view) }));
    } else if (il.cls === "cm-link") {
      // [text](url) → hide [, mark text, hide ](url)
      builder.add(f, f + 1, Decoration.replace({}));
      const textEnd = f + 1 + il.linkText.length;
      if (f + 1 < textEnd) builder.add(f + 1, textEnd, Decoration.mark({ class: "cm-link" }));
      if (textEnd < t) builder.add(textEnd, t, Decoration.replace({}));
    } else if (il.cls === "cm-color") {
      // {#hex text} → hide "{#hex ", color the text, hide "}"
      builder.add(f, f + il.prefixLen, Decoration.replace({}));
      const textEnd = t - 1;
      if (f + il.prefixLen < textEnd)
        builder.add(f + il.prefixLen, textEnd, Decoration.mark({ attributes: { style: `color:${il.color}` } }));
      builder.add(textEnd, t, Decoration.replace({}));
    } else {
      const d = il.dlen;
      if (d > 0 && f + d <= t - d) {
        builder.add(f, f + d, Decoration.replace({}));
        if (f + d < t - d) builder.add(f + d, t - d, Decoration.mark({ class: il.cls }));
        builder.add(t - d, t, Decoration.replace({}));
      } else if (d === 0 && f < t) {
        builder.add(f, t, Decoration.mark({ class: il.cls }));
      }
    }
  }
}

// ── Fenced code block scanner ──────────────────────────────────────
// Only marks complete pairs (open + close). Unclosed fences stay raw.
function scanFences(doc) {
  const map = new Map();
  const ticks = [];
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (/^```/.test(line.text)) ticks.push({ i, from: line.from, text: line.text });
  }
  for (let t = 0; t + 1 < ticks.length; t += 2) {
    const open = ticks[t], close = ticks[t + 1];
    map.set(open.from, { type: 'open', lang: open.text.slice(3).trim() });
    map.set(close.from, { type: 'close' });
    for (let j = open.i + 1; j < close.i; j++)
      map.set(doc.line(j).from, { type: 'body' });
  }
  return map;
}

// ── ViewPlugin ─────────────────────────────────────────────────────

function buildDecos(view) {
  const builder = new RangeSetBuilder();
  const { doc } = view.state;
  const fences = scanFences(doc);

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const { text, from: lf } = line;

      // ── Fenced code block ─────────────────────────────
      const fence = fences.get(lf);
      if (fence?.type === 'open') {
        builder.add(lf, lf, Decoration.line({ class: 'cm-md-fence-open' }));
        pos = line.to + 1;
        continue;
      }
      if (fence?.type === 'close') {
        builder.add(lf, lf, Decoration.line({ class: 'cm-md-fence-close' }));
        pos = line.to + 1;
        continue;
      }
      if (fence?.type === 'body') {
        builder.add(lf, lf, Decoration.line({ class: 'cm-md-code-line' }));
        pos = line.to + 1;
        continue;
      }

      // ── Heading ──────────────────────────────────────
      const hm = text.match(/^(#{1,6}) (.*)/);
      if (hm) {
        const lvl = hm[1].length;
        const plen = lvl + 1;
        builder.add(lf, lf, Decoration.line({ class: `cm-md-h${lvl}` }));
        builder.add(lf, lf + plen, Decoration.replace({}));
        pushInline(builder, lf + plen, collectInline(hm[2]), view);
        pos = line.to + 1;
        continue;
      }

      // ── Horizontal rule ───────────────────────────────
      if (text.trim().length >= 3 && /^[-*_]+$/.test(text.trim()) && line.to > lf) {
        builder.add(lf, lf, Decoration.line({ class: "cm-md-hr" }));
        builder.add(lf, line.to, Decoration.replace({ widget: new HrWidget() }));
        pos = line.to + 1;
        continue;
      }

      // ── Blockquote ────────────────────────────────────
      const bqm = text.match(/^(> ?)(.*)/);
      if (bqm) {
        builder.add(lf, lf, Decoration.line({ class: "cm-md-bq" }));
        builder.add(lf, lf + bqm[1].length, Decoration.replace({}));
        pushInline(builder, lf + bqm[1].length, collectInline(bqm[2]), view);
        pos = line.to + 1;
        continue;
      }

      // ── Checkbox ─────────────────────────────────────
      // [ ] = unchecked, [x] = checked. Bullet prefix optional. Trailing space optional.
      const cbm = text.match(/^(\s*)(?:[-*] )\[([ xX])\] ?(.*)/);
      if (cbm) {
        const checked = cbm[2].toLowerCase() === "x";
        const indent = cbm[1].length;
        const widgetEnd = cbm[0].length - cbm[3].length;
        if (lf + indent < lf + widgetEnd) {
          builder.add(lf + indent, lf + widgetEnd, Decoration.replace({
            widget: new CheckboxWidget(checked, lf),
          }));
        }
        if (checked && lf + widgetEnd < line.to)
          builder.add(lf + widgetEnd, line.to, Decoration.mark({ class: "cm-cb-done" }));
        pushInline(builder, lf + widgetEnd, collectInline(cbm[3]), view);
        pos = line.to + 1;
        continue;
      }

      // ── Regular line — inline only + hanging indent ──
      // Wrapped text aligns with content start (Google Docs style)
      const hm2 = text.match(/^(\s*)([-*]\s|\d+\.\s)?/);
      const hangTotal = (hm2[1] || '').length + (hm2[2] || '').length;
      if (hangTotal > 0) {
        builder.add(lf, lf, Decoration.line({
          attributes: { style: `padding-left:${hangTotal}ch;text-indent:-${hangTotal}ch` },
        }));
      }
      pushInline(builder, lf, collectInline(text), view);

      pos = line.to + 1;
    }
  }

  return builder.finish();
}

const mdPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecos(view);
    }
    update(u) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildDecos(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// ── Theme ──────────────────────────────────────────────────────────

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      background: "#0d0d0d",
      color: "#c8c8c8",
      fontFamily: "IBM Plex Mono, monospace",
      fontSize: "13.5px",
      lineHeight: "1.8",
    },
    ".cm-content": { padding: "20px 22px", caretColor: "#c8c8c8" },
    ".cm-line": { padding: "0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#c8c8c8 !important" },
    ".cm-selectionBackground": { background: "#2a3a50 !important" },
    ".cm-focused .cm-selectionBackground": { background: "#2a3a50 !important" },
    "::selection": { background: "#2a3a50" },
    ".cm-scroller": { overflow: "auto" },
    // Headings — styled via Decoration.line class on .cm-line
    ".cm-md-h1": { fontSize: "1.6em", fontWeight: "bold", color: "#e8e8e8" },
    ".cm-md-h2": { fontSize: "1.35em", fontWeight: "bold", color: "#e0e0e0" },
    ".cm-md-h3": { fontSize: "1.15em", fontWeight: "bold", color: "#d8d8d8" },
    ".cm-md-h4, .cm-md-h5, .cm-md-h6": { fontWeight: "bold", color: "#d0d0d0" },
    // Inline markup
    ".cm-bold": { fontWeight: "bold", color: "#e8e8e8" },
    ".cm-em": { fontStyle: "italic", color: "#d8d8d8" },
    ".cm-bi": { fontWeight: "bold", fontStyle: "italic", color: "#e8e8e8" },
    ".cm-ic": {
      fontFamily: "IBM Plex Mono, monospace",
      background: "#1a1a1a",
      color: "#8ce870",
      padding: "1px 4px",
      borderRadius: "3px",
      fontSize: "0.9em",
    },
    ".cm-del": { textDecoration: "line-through", color: "#888" },
    ".cm-link": { color: "#7ab4f5", textDecoration: "underline", cursor: "pointer" },
    // Blockquote
    ".cm-md-bq": {
      borderLeft: "3px solid #444",
      paddingLeft: "14px !important",
      color: "#999",
    },
    // HR widget
    ".cm-hr-widget": {
      display: "block",
      height: "1px",
      background: "#555",
      margin: "8px 0",
      width: "100%",
    },
    // Images
    ".cm-img-wrap": { position: "relative", display: "inline-block", maxWidth: "100%", margin: "4px 0" },
    ".cm-img-widget": { display: "block", maxWidth: "100%", borderRadius: "4px" },
    ".cm-img-resize-handle": {
      position: "absolute", right: "0", bottom: "0",
      width: "14px", height: "14px",
      background: "rgba(255,255,255,0.7)",
      cursor: "nwse-resize",
      borderRadius: "3px 0 4px 0",
      opacity: "0",
      transition: "opacity 0.15s",
    },
    ".cm-img-wrap:hover .cm-img-resize-handle": { opacity: "1" },
    // Fenced code blocks — background/border live in app.css to avoid CM6 specificity issues
    ".cm-md-code-line": {
      color: "#d4d4d4",
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: "0.9em",
    },
    // Checkbox
    ".cm-cb-wrap": { display: "inline-block", paddingRight: "10px", lineHeight: "1", verticalAlign: "middle" },
    ".cm-cb": { cursor: "pointer", verticalAlign: "middle" },
    ".cm-cb-done": { textDecoration: "line-through", color: "#666" },
    // Scrollbar
    ".cm-scroller::-webkit-scrollbar": { width: "6px" },
    ".cm-scroller::-webkit-scrollbar-thumb": { background: "#555", borderRadius: "3px" },
    // Tables
    ".cm-table-wrap": { margin: "6px 0", overflowX: "auto", cursor: "text", borderRadius: "3px" },
    ".cm-table-wrap:hover": { outline: "1px solid #2a2a2a" },
    ".cm-table-widget": { borderCollapse: "collapse", fontFamily: "IBM Plex Mono, monospace", fontSize: "13px" },
    ".cm-table-widget th, .cm-table-widget td": { border: "1px solid #222", padding: "4px 12px" },
    ".cm-table-widget thead tr": { background: "#181818", color: "#e0e0e0", fontWeight: "600" },
    ".cm-table-widget tbody tr:hover": { background: "#131313" },
    // Search / replace panel
    ".cm-panels": { background: "#111", borderBottom: "1px solid #222", zIndex: "10" },
    ".cm-search": { padding: "7px 10px", display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
    ".cm-search label": { color: "#555", fontSize: "11px", display: "flex", alignItems: "center", gap: "4px", fontFamily: "IBM Plex Mono, monospace" },
    ".cm-textfield": { background: "#1a1a1a", border: "1px solid #2a2a2a", color: "#ccc", borderRadius: "4px", padding: "3px 8px", fontSize: "12px", fontFamily: "IBM Plex Mono, monospace", outline: "none", width: "160px" },
    ".cm-textfield:focus": { borderColor: "#444" },
    ".cm-button": { background: "#1e1e1e", border: "1px solid #2a2a2a", color: "#888", borderRadius: "4px", padding: "2px 10px", fontSize: "11px", fontFamily: "IBM Plex Mono, monospace", cursor: "pointer" },
    ".cm-button:hover": { color: "#ccc", borderColor: "#444" },
    ".cm-button[name=close]": { background: "none", border: "none", color: "#444", fontSize: "16px", padding: "0 4px", lineHeight: "1" },
    ".cm-button[name=close]:hover": { color: "#888", border: "none" },
    ".cm-searchMatch": { background: "rgba(95,200,59,0.15)", outline: "1px solid rgba(95,200,59,0.3)", borderRadius: "2px" },
    ".cm-searchMatch.cm-searchMatch-selected": { background: "rgba(95,200,59,0.35)" },
  },
  { dark: true }
);

// ── Smart Enter ────────────────────────────────────────────────────
// Continues list/checkbox on Enter at end of line; exits on empty item.

function smartEnter(view) {
  const { state } = view;
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);

  const m = line.text.match(/^(\s*)([-*] \[[ xX]\]\s?|[-*] |\d+\. )(.*)/);
  if (!m) return false;

  const indent = m[1];
  const marker = m[2];
  const content = m[3];

  // Empty item → exit list (clear prefix, plain newline)
  if (!content.trim()) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: "" },
      selection: { anchor: line.from },
    });
    return true;
  }

  // Build continuation marker
  let newMarker;
  if (/\[[ xX]\]/.test(marker)) {
    // Checkbox: always unchecked
    newMarker = marker.replace(/\[[ xX]\]\s?/, "[ ] ");
  } else if (/^\d+\./.test(marker)) {
    // Numbered: increment
    newMarker = marker.replace(/^\d+/, (n) => String(parseInt(n) + 1));
  } else {
    newMarker = marker;
  }

  // Cursor at line start → insert new item above, keep existing line intact
  if (from === line.from) {
    const newLine = indent + newMarker;
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: newLine + "\n" },
      selection: { anchor: line.from + newLine.length },
    });
    return true;
  }

  const insert = "\n" + indent + newMarker;
  view.dispatch({
    changes: { from, to: from, insert },
    selection: { anchor: from + insert.length },
  });
  return true;
}

// ── Public API ─────────────────────────────────────────────────────

window.WEditor = {
  /**
   * Mount a markdown editor at `parent`.
   * @param {HTMLElement} parent
   * @param {{ doc?: string, onChange?: (text: string) => void }} opts
   * @returns {EditorView}
   */
  create(parent, { doc = "", onChange, tabIndent = false, uploadImage = null } = {}) {
    // List-aware Tab: indents list/checkbox lines at the line start.
    // Returns false on non-list lines so other handlers (tabIndent) can take over.
    const listTab = { key: "Tab", run: (view) => {
      const { state } = view;
      const line = state.doc.lineAt(state.selection.main.from);
      if (/^(\s*)([-*] \[[ xX]\]\s?|[-*] |\d+\. )/.test(line.text)) {
        view.dispatch({ changes: { from: line.from, to: line.from, insert: "  " } });
        return true;
      }
      return false;
    }};
    const listShiftTab = { key: "Shift-Tab", run: (view) => {
      const { state } = view;
      const line = state.doc.lineAt(state.selection.main.from);
      if (/^(\s*)([-*] \[[ xX]\]\s?|[-*] |\d+\. )/.test(line.text) && line.text.startsWith("  ")) {
        view.dispatch({ changes: { from: line.from, to: line.from + 2, insert: "" } });
        return true;
      }
      return false;
    }};

    const exts = [
      history(),
      keymap.of([
        listTab,
        listShiftTab,
        ...(tabIndent ? [
          { key: "Tab", run: (view) => { view.dispatch(view.state.replaceSelection("  ")); return true; } },
          { key: "Shift-Tab", run: (view) => {
            const { state } = view;
            const line = state.doc.lineAt(state.selection.main.from);
            if (line.text.startsWith("  ")) {
              view.dispatch({ changes: { from: line.from, to: line.from + 2, insert: "" } });
            }
            return true;
          }},
        ] : []),
        { key: "Ctrl-h", run: openSearchPanel },
        ...searchKeymap,
        { key: "Enter", run: smartEnter },
        // Atomic image delete — removes the entire ![...](url) span in one keystroke
        { key: "Backspace", run(view) {
          const { from, empty } = view.state.selection.main;
          if (!empty) return false;
          const doc = view.state.doc.toString();
          for (const m of doc.slice(0, from).matchAll(/!\[[^\]\n]*\]\([^)\n]+\)/g)) {
            if (m.index + m[0].length === from) {
              view.dispatch({ changes: { from: m.index, to: from } });
              return true;
            }
          }
          return false;
        }},
        { key: "Delete", run(view) {
          const { from, empty } = view.state.selection.main;
          if (!empty) return false;
          const m = view.state.doc.toString().slice(from).match(/^!\[[^\]\n]*\]\([^)\n]+\)/);
          if (m) { view.dispatch({ changes: { from, to: from + m[0].length } }); return true; }
          return false;
        }},
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.lineWrapping,
      search({ top: true }),
      mdPlugin,
      editorTheme,
      // Android IME doesn't fire keydown reliably — intercept input events instead
      EditorView.inputHandler.of((view, _from, _to, text) => {
        if (text === '\n') return smartEnter(view);
        return false;
      }),
      EditorView.domEventHandlers({
        mousedown(event, view) {
          // Open links on click — the URL part is hidden by decoration so we
          // look up the raw document text around the click position.
          if (!event.target.classList.contains('cm-link')) return false;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) return false;
          const line = view.state.doc.lineAt(pos);
          const text = line.text;
          // Find all [text](url) matches in this line and pick the one the click lands on
          for (const m of text.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
            const start = line.from + m.index;
            const end   = start + m[0].length;
            if (pos >= start && pos <= end) {
              event.preventDefault();
              window.open(m[2], '_blank', 'noopener,noreferrer');
              return true;
            }
          }
          return false;
        },
        paste(event, view) {
          const items = event.clipboardData?.items;
          if (!items) return false;
          for (const item of items) {
            if (item.type.startsWith('image/')) {
              event.preventDefault();
              if (!uploadImage) return true;
              const file = item.getAsFile();
              uploadImage(file).then(url => {
                const markdown = `![](${url})`;
                const { from } = view.state.selection.main;
                view.dispatch({
                  changes: { from, to: from, insert: '\n' + markdown + '\n' },
                  selection: { anchor: from + markdown.length + 2 },
                });
              }).catch(err => console.error('Image upload failed', err));
              return true;
            }
          }
          return false;
        },
      }),
    ];
    if (onChange) {
      exts.push(
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
        })
      );
    }
    return new EditorView({
      state: EditorState.create({ doc, extensions: exts }),
      parent,
    });
  },

  /** Read current text from a view */
  getText(view) {
    return view ? view.state.doc.toString() : "";
  },

  /** Replace all content in a view */
  setText(view, text) {
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  },

  /** Scroll editor to a document position and focus */
  scrollTo(view, pos) {
    if (!view) return;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 40 }),
    });
    view.focus();
  },

  /** Destroy a view and free memory */
  destroy(view) {
    if (view) view.destroy();
  },
};
