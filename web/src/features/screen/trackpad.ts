// The screen as a trackpad: one finger moves the pointer, a tap clicks, a two-finger tap is
// the secondary click, two fingers scroll or pinch to zoom, tap then press drags. Three or
// more fingers swipe as the host does: sideways between spaces, up and down for windows.

/** What the trackpad needs of the VNC client. The pointer call is the client's own, not a public one. */
export interface Host {
  _fbWidth: number;
  _fbHeight: number;
  /** The client's own drawing of the screen. */
  _canvas: HTMLCanvasElement;
  /** Takes a position in the drawing's CSS pixels, not the host's, and converts it itself. */
  _sendMouse(x: number, y: number, mask: number): void;
}

const LEFT = 1;
const RIGHT = 4;
const WHEEL_UP = 8;
const WHEEL_DOWN = 16;
/** How much further the pointer goes than the finger. */
const SPEED = 1.5;

export interface Trackpad {
  detach(): void;
}

/** Makes `pad` a trackpad for the screen in `stage`; `active()` says whether touches reach
 * the host or only move the view. */
type Swipe = "left" | "right" | "up" | "down";

export function attach(pad: HTMLElement, stage: HTMLElement, pointer: HTMLElement, host: () => Host | null, active: () => boolean, gestures: () => boolean, swipe: (way: Swipe) => void): Trackpad {
  // The pointer, in the host's own pixels.
  const at = { x: 0, y: 0, placed: false };
  let zoom = 1;
  let dragging = false;
  let lastTap = 0;
  let ignored = false;
  let touch = { n: 0, x: 0, y: 0, span: 0, moved: 0, began: 0, most: 0, scroll: 0 };
  // How far a swipe of three fingers or more has gone, and whether it has been acted on.
  let swept = { x: 0, y: 0, done: false };

  /** The drawn screen inside the stage, before any zoom: where it is and how many px one host pixel takes. */
  const frame = () => {
    const h = host();
    const canvas = h?._canvas;
    if (!canvas || !h._fbWidth || !canvas.offsetWidth) return null;
    // Where the drawing sits inside the stage, summed up the chain of positioned boxes.
    let [left, top] = [0, 0];
    for (let el: HTMLElement | null = canvas; el && el !== stage; el = el.offsetParent as HTMLElement | null) {
      left += el.offsetLeft;
      top += el.offsetTop;
    }
    return { left, top, scale: canvas.offsetWidth / h._fbWidth, h };
  };

  const draw = () => {
    const f = frame();
    if (!f) return;
    if (!at.placed) Object.assign(at, { x: f.h._fbWidth / 2, y: f.h._fbHeight / 2, placed: true });
    const [px, py] = [f.left + at.x * f.scale, f.top + at.y * f.scale];
    // Zoomed about the pointer, so the part of the screen under it is the part in view.
    stage.style.transformOrigin = `${px}px ${py}px`;
    stage.style.transform = `scale(${zoom})`;
    pointer.style.transform = `translate(${px}px, ${py}px)`;
    // For what is drawn as the pointer: the host's own cursor is in host pixels and grows
    // with the zoom like the screen; the stand-in arrow keeps its size.
    pointer.style.setProperty("--scale", String(f.scale));
    pointer.style.setProperty("--unzoom", String(1 / zoom));
    pointer.hidden = false;
  };

  const send = (mask: number) => {
    const f = frame();
    if (f && active()) f.h._sendMouse(at.x * f.scale, at.y * f.scale, mask);
  };
  const click = (button: number) => {
    send(button);
    send(0);
  };

  const read = (e: TouchEvent) => {
    const [a, b] = [e.touches[0], e.touches[1]];
    if (!a) return { n: 0, x: 0, y: 0, span: 0 };
    if (!b) return { n: 1, x: a.clientX, y: a.clientY, span: 0 };
    if (e.touches.length > 2) {
      const all = [...e.touches];
      return { n: all.length, x: all.reduce((sum, t) => sum + t.clientX, 0) / all.length, y: all.reduce((sum, t) => sum + t.clientY, 0) / all.length, span: 0 };
    }
    return { n: 2, x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, span: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
  };

  const start = (e: TouchEvent) => {
    e.preventDefault();
    // With gestures off, a touch that ever had a second finger does nothing at all.
    if (!gestures() && e.touches.length > 1) {
      ignored = true;
      return;
    }
    if (ignored) return;
    const now = read(e);
    const fresh = touch.n === 0;
    touch = { ...now, moved: fresh ? 0 : touch.moved, began: fresh ? performance.now() : touch.began, most: Math.max(fresh ? 0 : touch.most, now.n), scroll: 0 };
    // A press right after a tap holds the button down: a drag.
    if (fresh && now.n === 1 && performance.now() - lastTap < 300) {
      dragging = true;
      send(LEFT);
    }
  };

  const move = (e: TouchEvent) => {
    e.preventDefault();
    if (ignored) return;
    const now = read(e);
    const f = frame();
    if (!f || now.n !== touch.n) return;
    const [dx, dy] = [now.x - touch.x, now.y - touch.y];
    touch.moved += Math.hypot(dx, dy);
    if (now.n >= 3) {
      swept.x += dx;
      swept.y += dy;
      const far = Math.abs(swept.x) > 50 || Math.abs(swept.y) > 50;
      if (far && !swept.done && active()) {
        swept.done = true;
        // Fingers going left bring the space on the right, as on a trackpad.
        swipe(Math.abs(swept.x) > Math.abs(swept.y) ? (swept.x < 0 ? "right" : "left") : swept.y < 0 ? "up" : "down");
      }
    } else if (now.n === 1) {
      at.x = Math.min(f.h._fbWidth - 1, Math.max(0, at.x + (dx * SPEED) / (f.scale * zoom)));
      at.y = Math.min(f.h._fbHeight - 1, Math.max(0, at.y + (dy * SPEED) / (f.scale * zoom)));
      send(dragging ? LEFT : 0);
    } else if (touch.span && Math.abs(now.span - touch.span) > Math.abs(dy)) {
      zoom = Math.min(8, Math.max(1, (zoom * now.span) / touch.span));
      touch.moved += Math.abs(now.span - touch.span);
    } else {
      // As on a trackpad: fingers moving down bring what is above into view.
      touch.scroll += dy;
      while (Math.abs(touch.scroll) >= 14) {
        click(touch.scroll > 0 ? WHEEL_UP : WHEEL_DOWN);
        touch.scroll -= Math.sign(touch.scroll) * 14;
      }
    }
    Object.assign(touch, now);
    draw();
  };

  const end = (e: TouchEvent) => {
    e.preventDefault();
    if (ignored) {
      if (e.touches.length === 0) {
        ignored = false;
        touch.n = 0;
      }
      return;
    }
    const now = read(e);
    if (now.n > 0) {
      // A finger lifted while another stays: carry on from where that one is.
      Object.assign(touch, now);
      return;
    }
    swept = { x: 0, y: 0, done: false };
    const tap = touch.moved < 10 && performance.now() - touch.began < 280;
    if (dragging) {
      dragging = false;
      send(0);
    } else if (tap && touch.most === 2) {
      click(RIGHT);
    } else if (tap) {
      click(LEFT);
      lastTap = performance.now();
    }
    touch.n = 0;
  };

  const observer = new ResizeObserver(draw);
  observer.observe(stage);
  const options = { passive: false } as const;
  pad.addEventListener("touchstart", start, options);
  pad.addEventListener("touchmove", move, options);
  pad.addEventListener("touchend", end, options);
  pad.addEventListener("touchcancel", end, options);
  draw();
  return {
    detach() {
      observer.disconnect();
      pad.removeEventListener("touchstart", start);
      pad.removeEventListener("touchmove", move);
      pad.removeEventListener("touchend", end);
      pad.removeEventListener("touchcancel", end);
      stage.style.transform = "";
      pointer.hidden = true;
    },
  };
}
