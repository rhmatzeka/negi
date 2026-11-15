// The theme switch that is on every page.

import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useRef } from "react";
import { Tip } from "@/components/Tip";
import { Button } from "@/components/ui/button";
import { calm, gsap, useGSAP } from "@/lib/anim";
import { switchTheme, useResolvedTheme } from "@/lib/theme";

/** Flips between light and dark. The new theme spreads out from the button. */
export function ThemeToggle() {
  const dark = useResolvedTheme() === "dark";
  const icon = useRef<HTMLSpanElement>(null);
  // The glyph turns in as the theme changes.
  useGSAP(
    () => {
      if (!calm()) gsap.fromTo(icon.current, { rotation: -90, scale: 0.4 }, { rotation: 0, scale: 1, duration: 0.7, ease: "elastic.out(1, 0.5)" });
    },
    { dependencies: [dark] },
  );
  return (
    <Tip label={dark ? "Light theme" : "Dark theme"} side="bottom">
      <Button
        variant="soft"
        size="icon"
        aria-label={dark ? "Switch to the light theme" : "Switch to the dark theme"}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          switchTheme(dark ? "light" : "dark", { x: box.left + box.width / 2, y: box.top + box.height / 2 });
        }}
      >
        <span ref={icon} className="grid">
          {dark ? <SunIcon weight="fill" size={20} /> : <MoonIcon weight="fill" size={20} />}
        </span>
      </Button>
    </Tip>
  );
}
