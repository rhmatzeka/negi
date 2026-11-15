// Every sheet in the app. One container is mounted at the root; the store says which sheet is in it.

import { useState, useSyncExternalStore } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { type SheetState, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { close, Title } from "./shared";
import { DeviceSheet } from "./DeviceSheet";
import { MacSheet } from "@/features/mac/MacSheet";
import { NewSession } from "./NewSession";
import { PaneSheet } from "./PaneSheet";
import { SessionSheet } from "./SessionSheet";

/** True from the width at which the app shows two columns. */
function useWide(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = matchMedia("(min-width: 768px)");
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => matchMedia("(min-width: 768px)").matches,
  );
}

/** A sheet comes up from the bottom edge on a phone, and is a dialog in the middle of a wider screen. */
export function Sheets() {
  const sheet = useApp((s) => s.sheet);
  const wide = useWide();
  // The container animates out after the store has cleared, so keep showing the last one.
  const [shown, setShown] = useState<SheetState>(sheet);
  if (sheet && sheet !== shown) setShown(sheet);
  const body = (
    <>
      {shown?.kind === "new-session" && <NewSession />}
      {shown?.kind === "session" && <SessionSheet id={shown.session} />}
      {shown?.kind === "pane" && <PaneSheet id={shown.pane} />}
      {shown?.kind === "device" && <DeviceSheet />}
      {shown?.kind === "mac" && <MacSheet />}
    </>
  );
  const onOpenChange = (open: boolean) => !open && close();
  if (wide) {
    return (
      <Dialog open={sheet !== null} onOpenChange={onOpenChange}>
        <DialogContent
          aria-describedby={undefined}
          showCloseButton={false}
          className={cn(
            "flex max-h-[calc(100dvh-48px)] w-full max-w-[440px] flex-col gap-0 rounded-xl border-0 bg-popover p-5 pt-2 shadow-[0_24px_80px_rgb(0_0_0/0.18)] sm:max-w-[440px]",
            // Its settings sit in two columns side by side when there is room.
            shown?.kind === "device" && "max-w-[720px] sm:max-w-[720px]",
          )}
        >
          <Title value={DialogTitle}>{body}</Title>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Drawer open={sheet !== null} onOpenChange={onOpenChange}>
      <DrawerContent aria-describedby={undefined} className="px-4 pb-[calc(20px+env(safe-area-inset-bottom))]">
        <Title value={DrawerTitle}>{body}</Title>
      </DrawerContent>
    </Drawer>
  );
}
