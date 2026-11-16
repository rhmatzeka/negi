// The socket itself. Mounted once, at the root; renders nothing.

import { useEffect, useState, useSyncExternalStore } from "react";
import * as socketLibrary from "react-use-websocket";
import { dropped, receive, setSender } from "@/connection/link";
import { useApp } from "@/lib/store";

// The package is CommonJS; depending on the bundler its hook arrives as the default
// export or one level deeper. Take whichever is the function.
const { ReadyState } = socketLibrary;
const nested = socketLibrary.default as unknown as { default?: typeof socketLibrary.default };
const useWebSocket = typeof socketLibrary.default === "function" ? socketLibrary.default : nested.default!;

/** How long a hidden page keeps its socket: a look at another app or Space and back costs no
 * reconnect, while a page left behind lets go, so the Mac keeps no control client for it. */
const HOLD_HIDDEN_MS = 5 * 60_000;

function usePageVisible(): boolean {
  return useSyncExternalStore(
    (notify) => {
      document.addEventListener("visibilitychange", notify);
      return () => document.removeEventListener("visibilitychange", notify);
    },
    () => !document.hidden,
  );
}

export function Link() {
  const token = useApp((s) => s.token);
  const visible = usePageVisible();
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (visible) return;
    const timer = setTimeout(() => setGone(true), HOLD_HIDDEN_MS);
    return () => {
      clearTimeout(timer);
      setGone(false);
    };
  }, [visible]);
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  // "demo" is the sample-data mode of a development build: there is no socket at all.
  const demo = token === "demo";
  const url = token && !demo && (visible || !gone) ? `${scheme}//${location.host}/api/ws` : null;

  const { sendJsonMessage, readyState } = useWebSocket(url, {
    onOpen: () => sendJsonMessage({ t: "hello", token: useApp.getState().token }, false),
    onMessage: (event) => receive(JSON.parse(event.data)),
    onClose: dropped,
    shouldReconnect: () => Boolean(useApp.getState().token),
    retryOnError: true,
    reconnectAttempts: Number.MAX_SAFE_INTEGER,
    reconnectInterval: (attempt) => Math.min(8000, 400 * 2 ** attempt),
  });

  useEffect(() => {
    if (demo) return;
    // `false`: never queue. A request made while disconnected fails at once instead of
    // being replayed, stale, after a reconnect.
    setSender(readyState === ReadyState.OPEN ? (message) => sendJsonMessage(message, false) : null);
    return () => {
      // Sample-data mode installs its own way out; leaving this effect must not remove it.
      if (useApp.getState().token !== "demo") setSender(null);
    };
  }, [demo, readyState, sendJsonMessage]);

  return null;
}
