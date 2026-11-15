import type { AnyFieldApi } from "@tanstack/react-form";

/** Takes a new value into a field and drops the error about the old one. */
export function edit(field: AnyFieldApi, value: string) {
  field.handleChange(value);
  if (field.state.meta.errors.length) field.setMeta((meta) => ({ ...meta, errorMap: {}, errors: [] }));
}
