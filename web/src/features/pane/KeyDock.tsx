// The keys a phone keyboard lacks, and the field that types into the pane.

import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, CircleNotchIcon, type Icon, KeyboardIcon, PaperclipIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { type FormEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/Tip";
import { upload, useAsk } from "@/connection/api";
import { useApp } from "@/lib/store";
import { isMod, take, useKeyboard, useMods } from "./mods";
import { cn } from "@/lib/utils";

interface Key {
  /** The key as tmux names it, or a modifier that latches. */
  id: string;
  /** What a screen reader and the tooltip call it. */
  name: string;
  /** What it is for, when the name does not say. */
  hint?: string;
  /** Its face: a word, or an arrow. */
  word?: string;
  icon?: Icon;
  /** The sign a Mac keyboard prints for it, shown before the word. */
  sign?: string;
}

const ARROWS: Key[] = [
  { id: "Up", name: "Up", hint: "Up, or the previous command", icon: ArrowUpIcon },
  { id: "Down", name: "Down", hint: "Down, or the next command", icon: ArrowDownIcon },
  { id: "Left", name: "Left", icon: ArrowLeftIcon },
  { id: "Right", name: "Right", icon: ArrowRightIcon },
];

// A Mac's keys, most used first because a phone shows about seven before the row scrolls.
const MAC: Key[] = [
  { id: "Escape", name: "Escape", hint: "Cancel, or leave a mode", word: "esc" },
  { id: "Tab", name: "Tab", hint: "Complete what is typed. With shift, back one choice", word: "tab" },
  { id: "ctrl", name: "Control", hint: "Held for the next key only", word: "ctrl", sign: "⌃" },
  { id: "alt", name: "Option", hint: "Held for the next key only", word: "opt", sign: "⌥" },
  ...ARROWS,
  { id: "C-c", name: "Control C", hint: "Stop what is running", word: "⌃C" },
  { id: "shift", name: "Shift", hint: "Held for the next key only", word: "shift", sign: "⇧" },
  { id: "cmd", name: "Command", hint: "With ← → the line's ends, with delete the whole line, with K a clear screen", word: "cmd", sign: "⌘" },
  { id: "BSpace", name: "Delete", hint: "Deletes the character behind the cursor", word: "del" },
];

const PC: Key[] = [
  { id: "Escape", name: "Escape", hint: "Cancel, or leave a mode", word: "Esc" },
  { id: "Tab", name: "Tab", hint: "Complete what is typed. With Shift, back one choice", word: "Tab" },
  { id: "ctrl", name: "Control", hint: "Held for the next key only", word: "Ctrl" },
  { id: "alt", name: "Alt", hint: "Held for the next key only", word: "Alt" },
  { id: "shift", name: "Shift", hint: "Held for the next key only", word: "Shift" },
  ...ARROWS,
  { id: "BSpace", name: "Backspace", hint: "Deletes the character behind the cursor", word: "Bksp" },
  { id: "C-c", name: "Control C", hint: "Stop what is running", word: "^C" },
  { id: "PPage", name: "Page up", hint: "Scroll up a page", word: "PgUp" },
  { id: "NPage", name: "Page down", hint: "Scroll down a page", word: "PgDn" },
  { id: "Home", name: "Home", hint: "Start of the line", word: "Home" },
  { id: "End", name: "End", hint: "End of the line", word: "End" },
  { id: "DC", name: "Delete", hint: "Deletes the character ahead", word: "Del" },
];

export function KeyDock({ pane }: { pane: string }) {
  const ask = useAsk();
  // Keys are named the way the host's own keyboard names them.
  const mac = useApp((s) => s.os === "macos");
  const [text, setText] = useState("");
  // Modifiers latch, and apply to the next key or the next single character, typed here or straight into the terminal.
  const mods = useMods((s) => s.held);
  const latched = Object.values(mods).some(Boolean);
  const typing = useKeyboard((s) => s.typing);

  // A file from the phone is kept on the host, and its path is typed into the pane, with a
  // space after it and no Enter: a path is something to say more about.
  const picker = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const attach = async (files: File[]) => {
    if (!files.length) return;
    setSending(true);
    try {
      for (const file of files) {
        const path = await upload(file);
        await ask.mutateAsync({ t: "text", pane, text: `${path} `, enter: false });
      }
      toast(files.length === 1 ? "Sent" : `${files.length} files sent`, { description: "The path is on the line" });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const send = (key: string) => {
    const out = take(key);
    if (out) ask.mutate({ t: "keys", pane, keys: [out] });
    else toast("Command works with ← → delete and K here.");
  };

  const press = (id: string) => (isMod(id) ? useMods.getState().toggle(id) : send(id));

  // One character under a latched modifier is a key; nothing typed is a bare Enter; anything else is text and Enter.
  const submit = () => {
    if (latched && /^[!-~]$/.test(text)) send(text);
    else if (text === "") send("Enter");
    else ask.mutate({ t: "text", pane, text, enter: true });
    setText("");
  };

  return (
    <div className="grid shrink-0 grid-cols-[minmax(0,1fr)] gap-2">
      <div role="toolbar" aria-label="Keys" className="no-scrollbar flex min-w-0 touch-pan-x gap-1.5 overflow-x-auto">
        {(mac ? MAC : PC).map(({ id, name, hint, word, icon: Glyph, sign }) => {
          const on = isMod(id) && mods[id];
          return (
            <Tip key={id} label={name} hint={hint}>
              <button
                type="button"
                data-k={id}
                aria-label={isMod(id) ? `${name}, applies to the next key` : name}
                aria-pressed={isMod(id) ? on : undefined}
                onClick={() => press(id)}
                className={cn(
                  "flex h-ctl min-w-ctl shrink-0 items-center justify-center gap-1 rounded-sm px-3 font-mono text-sm font-bold",
                  // Only the ground fades on a press: scaling shifts the colour on a wide-gamut
                  // screen, and a fading label vanishes halfway, which reads as a blink.
                  "transition-[background-color] duration-150 ease-out active:duration-0",
                  // Solid colours only: fading through a see-through one flashes on the way to the latched colour.
                  on ? "bg-mint text-mint-ink active:bg-[color-mix(in_oklab,var(--mint)_84%,black)]" : "bg-soft hover:bg-soft-strong active:bg-[color-mix(in_oklab,var(--foreground)_24%,var(--soft))]",
                )}
              >
                {sign && <span className="font-sans text-base font-medium">{sign}</span>}
                {Glyph ? <Glyph weight="bold" size={18} /> : word}
              </button>
            </Tip>
          );
        })}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Text to type into the pane"
          placeholder="Type a command"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          className="h-ctl-lg min-w-0 flex-1 rounded-full border border-input bg-soft px-5 font-mono text-base font-medium outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
        />
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void attach([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <Tip label="Attach" hint="Sends a file to your Mac and types its path here">
          <Button variant="soft" size="icon-lg" aria-label="Attach a file" disabled={sending} onClick={() => picker.current?.click()}>
            {sending ? <CircleNotchIcon weight="bold" size={22} className="animate-spin" /> : <PaperclipIcon weight="bold" size={22} />}
          </Button>
        </Tip>
        <Tip label="Keyboard" hint="Type straight into the pane, key by key">
          <Button
            variant="soft"
            size="icon-lg"
            aria-label="Keyboard: type straight into the pane"
            aria-pressed={typing}
            // Keeps the focus where it is, so pressing it while typing puts the keyboard away.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => useKeyboard.getState().toggle()}
            className={cn(typing && "bg-mint text-mint-ink hover:bg-mint")}
          >
            <KeyboardIcon weight="bold" size={22} />
          </Button>
        </Tip>
        <Tip label="Send" hint="Types the text and presses Enter" keycap="↵">
          <Button type="submit" size="icon-lg" aria-label="Send and press Enter">
            <PaperPlaneTiltIcon weight="fill" size={22} />
          </Button>
        </Tip>
      </form>
    </div>
  );
}
