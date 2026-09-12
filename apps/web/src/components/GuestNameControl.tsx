import { useState, type FormEvent } from "react";
import { guestLabelSchema } from "@app/contracts";
import { useBrowser, useGuest } from "../browser-context";

export function GuestNameControl() {
  const { session } = useBrowser();
  const guest = useGuest();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(guest.name);
  const [error, setError] = useState("");
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
    <div className="guest-control">
      {editing ? (
        <form onSubmit={save} className="guest-name-form">
          <label htmlFor="guest-name">Your display name</label>
          <input
            id="guest-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoFocus
            aria-invalid={!!error}
            aria-describedby={error ? "guest-error" : undefined}
          />
          {error && (
            <small id="guest-error" role="alert" className="error">
              {error}
            </small>
          )}
          <div className="actions">
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit">Save name</button>
          </div>
        </form>
      ) : (
        <button
          onClick={() => {
            setName(guest.name);
            setEditing(true);
          }}
          aria-label={`Edit display name: ${guest.name}`}
        >
          <span className="avatar" style={{ color: guest.color }}>
            {guest.name[0]}
          </span>
          {guest.name}
          <span aria-hidden="true">✎</span>
        </button>
      )}
      {!session.isGuestSaved() && (
        <small role="status">
          Your name is available in this tab, but browser storage could not save
          it.
        </small>
      )}
    </div>
  );
}
