import { useEffect, useState } from "react";
import { Check, Link2 } from "lucide-react";
import { contributionLink } from "../workspace-api";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/field";

/**
 * Hands out the contribution link.
 *
 * The clipboard API is refused in plenty of ordinary situations — an insecure
 * origin, a denied permission, a browser that only allows it inside a trusted
 * gesture it did not recognise — so a failure falls back to a selectable field
 * rather than leaving the reader with a button that silently does nothing.
 */
export function ShareWorkspace({ id, compact = false }: { id: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const link = contributionLink(id);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="share-workspace relative shrink-0">
      <Button className={compact ? "size-9 p-0" : "w-48"} title={copied ? "Link copied" : "Copy workspace link"} aria-label="Copy workspace link"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
            setManual(false);
          } catch {
            setManual(true);
            setCopied(false);
          }
        }}
      >
        {copied ? (
          <Check aria-hidden="true" className="text-emerald-600" />
        ) : (
          <Link2 aria-hidden="true" />
        )}
        <span role="status" className={compact ? "sr-only" : undefined}>{copied ? "Link copied" : "Copy workspace link"}</span>
      </Button>

      {manual && (
        <div className="absolute right-0 top-full z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] space-y-1.5 rounded-xl border border-border bg-card p-3 shadow-lg sm:w-80">
          <Label htmlFor="contribution-link">Copy this contribution link</Label>
          <Input
            id="contribution-link"
            readOnly
            value={link}
            onFocus={(event) => event.target.select()}
            className="font-mono text-[11.5px]"
          />
        </div>
      )}
    </div>
  );
}
