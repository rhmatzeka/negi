import { PlusIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { z } from "zod";
import { ConfirmButton } from "@/components/Confirm";
import { TextField } from "@/components/Field";
import { Tile } from "@/components/Tile";
import { useAsk } from "@/connection/api";
import { Frame } from "./parts";
import { close, useOpenPane } from "./shared";

const sessionSchema = z.object({ name: z.string().trim().max(64, "A name has at most 64 characters"), folder: z.string().trim() });

export function NewSession() {
  const ask = useAsk();
  const openPane = useOpenPane();
  const [error, setError] = useState("");
  const form = useForm({
    defaultValues: { name: "", folder: "" },
    validators: { onSubmit: sessionSchema },
    onSubmit: async ({ value }) => {
      setError("");
      try {
        // The folder is checked on the Mac, the only place that knows whether it exists.
        const made = await ask.mutateAsync({ t: "new-session", name: value.name.trim() || null, cwd: value.folder.trim() || null });
        close();
        if (made.pane) void openPane(made.pane);
      } catch (e) {
        setError((e as Error).message);
      }
    },
  });
  return (
    <Frame title="New session" lead={<Tile icon={PlusIcon} tone="accent" seed="new" size="sm" />}>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="name">{(field) => <TextField field={field} label="Name" placeholder="Optional" />}</form.Field>
        <form.Field name="folder">
          {(field) => <TextField field={field} label="Folder" problem={error} onEdit={() => error && setError("")} placeholder="~/projects/app" inputMode="url" hint="Leave empty to start in your home folder." />}
        </form.Field>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(busy) => (
            <ConfirmButton disabled={busy} className="w-full" confirmLabel="Tap again to start" onConfirm={() => form.handleSubmit()}>
              <TerminalWindowIcon weight="fill" size={20} />
              {busy ? "Starting…" : "Start session"}
            </ConfirmButton>
          )}
        </form.Subscribe>
      </form>
    </Frame>
  );
}
