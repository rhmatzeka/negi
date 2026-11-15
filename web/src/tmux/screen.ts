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

/** Fills `row` with one captured line. */
export function paintRow(row: HTMLElement, line: string) {
  row.textContent = "";
  for (const entry of Anser.ansiToJson(line, { json: true, use_classes: true, remove_empty: true })) {
    row.append(span(entry));
  }
  // An empty row still needs a line box, or the screen collapses.
  if (!row.firstChild) row.append("​");
}

/** The text of a captured line with every escape sequence removed. */
export const plain = (line: string): string => Anser.ansiToText(line);

export interface ScreenMessage {
  cols: number;
  rows: number;
  alt: boolean;
  cur: [number, number, boolean];
  lines: string[];
}

export interface RowsMessage {
  cur: [number, number, boolean];
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
  private crop([, y]: [number, number, boolean]) {
    let used = this.lines.length;
    while (used > 0 && plain(this.lines[used - 1]).trim() === "") used--;
    this.el.style.setProperty("--used", String(Math.max(used, y + 1, 1)));
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

  private cursor([x, y, visible]: [number, number, boolean]) {
    this.cursorEl.hidden = !visible;
    this.cursorEl.style.setProperty("--cx", String(x));
    this.cursorEl.style.setProperty("--cy", String(y));
  }
}
