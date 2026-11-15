// The computer's battery and Wi-Fi, and the two speed tests, as the server reports them.

import { BatteryChargingIcon, BatteryEmptyIcon, BatteryFullIcon, BatteryHighIcon, BatteryLowIcon, BatteryMediumIcon, type Icon, WifiHighIcon, WifiLowIcon, WifiMediumIcon, WifiSlashIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useApp } from "@/lib/store";

export interface Battery {
  percent: number | null;
  charging: boolean;
  full: boolean;
  onPower: boolean;
  minutesLeft: number | null;
}

interface Wifi {
  connected: boolean;
  rssi?: number;
  noise?: number;
  rateMbps?: number;
  channel?: string;
  band?: string;
  standard?: string;
}

interface MacStatus {
  battery: Battery | null;
  wifi: Wifi | null;
}

const authorised = () => ({ Authorization: `Bearer ${useApp.getState().token}` });

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...authorised(), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `The Mac answered ${response.status}`);
  return body as T;
}

/** Battery and Wi-Fi, read again every half minute while something shows them. */
export function useMacStatus() {
  return useQuery({ queryKey: ["mac"], queryFn: () => get<MacStatus>("/api/mac"), refetchInterval: 30_000, staleTime: 10_000 });
}

export function batteryIcon(b: Battery): Icon {
  if (b.charging) return BatteryChargingIcon;
  const p = b.percent ?? 0;
  return p >= 90 ? BatteryFullIcon : p >= 60 ? BatteryHighIcon : p >= 30 ? BatteryMediumIcon : p >= 10 ? BatteryLowIcon : BatteryEmptyIcon;
}

/** Signal in words, from its strength: above -55 dBm is strong, below -75 weak. */
export function signal(w: Wifi): { icon: Icon; word: string } {
  if (!w.connected || w.rssi == null) return { icon: WifiSlashIcon, word: "Not connected" };
  if (w.rssi >= -55) return { icon: WifiHighIcon, word: "Strong" };
  if (w.rssi >= -67) return { icon: WifiMediumIcon, word: "Good" };
  if (w.rssi >= -75) return { icon: WifiLowIcon, word: "Fair" };
  return { icon: WifiLowIcon, word: "Weak" };
}

export function batteryWords(b: Battery): string {
  if (b.charging) return "Charging";
  if (b.full && b.onPower) return "Full, on power";
  if (b.onPower) return "On power";
  if (b.minutesLeft) return `${Math.floor(b.minutesLeft / 60)} h ${b.minutesLeft % 60} min left`;
  return "On battery";
}

interface LinkResult {
  pingMs: number;
  downMbps: number;
  upMbps: number;
}

const mbps = (bytes: number, ms: number) => Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 10) / 10;

/** The phone's link to the computer, the path the screen and terminal use: median of five
 * round trips, then a timed download and upload. */
export async function testLink(step: (what: string) => void): Promise<LinkResult> {
  step("Latency");
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await fetch("/api/health", { cache: "no-store" });
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);

  step("Download");
  const downBytes = 8 * 1024 * 1024;
  let t = performance.now();
  const got = await (await fetch(`/api/speed/down?bytes=${downBytes}`, { headers: authorised(), cache: "no-store" })).arrayBuffer();
  const downMs = performance.now() - t;

  step("Upload");
  const upload = new Uint8Array(4 * 1024 * 1024);
  // getRandomValues fills at most 64 KiB a call.
  for (let i = 0; i < upload.length; i += 65536) crypto.getRandomValues(upload.subarray(i, i + 65536));
  t = performance.now();
  await get<{ bytes: number }>("/api/speed/up", { method: "POST", body: upload });
  const upMs = performance.now() - t;

  return { pingMs: Math.round(times[2]), downMbps: mbps(got.byteLength, downMs), upMbps: mbps(upload.length, upMs) };
}

interface InternetResult {
  downMbps: number | null;
  upMbps: number | null;
  rpm: number | null;
  rttMs: number | null;
}

/** The computer's own internet, measured on the computer by macOS (about 20 s). */
export const testInternet = () => get<InternetResult>("/api/speed/internet", { method: "POST" });
