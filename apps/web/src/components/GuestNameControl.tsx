import { useEffect, useRef, useState, type FormEvent } from "react";
import { Pencil } from "lucide-react";
import { guestLabelSchema } from "@app/contracts";
import { useBrowser, useGuest } from "../browser-context";
import { Button } from "./ui/button";
import { FieldError, Input, Label } from "./ui/field";
import { Avatar } from "./ui/misc";

export function GuestNameControl({ sidebar = false }: { sidebar?: boolean }) {
  const { session } = useBrowser();
  const guest = useGuest();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(guest.name);
  const [error, setError] = useState("");
  const container = useRef<HTMLDivElement>(null);

  // Dismiss on Escape or a click outside, like any other popover on the page.
  useEffect(() => {
    if (!editing) return;
    const key = (event: KeyboardEvent) =>
      event.key === "Escape" && setEditing(false);
    const away = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target)
      )
        setEditing(false);
    };
    window.addEventListener("keydown", key);
    document.addEventListener("mousedown", away);
    return () => {
      window.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", away);
    };
  }, [editing]);

  function save(event: FormEvent) {
    event.preventDefault();
    const result = guestLabelSchema.safeParse(name);
    if (!result.success) {
      setError("Enter a name between 1 and 80 characters.");
      return;
    }
    session.rename(result.data);
    setError("");
    setEditing(false);
  }

  return (
    <div ref={container} className="guest-control relative">
      <button
        type="button"
        onClick={() => {
          setName(guest.name);
          setError("");
          setEditing((value) => !value);
        }}
        aria-label={`Edit display name: ${guest.name}`}
        aria-expanded={editing}
        title="Edit display name"
        className={sidebar
          ? "grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          : "flex max-w-[220px] items-center gap-2 rounded-full border border-border bg-card py-1 pr-3 pl-1 text-[12px] font-medium transition-colors hover:bg-muted"}
      >
        {!sidebar && <Avatar name={guest.name} color={guest.color} size="sm" />}
        {!sidebar && <span className="truncate">{guest.name}</span>}
        <Pencil
          aria-hidden="true"
          className="size-3 shrink-0 text-muted-foreground"
        />
      </button>

      {editing && (
        <form
          onSubmit={save}
          className={sidebar
            ? "fixed bottom-4 left-4 z-[70] max-h-[calc(100dvh-2rem)] w-[min(290px,calc(100vw-2rem))] space-y-3 overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg animate-[rise_0.2s_cubic-bezier(0.22,1,0.36,1)_both]"
            : "absolute top-full right-0 z-40 mt-2 w-[290px] max-w-[calc(100vw-2rem)] space-y-3 rounded-xl border border-border bg-card p-4 shadow-lg animate-[rise_0.2s_cubic-bezier(0.22,1,0.36,1)_both]"}
        >
          <div className="space-y-1.5">
            <Label htmlFor="guest-name">Your display name</Label>
            <Input
              id="guest-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              autoFocus
              aria-invalid={!!error}
              aria-describedby={error ? "guest-error" : undefined}
            />
          </div>
          {error && (
            <p role="alert">
              <FieldError id="guest-error">{error}</FieldError>
            </p>
          )}
          <p className="text-[11.5px] text-muted-foreground">
            A display name only. It grants no access to this workspace.
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit">
              Save name
            </Button>
          </div>
        </form>
      )}

      {!session.isGuestSaved() && (
        <small
          role="status"
          className="mt-1 block max-w-[260px] text-[11px] text-muted-foreground"
        >
          Your name is available in this tab, but browser storage could not save
          it.
        </small>
      )}
    </div>
  );
}
