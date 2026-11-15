import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { useApp } from "@/lib/store";
import { AppPage, Root } from "@/app/pages";
import { PairPage } from "@/features/pair/PairPage";
import { ScreenPage } from "@/features/screen/ScreenPage";

/** Everything but pairing needs a device key. */
const paired = () => {
  if (!useApp.getState().token) throw redirect({ to: "/pair" });
};

const rootRoute = createRootRoute({ component: Root });
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", beforeLoad: paired, component: AppPage });
const paneRoute = createRoute({ getParentRoute: () => rootRoute, path: "/pane/$pane", beforeLoad: paired, component: AppPage });
const screenRoute = createRoute({ getParentRoute: () => rootRoute, path: "/screen", beforeLoad: paired, component: ScreenPage });
const pairRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pair",
  beforeLoad: () => {
    if (useApp.getState().token) throw redirect({ to: "/" });
  },
  component: PairPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, paneRoute, screenRoute, pairRoute]),
  defaultPreload: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
