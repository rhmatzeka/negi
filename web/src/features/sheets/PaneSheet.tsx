import { ArrowsHorizontalIcon, ClockCounterClockwiseIcon, DesktopIcon, DeviceMobileIcon, MinusIcon, PlusIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { Tip } from "@/components/Tip";
import { Tile } from "@/components/Tile";
import { useAsk } from "@/connection/api";
import { programIcon } from "@/tmux/programs";
import { useApp } from "@/lib/store";
import { useShallow } from "zustand/react/shallow";
import { findPane } from "@/tmux/tree";
import { cn } from "@/lib/utils";
import { DangerPair, Frame, Group, Row } from "./parts";
import { close } from "./shared";
import { RenameForm } from "./RenameForm";

/** The two ways to show a pane, and what each costs, said in the sheet under the choice. */
const VIEWS = [
  { value: "screen", label: "As is", icon: DesktopIcon, says: (host: string) => `As on ${host}. A wide pane is small or scrolls sideways.` },
  { value: "fit", label: "Fit", icon: DeviceMobileIcon, says: (host: string) => `Resized to this screen, on ${host} too, until you leave.` },
] as const;

export function PaneSheet({ id }: { id: string }) {
  const where = useApp(useShallow((s) => findPane(s.sessions, id)));
  const zoom = useApp((s) => s.zoom);
  const setZoom = useApp((s) => s.setZoom);
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const host = useApp((s) => (s.os === "macos" ? "your Mac" : "your computer"));
  const ask = useAsk();
  if (!where) return null;
  const { window, pane } = where;
  const seg = "inline-flex h-ctl items-center justify-center gap-1.5 rounded-full text-sm font-semibold transition-colors hover:bg-soft-strong active:bg-soft-strong disabled:opacity-40";
  return (
    <Frame title={window.name} lead={<Tile icon={programIcon(pane.command)} seed={where.session.name} size="sm" />}>
      <RenameForm label="Window name" value={window.name} onSave={(name) => ask.mutateAsync({ t: "rename-window", window: window.id, name }).then(close, () => {})} />
      <Group>
        <Row
          icon={ClockCounterClockwiseIcon}
          tone="quiet"
          label="Load history"
          sub="Shows earlier output above the screen"
          onClick={() =>
            ask.mutate(
              { t: "history", pane: id, lines: 2000 },
              { onSuccess: (got) => (useApp.setState({ history: { pane: id, lines: got.lines ?? [] } }), close()) },
            )
          }
        />
      </Group>
      <p className="px-2 pt-1 text-xs font-bold text-muted-foreground">View</p>
      <div role="group" aria-label="View" className="grid grid-cols-2 gap-0.5 rounded-full bg-soft p-1">
        {VIEWS.map(({ value, label, icon: Glyph }) => (
          <button
            key={value}
            type="button"
            aria-pressed={view === value}
            onClick={() => setView(value)}
            className="inline-flex h-ctl items-center justify-center gap-1.5 rounded-full text-sm font-semibold transition-colors hover:bg-soft-strong aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            <Glyph weight="fill" size={18} />
            {label}
          </button>
        ))}
      </div>
      {/* Two lines kept whatever it says, so choosing a view moves nothing below. */}
      <p className="min-h-[2.6em] px-2 text-xs leading-[1.3] text-muted-foreground">{view === "screen" && !where.session.attached
          ? `No terminal on ${host} shows this session, so it fills this screen.`
          : VIEWS.find((v) => v.value === view)?.says(host)}</p>
      <p className="px-2 pt-1 text-xs font-bold text-muted-foreground">Text size</p>
      <div role="group" aria-label="Text size" className="grid grid-cols-3 gap-0.5 rounded-full bg-soft p-1">
        <Tip label="Smaller text" hint="10% less, down to 50%">
          <button type="button" aria-label="Smaller" disabled={zoom <= 0.5} className={seg} onClick={() => setZoom(zoom - 0.1)}>
            <MinusIcon weight="bold" size={18} />
          </button>
        </Tip>
        {/* The size now, as a share of the size that fits the pane. Pressing it goes back to 100%. */}
        <Tip label="Fit the width" hint="100% fills the pane's columns exactly">
          <button type="button" aria-label={`Text size ${Math.round(zoom * 100)}%. Press to fit the width.`} className={cn(seg, "tabular-nums")} onClick={() => setZoom(1)}>
            {zoom === 1 && <ArrowsHorizontalIcon weight="bold" size={18} />}
            {Math.round(zoom * 100)}%
          </button>
        </Tip>
        <Tip label="Larger text" hint="10% more, up to 300%">
          <button type="button" aria-label="Larger" disabled={zoom >= 3} className={seg} onClick={() => setZoom(zoom + 0.1)}>
            <PlusIcon weight="bold" size={18} />
          </button>
        </Tip>
      </div>
      <p className="px-2 pt-1 text-xs font-bold text-muted-foreground">Close</p>
      <DangerPair
        choices={[
          { icon: XIcon, label: "Pane", sure: "Tap again: close pane", onConfirm: () => ask.mutate({ t: "kill-pane", pane: id }, { onSuccess: close }) },
          { icon: TrashIcon, label: "Window", sure: "Tap again: close window", onConfirm: () => ask.mutate({ t: "kill-window", window: window.id }, { onSuccess: close }) },
        ]}
      />
    </Frame>
  );
}
