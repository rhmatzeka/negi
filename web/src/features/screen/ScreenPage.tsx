// The host's own screen, through its screen sharing: seen, and worked with touch.

import { ArrowClockwiseIcon, PlugsConnectedIcon, PlugsIcon, CaretLeftIcon, DeviceMobileIcon, EyeIcon, EyeSlashIcon, HandPointingIcon, HandsClappingIcon, KeyboardIcon, LockSimpleIcon, UserIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/Confirm";
import { Input } from "@/components/ui/input";
import { Pose } from "@/components/State";
import { Switch } from "@/components/Switch";
import { Tip } from "@/components/Tip";
import { outdated } from "@/connection/link";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import macCursor from "@/assets/art/cursor.webp";
import { SoftKeys } from "./SoftKeys";
import { attach, type Host } from "./trackpad";

const KEY = "flex h-ctl min-w-ctl shrink-0 items-center justify-center gap-1 rounded-sm px-3 font-mono text-sm font-bold";

type Phase = { is: "connecting" } | { is: "asking"; wants: string[]; wrong?: boolean } | { is: "showing" } | { is: "ended"; why: string };

interface Viewer {
  viewOnly: boolean;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  sendCredentials(credentials: Record<string, string>): void;
  disconnect(): void;
}

// Keys as X11 names them, which is what screen sharing speaks. On a Mac's screen sharing
// Super is Command and Alt is Option.
const SYM = { esc: 0xff1b, tab: 0xff09, enter: 0xff0d, back: 0xff08, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54 };
const MODS = [
  { id: "ctrl", word: "ctrl", sign: "⌃", sym: 0xffe3 },
  { id: "opt", word: "opt", sign: "⌥", sym: 0xffe9 },
  { id: "cmd", word: "cmd", sign: "⌘", sym: 0xffeb },
  { id: "shift", word: "shift", sign: "⇧", sym: 0xffe1 },
] as const;
type ModId = (typeof MODS)[number]["id"];

/** The keysym of one typed character: itself for Latin-1, its code point marked as Unicode otherwise. */
const symOf = (char: string) => {
  const point = char.codePointAt(0) ?? 0;
  return point < 0x100 ? point : 0x01000000 + point;
};

/** What the host's screen sharing was last told, for coming back to the screen without asking. */
let remembered: Record<string, string> | null = null;

// Kept across reloads only as the server sealed it, for this device alone.
const KEPT = "negi.screen-login";
const kept = {
  get: () => {
    try {
      return localStorage.getItem(KEPT) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set: (sealed: string) => {
    try {
      localStorage.setItem(KEPT, sealed);
    } catch {
      // Private browsing: it is asked for again next time.
    }
  },
  drop: () => {
    try {
      localStorage.removeItem(KEPT);
    } catch {
      // Nothing was kept.
    }
  },
};

async function keep(login: Record<string, string>) {
  const token = useApp.getState().token;
  const response = await fetch("/api/screen/seal", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(login) });
  const body = (await response.json().catch(() => ({}))) as { sealed?: string };
  if (response.ok && body.sealed) kept.set(body.sealed);
}

/** What the page says after the Disconnect button. */
const STOPPED = "You disconnected. Nothing is shared until you connect again.";

/** How long the page may be out of sight before it lets go of the screen. */
const HIDDEN_MS = 20_000;

/** How many times in a row a lost connection is taken up again by itself. */
const RETRIES = 3;

export function ScreenPage() {
  const navigate = useNavigate();
  const mac = useApp((s) => s.os === "macos");
  const stage = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [phase, setPhase] = useState<Phase>({ is: "connecting" });
  const [touch, setTouch] = useState(true);
  // Multi-finger gestures: two to scroll, zoom and right click, three to swipe. Off, only one finger works.
  const [gestures, setGestures] = useState(true);
  const gesturing = useRef(gestures);
  useEffect(() => {
    gesturing.current = gestures;
  }, [gestures]);
  // Counted up to connect again after a wrong password or a lost connection.
  const [attempt, setAttempt] = useState(0);
  const retries = useRef(0);
  // Hung up on purpose: nothing connects again until asked.
  const stopped = useRef(false);
  // The Mac's own cursor, once it has sent one; until then the drawn arrow stands in.
  const cursor = useRef<HTMLCanvasElement>(null);
  const [native, setNative] = useState(false);
  // The login just typed is to be kept once the host has accepted it.
  const keeping = useRef(false);
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    const target = stage.current;
    const token = useApp.getState().token;
    if (!target || !token) return;
    let live = true;
    let socket: WebSocket | null = null;
    // Loaded before the socket opens: the screen sharing server speaks right after the ok.
    void import("@novnc/novnc").then(({ default: RFB }) => {
      if (!live) return;
      const opened = (socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/screen`));
      opened.binaryType = "arraybuffer";
      opened.onopen = () => opened.send(JSON.stringify({ token, sealed: kept.get() }));
      opened.onerror = () => live && setPhase({ is: "ended", why: "negi could not reach the screen." });
      connect(opened, RFB);
    });
    const connect = (socket: WebSocket, RFB: typeof import("@novnc/novnc").default) => {
    // The server's first word says whether screen sharing can be had; the VNC client takes the socket from there.
    socket.onmessage = (first) => {
      const answer = JSON.parse(String(first.data)) as { ok?: boolean; error?: string; build?: string; login?: Record<string, string> | null };
      if (answer.login && !remembered) remembered = answer.login;
      if (outdated(answer.build)) return;
      if (!answer.ok) {
        socket.close();
        const off = answer.error === "screen sharing is off";
        return live && setPhase({ is: "ended", why: off ? `Screen sharing is off. Turn it on in System Settings, General, Sharing${mac ? " on your Mac" : ""}.` : (answer.error ?? "Refused.") });
      }
      const rfb = new RFB(target, socket);
      rfb.scaleViewport = true;
      // Over a tailnet to a phone, a quick picture matters more than a fine one.
      rfb.qualityLevel = 3;
      rfb.compressionLevel = 6;
      rfb.background = "transparent";
      rfb.addEventListener("credentialsrequired", (e) => {
        if (remembered) rfb.sendCredentials(remembered);
        else setPhase({ is: "asking", wants: (e as CustomEvent<{ types: string[] }>).detail.types });
      });
      rfb.addEventListener("connect", () => {
        retries.current = 0;
        if (keeping.current && remembered) void keep(remembered);
        keeping.current = false;
        setPhase({ is: "showing" });
      });
      rfb.addEventListener("securityfailure", () => {
        remembered = null;
        kept.drop();
        setPhase({ is: "asking", wants: ["username", "password"], wrong: true });
      });
      rfb.addEventListener("disconnect", () => {
        if (!live || asleep.current || stopped.current) return;
        // Signed in before: a dropped line (the phone asleep, the server restarted) is picked up again.
        if (remembered && retries.current < RETRIES) {
          retries.current += 1;
          setPhase({ is: "connecting" });
          window.setTimeout(() => live && setAttempt((n) => n + 1), 600 * retries.current);
          return;
        }
        setPhase((p) => (p.is === "asking" && p.wrong ? p : { is: "ended", why: "The connection to your screen dropped." }));
      });
      // The Mac sends its cursor's shape apart from the picture; it is drawn at the pointer,
      // hot spot on the point.
      const own = (rfb as unknown as { _updateCursor: (rgba: Uint8Array, hx: number, hy: number, w: number, h: number) => void })._updateCursor.bind(rfb);
      (rfb as unknown as { _updateCursor: typeof own })._updateCursor = (rgba, hx, hy, w, h) => {
        own(rgba, hx, hy, w, h);
        const canvas = cursor.current;
        if (!canvas || !w || !h) return;
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
        canvas.style.setProperty("--w", String(w));
        canvas.style.setProperty("--h", String(h));
        canvas.style.setProperty("--hx", String(hx));
        canvas.style.setProperty("--hy", String(hy));
        // A phone shows the Mac's screen a few times smaller; the cursor is never drawn under 22 px.
        canvas.style.setProperty("--side", String(Math.max(w, h)));
        setNative(true);
      };
      viewer.current = rfb;
    };
    };
    return () => {
      live = false;
      viewer.current?.disconnect();
      viewer.current = null;
      socket?.close();
    };
  }, [attempt, mac]);

  // A phone put away with this page open must not leave the screen shared: hidden for a
  // while, it hangs up, and coming back connects again.
  const asleep = useRef(false);
  const hangUp = () => {
    stopped.current = true;
    viewer.current?.disconnect();
    setPhase({ is: "ended", why: STOPPED });
  };
  useEffect(() => {
    let timer = 0;
    const changed = () => {
      clearTimeout(timer);
      if (document.hidden) {
        timer = window.setTimeout(() => {
          asleep.current = true;
          viewer.current?.disconnect();
        }, HIDDEN_MS);
      } else if (asleep.current && !stopped.current) {
        asleep.current = false;
        retries.current = 0;
        setPhase({ is: "connecting" });
        setAttempt((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", changed);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", changed);
    };
  }, []);

  // Touch works the screen as a trackpad. Looking only, the same gestures move the pointer
  // and zoom here, and nothing is sent.
  const pad = useRef<HTMLDivElement>(null);
  const pointer = useRef<HTMLDivElement>(null);
  const touching = useRef(touch);
  useEffect(() => {
    touching.current = touch;
  }, [touch]);
  const showing = phase.is === "showing";
  useEffect(() => {
    if (!showing || !pad.current || !stage.current || !pointer.current) return;
    const trackpad = attach(pad.current, stage.current, pointer.current, () => viewer.current as unknown as Host | null, () => touching.current, () => gesturing.current, (way) => {
      // The host's own shortcuts for these: Control with an arrow.
      const rfb = viewer.current;
      if (!rfb) return;
      rfb.sendKey(0xffe3, null, true);
      rfb.sendKey(SYM[way], null);
      rfb.sendKey(0xffe3, null, false);
    });
    return () => trackpad.detach();
  }, [showing]);

  // Modifiers latch: held down on the host from the press until the next key has gone.
  const [held, setHeld] = useState<ModId[]>([]);
  const toggle = (id: ModId) => {
    const mod = MODS.find((m) => m.id === id);
    if (!mod) return;
    const on = !held.includes(id);
    viewer.current?.sendKey(mod.sym, null, on);
    setHeld(on ? [...held, id] : held.filter((h) => h !== id));
  };
  const key = (sym: number) => {
    viewer.current?.sendKey(sym, null);
    for (const id of held) viewer.current?.sendKey(MODS.find((m) => m.id === id)?.sym ?? 0, null, false);
    if (held.length) setHeld([]);
  };

  // A real keyboard, at a desk or attached to the phone: every key goes through as it is
  // pressed and released, modifiers included, so the host's own shortcuts work.
  useEffect(() => {
    if (!showing) return;
    const NAMED: Record<string, number> = {
      Control: 0xffe3, Alt: 0xffe9, Meta: 0xffeb, Shift: 0xffe1, Escape: SYM.esc, Tab: SYM.tab, Enter: SYM.enter, Backspace: SYM.back,
      ArrowLeft: SYM.left, ArrowUp: SYM.up, ArrowRight: SYM.right, ArrowDown: SYM.down, Delete: 0xffff, Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56, " ": 0x20,
    };
    const symFor = (e: KeyboardEvent) => {
      if (NAMED[e.key]) return NAMED[e.key];
      // With Option held a Mac reports the composed character; the key itself is in `code`.
      if (/^Key[A-Z]$/.test(e.code)) return (e.shiftKey ? e.code[3] : e.code[3].toLowerCase()).charCodeAt(0);
      if (/^Digit\d$/.test(e.code) && !e.shiftKey) return e.code.charCodeAt(5);
      return e.key.length === 1 ? symOf(e.key) : null;
    };
    // Some keyboards report a modifier only as a flag on the key it changes, never as a
    // press of its own. Those are pressed on the host around that key.
    const FLAGS = [
      ["ctrlKey", 0xffe3],
      ["altKey", 0xffe9],
      ["metaKey", 0xffeb],
      ["shiftKey", 0xffe1],
    ] as const;
    const held = new Set<number>();
    const lent = new Map<number, number[]>();
    const pass = (down: boolean) => (e: KeyboardEvent) => {
      // The unseen field has the phone's own keyboard; that is handled as typed text.
      if (!touching.current || e.target === typist.current || e.isComposing) return;
      const sym = symFor(e);
      const rfb = viewer.current;
      if (sym === null || !rfb) return;
      e.preventDefault();
      if (FLAGS.some(([, mod]) => mod === sym)) {
        if (down) held.add(sym);
        else held.delete(sym);
        rfb.sendKey(sym, null, down);
        return;
      }
      if (down) {
        const extra = FLAGS.filter(([flag, mod]) => e[flag] && !held.has(mod)).map(([, mod]) => mod);
        for (const mod of extra) rfb.sendKey(mod, null, true);
        lent.set(sym, [...(lent.get(sym) ?? []), ...extra]);
        rfb.sendKey(sym, null, true);
      } else {
        rfb.sendKey(sym, null, false);
        for (const mod of lent.get(sym) ?? []) rfb.sendKey(mod, null, false);
        lent.delete(sym);
      }
    };
    const [down, up] = [pass(true), pass(false)];
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
    };
  }, [showing]);

  // The phone's keyboard, through a field that is not seen and always holds one invisible
  // character, so that a Backspace on nothing is still heard.
  const typist = useRef<HTMLTextAreaElement>(null);
  const [typing, setTyping] = useState(false);
  // Our own keyboard, under the screen, for when the phone's would cover what is typed on.
  const [soft, setSoft] = useState(false);
  const [reveal, setReveal] = useState(false);
  const typed = (field: HTMLTextAreaElement) => {
    const value = field.value;
    field.value = "\u200b";
    if (value.length < 1) return key(SYM.back);
    for (const char of value.replace("\u200b", "")) key(char === "\n" ? SYM.enter : symOf(char));
  };

  const signIn = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const given = { username: String(form.get("username") ?? ""), password: String(form.get("password") ?? "") };
    remembered = given;
    keeping.current = remember;
    // After a refusal the server has hung up; connect again and answer when it asks.
    if (phase.is === "asking" && phase.wrong) {
      pending.current = given;
      setPhase({ is: "connecting" });
      setAttempt((n) => n + 1);
    } else {
      viewer.current?.sendCredentials(given);
      setPhase({ is: "connecting" });
    }
  };
  const pending = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    if (phase.is === "asking" && !phase.wrong && pending.current) {
      viewer.current?.sendCredentials(pending.current);
      pending.current = null;
    }
  }, [phase]);

  return (
    <main className="flex h-full flex-col gap-3 px-3 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
      <header className="flex shrink-0 items-center gap-2">
        <Button variant="soft" size="icon" aria-label="Back to sessions" onClick={() => navigate({ to: "/" })}>
          <CaretLeftIcon weight="bold" size={20} />
        </Button>
        <h1 className="min-w-0 flex-1 truncate px-1 text-lg font-semibold">{mac ? "Your Mac's screen" : "Your computer's screen"}</h1>
        {phase.is === "showing" && (
          <Tip label="Disconnect" hint="Stop sharing the screen" side="bottom">
            <ConfirmButton variant="soft" size="icon" aria-label="Disconnect" confirmLabel="Tap to disconnect" tone="danger" onConfirm={hangUp}>
              <PlugsIcon weight="bold" size={20} />
            </ConfirmButton>
          </Tip>
        )}
        {phase.is === "showing" && (
          <Tip label={gestures ? "Gestures on" : "Gestures off"} hint={gestures ? "Two fingers scroll, zoom, right click; three swipe" : "One finger only"} side="bottom">
            <Button variant="soft" size="icon" aria-pressed={gestures} aria-label={gestures ? "Turn gestures off" : "Turn gestures on"} onClick={() => setGestures(!gestures)}>
              <HandsClappingIcon weight={gestures ? "fill" : "regular"} size={20} />
            </Button>
          </Tip>
        )}
        {phase.is === "showing" && (
          <Tip label={touch ? "Touch controls it" : "Looking only"} hint="Press to switch" side="bottom">
            <Button variant="soft" size="icon" aria-pressed={touch} aria-label={touch ? "Stop controlling, only look" : "Control with touch"} onClick={() => setTouch(!touch)}>
              {touch ? <HandPointingIcon weight="fill" size={20} /> : <EyeIcon weight="fill" size={20} />}
            </Button>
          </Tip>
        )}
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-term">
        <div ref={stage} className="pointer-events-none absolute inset-0">
          <div ref={pointer} hidden className="absolute top-0 left-0 z-10 size-0">
            {/* Sized in the screen's own pixels, but never under 22 px, and kept that size while
                zoomed; scaled about the hot spot, which stays on the point. */}
            <span aria-hidden className={cn("absolute top-0 left-0 block origin-top-left scale-(--unzoom)", !native && "hidden")}>
              <canvas
                ref={cursor}
                className="absolute block max-w-none"
                style={{ "--k": "max(var(--scale), calc(22 / var(--side)))", width: "calc(var(--w) * var(--k) * 1px)", height: "calc(var(--h) * var(--k) * 1px)", left: "calc(var(--hx) * var(--k) * -1px)", top: "calc(var(--hy) * var(--k) * -1px)" } as React.CSSProperties}
              />
            </span>
            {/* Until the Mac has sent its cursor: the owner's own arrow (Mousecape), tip 31 of 32
                points across, at the top. */}
            <span aria-hidden className={cn("mac-cursor block origin-top-right scale-(--unzoom)", native && "hidden")} style={{ backgroundImage: `url(${macCursor})` }} />
          </div>
        </div>
        {/* What the fingers touch: the screen itself takes no touches, they are read here as a trackpad's. */}
        <div ref={pad} aria-label="Trackpad" className="absolute inset-0 touch-none" />
        {phase.is === "connecting" && (
          <p role="status" className="absolute inset-0 grid place-content-center justify-items-center gap-1 text-sm font-medium text-[#8a93b8]">
            <Pose art="loading" className="size-[120px]" />
            {mac ? "Reaching your Mac" : "Reaching your computer"}
          </p>
        )}
        {phase.is === "ended" && (
          <div className="absolute inset-0 m-auto grid h-fit w-[min(340px,calc(100%-32px))] justify-items-center gap-3 rounded-lg bg-popover px-5 pt-4 pb-5 text-center text-popover-foreground shadow-[0_24px_80px_rgb(0_0_0/0.3)]">
            <Pose art={phase.why.includes("off") ? "toggle" : "unplugged"} className="size-[112px]" />
            <div className="grid gap-1">
              <p className="text-lg font-semibold">{phase.why.includes("off") ? "Screen sharing is off" : "Disconnected"}</p>
              <p className="text-sm text-balance text-muted-foreground">{phase.why}</p>
            </div>
            <Button className="w-full" onClick={() => (stopped.current = false, retries.current = 0, setPhase({ is: "connecting" }), setAttempt((n) => n + 1))}>
              {phase.why === STOPPED ? <PlugsConnectedIcon weight="bold" size={18} /> : <ArrowClockwiseIcon weight="bold" size={18} />}
              {phase.why === STOPPED ? "Connect" : "Reconnect"}
            </Button>
            {remembered && (
              <button
                type="button"
                className="text-sm font-medium text-muted-foreground hover:text-foreground"
                onClick={() => {
                  remembered = null;
                  kept.drop();
                  stopped.current = false;
                  retries.current = 0;
                  setPhase({ is: "connecting" });
                  setAttempt((n) => n + 1);
                }}
              >
                Sign in with another account
              </button>
            )}
          </div>
        )}
        {phase.is === "asking" && (
          <form onSubmit={signIn} className="absolute inset-0 m-auto grid h-fit w-[min(340px,calc(100%-32px))] justify-items-center gap-3 rounded-lg bg-popover px-5 pt-4 pb-5 text-popover-foreground shadow-[0_24px_80px_rgb(0_0_0/0.3)]">
            <Pose art={phase.wrong ? "locked" : "remote"} className="size-[112px]" />
            <div className="grid justify-items-center gap-1 text-center">
              <p className="text-lg font-semibold">{mac ? "Sign in to your Mac" : "Sign in to your computer"}</p>
              {phase.wrong ? (
                <p role="alert" className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                  <WarningCircleIcon weight="fill" size={16} />
                  Wrong name or password
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{mac ? "Your Mac login. Forgotten on reload." : "Its own login. Forgotten on reload."}</p>
              )}
            </div>
            {phase.wants.includes("username") && (
              <label className="relative w-full">
                <UserIcon weight="bold" size={18} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input name="username" aria-label="Account name" placeholder="Account name" defaultValue={remembered?.username} autoCapitalize="none" autoCorrect="off" autoComplete="username" required className="pl-10" />
              </label>
            )}
            <label className="relative w-full">
              <LockSimpleIcon weight="bold" size={18} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input name="password" aria-label="Password" placeholder="Password" type={reveal ? "text" : "password"} autoComplete="current-password" required autoFocus={phase.wrong} className="px-10" />
              <button type="button" aria-label={reveal ? "Hide the password" : "Show the password"} aria-pressed={reveal} onClick={() => setReveal(!reveal)} className="absolute top-1/2 right-1.5 grid size-9 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:text-foreground">
                {reveal ? <EyeSlashIcon weight="bold" size={18} /> : <EyeIcon weight="bold" size={18} />}
              </button>
            </label>
            <div className="flex w-full items-center justify-between gap-3 px-1 text-sm font-medium">
              Remember on this phone
              <Switch label="Remember on this phone" checked={remember} onChange={setRemember} />
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
        )}
      </div>
      {phase.is === "showing" && touch && (
        <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <textarea
            ref={typist}
            aria-label="Type on the computer"
            defaultValue={"\u200b"}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            onChange={(e) => !(e.nativeEvent as InputEvent).isComposing && typed(e.currentTarget)}
            onCompositionEnd={(e) => typed(e.currentTarget)}
            className="pointer-events-none absolute h-px w-px resize-none opacity-0 text-[16px]"
          />
          <div role="toolbar" aria-label="Keys" className="no-scrollbar flex min-w-0 touch-pan-x gap-1.5 overflow-x-auto">
            {MODS.map(({ id, word, sign }) => (
              <button key={id} type="button" aria-pressed={held.includes(id)} onClick={() => toggle(id)} className={cn(KEY, held.includes(id) ? "bg-mint text-mint-ink" : "bg-soft")}>
                <span className="font-sans text-base font-medium">{sign}</span>
                {word}
              </button>
            ))}
            {(
              [
                ["esc", SYM.esc],
                ["tab", SYM.tab],
                ["↑", SYM.up],
                ["↓", SYM.down],
                ["←", SYM.left],
                ["→", SYM.right],
                ["del", SYM.back],
                ["return", SYM.enter],
              ] as const
            ).map(([word, sym]) => (
              <button key={word} type="button" onClick={() => key(sym)} className={cn(KEY, "bg-soft active:bg-soft-strong")}>
                {word}
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            <Tip label="Phone keyboard" hint="Covers the lower half">
              <Button
                variant="soft"
                size="icon-lg"
                aria-label="Phone keyboard"
                aria-pressed={typing}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  setSoft(false);
                  if (document.activeElement === typist.current) typist.current?.blur();
                  else typist.current?.focus({ preventScroll: true });
                }}
                className={cn(typing && "bg-mint text-mint-ink hover:bg-mint")}
              >
                <DeviceMobileIcon weight="bold" size={22} />
              </Button>
            </Tip>
            <Tip label="negi keyboard" hint="Sits under the screen">
              <Button
                variant="soft"
                size="icon-lg"
                aria-label="negi keyboard"
                aria-pressed={soft}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  typist.current?.blur();
                  setSoft(!soft);
                }}
                className={cn(soft && "bg-mint text-mint-ink hover:bg-mint")}
              >
                <KeyboardIcon weight="bold" size={22} />
              </Button>
            </Tip>
          </div>
        </div>
      )}
      {phase.is === "showing" && touch && soft && <SoftKeys press={key} symOf={symOf} />}
    </main>
  );
}
