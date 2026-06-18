import {
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType,
  keymap,
} from "@codemirror/view";
import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
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

// ── Table cell inline rendering ────────────────────────────────────
// Render a single cell's markdown to safe HTML. Escape first, then apply a
// small set of inline rules on the escaped string so user text can never
// inject markup. Mirrors the inline grammar used elsewhere (collectInline)
// but emits HTML instead of CM6 decorations, since a widget needs real DOM.
function escCellHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function cellHtml(raw) {
  let s = escCellHtml(raw);
  // Inline code first (nothing parsed inside)
  s = s.replace(/`([^`]+)`/g, (_m, t) => `<code class="cm-ic">${t}</code>`);
  // Images ![alt](url) before links
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => `<img src="${url}" alt="${alt}" style="max-width:120px;border-radius:3px;vertical-align:middle">`);
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="cm-link">${txt}</a>`);
  // Colored text {#hex words}
  s = s.replace(/\{#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\s+([^}]+)\}/g, (_m, hex, t) => `<span style="color:#${hex}">${t}</span>`);
  // Bold+italic, bold, italic, strike
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<span style='text-decoration:line-through;color:#888'>$1</span>");
  return s;
}

class TableWidget extends WidgetType {
  constructor(block) {
    super();
    this.block = block;
    // Identity for CM6's diff — rebuild the DOM when content OR positions change
    // (positions back the click-to-edit mapping, so stale ones must not survive).
    this.key = JSON.stringify([
      block.header, block.align, block.rows,
      block.from, block.headerPos, block.rowFroms, block.rowPos,
    ]);
  }
  eq(other) { return this.key === other.key; }
  toDOM() {
    const b = this.block;
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    wrap.dataset.from = String(b.from);
    // Border/radius live on an inner box so the wrap's spacing can be *padding*
    // (part of the widget's measured height) rather than margin — a margin
    // leaves a dead gap between the block widget and the next line where the
    // cursor snaps into the table and vertical motion skips the whole block.
    const box = document.createElement("div");
    box.className = "cm-table-widget-box";
    const table = document.createElement("table");
    table.className = "cm-table-widget";

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    htr.dataset.pos = String(b.from);
    b.header.forEach((c, i) => {
      const th = document.createElement("th");
      th.innerHTML = cellHtml(c);
      if (b.align[i]) th.style.textAlign = b.align[i];
      if (b.headerPos[i] != null) th.dataset.pos = String(b.from + b.headerPos[i]);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    b.rows.forEach((row, k) => {
      const tr = document.createElement("tr");
      const rowFrom = b.rowFroms[k];
      tr.dataset.pos = String(rowFrom);
      for (let i = 0; i < b.header.length; i++) {
        const td = document.createElement("td");
        td.innerHTML = cellHtml(row[i] || "");
        if (b.align[i]) td.style.textAlign = b.align[i];
        const cp = b.rowPos[k] ? b.rowPos[k][i] : null;
        if (cp != null) td.dataset.pos = String(rowFrom + cp);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
    wrap.appendChild(box);
    return wrap;
  }
  // Let clicks through so the editor's mousedown handler can either open a
  // link in a cell or drop the cursor into the block to edit the raw pipes.
  ignoreEvent() { return false; }
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

// ── Table block scanner ────────────────────────────────────────────
// A markdown table = a header row of `| a | b |`, a separator row of
// `| --- | :--: |` directly below it, then zero+ body rows. We collapse the
// whole block into one widget when the cursor is outside it.
// Split a raw row into cells, keeping each cell's content offset *within the
// raw line text* (`pos`) so a click on a rendered cell can map back to the
// exact spot in the source for editing. Offsets are relative to the line start.
function parseRow(raw) {
  const segs = [];
  let cur = "", start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && raw[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "|") { segs.push({ text: cur, start }); cur = ""; start = i + 1; continue; }
    cur += ch;
  }
  segs.push({ text: cur, start });
  // Drop the empty cells produced by leading/trailing outer pipes.
  if (segs.length && segs[0].text.trim() === "") segs.shift();
  if (segs.length && segs[segs.length - 1].text.trim() === "") segs.pop();
  return segs.map((s) => {
    const lead = s.text.length - s.text.replace(/^\s+/, "").length;
    return { text: s.text.trim(), pos: s.start + lead };
  });
}
function splitRow(row) {
  return parseRow(row).map((c) => c.text);
}
function isSepRow(text) {
  if (!text.includes("|")) return false;
  const cells = splitRow(text);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}
function alignOf(cell) {
  const l = cell.startsWith(":"), r = cell.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return "";
}
function scanTables(doc, fences) {
  const blocks = [];
  let i = 1;
  while (i < doc.lines) {
    const h = doc.line(i);
    const sep = doc.line(i + 1);
    if (!fences.get(h.from) && h.text.includes("|") && isSepRow(sep.text)) {
      const headerCells = parseRow(h.text);
      const align = splitRow(sep.text).map(alignOf);
      const rows = [], rowFroms = [], rowPos = [];
      let j = i + 2;
      while (j <= doc.lines) {
        const r = doc.line(j);
        if (fences.get(r.from) || !r.text.includes("|") || r.text.trim() === "") break;
        const cells = parseRow(r.text);
        rows.push(cells.map((c) => c.text));
        rowPos.push(cells.map((c) => c.pos));
        rowFroms.push(r.from);
        j++;
      }
      const last = doc.line(j - 1);
      blocks.push({
        from: h.from, to: last.to, align,
        header: headerCells.map((c) => c.text),
        headerPos: headerCells.map((c) => c.pos),
        rows, rowFroms, rowPos,
      });
      i = j;
    } else {
      i++;
    }
  }
  return blocks;
}

// ── ViewPlugin ─────────────────────────────────────────────────────

// Decorate a single line. Throws nothing of its own, but the RangeSetBuilder it
// writes to will throw if ranges ever arrive out of order — see decorateLine's
// caller, which isolates that failure to the one offending line.
function decorateLine(builder, line, fences, view, numWidths) {
  const { text, from: lf } = line;

  // ── Fenced code block ─────────────────────────────
  const fence = fences.get(lf);
  if (fence?.type === 'open') {
    builder.add(lf, lf, Decoration.line({ class: 'cm-md-fence-open' }));
    return;
  }
  if (fence?.type === 'close') {
    builder.add(lf, lf, Decoration.line({ class: 'cm-md-fence-close' }));
    return;
  }
  if (fence?.type === 'body') {
    builder.add(lf, lf, Decoration.line({ class: 'cm-md-code-line' }));
    return;
  }

  // ── Heading ──────────────────────────────────────
  const hm = text.match(/^(#{1,6}) (.*)/);
  if (hm) {
    const lvl = hm[1].length;
    const plen = lvl + 1;
    builder.add(lf, lf, Decoration.line({ class: `cm-md-h${lvl}` }));
    builder.add(lf, lf + plen, Decoration.replace({}));
    pushInline(builder, lf + plen, collectInline(hm[2]), view);
    return;
  }

  // ── Horizontal rule ───────────────────────────────
  if (text.trim().length >= 3 && /^[-*_]+$/.test(text.trim()) && line.to > lf) {
    builder.add(lf, lf, Decoration.line({ class: "cm-md-hr" }));
    builder.add(lf, line.to, Decoration.replace({ widget: new HrWidget() }));
    return;
  }

  // ── Blockquote ────────────────────────────────────
  const bqm = text.match(/^(> ?)(.*)/);
  if (bqm) {
    builder.add(lf, lf, Decoration.line({ class: "cm-md-bq" }));
    builder.add(lf, lf + bqm[1].length, Decoration.replace({}));
    pushInline(builder, lf + bqm[1].length, collectInline(bqm[2]), view);
    return;
  }

  // ── Checkbox ─────────────────────────────────────
  // [ ] = unchecked, [x] = checked. Bullet prefix optional. Trailing space optional.
  const cbm = text.match(/^(\s*)(?:[-*] )\[([ xX])\] ?(.*)/);
  if (cbm) {
    const checked = cbm[2].toLowerCase() === "x";
    const indent = cbm[1].length;
    const widgetEnd = cbm[0].length - cbm[3].length;
    // Strike-through for done items is applied as a whole-line decoration
    // (added first, at the line start) rather than an inline mark spanning
    // the remaining text. An inline mark would start at the same position as
    // any inline decoration (link/bold/color) at the head of the content,
    // and the two could be handed to RangeSetBuilder out of startSide order —
    // which throws and wipes ALL decorations for the entire note.
    if (checked)
      builder.add(lf, lf, Decoration.line({ class: "cm-cb-done-line" }));
    if (lf + indent < lf + widgetEnd) {
      builder.add(lf + indent, lf + widgetEnd, Decoration.replace({
        widget: new CheckboxWidget(checked, lf),
      }));
    }
    pushInline(builder, lf + widgetEnd, collectInline(cbm[3]), view);
    return;
  }

  // ── Regular line — inline only + hanging indent ──
  // Wrapped text aligns with content start (Google Docs style). For numbered
  // items, pad the first line by the run's widest number minus this number, so
  // shorter numbers right-align and every item's text shares one column.
  const hm2 = text.match(/^(\s*)([-*]\s|\d+\.\s)?/);
  const hangTotal = (hm2[1] || '').length + (hm2[2] || '').length;
  if (hangTotal > 0) {
    let pad = hangTotal;
    const numM = text.match(/^(\s*)(\d+)\.\s/);
    if (numM && numWidths && numWidths.has(lf)) {
      pad = hangTotal + (numWidths.get(lf) - numM[2].length); // extra = D - d
    }
    builder.add(lf, lf, Decoration.line({
      attributes: { style: `padding-left:${pad}ch;text-indent:-${hangTotal}ch` },
    }));
  }
  pushInline(builder, lf, collectInline(text), view);
}

// For each numbered-list item, the widest number (digit count) in its run of
// consecutive same-indent items. Lets shorter numbers be right-aligned so every
// item's text starts in the same column (e.g. "9." and "10." line up) instead
// of a two-digit number shoving its text and wrapped lines a column right.
function numberedListWidths(doc) {
  const map = new Map(); // line.from -> max digit count in its run
  let run = [], runIndent = null;
  const flush = () => {
    if (run.length) {
      const D = Math.max(...run.map((r) => r.digits));
      for (const r of run) map.set(r.from, D);
    }
    run = []; runIndent = null;
  };
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = line.text.match(/^(\s*)(\d+)\.\s/);
    if (m) {
      const indent = m[1].length;
      if (runIndent !== null && indent !== runIndent) flush();
      runIndent = indent;
      run.push({ from: line.from, digits: m[2].length });
    } else {
      flush();
    }
  }
  flush();
  return map;
}

function buildDecos(view) {
  const builder = new RangeSetBuilder();
  const { doc } = view.state;
  const fences = scanFences(doc);
  const numWidths = numberedListWidths(doc);

  // Skip lines belonging to a collapsed table — those are rendered as a grid
  // widget by `tableField` (a StateField, because block-level decorations that
  // change document height can't come from a view plugin). When the cursor is
  // inside a table, it isn't collapsed, so we fall through and decorate its
  // lines normally (raw pipes) for editing.
  const collapsedTable = collapsedTables(view.state);

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const block = collapsedTable.get(line.from);
      if (block) {
        pos = block.to + 1; // handled by tableField; don't decorate here
        continue;
      }
      pos = line.to + 1; // advance first, so a thrown line can't loop forever
      // Per-line safety net: if decorating one line ever throws (e.g. a future
      // markdown combo feeds RangeSetBuilder ranges out of order), only that
      // line falls back to plain text — every other line in the note keeps its
      // formatting. A throw here used to take down the entire note.
      try {
        decorateLine(builder, line, fences, view, numWidths);
      } catch (e) {
        console.warn("markdown decorate skipped line", line.number, e);
      }
    }
  }

  return builder.finish();
}

// Map of header-line `from` → table block, for every table the cursor/selection
// does NOT touch (those get collapsed into a grid). Shared by the view plugin
// (which skips these lines) and the table StateField (which draws the grid), so
// the two always agree on which tables are collapsed.
function collapsedTables(state) {
  const fences = scanFences(state.doc);
  const sel = state.selection;
  const map = new Map();
  for (const b of scanTables(state.doc, fences)) {
    const editing = sel.ranges.some((r) => r.from <= b.to && r.to >= b.from);
    if (!editing) map.set(b.from, b);
  }
  return map;
}

// Block-level (height-changing) decorations must be served from a StateField,
// not a view plugin — CM6 measures document height before running plugins, so
// plugin-provided block decorations are silently ignored.
function buildTableDecos(state) {
  const ranges = [];
  for (const b of collapsedTables(state).values()) {
    ranges.push(
      Decoration.replace({ widget: new TableWidget(b), block: true }).range(b.from, b.to)
    );
  }
  return Decoration.set(ranges, true);
}

const tableField = StateField.define({
  create: (state) => buildTableDecos(state),
  update(value, tr) {
    // Rebuild when the text changes (table content) or the selection moves
    // (cursor entering/leaving a table flips it between grid and raw pipes).
    if (tr.docChanged || tr.selection) return buildTableDecos(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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
    ".cm-cb-done-line": { textDecoration: "line-through", color: "#666" },
    // Scrollbar
    ".cm-scroller::-webkit-scrollbar": { width: "6px" },
    ".cm-scroller::-webkit-scrollbar-thumb": { background: "#555", borderRadius: "3px" },
    // Tables
    ".cm-table-wrap": { padding: "10px 0", overflowX: "auto", cursor: "pointer" },
    ".cm-table-widget-box": { borderRadius: "5px", border: "1px solid #262626", overflow: "hidden" },
    ".cm-table-widget": { borderCollapse: "collapse", width: "100%", fontFamily: "IBM Plex Mono, monospace", fontSize: "13px" },
    ".cm-table-widget th, .cm-table-widget td": { borderBottom: "1px solid #1e1e1e", borderRight: "1px solid #1e1e1e", padding: "8px 16px", textAlign: "left", verticalAlign: "top", whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "break-word" },
    ".cm-table-widget th:last-child, .cm-table-widget td:last-child": { borderRight: "none" },
    ".cm-table-widget tbody tr:last-child td": { borderBottom: "none" },
    ".cm-table-widget thead tr": { background: "#161616", color: "#cfcfcf", fontWeight: "700" },
    ".cm-table-widget thead th": { borderBottom: "1px solid #2a2a2a" },
    ".cm-table-widget tbody td": { color: "#c8c8c8" },
    ".cm-table-widget tbody tr:hover": { background: "#121212" },
    ".cm-table-widget a.cm-link": { color: "#e0b25a", textDecoration: "none" },
    ".cm-table-widget a.cm-link:hover": { textDecoration: "underline" },
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

// ── Arrow-key entry into a collapsed table ─────────────────────────
// A collapsed table is one block widget, so CM6's default vertical motion
// leaps over ALL its rows in a single press — you can never land on a row with
// the keyboard, only by clicking. These handlers detect the cursor sitting
// directly above/below a collapsed table and step it onto the adjacent table
// line instead, which (since the cursor is now inside) expands the table to
// raw text so you can keep moving row by row normally.
function tableStepDown(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (line.number >= state.doc.lines) return false;
  const next = state.doc.line(line.number + 1);
  if (!collapsedTables(state).has(next.from)) return false;
  const col = sel.head - line.from;
  view.dispatch({ selection: { anchor: Math.min(next.from + col, next.to) }, scrollIntoView: true });
  return true;
}
function tableStepUp(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (line.number <= 1) return false;
  const prev = state.doc.line(line.number - 1);
  let hit = false;
  for (const b of collapsedTables(state).values()) {
    if (state.doc.lineAt(b.to).number === prev.number) { hit = true; break; }
  }
  if (!hit) return false;
  const col = sel.head - line.from;
  view.dispatch({ selection: { anchor: Math.min(prev.from + col, prev.to) }, scrollIntoView: true });
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
        // Let the keyboard step into a collapsed table instead of jumping over it
        { key: "ArrowDown", run: tableStepDown },
        { key: "ArrowUp", run: tableStepUp },
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
      tableField,
      mdPlugin,
      editorTheme,
      // Android IME doesn't fire keydown reliably — intercept input events instead
      EditorView.inputHandler.of((view, _from, _to, text) => {
        if (text === '\n') return smartEnter(view);
        return false;
      }),
      EditorView.domEventHandlers({
        mousedown(event, view) {
          // Click inside a rendered table → drop the cursor into the block so
          // it flips back to raw pipes for editing. Links inside cells are real
          // <a> tags, so let those clicks fall through and open normally.
          const wrap = event.target.closest && event.target.closest('.cm-table-wrap');
          if (wrap) {
            if (event.target.closest('a')) return false;
            // Land the cursor on the cell/row that was actually clicked. A block
            // widget has no internal layout CM6 can map a click into, so without
            // this the cursor would snap to the top or bottom of the whole table.
            const cell = event.target.closest('td, th');
            const row = event.target.closest('tr');
            let anchor;
            if (cell && cell.dataset.pos != null) anchor = parseInt(cell.dataset.pos, 10);
            else if (row && row.dataset.pos != null) anchor = parseInt(row.dataset.pos, 10);
            else {
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              anchor = pos != null ? pos : parseInt(wrap.dataset.from || '0', 10);
            }
            // Clamp defensively — positions are from the last render and the doc
            // may have shifted since (it shouldn't, but never seek out of range).
            anchor = Math.max(0, Math.min(anchor, view.state.doc.length));
            event.preventDefault();
            view.dispatch({ selection: { anchor } });
            view.focus();
            return true;
          }
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

  /** Insert a starter markdown table at the cursor and focus the editor */
  insertTable(view) {
    if (!view) return;
    const tmpl =
      "| Column 1 | Column 2 | Column 3 |\n" +
      "| --- | --- | --- |\n" +
      "| Cell | Cell | Cell |\n" +
      "| Cell | Cell | Cell |\n";
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    // Drop it on its own line — after the current line if that line has text.
    const onText = line.text.trim() !== "";
    const at = onText ? line.to : line.from;
    const insert = onText ? "\n" + tmpl : tmpl;
    view.dispatch({
      changes: { from: at, to: at, insert },
      // Park the cursor just past the table so it renders immediately.
      selection: { anchor: at + insert.length },
    });
    view.focus();
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
