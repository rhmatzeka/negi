import { ArrowsClockwiseIcon, CircleNotchIcon, GlobeIcon, LaptopIcon, LinkSimpleIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { createElement, type ReactNode, useState } from "react";
import { Tile } from "@/components/Tile";
import { Tip } from "@/components/Tip";
import { Button } from "@/components/ui/button";
import { Frame, Group, Row } from "@/features/sheets/parts";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { batteryIcon, batteryWords, signal, testInternet, testLink, useMacStatus } from "./status";

/** The small status in the list's header: battery and Wi-Fi, as a phone's own top bar shows them. */
export function MacPill() {
  const { data } = useMacStatus();
  const openSheet = useApp((s) => s.openSheet);
  const os = useApp((s) => s.os);
  // While the Mac is not answering, what it last said is stale; the header shows that instead.
  const lost = useApp((s) => s.phase === "lost");
  if (lost || !data || (!data.battery && !data.wifi)) return null;
  const name = os === "macos" ? "Your Mac" : "Your computer";
  return (
    <Tip label={name} hint="Battery, Wi-Fi and speed" side="bottom">
      <button
        type="button"
        aria-label={`${name}: ${data.battery?.percent != null ? `battery ${data.battery.percent}%` : ""} ${data.wifi ? `Wi-Fi ${signal(data.wifi).word.toLowerCase()}` : ""}`}
        onClick={() => openSheet({ kind: "mac" })}
        className="inline-flex h-ctl items-center gap-1.5 rounded-full bg-soft px-3 text-sm font-semibold tabular-nums transition-colors hover:bg-soft-strong"
      >
        {data.battery && createElement(batteryIcon(data.battery), { weight: "fill", size: 18, className: cn(data.battery.charging && "text-mint") })}
        {data.battery?.percent != null && <span>{data.battery.percent}%</span>}
        {data.wifi && createElement(signal(data.wifi).icon, { weight: "bold", size: 18 })}
      </button>
    </Tip>
  );
}

export function MacSheet() {
  const { data, isPending, error } = useMacStatus();
  const os = useApp((s) => s.os);
  const mac = os === "macos";
  const [step, setStep] = useState("");
  const link = useMutation({ mutationFn: () => testLink(setStep), onSettled: () => setStep("") });
  const internet = useMutation({ mutationFn: testInternet });
  const wifi = data?.wifi;
  const battery = data?.battery;
  return (
    <Frame title={mac ? "Your Mac" : "Your computer"} lead={<Tile icon={LaptopIcon} tone="accent" seed="mac" size="sm" />}>
      {isPending && <p className="px-2 text-sm text-muted-foreground">Reading…</p>}
      {error && <p className="px-2 text-sm text-destructive">{error.message}</p>}
      {data && (
        <Group>
          {battery && <Row icon={batteryIcon(battery)} tone="quiet" label={battery.percent != null ? `Battery ${battery.percent}%` : "Battery"} sub={batteryWords(battery)} />}
          {wifi && (
            <Row
              icon={signal(wifi).icon}
              tone="quiet"
              label={wifi.connected ? `Wi-Fi · ${signal(wifi).word}` : "Wi-Fi off or not connected"}
              sub={wifi.connected ? [wifi.rssi != null && `${wifi.rssi} dBm`, wifi.rateMbps && `${wifi.rateMbps} Mbps link`, wifi.standard, wifi.band && `${wifi.band}${wifi.channel ? ` ch ${wifi.channel}` : ""}`].filter(Boolean).join(" · ") : undefined}
            />
          )}
        </Group>
      )}

      <Test
        icon={LinkSimpleIcon}
        title={mac ? "This phone ↔ Mac" : "This phone ↔ computer"}
        note="The path the screen and terminal use"
        running={link.isPending}
        step={step}
        onRun={() => link.mutate()}
        error={link.error?.message}
        stats={link.data && [
          ["Latency", `${link.data.pingMs}`, "ms"],
          ["Down", `${link.data.downMbps}`, "Mbps"],
          ["Up", `${link.data.upMbps}`, "Mbps"],
        ]}
      />
      <Test
        icon={GlobeIcon}
        title={mac ? "Mac's internet" : "Computer's internet"}
        note="Measured on it by macOS, about 20 s"
        running={internet.isPending}
        step="Measuring"
        onRun={() => internet.mutate()}
        error={internet.error?.message}
        stats={internet.data && [
          ["Down", `${internet.data.downMbps ?? "-"}`, "Mbps"],
          ["Up", `${internet.data.upMbps ?? "-"}`, "Mbps"],
          ["Ping", `${internet.data.rttMs ?? "-"}`, "ms"],
        ]}
      />
    </Frame>
  );
}

interface TestProps {
  icon: typeof GlobeIcon;
  title: string;
  note: string;
  running: boolean;
  step: string;
  onRun: () => void;
  error?: string;
  stats?: [label: string, value: string, unit: string][];
}

function Test({ icon: Glyph, title, note, running, step, onRun, error, stats }: TestProps) {
  return (
    <section className="grid gap-2 rounded-md bg-card p-3">
      <div className="flex items-center gap-3">
        <Glyph weight="bold" size={20} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 font-semibold">
          {title}
          <small className="block text-xs font-medium text-muted-foreground">{note}</small>
        </span>
        <Button variant="soft" size="md" disabled={running} onClick={onRun} className="min-w-28">
          {running ? <CircleNotchIcon weight="bold" size={16} className="animate-spin" /> : <ArrowsClockwiseIcon weight="bold" size={16} />}
          {running ? step || "Testing" : stats ? "Again" : "Test"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {stats && (
        <div className="grid grid-cols-3 gap-2">
          {stats.map(([label, value, unit]) => (
            <Stat key={label} label={label}>
              {value}
              <small className="ml-0.5 text-xs font-semibold text-muted-foreground">{unit}</small>
            </Stat>
          ))}
        </div>
      )}
    </section>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid rounded-sm bg-soft px-3 py-2">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className="text-lg font-bold tabular-nums">{children}</span>
    </div>
  );
}
