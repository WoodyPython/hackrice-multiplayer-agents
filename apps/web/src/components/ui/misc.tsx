import type { HTMLAttributes, ReactNode } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { cn } from "../../lib/utils";
import { initials } from "../../lib/utils";

export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl bg-[linear-gradient(110deg,var(--color-muted)_25%,var(--color-card)_50%,var(--color-muted)_75%)] bg-[length:200%_100%] animate-[shimmer_1.8s_linear_infinite]",
        className,
      )}
      {...props}
    />
  );
}

/** Small uppercase kicker above a heading. */
export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "block text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Monospace path chip, used wherever a repository path is shown. */
export function Path({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <code
      className={cn(
        "rounded-md border border-border bg-muted/70 px-1.5 py-0.5 font-mono text-[11.5px] break-all text-foreground/80",
        className,
      )}
    >
      {children}
    </code>
  );
}

export function Avatar({
  name,
  color,
  className,
  size = "default",
}: {
  name: string;
  color?: string;
  className?: string;
  size?: "sm" | "default" | "lg";
}) {
  return (
    <span
      aria-hidden="true"
      style={color ? { color } : undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-secondary font-semibold text-secondary-foreground",
        size === "sm" && "size-5 text-[9px]",
        size === "default" && "size-7 text-[10px]",
        size === "lg" && "size-9 text-[12px]",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

/**
 * A callout for run-level explanation and other non-blocking notices.
 * `tone` is presentation only — the role the caller passes decides how it is
 * announced.
 */
export function Notice({
  title,
  children,
  tone = "info",
  className,
  ...props
}: {
  title?: ReactNode;
  children: ReactNode;
  tone?: "info" | "warn";
} & Omit<HTMLAttributes<HTMLDivElement>, "title">) {
  const Icon = tone === "warn" ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        "rounded-xl border p-4 sm:p-5",
        tone === "warn"
          ? "border-amber-300/70 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
          : "border-navy-200 bg-navy-50/70 dark:border-navy-800 dark:bg-navy-950/40",
        className,
      )}
      {...props}
    >
      <div className="flex gap-3">
        <Icon
          aria-hidden="true"
          className={cn(
            "mt-0.5 size-4 shrink-0",
            tone === "warn"
              ? "text-amber-700 dark:text-amber-400"
              : "text-navy-600 dark:text-navy-300",
          )}
        />
        <div className="min-w-0 flex-1 space-y-2">
          {title && <h3 className="text-[13px] font-semibold">{title}</h3>}
          <div className="space-y-2 text-[13px] text-muted-foreground [&_p]:m-0">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Inline error text, announced by the caller's role where it matters. */
export function ErrorText({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-[13px] text-destructive", className)} {...props}>
      {children}
    </p>
  );
}
