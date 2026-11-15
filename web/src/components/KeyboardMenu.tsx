// One keyboard button: it opens a small menu above it to choose the phone's own keyboard or
// negi's, which sits under the content instead of over it.

import { CheckIcon, DeviceMobileIcon, KeyboardIcon } from "@phosphor-icons/react";
import { Popover } from "radix-ui";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface KeyboardMenuProps {
  phone: boolean;
  negi: boolean;
  /** Called in the tap itself: iOS shows its keyboard only for a focus made in a gesture. */
  onPhone: () => void;
  onNegi: () => void;
}

export function KeyboardMenu({ phone, negi, onPhone, onNegi }: KeyboardMenuProps) {
  const [open, setOpen] = useState(false);
  const on = phone || negi;
  const choose = (pick: () => void) => () => {
    setOpen(false);
    pick();
  };
  const item = "flex min-h-ctl w-full items-center gap-3 rounded-sm px-3 text-left text-sm font-semibold hover:bg-soft-strong active:bg-soft-strong";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="soft"
          size="icon-lg"
          aria-label="Keyboard"
          aria-pressed={on}
          // Keeps the focus where it is, so the phone's keyboard stays up while the menu opens.
          onPointerDown={(e) => e.preventDefault()}
          className={cn(on && "bg-mint text-mint-ink hover:bg-mint")}
        >
          <KeyboardIcon weight="bold" size={22} />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-50 grid w-60 gap-0.5 rounded-lg bg-popover p-1.5 text-popover-foreground shadow-[0_16px_48px_rgb(0_0_0/0.28)]"
        >
          <button type="button" className={item} onClick={choose(onPhone)}>
            <DeviceMobileIcon weight="bold" size={20} />
            <span className="flex-1">
              Phone keyboard
              <small className="block text-xs font-medium text-muted-foreground">Can cover the lower half</small>
            </span>
            {phone && <CheckIcon weight="bold" size={16} className="text-mint" />}
          </button>
          <button type="button" className={item} onClick={choose(onNegi)}>
            <KeyboardIcon weight="bold" size={20} />
            <span className="flex-1">
              negi keyboard
              <small className="block text-xs font-medium text-muted-foreground">Sits under it, never over it</small>
            </span>
            {negi && <CheckIcon weight="bold" size={16} className="text-mint" />}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
