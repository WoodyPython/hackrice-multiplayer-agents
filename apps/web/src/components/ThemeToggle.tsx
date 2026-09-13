import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "../lib/utils";
import {
  applyTheme,
  readTheme,
  resolveTheme,
  watchSystemTheme,
  writeTheme,
  type ThemeChoice,
} from "../theme";

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/** Start with the system preference; explicit choices are light or dark. */
export function ThemeToggle({ className }: { className?: string }) {
  const [, setSystemRevision] = useState(0);
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    const stored = readTheme();
    setChoice(stored);
    applyTheme(stored);
  }, []);

  useEffect(
    () => watchSystemTheme(() => { if (choice === "system") { applyTheme("system"); setSystemRevision((value) => value + 1); } }),
    [choice],
  );

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5",
        className,
      )}
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={resolveTheme(choice) === value}
          tabIndex={resolveTheme(choice) === value ? 0 : -1}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "light" : event.key === "End" ? "dark" : value === "light" ? "dark" : "light";
            setChoice(next);
            writeTheme(next);
            const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button");
            buttons?.[next === "light" ? 0 : 1]?.focus();
          }}
          aria-label={label}
          title={label}
          onClick={() => {
            setChoice(value);
            writeTheme(value);
          }}
          className={cn(
            "grid size-9 place-items-center rounded-md transition-colors",
            resolveTheme(choice) === value
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
