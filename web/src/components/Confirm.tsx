// Two presses for anything that changes tmux: the first asks, the second does it.

import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** How long a control stays armed before it settles back. */
const ARMED_MS = 3000;

/** The state behind a two-press control. `press(run)` arms on the first call and runs on the second. */
export function useTwoTap() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  return {
    armed,
    disarm: () => setArmed(false),
    press: (run: () => unknown) => {
      if (!armed) return setArmed(true);
      setArmed(false);
      void run();
    },
  };
}

const TONES = {
  danger: { text: "text-destructive", wash: "bg-destructive/10", fill: "bg-destructive text-background" },
  primary: { text: "text-foreground", wash: "bg-mint-soft", fill: "bg-mint text-mint-ink" },
};

/** An armed control's question, with a filled copy that drains over the three armed seconds.
 * The control must be `relative overflow-hidden`. */
export function ArmedFill({ label, tone, className }: { label: string; tone: keyof typeof TONES; className?: string }) {
  return (
    <>
      <span className={cn("relative", TONES[tone].text, className)}>{label}</span>
      <span aria-hidden className={cn("confirm-fill pointer-events-none absolute inset-0 flex items-center px-[inherit]", TONES[tone].fill, className)}>
        {label}
      </span>
      <span aria-hidden className="confirm-shine pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 bg-linear-to-r from-transparent via-white/40 to-transparent" />
    </>
  );
}

interface ConfirmButtonProps extends Omit<ComponentProps<typeof Button>, "onClick" | "children"> {
  onConfirm: () => unknown;
  /** What the control says once armed, such as "Tap again to close". Short: it has to fit a phone, inside the control it replaces. */
  confirmLabel: string;
  /** danger for what cannot be undone, primary for a change that should not happen on a slip. */
  tone?: keyof typeof TONES;
  children: ReactNode;
}

/** A button that needs two presses. A round icon button opens into a pill that fits its question. */
export function ConfirmButton({ onConfirm, confirmLabel, tone = "primary", children, className, ...props }: ConfirmButtonProps) {
  const tap = useTwoTap();
  return (
    <Button
      {...props}
      aria-label={tap.armed ? confirmLabel : props["aria-label"]}
      onBlur={(e) => {
        props.onBlur?.(e);
        tap.disarm();
      }}
      // A wrapper such as a tooltip passes its own click handler; it still has to run.
      onClick={(e) => {
        (props as ComponentProps<typeof Button>).onClick?.(e);
        tap.press(onConfirm);
      }}
      className={cn("relative overflow-hidden", className, tap.armed && cn("!w-auto justify-center !px-5 text-sm whitespace-nowrap", TONES[tone].wash))}
    >
      {tap.armed ? <ArmedFill label={confirmLabel} tone={tone} className="justify-center" /> : children}
    </Button>
  );
}
