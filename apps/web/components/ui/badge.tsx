import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", {
  variants: {
    variant: {
      default: "border-transparent bg-navy text-white",
      outline: "border-line bg-card text-muted",
      ready: "border-transparent bg-[#ece7df] text-ink",
      progress: "border-transparent bg-[#f8efd8] text-[#8a5a10]",
      done: "border-transparent bg-[#e5f0e6] text-moss",
      risk: "border-clay bg-[#f8e8e4] text-clay",
    },
  },
  defaultVariants: { variant: "default" },
});

export function Badge({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
