import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  className?: string;
}

/** An on/off switch: a real checkbox underneath, so it is reached and toggled from the keyboard. */
export function Switch({ checked, onChange, label, className }: SwitchProps) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} className="peer absolute inset-0 z-10 cursor-pointer opacity-0" />
      <span
        aria-hidden
        className="relative h-7 w-12 rounded-full bg-soft-strong transition-colors duration-300 peer-checked:bg-mint peer-focus-visible:ring-2 peer-focus-visible:ring-ring after:absolute after:top-1 after:left-1 after:size-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform after:duration-300 after:ease-spring peer-checked:after:translate-x-5"
      />
    </span>
  );
}
