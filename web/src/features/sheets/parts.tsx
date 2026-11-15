// What every sheet is built from: its frame, its groups and its rows.

import { type Icon, XIcon } from "@phosphor-icons/react";
import { type ReactNode, use, useEffect, useState } from "react";
import { ArmedFill, useTwoTap } from "@/components/Confirm";
import { Tile } from "@/components/Tile";
import { Button } from "@/components/ui/button";
import { type Tone } from "@/tmux/programs";
import { cn } from "@/lib/utils";
import { close, Title } from "./shared";

export function Frame({ title, lead, children }: { title: string; lead: ReactNode; children: ReactNode }) {
  const Heading = use(Title);
  return (
    <div className="slim-scroll grid min-h-0 gap-3 overflow-y-auto overscroll-none pt-3">
      <div className="flex items-center gap-3 px-1 pb-1">
        {lead}
        <Heading className="min-w-0 flex-1 truncate text-xl leading-tight font-semibold">{title}</Heading>
        <Button variant="soft" size="icon" aria-label="Close sheet" onClick={close}>
          <XIcon weight="bold" size={20} />
        </Button>
      </div>
      {children}
    </div>
  );
}

interface Choice {
  icon: Icon;
  /** One word: the row has room for little more. */
  label: string;
  /** What it asks once pressed. */
  sure: string;
  onConfirm: () => void;
}

/** Two closing actions in one row; an armed one widens for its question, so nothing below moves. */
export function DangerPair({ choices }: { choices: [Choice, Choice] }) {
  const [armed, setArmed] = useState<number | null>(null);
  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <div className="flex gap-1 rounded-md bg-card p-1">
      {choices.map(({ icon: Glyph, label, sure, onConfirm }, i) => (
        <button
          key={label}
          type="button"
          aria-label={armed === i ? sure : `Close this ${label.toLowerCase()}`}
          onBlur={() => armed === i && setArmed(null)}
          onClick={() => {
            if (armed !== i) return setArmed(i);
            setArmed(null);
            onConfirm();
          }}
          className={cn(
            "relative flex h-ctl-lg min-w-ctl-lg items-center justify-center gap-2 overflow-hidden rounded-sm px-3 font-semibold whitespace-nowrap text-destructive transition-[flex-grow,background-color] duration-300 ease-out",
            armed === null ? "grow basis-0 hover:bg-soft-strong" : armed === i ? "grow-[1] basis-0 bg-destructive/10" : "grow-0 basis-auto opacity-60",
          )}
        >
          {armed === i ? (
            <ArmedFill label={sure} tone="danger" className="justify-center" />
          ) : (
            <>
              <Glyph weight="fill" size={20} className="shrink-0" />
              {armed === null && label}
            </>
          )}
        </button>
      ))}
    </div>
  );
}

export function Group({ children }: { children: ReactNode }) {
  return <div className="grid gap-0.5 rounded-md bg-card p-1">{children}</div>;
}

interface RowProps {
  icon: Icon;
  tone: Tone;
  label: string;
  sub?: ReactNode;
  /** Something to do with the row, at its far end. */
  end?: ReactNode;
  onClick?: () => void;
  /** Set for a row that changes tmux: what it asks once pressed, before it acts. */
  confirm?: string;
}

/** One line of a sheet: a tile, what it does, and a second line saying how. */
export function Row({ icon, tone, label, sub, end, onClick, confirm }: RowProps) {
  const tap = useTwoTap();
  const base = "flex min-h-ctl-lg w-full items-center gap-3 rounded-sm p-2 text-left font-semibold";
  if (!onClick) {
    return (
      <div className={base}>
        <Tile icon={icon} tone={tone} seed={label} size="sm" />
        <span className="min-w-0 flex-1">
          {label}
          {sub && <small className="block text-xs font-medium text-muted-foreground">{sub}</small>}
        </span>
        {end}
      </div>
    );
  }
  const danger = tone === "danger";
  return (
    <button
      type="button"
      onBlur={tap.disarm}
      onClick={() => (confirm ? tap.press(onClick) : onClick())}
      className={cn(
        base,
        "relative overflow-hidden transition-transform duration-500 ease-spring active:scale-[0.97] active:duration-75",
        danger && "text-destructive",
        tap.armed ? (danger ? "bg-destructive/10" : "bg-mint-soft") : "hover:bg-soft-strong",
      )}
    >
      {tap.armed && confirm ? (
        <ArmedFill label={confirm} tone={danger ? "danger" : "primary"} className="pl-4" />
      ) : (
        <>
          <Tile icon={icon} tone={tone} seed={label} size="sm" />
          <span className="min-w-0 flex-1">
            {label}
            {sub && <small className="block text-xs font-medium text-muted-foreground">{sub}</small>}
          </span>
        </>
      )}
    </button>
  );
}

/** A row for something that cannot be undone. */
export function DangerRow({ icon, label, sure, onConfirm }: { icon: Icon; label: string; sure: string; onConfirm: () => void }) {
  return <Row icon={icon} tone="danger" label={label} confirm={sure} onClick={onConfirm} />;
}

