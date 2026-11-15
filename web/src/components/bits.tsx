// Small pieces used in more than one place.

import { CircleNotchIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import working from "@/assets/art/working.avif";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Window } from "@/tmux/tree";

/** Says a pane has been putting out text for a few seconds running, as an agent or a build does. */
export function BusyMark() {
  const motion = useApp((s) => s.motion);
  return (
    <span
      role="status"
      aria-label="Working"
      title="Working: something here is putting out text"
      style={{ "--s": "38px", backgroundImage: `url(${working})` } as React.CSSProperties}
      className={cn("working-mark shrink-0", motion && "working-mark-plays")}
    />
  );
}

interface WindowChipProps {
  window: Window;
  current: boolean;
  onClick: () => void;
  /** It was pressed and its screen is on the way. */
  loading?: boolean;
  /** Something in the window is working. */
  busy?: boolean;
  /** What a long press, or a right click, opens: the window's own actions. */
  onMenu?: () => void;
  className?: string;
}

export function WindowChip({ window, current, loading, busy, onClick, onMenu, className }: WindowChipProps) {
  const el = useRef<HTMLButtonElement>(null);
  // A press held this long is a request for the menu, not a tap. A phone has no right click.
  const hold = useRef(0);
  const held = useRef(false);
  const from = useRef({ x: 0, y: 0 });
  const letGo = () => clearTimeout(hold.current);
  // The chips move only under a finger, except as the session opens with its chip out of sight;
  // a press never moves the row, or the next chip would slide from under the finger.
  useEffect(() => {
    const chip = el.current;
    const row = chip?.parentElement;
    if (!current || !chip || !row) return;
    const [c, r] = [chip.getBoundingClientRect(), row.getBoundingClientRect()];
    if (c.left < r.left || c.right > r.right) chip.scrollIntoView({ behavior: "auto", inline: "nearest", block: "nearest" });
    // Once, as the chip first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <button
      ref={el}
      type="button"
      aria-current={current ? "true" : undefined}
      title={busy ? `${window.name}: working` : undefined}
      aria-haspopup={onMenu ? "dialog" : undefined}
      onPointerDown={(e) => {
        if (!onMenu || e.button !== 0) return;
        held.current = false;
        from.current = { x: e.clientX, y: e.clientY };
        hold.current = globalThis.setTimeout(() => {
          held.current = true;
          onMenu();
        }, 480);
      }}
      // Dragging the row to scroll it is not holding a chip.
      onPointerMove={(e) => Math.hypot(e.clientX - from.current.x, e.clientY - from.current.y) > 8 && letGo()}
      onPointerUp={letGo}
      onPointerLeave={letGo}
      onPointerCancel={letGo}
      onContextMenu={(e) => {
        if (!onMenu) return;
        e.preventDefault();
        letGo();
        if (!held.current) onMenu();
      }}
      onClick={() => {
        // The release that ends a long press is not a tap.
        if (held.current) held.current = false;
        else onClick();
      }}
      className={cn(
        "inline-flex h-ctl-sm max-w-[220px] shrink-0 items-center gap-1.5 rounded-full bg-soft pr-3 pl-2 text-sm font-semibold transition-[transform,background-color] duration-500 ease-spring hover:bg-soft-strong active:scale-95 active:duration-75 pointer-coarse:h-ctl pointer-coarse:pr-4",
        "group scroll-mx-3 select-none [-webkit-touch-callout:none] aria-[current=true]:bg-mint-soft",
        // So an agent at work in another window is seen from here, without opening each one.
        busy && "working-edge",
        className,
      )}
    >
      <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-soft-strong font-mono text-xs font-bold group-aria-[current=true]:bg-mint group-aria-[current=true]:text-mint-ink">
        {loading ? <CircleNotchIcon weight="bold" size={12} className="animate-spin" /> : window.index}
      </span>
      <span className="truncate">{window.name}</span>
    </button>
  );
}
