import { LinkBreakIcon } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";

/** Shown while the socket is down and being retried. */
export function LinkState() {
  const lost = useApp((s) => s.phase === "lost");
  const problem = useApp((s) => s.problem);
  if (!lost) return null;
  return (
    <span role="status" aria-label={problem ? "The Mac is not answering" : "Reconnecting"} className="inline-flex h-ctl-sm min-w-0 items-center gap-1.5 rounded-full bg-destructive/10 px-3 text-sm font-semibold whitespace-nowrap text-destructive">
      <LinkBreakIcon weight="bold" size={16} className="shrink-0" />
      <span className="truncate">{problem ? "Offline" : "Reconnecting"}</span>
    </span>
  );
}
