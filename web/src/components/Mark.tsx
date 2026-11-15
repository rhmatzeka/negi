import { MARK } from "@/lib/icon";
import { cn } from "@/lib/utils";

/** The app's mark: its icon's drawing without the square behind it. */
export function Mark({ size = 44, className }: { size?: number; className?: string }) {
  return <img src={MARK} alt="" width={size} height={size} draggable={false} className={cn("shrink-0 select-none", className)} />;
}
