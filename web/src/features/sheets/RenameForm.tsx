import { CheckIcon } from "@phosphor-icons/react";
import { useForm } from "@tanstack/react-form";
import { z } from "zod";
import { ConfirmButton } from "@/components/Confirm";
import { Tip } from "@/components/Tip";
import { edit } from "@/lib/form";
import { ErrorBubble } from "@/components/Field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const nameSchema = z.object({ name: z.string().trim().min(1, "A name has 1 to 64 characters").max(64, "A name has 1 to 64 characters") });

/** A name field with its save button on the same line. */
export function RenameForm({ label, value, onSave }: { label: string; value: string; onSave: (name: string) => Promise<unknown> }) {
  const form = useForm({
    defaultValues: { name: value },
    validators: { onSubmit: nameSchema },
    onSubmit: ({ value }) => onSave(value.name.trim()),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(field) => {
          const error = (field.state.meta.errors[0] as { message?: string } | undefined)?.message;
          return (
            <div className="grid gap-1.5">
              <Label htmlFor="rename" className="pl-1 font-semibold">
                {label}
              </Label>
              {/* The field and its button share one row, so they line up whatever the label does. */}
              <div className="flex items-center gap-2">
                <ErrorBubble message={error} className="flex-1">
                  <Input id="rename" value={field.state.value} onChange={(e) => edit(field, e.target.value)} onBlur={field.handleBlur} aria-invalid={error ? true : undefined} />
                </ErrorBubble>
                <Tip label="Save name" hint="Press twice to rename">
                  <ConfirmButton size="icon-lg" aria-label="Save name" confirmLabel="Tap again" onConfirm={() => form.handleSubmit()}>
                    <CheckIcon weight="bold" size={22} />
                  </ConfirmButton>
                </Tip>
              </div>
            </div>
          );
        }}
      </form.Field>
    </form>
  );
}
