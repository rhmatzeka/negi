// The modifiers of the key row. They latch, and are spent on the next key, wherever it is
// typed: on the row, in the command field, or straight into the terminal.

import { create } from "zustand";

type Mod = "ctrl" | "alt" | "cmd" | "shift";

const NONE: Record<Mod, boolean> = { ctrl: false, alt: false, cmd: false, shift: false };
export const isMod = (id: string): id is Mod => id in NONE;

// Command never reaches a program in a terminal. These are what a Mac terminal sends in its place.
const WITH_CMD: Record<string, string> = { Left: "C-a", Right: "C-e", BSpace: "C-u", k: "C-l", K: "C-l" };

/** The key tmux should get for `key` under the latched modifiers, or null when command has nothing for it. */
export function resolve(key: string, mods: Record<Mod, boolean>): string | null {
  if (mods.cmd) return WITH_CMD[key] ?? null;
  // ^C carries its own modifier; a latched one would make C-C-c.
  if (key.includes("-") && key.length > 1) return key;
  let k = key;
  let shift = mods.shift;
  if (shift && k === "Tab") [k, shift] = ["BTab", false];
  if (shift && k.length === 1) [k, shift] = [k.toUpperCase(), false];
  return (mods.ctrl ? "C-" : "") + (mods.alt ? "M-" : "") + (shift ? "S-" : "") + k;
}

export const useMods = create<{ held: Record<Mod, boolean>; toggle: (mod: Mod) => void }>((set) => ({
  held: NONE,
  toggle: (mod) => set((s) => ({ held: { ...s.held, [mod]: !s.held[mod] } })),
}));

/** Whether the phone's keyboard is up; the terminal owns its field, the key row its button. */
export const useKeyboard = create<{ typing: boolean; toggle: () => void }>(() => ({ typing: false, toggle: () => {} }));

/** The key tmux should get for `key` under what is latched now, spending it. Null when command has nothing for the key. */
export function take(key: string): string | null {
  const { held } = useMods.getState();
  if (Object.values(held).some(Boolean)) useMods.setState({ held: NONE });
  return resolve(key, held);
}
