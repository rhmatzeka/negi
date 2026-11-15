// A key held down keeps pressing, slowly at first and then faster, as a hardware keyboard
// does. A tap is still one press, and a row scrolled sideways cancels the hold.

import type { MouseEvent, PointerEvent } from "react";

const WAIT_MS = 400;
const FIRST_MS = 110;
const FASTEST_MS = 35;

const timers = new WeakMap<EventTarget, number>();
const repeated = new WeakSet<EventTarget>();

export function repeats(fire: () => void) {
  const stop = (e: PointerEvent<HTMLElement>) => {
    clearTimeout(timers.get(e.currentTarget));
    timers.delete(e.currentTarget);
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      const key = e.currentTarget;
      stop(e);
      repeated.delete(key);
      let gap = FIRST_MS;
      const step = () => {
        repeated.add(key);
        fire();
        gap = Math.max(FASTEST_MS, gap * 0.85);
        timers.set(key, window.setTimeout(step, gap));
      };
      timers.set(key, window.setTimeout(step, WAIT_MS));
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    // A long press would otherwise open the phone's own menu.
    onContextMenu: (e: MouseEvent<HTMLElement>) => e.preventDefault(),
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (repeated.delete(e.currentTarget)) return;
      fire();
    },
  };
}
