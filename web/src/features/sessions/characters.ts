// The drawings that look over the summary card: one figure in three costumes, eight cells
// each (four across, two down), so one set of movements fits all. The fourth cell has no
// eyes; they are drawn from these numbers (percent of a cell, tilt in degrees) to follow the pointer.

import miku from "@/assets/art/peek-miku.avif";
import sakura from "@/assets/art/peek-sakura.avif";
import snow from "@/assets/art/peek-snow.avif";

interface Eye {
  x: number;
  y: number;
  w: number;
  h: number;
  turn: number;
}

export const CHARACTERS = [
  { id: "miku", label: "Miku", sheet: miku, ink: "#393938", eyes: [{ x: 41.4, y: 58.0, w: 5.2, h: 12.8, turn: 6.6 }, { x: 65.9, y: 60.5, w: 5.2, h: 12.6, turn: 7.6 }] },
  { id: "sakura", label: "Sakura", sheet: sakura, ink: "#3b3938", eyes: [{ x: 41.4, y: 57.7, w: 5.3, h: 12.8, turn: 7.0 }, { x: 65.9, y: 60.3, w: 5.3, h: 12.6, turn: 7.7 }] },
  { id: "snow", label: "Snow", sheet: snow, ink: "#2a2927", eyes: [{ x: 41.4, y: 58.1, w: 5.4, h: 12.9, turn: 7.3 }, { x: 65.9, y: 60.7, w: 5.4, h: 12.8, turn: 7.5 }] },
] as const satisfies readonly { id: string; label: string; sheet: string; ink: string; eyes: readonly Eye[] }[];

/** The chosen drawing, or the first when the stored choice is one that no longer exists. */
export const characterOf = (id: string) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
