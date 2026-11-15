import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { Tile } from "@/components/Tile";
import { useAsk } from "@/connection/api";
import { programIcon } from "@/tmux/programs";
import { useApp } from "@/lib/store";
import { previewPane } from "@/tmux/tree";
import { DangerRow, Frame, Group, Row } from "./parts";
import { close, useOpenPane } from "./shared";
import { RenameForm } from "./RenameForm";

export function SessionSheet({ id }: { id: string }) {
  const session = useApp((s) => s.sessions.find((x) => x.id === id));
  const last = useApp((s) => s.last);
  const ask = useAsk();
  const openPane = useOpenPane();
  if (!session) return null;
  return (
    <Frame title={session.name} lead={<Tile icon={programIcon(previewPane(session, last)?.command)} seed={session.name} size="sm" />}>
      <RenameForm label="Session name" value={session.name} onSave={(name) => ask.mutateAsync({ t: "rename-session", session: id, name }).then(close, () => {})} />
      <Group>
        <Row
          icon={PlusIcon}
          tone="accent"
          label="New window"
          sub="Opens beside the others in this session"
          confirm="Tap again to add"
          onClick={() =>
            ask.mutate({ t: "new-window", session: id }, { onSuccess: (made) => (close(), made.pane && void openPane(made.pane)) })
          }
        />
      </Group>
      <Group>
        <DangerRow icon={TrashIcon} label="Close session" sure="Tap again to close it all" onConfirm={() => ask.mutate({ t: "kill-session", session: id }, { onSuccess: close })} />
      </Group>
    </Frame>
  );
}
