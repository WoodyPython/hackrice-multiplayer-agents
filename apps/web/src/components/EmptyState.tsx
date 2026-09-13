import type { ReactNode } from "react";
import { Inbox, type LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";

export function EmptyState({
  title,
  children,
  action,
  icon: Icon = Inbox,
  className,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl border border-dashed border-border bg-card/60 px-6 py-12 text-center",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="mb-4 grid size-11 place-items-center rounded-xl border border-navy-200/70 bg-navy-50 text-navy-700 dark:border-navy-800 dark:bg-navy-950/60 dark:text-navy-300"
      >
        <Icon className="size-5" />
      </span>
      <h2 className="text-[15px] font-semibold tracking-tight text-balance">
        {title}
      </h2>
      <p className="mt-2 max-w-md text-[13px] leading-relaxed text-muted-foreground text-pretty">
        {children}
      </p>
      {action && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          {action}
        </div>
      )}
    </div>
  );
}
