import { useEffect, useRef } from "react";
import { calm, gsap, useGSAP } from "@/lib/anim";
import { characterOf } from "@/features/sessions/characters";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

// Cells of the sheet. The first has her eyes drawn in; BARE is the face without them, under
// the eyes drawn here.
const HALF = 1;
const SHUT = 2;
const BARE = 3;
const HAPPY = 5;
const WIDE = 6;
const SLEEPY = 7;

/** The character looking over the edge of the summary card: her eyes follow the pointer, she blinks and dozes, and she cheers when a pane goes quiet. */
export function Peek({ className }: { className?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const quiets = useApp((s) => s.quiets);
  const { sheet, eyes, ink } = useApp((s) => characterOf(s.character));
  const gaze = useRef<HTMLDivElement>(null);
  const motion = useApp((s) => s.motion);
  const act = useRef<{ cheer(): void; poke(): void } | null>(null);

  useGSAP(() => {
    const node = el.current;
    if (!node || calm()) return;
    let running: gsap.core.Animation | undefined;

    const look = gaze.current;
    const show = (cell: number) => {
      node.style.backgroundPosition = `${((cell % 4) / 3) * 100}% ${Math.floor(cell / 4) * 100}%`;
      // Her own eyes show only over the bare face; every other cell has its eyes drawn in.
      if (look) look.style.opacity = cell === BARE ? "1" : "0";
    };
    show(BARE);

    // Her eyes drift toward the pointer, a little: far enough to be seen, never off the face.
    const moveX = look && gsap.quickTo(look, "x", { duration: 0.35, ease: "power3.out" });
    const moveY = look && gsap.quickTo(look, "y", { duration: 0.35, ease: "power3.out" });
    let rest: gsap.core.Tween | undefined;
    const follow = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || !moveX || !moveY) return;
      const box = node.getBoundingClientRect();
      const dx = e.clientX - (box.left + box.width * 0.5);
      const dy = e.clientY - (box.top + box.height * 0.7);
      const far = Math.hypot(dx, dy) || 1;
      // Full reach from about a card's width away; closer than that, in proportion.
      const pull = Math.min(1, far / 260);
      moveX((dx / far) * pull * box.width * 0.028);
      moveY((dy / far) * pull * box.width * 0.02);
      // With the pointer still for a while she looks ahead again.
      rest?.kill();
      rest = gsap.delayedCall(4, () => (moveX(0), moveY(0)));
    };
    window.addEventListener("pointermove", follow, { passive: true });

    // A blink closes her own eyes along their length, so it works wherever they are looking.
    const blink = () => {
      if (!look) return;
      running = gsap
        .timeline({ onComplete: idle })
        .to(look.children, { scaleY: 0.1, duration: 0.07, ease: "power2.in" })
        .to(look.children, { scaleY: 1, duration: 0.12, ease: "power2.out" });
    };

    // Cells shown one after another, each held for its own time, then back to waiting.
    function play(steps: [cell: number, hold: number][]) {
      running?.kill();
      const line = gsap.timeline({ onComplete: idle });
      for (const [cell, hold] of steps) line.call(show, [cell]).to({}, { duration: hold });
      line.call(show, [BARE]);
      running = line;
    }

    function idle() {
      running = gsap.delayedCall(gsap.utils.random(2.2, 5.5), () => {
        const roll = Math.random();
        // Blinks, and now and then dozes.
        if (roll < 0.85) blink();
        else play([[HALF, 0.12], [SLEEPY, 1.6], [HALF, 0.1]]);
      });
    }

    // She never leaves the ledge, which would show nothing below her: she only squashes,
    // stretches from it, or sinks behind it.
    gsap.set(node, { transformOrigin: "50% 100%" });
    const settle = { scaleX: 1, scaleY: 1, duration: 0.8, ease: "elastic.out(1, 0.4)" };

    const boing = () =>
      gsap
        .timeline({ defaults: { overwrite: "auto" } })
        .to(node, { scaleY: 0.88, scaleX: 1.05, duration: 0.1, ease: "power2.out" })
        .to(node, settle);

    // Ducks behind the ledge and comes back up, like someone caught looking.
    const duck = () =>
      gsap
        .timeline({ defaults: { overwrite: "auto" } })
        .to(node, { yPercent: 62, duration: 0.2, ease: "power2.in" })
        .to(node, { yPercent: 0, duration: 0.4, ease: "power3.out" }, "+=0.12");

    act.current = {
      cheer() {
        play([[SHUT, 0.32], [HAPPY, 1.4]]);
        duck();
      },
      poke() {
        play([[WIDE, 0.35], [HAPPY, 1.1]]);
        boing();
      },
    };

    gsap.from(node, { yPercent: 75, duration: 0.7, ease: "power3.out", delay: 0.3 });
    idle();
    return () => {
      // Back to the cell with her eyes drawn in, which is how she stands when nothing moves.
      node.style.backgroundPosition = "0% 0%";
      if (look) look.style.opacity = "0";
      window.removeEventListener("pointermove", follow);
      rest?.kill();
      running?.kill();
      if (look) gsap.killTweensOf([look, ...look.children]);
      gsap.killTweensOf(node);
      act.current = null;
    };
  }, { dependencies: [motion], revertOnUpdate: true });

  const heard = useRef(quiets);
  useEffect(() => {
    if (quiets === heard.current) return;
    heard.current = quiets;
    act.current?.cheer();
  }, [quiets]);

  return (
    // A plain element, not a button: she is decoration, and a button would take focus and show a ring.
    <div
      ref={el}
      aria-hidden
      onClick={() => act.current?.poke()}
      style={{ backgroundImage: `url(${sheet})`, backgroundSize: "400% 200%", backgroundPosition: "0% 0%" }}
      className={cn("aspect-square cursor-default bg-no-repeat select-none", className)}
    >
      {/* Hidden until the bare face is under them; with reduced motion she keeps the drawn eyes. */}
      <div ref={gaze} className="absolute inset-0 opacity-0">
        {eyes.map((eye, i) => (
          <span
            key={i}
            className="absolute rounded-full"
            style={{
              left: `${eye.x - eye.w / 2}%`,
              top: `${eye.y - eye.h / 2}%`,
              width: `${eye.w}%`,
              height: `${eye.h}%`,
              rotate: `${eye.turn}deg`,
              backgroundColor: ink,
            }}
          />
        ))}
      </div>
    </div>
  );
}
