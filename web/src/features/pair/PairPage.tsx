import { CheckIcon, CircleNotchIcon, CopyIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { type ClipboardEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Mark } from "@/components/Mark";
import { ThemeToggle } from "@/components/Toggles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePair } from "@/connection/api";
import { Peek } from "@/features/sessions/Peek";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const LENGTH = 8;

/** What a person would call this browser: "Safari on iPhone", "Chrome on Mac", or "negi app
 * on iPhone" once it is installed, which keeps its own pairing apart from the browser's. */
function deviceName(): string {
  const ua = navigator.userAgent;
  const installed = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const app = installed ? "negi app" : /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [app, device].filter(Boolean).join(" on ") || "This browser";
}

/** Only the letters and digits a code can hold, in capitals. */
const clean = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, LENGTH);

export function PairPage() {
  const pair = usePair();
  const notice = useApp((s) => s.notice);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState(deviceName);
  const [copied, setCopied] = useState(false);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const problem = pair.error?.message ?? notice;
  const sent = useRef("");

  const edit = (next: string) => {
    if (pair.error) pair.reset();
    if (notice) useApp.setState({ notice: "" });
    setCode(next);
  };
  const submit = (value = code) => {
    if (value.length !== LENGTH || !label.trim() || pair.isPending) return;
    sent.current = value;
    pair.mutate({ code: `${value.slice(0, 4)}-${value.slice(4)}`, label: label.trim() });
  };
  // A full code goes at once, as a one-time code does; a refused one is not sent again unchanged.
  useEffect(() => {
    if (code.length === LENGTH && code !== sent.current) submit(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const focus = (i: number) => boxes.current[Math.max(0, Math.min(LENGTH - 1, i))]?.focus();
  const typeAt = (i: number, text: string) => {
    const chars = clean(text);
    if (!chars) return;
    const next = (code.slice(0, i) + chars).slice(0, LENGTH);
    edit(next);
    focus(next.length);
  };
  const key = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      const at = code[i] ? i : i - 1;
      if (at < 0) return;
      edit(code.slice(0, at));
      focus(at);
    } else if (e.key === "ArrowLeft") focus(i - 1);
    else if (e.key === "ArrowRight") focus(i + 1);
    else if (e.key === "Enter") submit();
  };
  const paste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const chars = clean(e.clipboardData.getData("text"));
    edit(chars);
    focus(chars.length);
  };

  return (
    <main className="slim-scroll flex h-full flex-col overflow-auto overscroll-none px-4 pt-[max(16px,var(--safe-top))] pb-[max(16px,env(safe-area-inset-bottom))] md:grid md:place-items-center md:py-6">
      {/* On a phone the two cards fill the screen, Pair at the bottom under the thumb; wider, they sit side by side in the middle. */}
      <div className="grid w-full max-w-[880px] flex-1 grid-rows-[auto_1fr] gap-4 md:flex-none md:grid-cols-[1fr_1fr] md:grid-rows-none md:items-stretch">
        <section aria-label="negi" className="relative isolate min-h-[230px] overflow-hidden rounded-xl bg-hero px-6 pt-6 pb-6 text-hero-ink md:min-h-[440px]">
          <span aria-hidden className="absolute -top-20 -right-12 -z-10 size-60 rounded-full bg-hero-ink/[0.07]" />
          <span aria-hidden className="absolute top-14 -right-28 -z-10 size-72 rounded-full bg-hero-ink/[0.05]" />
          <div className="flex items-center gap-2.5">
            <Mark size={36} />
            <span className="text-xl font-bold tracking-tight">negi</span>
            <span className="ml-auto [&_button]:bg-hero-ink/10 [&_button]:text-hero-ink [&_button]:hover:bg-hero-ink/15">
              <ThemeToggle />
            </span>
          </div>
          <h1 className="mt-6 max-w-[62%] text-[30px] leading-[1.08] font-semibold text-balance md:mt-10 md:text-[40px]">Your Mac, in your pocket</h1>
          <p className="mt-2 max-w-[55%] text-[15px] font-medium opacity-80">Terminals and the screen, from this phone.</p>
          <Peek className="absolute -right-5 bottom-0 w-[50%] max-w-[230px] translate-y-[6%] md:w-[62%] md:max-w-[300px]" />
        </section>

        <section className="flex flex-col gap-5 rounded-xl bg-card p-5 md:justify-center md:p-7">
          <h2 className="text-2xl font-semibold">Pair this device</h2>

          <Step n={1} title="On your Mac, run">
            <div className="flex items-center gap-2">
              <code className="flex h-ctl flex-1 items-center rounded-sm bg-soft px-4 font-mono text-[15px] font-bold">
                <span className="mr-2 text-muted-foreground select-none">$</span>negi pair
              </code>
              <Button
                variant="soft"
                size="icon"
                aria-label={copied ? "Copied" : "Copy the command"}
                onClick={() =>
                  void navigator.clipboard.writeText("negi pair").then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  })
                }
              >
                {copied ? <CheckIcon weight="bold" size={18} className="text-mint" /> : <CopyIcon weight="bold" size={18} />}
              </Button>
            </div>
          </Step>

          <Step n={2} title="Type the code it shows">
            <div role="group" aria-label="Pairing code" className="flex items-center justify-between gap-1.5" onClick={() => focus(Math.min(code.length, LENGTH - 1))}>
              {Array.from({ length: LENGTH }, (_, i) => (
                <div key={i} className="contents">
                  {i === 4 && <span aria-hidden className="w-2 shrink-0 text-center text-xl font-bold text-muted-foreground">-</span>}
                  <input
                    ref={(el) => {
                      boxes.current[i] = el;
                    }}
                    aria-label={`Character ${i + 1}`}
                    value={code[i] ?? ""}
                    inputMode="text"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    autoComplete={i === 0 ? "one-time-code" : "off"}
                    spellCheck={false}
                    maxLength={LENGTH}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      // Typed into a filled box without selecting it: the old letter is still there first.
                      typeAt(i, code[i] && v.length > 1 && v.toUpperCase().startsWith(code[i]) ? v.slice(1) : v);
                    }}
                    onKeyDown={key(i)}
                    onPaste={paste}
                    onFocus={(e) => e.currentTarget.select()}
                    className={cn(
                      "h-14 w-full min-w-0 rounded-sm bg-soft text-center font-mono text-2xl font-bold uppercase outline-none transition-[box-shadow,background-color] focus:bg-soft-strong focus:shadow-[0_0_0_2px_var(--ring)]",
                      problem && "shadow-[0_0_0_2px_var(--destructive)]",
                    )}
                  />
                </div>
              ))}
            </div>
            {problem && (
              <p role="alert" className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                <WarningCircleIcon weight="fill" size={16} />
                {problem}
              </p>
            )}
          </Step>

          <label className="grid gap-1.5">
            <span className="pl-1 text-xs font-bold text-muted-foreground">This device is called</span>
            <Input value={label} maxLength={40} onChange={(e) => setLabel(e.currentTarget.value)} />
          </label>

          <Button disabled={code.length !== LENGTH || !label.trim() || pair.isPending} onClick={() => submit()} className="mt-auto w-full md:mt-0">
            {pair.isPending && <CircleNotchIcon weight="bold" size={18} className="animate-spin" />}
            {pair.isPending ? "Pairing" : "Pair"}
          </Button>
        </section>
      </div>
    </main>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <p className="flex items-center gap-2 font-semibold">
        <span className="grid size-6 place-items-center rounded-full bg-mint text-xs font-bold text-mint-ink">{n}</span>
        {title}
      </p>
      {children}
    </div>
  );
}
