// What the sheets share that is not a component: how one closes, which title part its
// container wants, and how to go to a pane.

import { useNavigate } from "@tanstack/react-router";
import { createContext } from "react";
import { DialogTitle } from "@/components/ui/dialog";
import { DrawerTitle } from "@/components/ui/drawer";
import { useApp } from "@/lib/store";
import { paneParam } from "@/tmux/tree";

export const close = () => useApp.getState().openSheet(null);

// A sheet's title has to be the title part of whichever container holds it.
export const Title = createContext<typeof DrawerTitle | typeof DialogTitle>(DrawerTitle);

export function useOpenPane() {
  const navigate = useNavigate();
  return (pane: string) => navigate({ to: "/pane/$pane", params: { pane: paneParam(pane) }, viewTransition: true });
}
