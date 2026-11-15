import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// Three heights and nothing else: 36, 44 and 52 px. Every button is a pill or a circle.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-full font-semibold whitespace-nowrap select-none transition-[transform,background-color,filter] duration-500 ease-spring active:scale-95 active:duration-75 disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:brightness-110",
        soft: "bg-soft text-foreground hover:bg-soft-strong",
        accent: "bg-hero text-hero-ink hover:brightness-105",
        ghost: "text-foreground hover:bg-soft",
        destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
      },
      size: {
        default: "h-ctl-lg gap-2 px-6 text-base",
        md: "h-ctl gap-2 px-4 text-sm",
        sm: "h-ctl-sm gap-1.5 px-3 text-sm",
        icon: "size-ctl",
        "icon-lg": "size-ctl-lg",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  type = "button",
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
