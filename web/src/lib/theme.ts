// Light, dark, or whatever the system says. Switching spreads the new theme out from the
// control that was pressed.

import { useSyncExternalStore } from "react";
import { useApp } from "./store";

export type Theme = "system" | "light" | "dark";

const system = matchMedia("(prefers-color-scheme: dark)");

export function resolve(theme: Theme): "light" | "dark" {
  return theme === "system" ? (system.matches ? "dark" : "light") : theme;
}

/** Puts a resolved theme on the page. */
function apply(resolved: "light" | "dark") {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  // The browser's own chrome (the status bar on a phone) follows the page.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#1b1d20" : "#fcfdfd");
}

/** Call once, before the first paint. Keeps following the system while set to "system". */
export function initTheme() {
  apply(resolve(useApp.getState().theme));
  document.documentElement.dataset.accent = useApp.getState().accent;
  system.addEventListener("change", () => {
    if (useApp.getState().theme === "system") apply(resolve("system"));
  });
}

/** Runs `commit` and reveals the new look as a circle growing from `at`; otherwise at once. */
function reveal(commit: () => void, at?: { x: number; y: number }) {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!at || still || !document.startViewTransition) return commit();
  const root = document.documentElement;
  // Far enough to cover the corner furthest from the press.
  const radius = Math.hypot(Math.max(at.x, innerWidth - at.x), Math.max(at.y, innerHeight - at.y));
  root.classList.add("theme-switching");
  const transition = document.startViewTransition(commit);
  void transition.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${at.x}px ${at.y}px)`, `circle(${radius}px at ${at.x}px ${at.y}px)`] },
      { duration: 760, easing: "cubic-bezier(0.65, 0, 0.35, 1)", pseudoElement: "::view-transition-new(root)" },
    );
  });
  void transition.finished.finally(() => root.classList.remove("theme-switching"));
}

/** Changes between light, dark and the system's. */
export function switchTheme(next: Theme, at?: { x: number; y: number }) {
  const changes = resolve(useApp.getState().theme) !== resolve(next);
  reveal(
    () => {
      useApp.getState().setTheme(next);
      apply(resolve(next));
    },
    changes ? at : undefined,
  );
}

type Accent = ReturnType<typeof useApp.getState>["accent"];

/** Changes the colour set. */
export function switchAccent(next: Accent, at?: { x: number; y: number }) {
  reveal(
    () => {
      useApp.getState().setAccent(next);
      document.documentElement.dataset.accent = next;
    },
    useApp.getState().accent === next ? undefined : at,
  );
}

/** The theme actually showing, kept current when the system changes. */
export function useResolvedTheme(): "light" | "dark" {
  const theme = useApp((s) => s.theme);
  const dark = useSyncExternalStore(
    (notify) => {
      system.addEventListener("change", notify);
      return () => system.removeEventListener("change", notify);
    },
    () => system.matches,
  );
  return theme === "system" ? (dark ? "dark" : "light") : theme;
}
