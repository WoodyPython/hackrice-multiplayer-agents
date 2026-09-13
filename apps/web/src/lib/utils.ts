import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class lists, letting later Tailwind utilities win. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Two-letter monogram for an avatar, from a display name. */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * "3 hours ago", for timestamps a reader scans rather than reads.
 *
 * A workspace list is compared, not audited: "2 days ago" answers "is this the
 * one I was in on Friday" at a glance, where a formatted date makes the reader
 * do the arithmetic. Anything older than a week becomes a date, because by then
 * the elapsed time has stopped meaning anything and the date starts to.
 *
 * `Intl.RelativeTimeFormat` rather than a hand-rolled table so it is correct in
 * the reader's locale, including languages where the plural rules are not
 * "add an s".
 */
export function relativeTime(value: string | Date, now = new Date()): string {
  const then = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(then.getTime())) return "";
  const seconds = Math.round((then.getTime() - now.getTime()) / 1000);
  const magnitude = Math.abs(seconds);
  if (magnitude < 45) return "just now";
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86_400],
  ] as const) {
    if (magnitude < size * (unit === "minute" ? 60 : unit === "hour" ? 24 : 7)) {
      return format.format(Math.round(seconds / size), unit);
    }
  }
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    // A year only when it is not this one: "12 Mar 2025" in March 2025 is noise.
    ...(then.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}
