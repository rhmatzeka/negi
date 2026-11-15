import type { Icon } from "@phosphor-icons/react";
import { useRef } from "react";
import { calm, gsap, useGSAP } from "@/lib/anim";
import { hash, TONES, type Tone } from "@/tmux/programs";
import { cn } from "@/lib/utils";

// A tile never has a colour of its own. It is the chosen colour set's accent, the main
// action's colour, a quiet neutral, or the colour of closing.
const tones: Record<Tone, string> = {
  accent: "bg-mint text-mint-ink",
  solid: "bg-primary text-primary-foreground",
  quiet: "bg-soft-strong text-foreground",
  danger: "bg-destructive/10 text-destructive",
};

const sizes = {
  sm: { box: "size-ctl-sm", icon: 20 },
  md: { box: "size-ctl shadow-[0_6px_14px_rgb(0_0_0/0.14)]", icon: 24 },
  lg: { box: "size-[72px] shadow-[0_14px_30px_rgb(0_0_0/0.18)]", icon: 38 },
};

interface TileProps {
  icon: Icon;
  /** Decides the colour and the slight turn, so the same thing always looks the same. */
  seed: string;
  tone?: Tone;
  size?: keyof typeof sizes;
  className?: string;
}

/** A squircle with a filled glyph, slightly turned. It straightens and springs when touched. */
export function Tile({ icon: Glyph, seed, tone, size = "md", className }: TileProps) {
  const el = useRef<HTMLSpanElement>(null);
  const n = hash(seed);
  const tilt = (n % 15) - 7;

  const { contextSafe } = useGSAP(() => gsap.set(el.current, { rotation: tilt }), { dependencies: [tilt] });
  const spring = contextSafe((vars: gsap.TweenVars) => {
    if (calm()) return;
    gsap.to(el.current, { duration: 0.7, ease: "elastic.out(1, 0.4)", overwrite: "auto", ...vars });
  });

  return (
    <span
      ref={el}
      aria-hidden
      onPointerEnter={(e) => e.pointerType === "mouse" && spring({ rotation: 0, scale: 1.14 })}
      onPointerLeave={() => spring({ rotation: tilt, scale: 1 })}
      onPointerDown={() => spring({ scale: 0.84, duration: 0.12, ease: "power2.out" })}
      onPointerUp={() => spring({ rotation: tilt, scale: 1 })}
      className={cn("inline-grid shrink-0 place-items-center rounded-[30%]", sizes[size].box, tones[tone ?? TONES[n % TONES.length]], className)}
    >
      <Glyph weight="fill" size={sizes[size].icon} />
    </span>
  );
}
