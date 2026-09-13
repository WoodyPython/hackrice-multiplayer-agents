import { guestLabelSchema, ownerKeySchema, uuidSchema } from "@app/contracts";

export const GUEST_STORAGE_KEY = "common.guest.v1";
export const BRIEFING_SESSION_STORAGE_KEY = "common.briefing-session.v1";
const OWNER_PREFIX = "common.owner.v1.";
export type GuestIdentity = Readonly<{
  contributorId: string;
  name: string;
  color: string;
}>;
/**
 * Cursor and avatar colours, drawn from the CoFlow palette.
 *
 * Each is dark enough to carry the white name label the collaborative editor
 * paints on it. A guest whose stored colour is not in this list falls back to
 * the first — only their colour changes, never their identity.
 */
const colors = ["#2c4270", "#7248a8", "#0f6f76", "#a2560f"];

/** Browser-only display identity. It never confers permissions. */
export class BrowserSession {
  private guest: GuestIdentity;
  private listeners = new Set<() => void>();
  private revision = 0;
  private unsavedOwners = new Map<string, string>();
  private guestSaved = true;
  private briefingSession: string | undefined;

  constructor(private storage: () => Storage = () => window.localStorage) {
    this.guest = this.readGuest() ?? this.newGuest();
  }
  private newGuest(): GuestIdentity {
    const contributorId = crypto.randomUUID();
    const index = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const guest = {
      contributorId,
      name: `Guest ${["Cedar", "Maple", "River", "Finch"][index % 4]}`,
      color: colors[index % colors.length]!,
    };
    this.guestSaved = this.write(GUEST_STORAGE_KEY, JSON.stringify(guest));
    return guest;
  }
  private readGuest(): GuestIdentity | null {
    try {
      const value = JSON.parse(
        this.storage().getItem(GUEST_STORAGE_KEY) ?? "null",
      );
      if (
        !value ||
        !uuidSchema.safeParse(value.contributorId).success ||
        !guestLabelSchema.safeParse(value.name).success
      )
        return null;
      return {
        contributorId: value.contributorId,
        name: guestLabelSchema.parse(value.name),
        color: colors.includes(value.color) ? value.color : colors[0]!,
      };
    } catch {
      return null;
    }
  }
  private write(key: string, value: string): boolean {
    try {
      this.storage().setItem(key, value);
      return this.storage().getItem(key) === value;
    } catch {
      return false;
    }
  }
  private emit = () => {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getRevision = () => this.revision;
  getGuest = () => this.guest;
  isGuestSaved = () => this.guestSaved;
  rename(name: string): void {
    const next = { ...this.guest, name: guestLabelSchema.parse(name) };
    this.guestSaved = this.write(GUEST_STORAGE_KEY, JSON.stringify(next));
    this.guest = next;
    this.emit();
  }
  /** Check before creating: the owner key cannot be retrieved a second time. */
  canPersist(): boolean {
    const key = `common.storage-check.${crypto.randomUUID()}`;
    try {
      this.storage().setItem(key, "ok");
      const ok = this.storage().getItem(key) === "ok";
      this.storage().removeItem(key);
      return ok;
    } catch {
      return false;
    }
  }
  saveOwner(workspaceId: string, ownerKey: string): boolean {
    uuidSchema.parse(workspaceId);
    ownerKeySchema.parse(ownerKey);
    const saved = this.write(OWNER_PREFIX + workspaceId, ownerKey);
    if (saved) this.unsavedOwners.delete(workspaceId);
    else this.unsavedOwners.set(workspaceId, ownerKey);
    this.emit();
    return saved;
  }
  getOwnerKey(workspaceId: string): string | undefined {
    const unsaved = this.unsavedOwners.get(workspaceId);
    if (unsaved) return unsaved;
    try {
      const value = this.storage().getItem(OWNER_PREFIX + workspaceId);
      return ownerKeySchema.safeParse(value).success ? value! : undefined;
    } catch {
      return undefined;
    }
  }
  /**
   * Scopes "Catch me up" history to this browser.
   *
   * Separate from `contributorId` on purpose: that one is broadcast to every
   * collaborator through editor awareness, and this one is never shared. It is
   * not a credential — it only decides whose briefing history is shown. Without
   * storage it lasts for this tab, so history simply starts fresh next time.
   */
  getBriefingSessionKey(): string {
    if (this.briefingSession) return this.briefingSession;
    try {
      const stored = this.storage().getItem(BRIEFING_SESSION_STORAGE_KEY);
      if (uuidSchema.safeParse(stored).success) return (this.briefingSession = stored!);
    } catch {
      /* Fall through to a key for this tab. */
    }
    const key = crypto.randomUUID();
    this.write(BRIEFING_SESSION_STORAGE_KEY, key);
    return (this.briefingSession = key);
  }
  hasUnsavedOwner = (workspaceId: string) =>
    this.unsavedOwners.has(workspaceId);
  retryOwnerSave(workspaceId: string): boolean {
    const key = this.unsavedOwners.get(workspaceId);
    return key ? this.saveOwner(workspaceId, key) : true;
  }
  /** Recheck browser storage on focus and cross-tab changes, without broadcasting secrets. */
  refresh = () => {
    const saved = this.readGuest();
    if (
      saved &&
      this.guestSaved &&
      JSON.stringify(saved) !== JSON.stringify(this.guest)
    )
      this.guest = saved;
    this.emit();
  };
  connect(target: Window = window): () => void {
    const changed = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === GUEST_STORAGE_KEY ||
        event.key.startsWith(OWNER_PREFIX)
      )
        this.refresh();
    };
    target.addEventListener("storage", changed);
    target.addEventListener("focus", this.refresh);
    return () => {
      target.removeEventListener("storage", changed);
      target.removeEventListener("focus", this.refresh);
    };
  }
}

/** A03 binds provider.awareness when a document opens, then disposes on close. */
export function bindGuestAwareness(
  awareness: { setLocalStateField: (field: string, value: unknown) => void },
  session: BrowserSession,
): () => void {
  let last: GuestIdentity | undefined;
  const publish = () => {
    const guest = session.getGuest();
    if (guest === last) return;
    last = guest;
    awareness.setLocalStateField("user", {
      id: guest.contributorId,
      name: guest.name,
      color: guest.color,
    });
  };
  publish();
  const unsubscribe = session.subscribe(publish);
  return () => {
    unsubscribe();
    awareness.setLocalStateField("user", null);
  };
}
