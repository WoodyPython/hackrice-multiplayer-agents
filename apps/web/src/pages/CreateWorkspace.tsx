import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { createWorkspaceRequestSchema } from "@app/contracts";
import { useAuth } from "../auth-context";
import { useBrowser } from "../browser-context";
import { workspaceError } from "../workspace-api";
import { Wordmark } from "../components/Logo";
import { ThemeToggle } from "../components/ThemeToggle";
import { AccountMenu } from "../components/AccountMenu";
import { Button, ButtonLink } from "../components/ui/button";
import {
  FieldError,
  FieldHint,
  Input,
  Label,
  Textarea,
} from "../components/ui/field";
import { Eyebrow } from "../components/ui/misc";
import { Landing, PILLARS } from "./Landing";

/**
 * The create form, and the front door for anyone who is not signed in.
 *
 * Signed out, this renders the landing page: creating a workspace needs an
 * account, since ownership is a membership row and an anonymous one could
 * never be administered or invited into, so the form would only fail. The
 * pitch itself lives in one place — `PILLARS`, in Landing — so what a visitor
 * read on the way in is what they see again when they make their first
 * workspace.
 */
export function CreateWorkspace() {
  const { api } = useBrowser();
  const { account, refresh } = useAuth();
  const navigate = useNavigate();
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    if (account) document.title = "New workspace — CoFlow";
  }, [account]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const data = new FormData(event.currentTarget);
    const parsed = createWorkspaceRequestSchema.safeParse({
      name: data.get("name"),
      purpose: data.get("purpose"),
    });
    if (!parsed.success) {
      setFields(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            String(issue.path[0]),
            issue.message,
          ]),
        ),
      );
      return;
    }
    setFields({});
    setError("");
    submitting.current = true;
    setPending(true);
    try {
      const id = await api.create(parsed.data);
      // Creation has already succeeded: a failed session read must never make
      // retrying this form create a second workspace.
      await refresh().catch(() => {});
      navigate(`/w/${id}`);
    } catch (cause) {
      setError(workspaceError(cause));
      submitting.current = false;
      setPending(false);
    }
  }

  if (!account) return <Landing />;

  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* Brand wash: a soft navy bloom over a faint grid, masked to the top. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
      >
        <div className="absolute inset-0 cf-grid-backdrop opacity-50" />
        <div className="absolute -top-40 left-1/2 size-[680px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,var(--color-navy-200)_0%,transparent_65%)] opacity-50 blur-3xl dark:bg-[radial-gradient(circle,var(--color-navy-700)_0%,transparent_65%)] dark:opacity-40" />
      </div>

      <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6">
        <Link to="/" aria-label="CoFlow home" className="rounded-lg">
          <Wordmark size="lg" />
        </Link>
        {/*
          `AccountMenu` rather than `AccountControl` here: it already shows the
          address and signs out, and it carries the way back to the workspace
          list, which this page now needs. Two sign-out controls in one header
          would only make the reader choose between them.
        */}
        <div className="flex flex-wrap items-center gap-3">
          <ThemeToggle />
          <AccountMenu />
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl items-start gap-12 px-6 pt-6 pb-20 lg:min-h-[calc(100vh-13rem)] lg:grid-cols-[1.05fr_minmax(360px,0.95fr)] lg:items-center lg:gap-16 lg:pt-6">
        <section className="max-w-xl">
          <Eyebrow>A little more possible, together</Eyebrow>
          <h1 className="mt-4 text-[42px] leading-[1.05] font-semibold tracking-[-0.04em] text-balance sm:text-[54px]">
            Make room for
            <br />
            <span className="text-navy-700 dark:text-navy-300">good work.</span>
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted-foreground text-pretty">
            Create a shared workspace. Invite collaborators with a link, shape
            the requirements together, and let parallel agents do the work —
            with a review before anything is applied.
          </p>

          <ul className="mt-9 grid gap-5">
            {PILLARS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3.5">
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-navy-200/70 bg-navy-50 text-navy-700 dark:border-navy-800 dark:bg-navy-950/60 dark:text-navy-300"
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-semibold tracking-tight">
                    {title}
                  </span>
                  <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
                    {body}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <div className="w-full">
          <form
            className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-lg sm:p-7"
            onSubmit={create}
            noValidate
          >
            <div className="space-y-1">
              <h2 className="text-lg font-semibold tracking-tight">
                Create a workspace
              </h2>
              <p className="text-[13px] text-muted-foreground">
                You will be its host. Invite people afterwards, and switch
                between your workspaces from the sidebar.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="workspace-name">Workspace name</Label>
              <Input
                id="workspace-name"
                name="name"
                maxLength={200}
                placeholder="Our launch room"
                aria-invalid={!!fields.name}
                aria-describedby={fields.name ? "name-error" : undefined}
              />
              {fields.name && (
                <FieldError id="name-error">{fields.name}</FieldError>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="workspace-purpose">
                Purpose
                <FieldHint>Optional</FieldHint>
              </Label>
              <Textarea
                id="workspace-purpose"
                name="purpose"
                maxLength={4000}
                rows={3}
                placeholder="What will you work on together?"
              />
            </div>

            {error && (
              <p role="alert">
                <FieldError>{error}</FieldError>
              </p>
            )}

            <Button
              variant="primary"
              size="lg"
              disabled={pending}
              type="submit"
              className="w-full"
            >
              {pending ? "Creating workspace…" : "Create workspace"}
            </Button>
          </form>

          <Link
            className="mt-4 inline-flex items-center gap-1.5 rounded-md px-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
            to="/"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Back to your workspaces
          </Link>
        </div>
      </div>
    </main>
  );
}
