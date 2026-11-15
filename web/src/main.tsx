import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app/setup";
import "./index.css";
import { useApp } from "./lib/store";
import { router } from "./app/router";
import { registerSW } from "virtual:pwa-register";
import { fitEdges } from "./lib/edges";

// Development only: `?demo` shows the interface on sample data, with no Mac and no
// pairing. `?demo=empty`, `connecting`, `unreachable` and `lost` show the other states.
const query = new URLSearchParams(location.search);
const demo = query.get("demo");
// `&os=linux` shows the key row as a host that is not a Mac would label it.
const demoOs = query.get("os") ?? "macos";
if (import.meta.env.DEV && (demo !== null || useApp.getState().token === "demo")) {
  void import("./connection/demo").then((m) => m.startDemo(demo || "sessions", demoOs));
}

fitEdges();

// Keeps the page and its files on the phone, so it opens at once and says so when the Mac
// cannot be reached, instead of the browser's own error.
if (import.meta.env.PROD) registerSW({ immediate: true });

const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
