// Sample data for looking at the interface without a Mac. Development builds only: it
// is loaded when the address carries `?demo`, and stands in for the socket.

import { type Incoming, receive, setSender } from "@/connection/link";
import { useApp } from "@/lib/store";
import type { Session } from "@/tmux/tree";

const ROWS = 30;
const COLS = 100;
const c = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const prompt = `${c("1;36", "~/work/api")} ${c("35", "main")} ${c("32", "❯")}`;

const pane = (id: string, command: string, path = "/Users/me/work") => ({
  id, index: 0, active: true, cols: COLS, rows: ROWS, command, path, title: command,
});

let sessions: Session[] = [
  {
    id: "$0", name: "api", attached: true,
    windows: [
      { id: "@0", index: 1, name: "shell", active: true, panes: [pane("%0", "zsh")] },
      { id: "@1", index: 2, name: "logs", active: false, panes: [pane("%1", "tail")] },
      { id: "@2", index: 3, name: "editor", active: false, panes: [pane("%2", "nvim")] },
    ],
  },
  { id: "$1", name: "build", attached: false, windows: [{ id: "@3", index: 1, name: "cargo", active: true, panes: [pane("%3", "cargo")] }] },
  { id: "$2", name: "agent", attached: false, windows: [{ id: "@4", index: 1, name: "claude", active: true, panes: [pane("%4", "claude")] }] },
  { id: "$3", name: "db", attached: false, windows: [{ id: "@5", index: 1, name: "psql", active: true, panes: [pane("%5", "psql")] }] },
];

const screens: Record<string, string[]> = {
  "%0": [
    `${prompt} git status -sb`,
    `## ${c("32", "main")}...${c("31", "origin/main")} [ahead 2]`,
    ` ${c("31", "M")} src/server.rs`,
    ` ${c("31", "M")} web/src/pages.tsx`,
    `${c("31", "??")} web/src/lib/demo.ts`,
    `${prompt} cargo test`,
    `   ${c("1;32", "Compiling")} negi v0.1.0`,
    `    ${c("1;32", "Finished")} test profile in 4.21s`,
    `test result: ${c("32", "ok")}. 61 passed; 0 failed`,
    `${prompt} `,
  ],
  "%1": ["GET /api/health 200 1ms", "WS  /api/ws     101", `POST /api/pair  ${c("31", "403")} 0ms`, "GET /assets/index.js 200 3ms"],
  "%2": [`${c("90", "  1")} ${c("35", "fn")} ${c("34", "main")}() {`, `${c("90", "  2")}     println!(${c("32", '"hello"')});`, `${c("90", "  3")} }`, `${c("7", " NORMAL ")} src/main.rs`],
  "%3": [],
  "%4": [
    `${c("90", ">")} keep the list header fixed`,
    "",
    `${c("1", "●")} Read ${c("1", "List.tsx")}`,
    `${c("1", "●")} Update ${c("1", "List.tsx")} ${c("32", "+6")} ${c("31", "-2")}`,
    "",
    `${c("1", "●")} Run the tests now?`,
    "",
    `${c("36", "❯")} 1. Yes`,
    "  2. Yes, always",
    "  3. No",
  ],
  "%5": ["negi=# select count(*) from devices;", " count ", "-------", "     2", "(1 row)", "", "negi=# "],
};

let step = 0;
let ticker: ReturnType<typeof setInterval> | undefined;

function tree() {
  receive({ t: "tree", server: true, sessions, busy: ["%3"] });
}

