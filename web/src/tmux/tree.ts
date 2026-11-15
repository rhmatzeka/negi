// What tmux has, as the server describes it.

export interface Pane {
  id: string;
  index: number;
  active: boolean;
  cols: number;
  rows: number;
  command: string;
  path: string;
  title: string;
}

export interface Window {
  id: string;
  index: number;
  name: string;
  active: boolean;
  panes: Pane[];
}

export interface Session {
  id: string;
  name: string;
  /** Shown by a real terminal on the Mac right now. */
  attached: boolean;
  windows: Window[];
}

interface Located {
  session: Session;
  window: Window;
  pane: Pane;
}

export function findPane(sessions: Session[], id: string): Located | null {
  for (const session of sessions)
    for (const window of session.windows)
      for (const pane of window.panes) if (pane.id === id) return { session, window, pane };
  return null;
}

export function activePane(window: Window): Pane {
  return window.panes.find((p) => p.active) ?? window.panes[0];
}

/** The pane a session's row opens: the one last opened here, else tmux's active pane, which
 * follows the desk and not the phone. */
export function previewPane(session: Session, last?: Record<string, string>): Pane | undefined {
  const remembered = last?.[session.id];
  if (remembered) {
    for (const window of session.windows) {
      const pane = window.panes.find((p) => p.id === remembered);
      if (pane) return pane;
    }
  }
  const window = session.windows.find((w) => w.active) ?? session.windows[0];
  return window && activePane(window);
}

export function sessionBusy(session: Session, busy: string[]): boolean {
  return session.windows.some((w) => w.panes.some((p) => busy.includes(p.id)));
}

/** Pane ids look like `%3`. Routes carry the number alone, so no URL needs escaping. */
export const paneParam = (id: string) => id.slice(1);
export const paneId = (param: string) => `%${param}`;

/** The last two parts of a folder, which is what tells two panes apart. */
export function shortPath(path: string): string {
  // A home folder is written the way a shell prompt writes it.
  const short = path.replace(/^\/(Users|home)\/[^/]+/, "~");
  const parts = short.split("/").filter(Boolean);
  return parts.length <= 2 ? short : `…/${parts.slice(-2).join("/")}`;
}

/** Programs that are a prompt: what they last printed says what is going on in them. */
export const isShell = (command: string | undefined) => /^(zsh|bash|sh|fish|dash|nu)$/.test(command ?? "");
