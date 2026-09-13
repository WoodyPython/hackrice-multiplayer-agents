import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { Eyebrow } from "./ui/misc";

export function PageHeading({
  eyebrow,
  title,
  description,
  badge,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Sits above the title, for a status the page is entirely about. */
  badge?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-7 flex flex-col gap-5 sm:mb-9 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0 space-y-2">
        {badge}
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.03em] text-balance sm:text-[30px]">
          {title}
        </h1>
        {description && (
          <p className="max-w-2xl text-[13.5px] text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2.5">
          {actions}
        </div>
      )}
    </header>
  );
}

/** The "← back" affordance that sits above a page heading. */
export function BackLink({
  to,
  children,
}: {
  to: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className="mb-5 inline-flex items-center gap-1.5 rounded-md text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      {children}
    </Link>
  );
}