function screen(id: string) {
  const lines = (screens[id] ?? []).slice(-ROWS);
  const last = lines.length ? lines.length - 1 : 0;
  const padded = [...lines, ...Array<string>(ROWS - lines.length).fill("")];
  // The cursor sits after the last line's text, as it would at a prompt.
  const column = (lines[last] ?? "").replace(/\x1b\[[0-9;]*m/g, "").length;
  receive({ t: "screen", pane: id, cols: COLS, rows: ROWS, alt: false, cur: [Math.min(column, COLS - 1), last, true], lines: padded });
}

/** Answers what the app sends, as the Mac would. */
function answer(message: Record<string, unknown>) {
  const id = message.id as number | undefined;
  const ack = (extra: object = {}) => id !== undefined && setTimeout(() => receive({ t: "ack", id, ok: true, ...extra } as Incoming), 120);
  const paneId = message.pane as string;
  switch (message.t) {
    case "watch":
      setTimeout(() => screen(paneId), 200);
      return;
    case "text":
      if (paneId === "%4") {
        screens["%4"] = [...screens["%4"].slice(0, 5), `${c("1", "●")} Bash(cargo test)`, `  ${c("32", "ok.")} 61 passed`, "", `${c("1", "●")} All 61 tests pass.`, "  The header stays put."];
        screen(paneId);
        return ack();
      }
      (screens[paneId] ??= []).push(`${screens[paneId]?.pop() ?? ""}${message.text as string}`);
      if (message.enter) screens[paneId].push(prompt + " ");
      screen(paneId);
      return ack();
    case "click":
    case "wheel":
    case "fit":
    case "unfit":
      return ack();
    case "history":
      return ack({ lines: paneId === "%0" ? Array.from({ length: 80 }, (_, i) => `${c("90", String(i + 1).padStart(3))} earlier output line ${i + 1}`) : [] });
    case "rename-session":
      sessions = sessions.map((s) => (s.id === message.session ? { ...s, name: message.name as string } : s));
      break;
    case "rename-window":
      sessions = sessions.map((s) => ({ ...s, windows: s.windows.map((w) => (w.id === message.window ? { ...w, name: message.name as string } : w)) }));
      break;
    case "kill-session":
      sessions = sessions.filter((s) => s.id !== message.session);
      break;
    case "kill-window":
    case "kill-pane":
      sessions = sessions
        .map((s) => ({ ...s, windows: s.windows.filter((w) => w.id !== message.window && !w.panes.some((p) => p.id === paneId)) }))
        .filter((s) => s.windows.length);
      break;
    case "new-session": {
      const n = 10 + sessions.length;
      screens[`%${n}`] = [prompt + " "];
      sessions = [...sessions, { id: `$${n}`, name: (message.name as string) || `session-${n}`, attached: false, windows: [{ id: `@${n}`, index: 1, name: "zsh", active: true, panes: [pane(`%${n}`, "zsh")] }] }];
      tree();
      return ack({ pane: `%${n}` });
    }
    case "new-window": {
      const n = 20 + sessions.reduce((sum, s) => sum + s.windows.length, 0);
      screens[`%${n}`] = [prompt + " "];
      sessions = sessions.map((s) =>
        s.id === message.session ? { ...s, windows: [...s.windows, { id: `@${n}`, index: s.windows.length + 1, name: "zsh", active: false, panes: [pane(`%${n}`, "zsh")] }] } : s,
      );
      tree();
      return ack({ pane: `%${n}` });
    }
  }
  tree();
  ack();
}

/**
 * `sessions` (the default): a full, clickable app. `empty`: tmux is not running.
 * `connecting`: no answer yet. `unreachable`: the Mac never answered. `lost`: the socket
 * dropped while a session list was showing.
 */
export function startDemo(scenario: string, os = "macos") {
  clearInterval(ticker);
  useApp.setState({ token: "demo", device: "Sample data", version: "0.1.0", os, phase: "connecting", problem: "", hasTree: false });
  if (scenario === "connecting") return;
  if (scenario === "unreachable") {
    useApp.setState({ problem: "Your Mac is not answering. Is negi running there?" });
    return;
  }
  useApp.setState({ phase: "ready" });
  setSender((message) => answer(message as Record<string, unknown>));
  if (scenario === "empty") {
    receive({ t: "tree", server: false, sessions: [], busy: [] });
    return;
  }
  tree();
  // One pane keeps printing, so the busy state and row updates can be seen.
  ticker = setInterval(() => {
    step += 1;
    const lines = (screens["%3"] ??= []);
    lines.push(`   ${c("1;32", "Compiling")} crate-${step} v0.${step % 9}.${step % 4} ${c("90", `(${(step * 7) % 900} ms)`)}`);
    if (lines.length > ROWS) lines.shift();
    screen("%3");
  }, 800);
  if (scenario === "lost") setTimeout(() => useApp.setState({ phase: "lost" }), 600);
}
