import { createContext, useContext, useSyncExternalStore } from "react";
import { BrowserSession } from "./session";
import { WorkspaceApi } from "./workspace-api";

export const BrowserContext = createContext<{
  session: BrowserSession;
  api: WorkspaceApi;
} | null>(null);
export function useBrowser() {
  const value = useContext(BrowserContext);
  if (!value) throw new Error("BrowserContext is required");
  return value;
}
export function useGuest() {
  const { session } = useBrowser();
  useSyncExternalStore(session.subscribe, session.getRevision);
  return session.getGuest();
}
