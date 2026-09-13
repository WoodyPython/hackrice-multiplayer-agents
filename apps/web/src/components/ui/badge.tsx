import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral:
          "border-ink-200 bg-ink-50 text-ink-600 dark:border-ink-700 dark:bg-ink-800/50 dark:text-ink-300",
        info: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-300",
        warn: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300",
        review:
          "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-300",
        done: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300",
        danger:
          "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300",
        brand:
          "border-navy-200 bg-navy-50 text-navy-800 dark:border-navy-800 dark:bg-navy-950/60 dark:text-navy-200",
      },
      size: {
        sm: "px-1.5 py-0.5 text-[10px]",
        default: "px-2 py-0.5 text-[11px]",
      },
    },
    defaultVariants: { tone: "neutral", size: "default" },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, size, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...props} />
  );
}

const DOT_TONE: Record<NonNullable<BadgeProps["tone"]> & string, string> = {
  neutral: "bg-ink-400",
  info: "bg-sky-500",
  warn: "bg-amber-500",
  review: "bg-violet-500",
  done: "bg-emerald-500",
  danger: "bg-red-500",
  brand: "bg-navy-600",
};

/** A small state dot, optionally pulsing while something is genuinely live. */
export function Dot({
  tone = "neutral",
  live = false,
  className,
}: {
  tone?: NonNullable<BadgeProps["tone"]>;
  live?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        DOT_TONE[tone],
        live && "animate-[pulse-dot_2s_ease-in-out_infinite]",
        className,
      )}
    />
  );
}
