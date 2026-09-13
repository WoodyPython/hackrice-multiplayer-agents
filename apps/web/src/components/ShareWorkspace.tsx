import { useState } from "react";
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
export function ShareWorkspace({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const link = contributionLink(id);
  return (
    <div className="share-workspace relative w-full sm:w-auto">
      <Button
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
        Copy workspace link
      </Button>

      {copied && (
        <small
          role="status"
          className="mt-1.5 block text-[11.5px] text-muted-foreground"
        >
          Link copied. Anyone with it can contribute.
        </small>
      )}

      {manual && (
        <div className="mt-2 w-full space-y-1.5 sm:w-80">
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
