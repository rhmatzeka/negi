import { type ReactNode, useRef } from "react";
import laptop from "@/assets/art/laptop.avif";
import loading from "@/assets/art/loading.avif";
import locked from "@/assets/art/locked.avif";
import lost from "@/assets/art/lost.avif";
import remote from "@/assets/art/remote.avif";
import sleep from "@/assets/art/sleep.avif";
import unplugged from "@/assets/art/unplugged.avif";
import toggle from "@/assets/art/switch.avif";
import wave from "@/assets/art/wave.avif";
import { ThemeToggle } from "@/components/Toggles";
import { useApp } from "@/lib/store";
import { calm, gsap, useGSAP } from "@/lib/anim";
import { cn } from "@/lib/utils";

/** The character's pose for each state: greeting, working, asleep, puzzled, and the screen's own. */
const ART = { wave, laptop, sleep, lost, remote, unplugged, toggle, locked, loading };

/** How each eight-frame sheet plays: `beat` per frame, `rest` on the first frame between loops. */
const PLAY: Record<keyof typeof ART, { beat: number; rest: number }> = {
  wave: { beat: 0.12, rest: 1.6 },
  laptop: { beat: 0.13, rest: 0 },
  sleep: { beat: 0.34, rest: 0.4 },
  lost: { beat: 0.3, rest: 0.8 },
  remote: { beat: 0.14, rest: 0.6 },
  unplugged: { beat: 0.16, rest: 0.5 },
  toggle: { beat: 0.18, rest: 0.8 },
  locked: { beat: 0.16, rest: 0.8 },
  loading: { beat: 0.11, rest: 0 },
};

const cell = (frame: number) => `${((frame % 4) / 3) * 100}% ${Math.floor(frame / 4) * 100}%`;

/** One of the character's drawings, playing its loop, at any size: for cards and dialogs. */
export function Pose({ art, className }: { art: keyof typeof ART; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const motion = useApp((s) => s.motion);
  useGSAP(
    () => {
      if (calm()) return;
      const { beat, rest } = PLAY[art];
      const reel = gsap.timeline({ repeat: -1, repeatDelay: rest });
      for (let frame = 0; frame < 8; frame++) reel.set(root.current, { backgroundPosition: cell(frame) }, frame * beat);
      reel.set(root.current, { backgroundPosition: cell(0) }, 8 * beat);
    },
    { scope: root, dependencies: [art, motion], revertOnUpdate: true },
  );
  return <div ref={root} aria-hidden className={cn("bg-no-repeat select-none", className)} style={{ backgroundImage: `url(${ART[art]})`, backgroundSize: "400% 200%", backgroundPosition: cell(0) }} />;
}

interface StateProps {
  art: keyof typeof ART;
  title: string;
  text: ReactNode;
  children?: ReactNode;
}

/** A whole-page state: pairing, connecting, tmux not running, the Mac unreachable. */
export function State({ art, title, text, children }: StateProps) {
  const root = useRef<HTMLDivElement>(null);
  const motion = useApp((s) => s.motion);
  useGSAP(
    () => {
      if (calm()) return;
      gsap.from(".art", { y: 40, scale: 0.86, opacity: 0, duration: 0.9, ease: "back.out(1.6)" });
      // The frames, one after another, then the first again for the rest.
      const { beat, rest } = PLAY[art];
      const reel = gsap.timeline({ repeat: -1, repeatDelay: rest, delay: 0.5 });
      for (let frame = 0; frame < 8; frame++) reel.set(".art", { backgroundPosition: cell(frame) }, frame * beat);
      reel.set(".art", { backgroundPosition: cell(0) }, 8 * beat);
      gsap.from(".in", { y: 8, opacity: 0, filter: "blur(10px)", duration: 0.6, ease: "expo.out", stagger: 0.06, delay: 0.12, clearProps: "filter" });
    },
    { scope: root, dependencies: [art, motion], revertOnUpdate: true },
  );
  return (
    <div ref={root} className="slim-scroll relative grid h-full place-items-center overflow-auto overscroll-none px-5 py-10">
      <div className="absolute top-[max(12px,var(--safe-top))] right-4">
        <ThemeToggle />
      </div>
      <section className="grid w-full max-w-[380px] justify-items-center gap-4 text-center">
        <div aria-hidden className="art size-[190px] bg-no-repeat select-none" style={{ backgroundImage: `url(${ART[art]})`, backgroundSize: "400% 200%", backgroundPosition: cell(0) }} />
        <h1 className="in text-[34px] leading-[1.1] font-semibold text-balance">{title}</h1>
        <p className="in text-lg text-muted-foreground">{text}</p>
        {children && <div className="in w-full pt-2">{children}</div>}
      </section>
    </div>
  );
}
