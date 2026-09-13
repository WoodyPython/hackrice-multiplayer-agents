import { cn } from "../lib/utils";

/**
 * The CoFlow mark: a checklist page with a flow bar alongside it.
 *
 * Drawn rather than shipped as a file so it inherits `currentColor` — the same
 * mark reads correctly on the light canvas, inside the navy sidebar, and in
 * dark mode without three copies of the asset.
 */
export function LogoMark({ className }: { className?: string }) {
  const rows = [8, 13.6, 19.2, 24.8];
  return (
    <svg
      viewBox="0 0 26 32"
      fill="none"
      role="presentation"
      aria-hidden="true"
      className={cn("size-6", className)}
    >
      <g
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x={1} y={2} width={18} height={28} rx={3.5} />
        <path d="M24.5 2.8v26.4" />
        {rows.map((y) => (
          <g key={y}>
            <path d={`M5 ${y} l1.9 2 l3.4 -4`} />
            <path d={`M12.6 ${y - 0.3} h4.2`} />
          </g>
        ))}
      </g>
    </svg>
  );
}

/**
 * Mark plus wordmark. `tone="invert"` is for the navy sidebar, where the mark
 * sits on the brand colour rather than on the canvas.
 */
export function Wordmark({
  className,
  size = "default",
  tone = "default",
  showText = true,
}: {
  className?: string;
  size?: "sm" | "default" | "lg";
  tone?: "default" | "invert";
  showText?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2.5",
        tone === "invert" ? "text-white" : "text-navy-800 dark:text-navy-100",
        className,
      )}
    >
      <LogoMark
        className={cn(
          size === "sm" && "size-5",
          size === "default" && "size-6",
          size === "lg" && "size-8",
        )}
      />
      {showText && (
        <span
          className={cn(
            "font-display font-semibold tracking-[-0.03em]",
            size === "sm" && "text-base",
            size === "default" && "text-lg",
            size === "lg" && "text-2xl",
          )}
        >
          CoFlow
        </span>
      )}
    </span>
  );
}
