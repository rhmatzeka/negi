// A pane's earlier output, above what its screen shows now.

import { useCallback, useEffect, useRef, useState } from "react";
import { onScreen, request, screenOf } from "@/connection/link";
import { useApp } from "@/lib/store";
import { plain } from "@/tmux/screen";

/** Lines from the first one that holds any text: a new shell's history is a few empty lines, which is none. */
function written(lines: string[]): string[] {
  const first = lines.findIndex((line) => plain(line).trim() !== "");
  return first < 0 ? [] : lines.slice(first);
}

/** Fetches a pane's earlier output as it opens, so scrolling up works; `quiet` while not asked for from the sheet. */
export function useEarlier(pane: string): { lines: string[] | null; quiet: boolean; answered: boolean; reload: () => void } {
  const lines = useApp((s) => (s.history?.pane === pane ? s.history.lines : null));
  const quiet = useApp((s) => s.history?.pane === pane && s.history.quiet === true);

  // Whether the first fetch has come back, with lines or without. Until then the pane is not
  // shown: its screen alone, and then its history arriving above it, is two jumps.
  const [answered, setAnswered] = useState(false);

  // Only the newest answer counts: a pane left, or a later fetch, makes an earlier one stale.
  const turn = useRef(0);
  const reload = useCallback(() => {
    const mine = ++turn.current;
    request({ t: "history", pane, lines: 1000 })
      .then((got) => {
        const answer = got as { lines?: string[]; alt?: boolean };
        // The answer also says whether a full-screen program has the pane, which is what
        // decides between scrolling here and turning the program's own wheel.
        const screen = screenOf(pane);
        if (screen && answer.alt !== undefined) screen.alt = answer.alt;
        const found = written(answer.lines ?? []);
        if (mine === turn.current) useApp.setState({ history: found.length ? { pane, lines: found, quiet: true } : null });
      })
      .catch(() => {})
      .finally(() => setAnswered(true));
  }, [pane]);

  // What scrolls off the screen becomes earlier output, so it is fetched again once the
  // pane has been still for a moment. Not while it prints: that would be a fetch per line.
  useEffect(() => {
    let timer = 0;
    const stop = onScreen(pane, () => {
      clearTimeout(timer);
      timer = window.setTimeout(reload, 1200);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [pane, reload]);

  useEffect(() => {
    reload();
    return () => {
      // The counter is meant to be read as it is now: bumping it is what cancels a fetch in flight.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      turn.current++;
      useApp.setState({ history: null });
    };
  }, [reload]);

  return { lines, quiet, answered, reload };
}
