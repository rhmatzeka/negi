import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useResolvedTheme } from "@/lib/theme"
import { CheckCircleIcon, InfoIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react"

const Toaster = (props: ToasterProps) => (
  <Sonner
    theme={useResolvedTheme()}
    // At the top: the bottom of a pane is where the keys and the typing are.
    position="top-center"
    offset={{ top: "max(12px, var(--safe-top))" }}
    mobileOffset={{ top: "max(12px, var(--safe-top))" }}
    icons={{
      success: <CheckCircleIcon weight="fill" className="size-5" />,
      info: <InfoIcon weight="fill" className="size-5" />,
      warning: <WarningIcon weight="fill" className="size-5" />,
      error: <XCircleIcon weight="fill" className="size-5" />,
    }}
    toastOptions={{
      classNames: {
        // A card, not a pill: a title, and a line under it saying what happened next.
        toast: "!rounded-lg !border !border-border !bg-popover !text-popover-foreground !px-4 !py-3 !gap-3 !font-sans !shadow-[0_16px_48px_rgb(0_0_0/0.22)]",
        title: "!text-sm !font-semibold !leading-tight",
        description: "!text-xs !font-medium !text-muted-foreground !leading-snug",
        icon: "!m-0 !size-9 !shrink-0",
      },
    }}
    {...props}
  />
)

export { Toaster }
