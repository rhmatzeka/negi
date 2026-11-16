// Turns the lines tmux captured (text with SGR colour sequences) into DOM rows. The
// parsing is Anser's; the painting is done here, outside React, because a busy pane
// repaints rows many times a second.

import Anser, { type AnserJsonEntry } from "anser";

/** One of the 256 indexed colours. The first 16 follow the theme's terminal palette. */
function indexed(n: number): string {
  if (n < 16) return `var(--t-${n < 8 ? "" : "bright-"}${BASIC[n % 8]})`;
  if (n < 232) {
    const c = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${level(Math.floor(c / 36))} ${level(Math.floor(c / 6) % 6)} ${level(c % 6)})`;
  }
  const grey = 8 + (n - 232) * 10;
  return `rgb(${grey} ${grey} ${grey})`;
}

const BASIC = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** Anser names a colour by class (`ansi-bright-red`, `ansi-palette-208`, `ansi-truecolor`). */
function colour(name: string | null, truecolor: string | null): string | null {
  if (!name) return null;
  if (name === "ansi-truecolor") return truecolor ? `rgb(${truecolor})` : null;
  const palette = name.match(/^ansi-palette-(\d+)$/);
  if (palette) return indexed(Number(palette[1]));
  return `var(--t-${name.slice("ansi-".length)})`;
}

function span(entry: AnserJsonEntry): HTMLSpanElement {
  const el = document.createElement("span");
  el.textContent = entry.content;
  const fg = colour(entry.fg, entry.fg_truecolor);
  const bg = colour(entry.bg, entry.bg_truecolor);
  if (fg) el.style.color = fg;
  if (bg) el.style.backgroundColor = bg;
  const has = (name: string) => (entry.decorations as string[]).includes(name);
  if (has("bold")) el.style.fontWeight = "700";
  if (has("dim")) el.style.opacity = "0.6";
  if (has("italic")) el.style.fontStyle = "italic";
  const lines = [has("underline") && "underline", has("strikethrough") && "line-through"].filter(Boolean);
  if (lines.length) el.style.textDecorationLine = lines.join(" ");
  return el;
}

/** One column's width as a share of the text size, measured: the loaded face is not always
 * the one asked for, and a guess too small scrolls a fitted pane sideways. */
export function columnWidth(): number {
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(50);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:400 100px/1 var(--font-mono);font-variant-ligatures:none";
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width / 5000;
  probe.remove();
  return width > 0 ? width : 0.6;
}

// OSC sequences (a hyperlink, a window title, a prompt mark), ended by BEL or ST. Anser reads
// only colour sequences and would print the rest of these as text.
// oxlint-disable-next-line no-control-regex -- matching ESC and BEL is the point
const OSC = /\x1b\](\d*);?([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** A line without its OSC sequences, and the spans of visible text that OSC 8 made links. */
function links(line: string): { text: string; spans: { from: number; to: number; href: string }[] } {
  const spans: { from: number; to: number; href: string }[] = [];
  let text = "";
  let at = 0;
  let open: { from: number; href: string } | null = null;
  for (const m of line.matchAll(OSC)) {
    text += line.slice(at, m.index);
    at = m.index + m[0].length;
    if (m[1] !== "8") continue;
    const shown = Anser.ansiToText(text).length;
    if (open) spans.push({ from: open.from, to: shown, href: open.href });
    // `8;params;uri`: the uri after the parameters' semicolon; an empty one ends the link.
    const uri = m[2].slice(m[2].indexOf(";") + 1);
    open = /^https?:\/\//i.test(uri) ? { from: shown, href: uri } : null;
  }
  text += line.slice(at);
  if (open) spans.push({ from: open.from, to: Infinity, href: open.href });
  return { text, spans };
}

/** Fills `row` with one captured line. */
export function paintRow(row: HTMLElement, line: string) {
  row.textContent = "";
  const { text, spans } = links(line);
  let shown = 0;
  for (const entry of Anser.ansiToJson(text, { json: true, use_classes: true, remove_empty: true })) {
    // A coloured run can start or end inside a link: it is cut at the link's edges.
    let rest = entry.content;
    while (rest) {
      const link = spans.find((l) => shown >= l.from && shown < l.to);
      const next = spans.find((l) => l.from > shown)?.from ?? Infinity;
      const take = Math.min(rest.length, (link ? link.to : next) - shown);
      const piece = span({ ...entry, content: rest.slice(0, take) });
      if (link) {
        const a = document.createElement("a");
        a.href = link.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "term-link";
        a.append(piece);
        row.append(a);
      } else row.append(piece);
      rest = rest.slice(take);
      shown += take;
    }
  }
  // An empty row still needs a line box, or the screen collapses.
  if (!row.firstChild) row.append("\u200b");
}

/** The text of a captured line with every escape sequence removed. */
export const plain = (line: string): string => Anser.ansiToText(line.replace(OSC, ""));

/** Column, row, shown, and the shape the program asked for ("" when it asked for none). */
type Cursor = [number, number, boolean, string?];

export interface ScreenMessage {
  cols: number;
  rows: number;
  alt: boolean;
  cur: Cursor;
  lines: string[];
}

export interface RowsMessage {
  cur: Cursor;
  scroll: number;
  set: [number, string][];
}

/** A pane's screen as a live element: `set` takes a `screen` message, `patch` a `rows` one. */
export class Screen {
  readonly el = document.createElement("div");
  private rowsEl = document.createElement("div");
  private cursorEl = document.createElement("span");
  cols = 80;
  rows = 0;
  /** On the alternate screen: a full-screen program, which keeps any scrollback itself. */
  alt = false;
  lines: string[] = [];

  constructor() {
    this.el.className = "term-screen";
    this.el.setAttribute("role", "log");
    this.el.setAttribute("aria-label", "Pane screen");
    this.cursorEl.className = "term-cursor";
    this.cursorEl.setAttribute("aria-hidden", "true");
    this.el.append(this.rowsEl, this.cursorEl);
  }

  set(msg: ScreenMessage) {
    this.cols = msg.cols;
    this.el.style.setProperty("--cols", String(msg.cols));
    this.rows = msg.rows;
    this.alt = msg.alt;
    this.lines = msg.lines.slice();
    this.rowsEl.textContent = "";
    for (const line of this.lines) this.rowsEl.append(this.row(line));
    this.cursor(msg.cur);
    this.crop(msg.cur);
  }

  patch(msg: RowsMessage) {
    for (let i = 0; i < msg.scroll && this.rowsEl.firstChild; i++) {
      this.rowsEl.firstChild.remove();
      this.lines.shift();
      this.lines.push("");
      this.rowsEl.append(this.row(""));
    }
    for (const [index, line] of msg.set) {
      const row = this.rowsEl.children[index] as HTMLElement | undefined;
      if (!row) continue;
      this.lines[index] = line;
      paintRow(row, line);
    }
    this.cursor(msg.cur);
    this.crop(msg.cur);
  }

  /** Ends the element under the last row in use, so a fresh shell cannot scroll into empty rows. */
  private crop([, y]: Cursor) {
    let used = this.lines.length;
    while (used > 0 && plain(this.lines[used - 1]).trim() === "") used--;
    this.el.style.setProperty("--used", String(Math.max(used, y + 1, 1)));
    this.el.style.setProperty("--rows", String(Math.max(this.lines.length, 1)));
  }

  /** The last `count` rows that hold any text, for a preview. */
  tail(count: number): string[] {
    let end = this.lines.length;
    while (end > 0 && plain(this.lines[end - 1]).trim() === "") end--;
    return this.lines.slice(Math.max(0, end - count), end);
  }

  private row(line: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "term-row";
    paintRow(row, line);
    return row;
  }

  private cursor([x, y, visible, shape]: Cursor) {
    this.cursorEl.hidden = !visible;
    // Asked for nothing, or tmux before 3.5: a full-screen program (an editor) gets a block, a shell a bar.
    this.cursorEl.dataset.shape = shape === "block" || shape === "underline" || shape === "bar" ? shape : this.alt ? "block" : "bar";
    this.cursorEl.style.setProperty("--cx", String(x));
    this.cursorEl.style.setProperty("--cy", String(y));
  }
}
