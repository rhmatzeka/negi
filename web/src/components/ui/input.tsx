import * as React from "react"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      className={cn(
        "h-ctl-lg w-full min-w-0 rounded-md border border-input bg-soft px-4 text-base font-medium outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:shadow-[inset_0_0_0_1px_var(--ring)] disabled:opacity-50 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
