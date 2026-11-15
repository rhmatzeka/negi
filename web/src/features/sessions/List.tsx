// The home column: what is running, two actions, then one row per session.

import { BrowsersIcon, DeviceMobileIcon, DotsThreeIcon, GearSixIcon, MonitorIcon, MoonIcon, PlusIcon, PulseIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Mark } from "@/components/Mark";
import { Peek } from "@/features/sessions/Peek";
import { Tip } from "@/components/Tip";
import { Button } from "@/components/ui/button";
import { calm, Flip, gsap, useGSAP } from "@/lib/anim";
import { onScreen, screenOf } from "@/connection/link";
import { programIcon } from "@/tmux/programs";
import { useApp } from "@/lib/store";
import { plain } from "@/tmux/screen";
import { isShell, type Pane, paneParam, previewPane, type Session, sessionBusy, shortPath } from "@/tmux/tree";
import { cn } from "@/lib/utils";
import { LinkState } from "@/connection/LinkState";
import { MacPill } from "@/features/mac/MacSheet";
import { ThemeToggle } from "@/components/Toggles";

/** The card: how many sessions, counted up to, and how many panes are working. */
function Summary() {
  const count = useApp((s) => s.sessions.length);
  const windows = useApp((s) => s.sessions.reduce((n, x) => n + x.windows.length, 0));
  // Panes, not sessions: two agents working in one session are two at work.
  const printing = useApp((s) => s.sessions.reduce((n, x) => n + x.windows.reduce((m, w) => m + w.panes.filter((p) => s.busy.includes(p.id)).length, 0), 0));
  const number = useRef<HTMLParagraphElement>(null);
  const shown = useRef(0);

  useGSAP(
    () => {
      const el = number.current;
      if (!el) return;
      if (calm()) {
        el.textContent = String(count);
        return;
      }
      const from = { value: shown.current };
      gsap.to(from, { value: count, duration: 0.8, ease: "power3.out", onUpdate: () => (el.textContent = String(Math.round(from.value))) });
      shown.current = count;
    },
    { dependencies: [count] },
  );

  return (
    <section aria-label="Summary" className="in relative isolate min-h-[212px] overflow-hidden rounded-xl bg-hero px-6 pt-7 pb-6 text-hero-ink">
      {/* Two flat discs behind everything, so the card is not one empty colour. */}
      <span aria-hidden className="absolute -top-20 -right-12 -z-10 size-60 rounded-full bg-hero-ink/[0.07]" />
      <span aria-hidden className="absolute top-14 -right-28 -z-10 size-72 rounded-full bg-hero-ink/[0.05]" />
      <p ref={number} className="text-[68px] leading-[0.95] font-semibold tabular-nums">
        {count}
      </p>
      <p className="mt-1 text-[15px] font-medium">{count === 1 ? "session running" : "sessions running"}</p>
      <div className="mt-5 flex max-w-[58%] flex-col items-start gap-2">
        <span className="inline-flex h-ctl-sm items-center gap-1.5 rounded-full bg-(--hero-pill) pr-4 pl-3 text-sm font-semibold">
          <BrowsersIcon weight="fill" size={16} />
          {windows} {windows === 1 ? "window" : "windows"}
        </span>
        <span className="inline-flex h-ctl-sm items-center gap-1.5 rounded-full bg-(--hero-pill) pr-4 pl-3 text-sm font-semibold">
          {printing ? <PulseIcon weight="fill" size={16} /> : <MoonIcon weight="fill" size={16} />}
          {printing ? `${printing} working` : "all quiet"}
        </span>
      </div>
      {/* Her drawing rounds off at the bottom; sunk a little, the card's edge cuts her hands as a ledge would. */}
      <Peek className="absolute -right-5 bottom-0 w-[50%] max-w-[210px] translate-y-[6%]" />
    </section>
  );
}

/** The last line a pane printed, kept current. */
function LastLine({ pane }: { pane: Pane }) {
  const el = useRef<HTMLSpanElement>(null);
  const shell = isShell(pane.command);
  // A shell's last line is its prompt or its last output. A full-screen program's last
  // line is its status bar, which says nothing about the session, so that shows the folder.
  useEffect(() => {
    if (!shell) return;
    const paint = () => {
      const said = plain(screenOf(pane.id)?.tail(1)[0] ?? "").trim();
      // A bare prompt, a sign and nothing typed, says less than the folder it stands in.
      if (el.current) el.current.textContent = /[\p{L}\p{N}]/u.test(said) ? said : shortPath(pane.path) || " ";
    };
    paint();
    return onScreen(pane.id, paint);
  }, [pane.id, pane.path, shell]);
  if (!shell) return <span className="block truncate font-mono text-xs text-muted-foreground">{shortPath(pane.path)}</span>;
  return <span ref={el} className="block truncate font-mono text-xs text-muted-foreground" />;
}

