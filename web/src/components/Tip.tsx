import type { ComponentProps, ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface TipProps {
  /** What the control is. */
  label: string;
  /** What pressing it does, when the name alone does not say. */
  hint?: string;
  /** A key that does the same, shown as a keycap. */
  keycap?: string;
  side?: ComponentProps<typeof TooltipContent>["side"];
  children: ReactElement;
}

/** Names a control that shows only an icon. Appears on hover and keyboard focus; a touch never opens it. */
export function Tip({ label, hint, keycap, side = "top", children }: TipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={8} collisionPadding={10} className="tip gap-3 rounded-md px-3.5 py-2.5 shadow-[0_10px_30px_rgb(0_0_0/0.22)]">
        <span className="grid gap-0.5 text-left">
          <span className="text-sm leading-tight font-semibold">{label}</span>
          {hint && <span className="text-xs leading-snug font-medium opacity-65">{hint}</span>}
        </span>
        {keycap && <kbd className="grid h-7 min-w-7 place-items-center rounded-sm bg-background/15 px-1.5 font-mono text-xs font-bold">{keycap}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}
