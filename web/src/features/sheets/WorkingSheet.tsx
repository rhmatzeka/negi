// Every pane at work right now, from the card's "working" count; one tap opens it.

import { PulseIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { Tile } from "@/components/Tile";
import { router } from "@/app/router";
import { useApp } from "@/lib/store";
import { programIcon } from "@/tmux/programs";
import { paneParam, shortPath } from "@/tmux/tree";
import { Frame, Group, Row } from "./parts";
import { close } from "./shared";

export function WorkingSheet() {
  const sessions = useApp((s) => s.sessions);
  const busy = useApp((s) => s.busy);
  const working = useMemo(
    () => sessions.flatMap((session) => session.windows.flatMap((window) => window.panes.filter((p) => busy.includes(p.id)).map((pane) => ({ session, window, pane })))),
    [sessions, busy],
  );
  return (
    <Frame title="Working now" lead={<Tile icon={PulseIcon} tone="accent" seed="working" size="sm" />}>
      {working.length === 0 ? (
        <p className="px-2 pb-2 text-sm text-muted-foreground">Nothing is working right now.</p>
      ) : (
        <Group>
          {working.map(({ session, window, pane }) => (
            <Row
              key={pane.id}
              icon={programIcon(pane.command)}
              tone="accent"
              label={`${session.name} · ${window.index} ${window.name}`}
              sub={[pane.command, shortPath(pane.path)].filter(Boolean).join(" · ")}
              onClick={() => {
                close();
                void router.navigate({ to: "/pane/$pane", params: { pane: paneParam(pane.id) }, viewTransition: true });
              }}
            />
          ))}
        </Group>
      )}
    </Frame>
  );
}