function SessionRow({ session, open }: { session: Session; open: boolean }) {
  const navigate = useNavigate();
  const busy = useApp((s) => sessionBusy(session, s.busy));
  const openSheet = useApp((s) => s.openSheet);
  const last = useApp((s) => s.last);
  const pane = previewPane(session, last);
  const Glyph = programIcon(pane?.command);
  const windows = session.windows.length;
  return (
    <div data-session={session.id} className={cn("in flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors", open ? "bg-mint-soft" : "hover:bg-card")}>
      <button
        type="button"
        aria-label={`Open ${session.name}`}
        data-working={busy || undefined}
        aria-current={open ? "true" : undefined}
        disabled={!pane}
        onClick={() => pane && navigate({ to: "/pane/$pane", params: { pane: paneParam(pane.id) }, viewTransition: true })}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 text-left"
      >
        <span aria-hidden className={cn("grid size-ctl shrink-0 place-items-center rounded-full transition-colors", open ? "bg-mint text-mint-ink" : "bg-soft text-foreground", busy && "working-edge")}>
          <Glyph weight="fill" size={22} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate font-semibold">{session.name}</span>
          </span>
          {pane && <LastLine pane={pane} />}
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-sm font-semibold">{pane?.command}</span>
          <span className="block text-xs text-muted-foreground">
            {windows} {windows === 1 ? "window" : "windows"}
          </span>
        </span>
      </button>
      <Tip label={`Manage ${session.name}`} hint="Rename, add a window, close" side="left">
        <Button variant="ghost" size="icon" aria-label={`Manage ${session.name}`} onClick={() => openSheet({ kind: "session", session: session.id })}>
          <DotsThreeIcon weight="bold" size={22} />
        </Button>
      </Tip>
    </div>
  );
}

export function List({ open }: { open: string | null }) {
  const navigate = useNavigate();
  const root = useRef<HTMLDivElement>(null);
  const sessions = useApp((s) => s.sessions);
  const openSheet = useApp((s) => s.openSheet);
  const rows = useRef<HTMLDivElement>(null);
  const before = useRef<Flip.FlipState | null>(null);
  const ids = sessions.map((s) => s.id).join(",");

  // The column arrives once, top to bottom.
  useGSAP(
    () => {
      if (calm()) return;
      gsap.from(".in", { y: 8, opacity: 0, filter: "blur(10px)", duration: 0.6, ease: "expo.out", stagger: 0.05, clearProps: "filter" });
    },
    { scope: root },
  );

  // When a session appears or goes, the others glide to their new places. Their old
  // places are read the moment the store changes, before React has moved anything.
  useEffect(
    () =>
      useApp.subscribe((next, prev) => {
        const changed = next.sessions.map((s) => s.id).join(",") !== prev.sessions.map((s) => s.id).join(",");
        if (changed && rows.current && !calm()) before.current = Flip.getState(rows.current.querySelectorAll("[data-session]"));
      }),
    [],
  );
  useLayoutEffect(() => {
    if (!before.current) return;
    Flip.from(before.current, { duration: 0.5, ease: "power3.out", targets: rows.current?.querySelectorAll("[data-session]") });
    before.current = null;
  }, [ids]);

  return (
    // The mark, the card and the two buttons stay where they are; only the sessions scroll under them.
    <div ref={root} className="flex h-full min-w-0 flex-col overflow-hidden px-4 pt-[max(12px,var(--safe-top))] *:shrink-0">
      <header className="in flex items-center gap-2 pb-4">
        <Mark />
        <span className="flex-1" />
        <LinkState />
        <MacPill />
        <Tip label="Screen" hint="See and control the computer itself" side="bottom">
          <Button variant="soft" size="icon" aria-label="The computer's screen" onClick={() => navigate({ to: "/screen" })}>
            <MonitorIcon weight="bold" size={20} />
          </Button>
        </Tip>
        <ThemeToggle />
        <Tip label="This device" hint="Theme, colour, pairing" side="bottom">
          <Button variant="soft" size="icon" aria-label="This device" onClick={() => openSheet({ kind: "device" })}>
            <GearSixIcon weight="bold" size={20} />
          </Button>
        </Tip>
      </header>
      <Summary />
      <div className="in grid grid-cols-2 gap-2 py-4">
        <Button variant="soft" size="md" onClick={() => openSheet({ kind: "new-session" })}>
          <PlusIcon weight="bold" size={18} />
          New session
        </Button>
        <Button variant="soft" size="md" onClick={() => openSheet({ kind: "device" })}>
          <DeviceMobileIcon weight="bold" size={18} />
          This device
        </Button>
      </div>
      <h1 className="sr-only">Sessions</h1>
      <div ref={rows} className="slim-scroll -mx-2 flex min-h-0 !shrink flex-1 flex-col gap-1 overflow-y-auto overscroll-none px-2 pb-[calc(24px+env(safe-area-inset-bottom))] *:shrink-0">
        {sessions.map((session) => (
          <SessionRow key={session.id} session={session} open={session.windows.some((w) => w.panes.some((p) => p.id === open))} />
        ))}
      </div>
    </div>
  );
}
