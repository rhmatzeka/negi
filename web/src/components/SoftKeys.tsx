import { ArrowUDownLeftIcon, ArrowFatUpIcon, BackspaceIcon } from "@phosphor-icons/react";
import { type ReactNode, useRef, useState } from "react";
import { repeats } from "@/lib/repeat";
import { cn } from "@/lib/utils";

const BACK = 0xff08;
const ENTER = 0xff0d;

const LETTERS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const NUMBERS = ["1234567890", "-/:;()$&@\"", ".,?!'"];
const SYMBOLS = ["[]{}#%^*+=", "_\\|~<>`€£•", ".,?!'"];

type Layer = "abc" | "123" | "#+=";

interface SoftKeysProps {
  /** Sends one keysym, with whatever modifiers the key row has latched. */
  press: (sym: number) => void;
  /** The keysym of a typed character. */
  symOf: (char: string) => number;
}

/** A keyboard under the screen instead of over it. Shift lasts one letter; twice is caps lock. */
export function SoftKeys({ press, symOf }: SoftKeysProps) {
  const [layer, setLayer] = useState<Layer>("abc");
  const [shift, setShift] = useState<"off" | "once" | "lock">("off");
  const lastShift = useRef(0);
  const rows = layer === "abc" ? LETTERS : layer === "123" ? NUMBERS : SYMBOLS;

  const type = (char: string) => {
    const upper = layer === "abc" && shift !== "off";
    press(symOf(upper ? char.toUpperCase() : char));
    if (shift === "once") setShift("off");
  };
  const tapShift = () => {
    const now = performance.now();
    if (shift === "once" && now - lastShift.current < 350) setShift("lock");
    else setShift(shift === "off" ? "once" : "off");
    lastShift.current = now;
  };

  const shown = (char: string) => (layer === "abc" && shift !== "off" ? char.toUpperCase() : char);
  return (
    <div role="group" aria-label="Keyboard" className="grid shrink-0 gap-1.5 select-none land:gap-1" onPointerDown={(e) => e.preventDefault()}>
      <Row>
        {[...rows[0]].map((c) => (
          <Key key={c} label={shown(c)} onPress={() => type(c)} />
        ))}
      </Row>
      <Row inset={layer === "abc"}>
        {[...rows[1]].map((c) => (
          <Key key={c} label={shown(c)} onPress={() => type(c)} />
        ))}
      </Row>
      <Row>
        {layer === "abc" ? (
          <Key wide label={<ArrowFatUpIcon weight={shift === "off" ? "bold" : "fill"} size={18} />} name={shift === "lock" ? "Caps lock on" : "Shift"} pressed={shift !== "off"} onPress={tapShift} className={cn(shift === "lock" && "underline decoration-2 underline-offset-4")} />
        ) : (
          <Key wide label={layer === "123" ? "#+=" : "123"} name={layer === "123" ? "More symbols" : "Numbers"} onPress={() => setLayer(layer === "123" ? "#+=" : "123")} small />
        )}
        {[...rows[2]].map((c) => (
          <Key key={c} label={shown(c)} onPress={() => type(c)} />
        ))}
        <Key wide label={<BackspaceIcon weight="bold" size={19} />} name="Delete" repeat={() => press(BACK)} />
      </Row>
      <Row>
        <Key wide label={layer === "abc" ? "123" : "abc"} name={layer === "abc" ? "Numbers and symbols" : "Letters"} onPress={() => setLayer(layer === "abc" ? "123" : "abc")} small />
        <Key label="space" onPress={() => press(0x20)} className="flex-[5] text-xs text-muted-foreground" />
        <Key wide label={<ArrowUDownLeftIcon weight="bold" size={19} />} name="Return" onPress={() => press(ENTER)} className="flex-[1.6] bg-mint text-mint-ink active:bg-mint/80" />
      </Row>
    </div>
  );
}

function Row({ children, inset }: { children: ReactNode; inset?: boolean }) {
  return <div className={cn("flex gap-1.5", inset && "px-[5%]")}>{children}</div>;
}

interface KeyProps {
  label: ReactNode;
  name?: string;
  onPress?: () => void;
  /** Pressed again and again while held, as Delete is. */
  repeat?: () => void;
  wide?: boolean;
  small?: boolean;
  pressed?: boolean;
  className?: string;
}

function Key({ label, name, onPress, repeat, wide, small, pressed, className }: KeyProps) {
  return (
    <button
      type="button"
      aria-label={name}
      aria-pressed={pressed}
      {...(repeat ? repeats(repeat) : { onClick: onPress })}
      className={cn(
        "grid h-11 min-w-0 flex-1 place-items-center rounded-sm bg-soft font-mono text-[15px] font-semibold active:bg-soft-strong land:h-8",
        wide && "flex-[1.4]",
        small && "text-xs",
        pressed && "bg-mint text-mint-ink active:bg-mint/80",
        className,
      )}
    >
      {label}
    </button>
  );
}
