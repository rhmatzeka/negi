import {
  BookOpenIcon, BugIcon, ChatsCircleIcon, CodeIcon, DatabaseIcon, FileTextIcon, GaugeIcon, GitBranchIcon,
  GlobeHemisphereWestIcon, type Icon, NotePencilIcon, PackageIcon, PlugsConnectedIcon, ShippingContainerIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";

// What runs in a pane decides its glyph. Unknown programs get the terminal.
const PROGRAMS: [RegExp, Icon][] = [
  [/^(zsh|bash|sh|fish|dash|nu|tmux)$/, TerminalWindowIcon],
  [/^(n?vim?|nano|hx|emacs|micro|helix)$/, NotePencilIcon],
  [/^(claude|opencode|codex|aider|gemini|goose)/, ChatsCircleIcon],
  [/^(git|lazygit|tig|gh|jj)$/, GitBranchIcon],
  [/^(node|bun|deno|python[\d.]*|ruby|go|java|php|lua|perl)$/, CodeIcon],
  [/^(cargo|rustc|make|npm|pnpm|yarn|gradle|ninja|cmake)$/, PackageIcon],
  [/^(htop|btop|top|glances|btm)$/, GaugeIcon],
  [/^(ssh|mosh|telnet|nc)$/, PlugsConnectedIcon],
  [/^(docker|podman|kubectl|k9s|lazydocker)$/, ShippingContainerIcon],
  [/^(less|man|bat|more)$/, BookOpenIcon],
  [/^(tail|cat|watch|jq)$/, FileTextIcon],
  [/^(psql|mysql|sqlite3|redis-cli|mongosh)$/, DatabaseIcon],
  [/^(curl|wget|http|ping)$/, GlobeHemisphereWestIcon],
  [/^(gdb|lldb|strace|dtrace)$/, BugIcon],
];

export function programIcon(command: string | undefined): Icon {
  return PROGRAMS.find(([pattern]) => pattern.test(command ?? ""))?.[1] ?? TerminalWindowIcon;
}

/** The tones a tile takes when nothing says which: one per thing, fixed by its name. */
export const TONES = ["accent", "solid", "quiet"] as const;
export type Tone = (typeof TONES)[number] | "danger";

export function hash(text: string): number {
  let n = 0;
  for (const c of text) n = (n * 31 + c.codePointAt(0)!) >>> 0;
  return n;
}
