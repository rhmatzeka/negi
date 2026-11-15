import { WarningCircleIcon } from "@phosphor-icons/react";
import type { AnyFieldApi } from "@tanstack/react-form";
import { type ComponentProps, type ReactNode, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { calm, gsap } from "@/lib/anim";
import { edit } from "@/lib/form";
import { cn } from "@/lib/utils";

/** One input, its error in a bubble hung over what is below so nothing moves; the bubble
 * shows for a few seconds, then only on focus or hover, with a mark left in the input. */
export function ErrorBubble({ message, className, children }: { message?: string | null; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!message || calm()) return;
    gsap.fromTo(box.current, { x: 0 }, { keyframes: { x: [-6, 6, -4, 4, -2, 0] }, duration: 0.42, ease: "power1.out" });
  }, [message]);
  return (
    // Raised while it has something to say, or the next field, drawn later, would cover the bubble.
    <div ref={box} className={cn("group/err relative min-w-0", message && "z-20", className)}>
      {children}
      {message && (
        <>
          <WarningCircleIcon aria-hidden weight="fill" size={20} className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-destructive transition-opacity group-focus-within/err:opacity-0" />
          {/* Keyed by its text, so a different error is announced and shown afresh. */}
          <div key={message} role="alert" className="error-bubble pointer-events-none absolute top-full left-4 z-40 mt-2.5 max-w-[calc(100%-2rem)]">
            <span aria-hidden className="absolute -top-1 left-5 size-3 rotate-45 rounded-[3px] bg-destructive" />
            <span className="relative block rounded-md bg-destructive px-3.5 py-2 text-sm leading-snug font-semibold text-background shadow-[0_10px_28px_rgb(0_0_0/0.25)]">{message}</span>
          </div>
        </>
      )}
    </div>
  );
}

interface TextFieldProps extends Omit<ComponentProps<typeof Input>, "value" | "onChange" | "onBlur"> {
  field: AnyFieldApi;
  label: string;
  hint?: string;
  /** Something wrong that the form's own checks could not know, such as the server's answer. */
  problem?: string | null;
  /** Called as the field is edited, so whoever holds `problem` can drop it. */
  onEdit?: () => void;
  /** Shapes what is typed before the field takes it, such as putting a dash into a code. */
  format?: (typed: string) => string;
}

/** A labelled input bound to a TanStack Form field, with its first error in a bubble. */
export function TextField({ field, label, hint, problem, onEdit, format, ...input }: TextFieldProps) {
  const error = field.state.meta.errors[0] as { message?: string } | string | undefined;
  const message = (typeof error === "string" ? error : error?.message) ?? problem;
  return (
    <div className="grid min-w-0 flex-1 gap-1.5">
      <Label htmlFor={field.name} className="pl-1 font-semibold">
        {label}
      </Label>
      <ErrorBubble message={message}>
        <Input
          id={field.name}
          name={field.name}
          value={field.state.value}
          onChange={(e) => {
            edit(field, format ? format(e.target.value) : e.target.value);
            onEdit?.();
          }}
          onBlur={field.handleBlur}
          aria-invalid={message ? true : undefined}
          {...input}
        />
      </ErrorBubble>
      {hint && <p className="pl-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
