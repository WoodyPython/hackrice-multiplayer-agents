import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Bot,
  CheckCheck,
  Clock3,
  Compass,
  Eye,
  FileText,
  GitBranch,
  HelpCircle,
  Inbox,
  LayoutGrid,
  MessageSquare,
  MessagesSquare,
  Paperclip,
  PenLine,
  Play,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { workspace as sample } from "../fixtures";
import { cn } from "../lib/utils";
import { LogoMark, Wordmark } from "../components/Logo";
import { ThemeToggle } from "../components/ThemeToggle";
import { ButtonLink, buttonVariants } from "../components/ui/button";
import { Badge, Dot } from "../components/ui/badge";
import { Avatar, Eyebrow } from "../components/ui/misc";

/**
 * The three things CoFlow promises. Shared with the signed-in create form so
 * the pitch a visitor read on the way in is the one they see when they make
 * their first workspace.
 */
export const PILLARS = [
  {
    icon: MessagesSquare,
    title: "Talk it through first",
    body: "Posting a task opens a discussion. No agent runs, and nothing is spent, until someone presses Start.",
  },
  {
    icon: GitBranch,
    title: "Parallel agents, one result",
    body: "Agents can work on different files at the same time. Their changes come together for you to review.",
  },
  {
    icon: ShieldCheck,
    title: "Nothing ships unreviewed",
    body: "Look over the changes before saving them to your workspace. Anyone can mark a task complete or unmark it later.",
  },
] satisfies { icon: LucideIcon; title: string; body: string }[];

const STEPS = [
  {
    icon: UserPlus,
    title: "Open a workspace",
    body: "Name it, say what it is for, and invite your team with a link. Guidance you add in Settings is shared with people and agents alike.",
  },
  {
    icon: PenLine,
    title: "Shape the task together",
    body: "Give it an outcome and acceptance criteria, attach the materials it should use, and settle the details in its discussion.",
  },
  {
    icon: Play,
    title: "Press Start",
    body: "An orchestrator splits the work into assignments. Analysts, writers, coders and reviewers run in parallel and ask when they are unsure.",
  },
  {
    icon: CheckCheck,
    title: "Review and apply",
    body: "Read the diff, resolve anything that overlaps, and apply exactly the candidate you approved to the workspace's files.",
  },
] satisfies { icon: LucideIcon; title: string; body: string }[];

const ROLES = [
  {
    icon: Eye,
    name: "Viewer",
    body: "Reads tasks, files and history, and shows up in presence. Anyone with the link.",
  },
  {
    icon: Users,
    name: "Member",
    body: "Creates and starts tasks, edits drafts live, answers agents, applies reviews and marks work complete.",
  },
  {
    icon: Settings,
    name: "Host",
    body: "Everything a member can do, plus settings, invitations, roles and the workspace's lifecycle.",
  },
] satisfies { icon: LucideIcon; name: string; body: string }[];

const NAV = [
  { href: "#product", label: "Product" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#teams", label: "For teams" },
];

/**
 * The signed-out front door.
 *
 * Laid out the way a product page reads today: a short centred claim, the
 * product itself underneath it, and the explanation after. Every colour here
 * is a token the workspace already uses — the navy ink, the warm canvas, the
 * board's status hues — so the page a visitor lands on and the app they sign
 * into read as one thing, not a marketing skin over a different product.
 */
export function Landing() {
  useEffect(() => {
    document.title = "CoFlow — a shared workspace for agent-assisted work";
  }, []);

  /*
    The links in the header and the footer travel to their section rather than
    cutting to it, so a visitor keeps their bearings and sees what they passed
    on the way.

    This sits on the document element because the viewport is what scrolls
    here, not `main`, and it is a rule for this page alone: it is put back on
    the way out so the rest of the app keeps the jump it has. Anyone who has
    asked for reduced motion still gets that jump, since the stylesheet's
    reduced-motion rule is `!important` and outranks an inline style.
  */
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = "smooth";
    return () => {
      root.style.scrollBehavior = previous;
    };
  }, []);

  return (
    <main className="relative min-h-screen overflow-x-clip">
      <Backdrop />
      <SiteHeader />
      <Hero />
      <Features />
      <HowItWorks />
      <Teams />
      <ClosingCall />
      <SiteFooter />
    </main>
  );
}

/* ---------------------------------------------------------------- chrome */

function Backdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
      <div className="absolute inset-x-0 top-0 h-[960px] cf-grid-backdrop opacity-60" />
      <div className="absolute -top-56 left-1/2 size-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,var(--color-navy-200)_0%,transparent_62%)] opacity-60 blur-3xl dark:bg-[radial-gradient(circle,var(--color-navy-700)_0%,transparent_62%)] dark:opacity-35" />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-6">
        <Link to="/" aria-label="CoFlow home" className="rounded-lg">
          <Wordmark />
        </Link>

        <nav aria-label="Page" className="hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle className="hidden sm:inline-flex" />
          <ButtonLink to="/signin" variant="ghost" className="hidden sm:inline-flex">
            Sign in
          </ButtonLink>
          <ButtonLink to="/signin?mode=up" variant="primary">
            Get started
          </ButtonLink>
        </div>
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <Wordmark size="sm" />
          <p className="text-[12px] text-muted-foreground">
            A shared workspace for people and agents to get work done together.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-muted-foreground">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} className="transition-colors hover:text-foreground">
              {item.label}
            </a>
          ))}
          <Link to={`/demo/w/${sample.id}`} className="transition-colors hover:text-foreground">
            Sample workspace
          </Link>
          <Link to="/signin" className="transition-colors hover:text-foreground">
            Sign in
          </Link>
          <ThemeToggle className="sm:hidden" />
        </nav>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ hero */

type PillWord = { word: string; pill: string; dot: string };

/**
 * The word inside the headline's pill, and the colour it wears while it is
 * there.
 *
 * Every entry has to finish "Make room for ___ work" as a sentence, so they
 * are all adjectives, and they are kept to a similar length: the pill is sized
 * to the longest of them, and a short word in a pill cut for a long one looks
 * slack. The tones are the board's own status hues, so a headline that changes
 * colour never leaves the palette the rest of the app uses.
 *
 * The list is typed as a non-empty one so the rotation always has a word to
 * land on.
 */
const HEADLINE_WORDS: [PillWord, ...PillWord[]] = [
  {
    word: "good",
    pill: "bg-navy-100 text-navy-800 dark:bg-navy-800/60 dark:text-navy-50",
    dot: "bg-navy-600 dark:bg-navy-300",
  },
  {
    word: "deep",
    pill: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-50",
    dot: "bg-emerald-600 dark:bg-emerald-400",
  },
  {
    word: "real",
    pill: "bg-sky-100 text-sky-900 dark:bg-sky-900/50 dark:text-sky-50",
    dot: "bg-sky-600 dark:bg-sky-400",
  },
  {
    word: "bold",
    pill: "bg-violet-100 text-violet-900 dark:bg-violet-900/50 dark:text-violet-50",
    dot: "bg-violet-600 dark:bg-violet-400",
  },
  {
    word: "great",
    pill: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-50",
    dot: "bg-amber-600 dark:bg-amber-400",
  },
];

/** How long each word holds before the next one takes its place. */
const WORD_HOLD_MS = 2400;

/**
 * The headline's pill: one word that changes, and a colour that changes with
 * it.
 *
 * All the words live in the same grid cell, so the pill is as wide as the
 * longest of them from the first paint and the sentence around it never
 * reflows while a word swaps. The word on its way out leaves upward and the
 * next arrives from below, so the motion always reads in one direction.
 *
 * The pill is an inline block rather than a flex line so that the baseline it
 * offers the sentence is the word's own; a flex pill hands out its first
 * item's baseline, which is the dot, and that drops the word below the rest of
 * the headline.
 *
 * A screen reader gets the sentence once as plain text, because a heading
 * that rewrites itself every couple of seconds is noise rather than
 * information, and the rotation stops altogether for anyone who has asked for
 * reduced motion.
 */
function HeadlineWord() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const motion =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;

    let timer: number | undefined;
    const sync = () => {
      window.clearInterval(timer);
      timer = motion?.matches
        ? undefined
        : window.setInterval(
            () => setIndex((i) => (i + 1) % HEADLINE_WORDS.length),
            WORD_HOLD_MS,
          );
    };

    sync();
    motion?.addEventListener("change", sync);
    return () => {
      window.clearInterval(timer);
      motion?.removeEventListener("change", sync);
    };
  }, []);

  const { word, pill, dot } = HEADLINE_WORDS[index] ?? HEADLINE_WORDS[0];
  /*
    The rotation is strictly in order, so the word on its way out is always
    the one before this one. Every other word waits below rather than above,
    which is what keeps the swap moving one way instead of crossing over.
  */
  const leaving = (index + HEADLINE_WORDS.length - 1) % HEADLINE_WORDS.length;

  return (
    <span
      className={cn(
        "mx-[0.04em] inline-block rounded-full px-[0.42em] pb-[0.04em] align-baseline whitespace-nowrap transition-colors duration-500",
        pill,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mr-[0.28em] inline-block size-[0.3em] rounded-full align-middle animate-pulse-dot transition-colors duration-500",
          dot,
        )}
      />
      <span className="sr-only">{word}</span>
      <span aria-hidden="true" className="inline-grid justify-items-center align-baseline">
        {HEADLINE_WORDS.map(({ word: candidate }, i) => (
          <span
            key={candidate}
            className={cn(
              "col-start-1 row-start-1 transition-[opacity,translate] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
              i === index && "translate-y-0 opacity-100",
              i !== index &&
                (i === leaving
                  ? "-translate-y-[0.45em] opacity-0"
                  : "translate-y-[0.45em] opacity-0"),
            )}
          >
            {candidate}
          </span>
        ))}
      </span>
    </span>
  );
}

function Hero() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 pt-20 pb-8 sm:pt-28">
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <h1 className="text-[44px] leading-[1.02] font-semibold tracking-[-0.045em] text-balance animate-rise sm:text-[64px] lg:text-[76px]">
          Make room for <HeadlineWord /> work
        </h1>

        <p className="mt-6 max-w-xl text-[16px] leading-relaxed text-muted-foreground text-pretty animate-rise [animation-delay:60ms] sm:text-[18px]">
          A shared workspace where your team shapes the task, parallel agents
          do the work, and every change is reviewed before it is applied.
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 animate-rise [animation-delay:120ms] sm:flex-row">
          <ButtonLink variant="primary" size="lg" to="/signin?mode=up" className="w-full sm:w-auto">
            Create your account
          </ButtonLink>
          <ButtonLink variant="subtle" size="lg" to={`/demo/w/${sample.id}`} className="w-full sm:w-auto">
            Explore the sample workspace
            <ArrowRight aria-hidden="true" />
          </ButtonLink>
        </div>
        <p className="mt-4 text-[12.5px] text-muted-foreground animate-rise [animation-delay:180ms]">
          Been sent a workspace link? Open it — you can read along without an
          account.
        </p>
      </div>

      <WorkspacePreview />
    </section>
  );
}

/* ------------------------------------------------------- product preview */

const PREVIEW_NAV: { icon: LucideIcon; label: string; active?: boolean; count?: number }[] = [
  { icon: Inbox, label: "Inbox", count: 2 },
  { icon: Compass, label: "Overview" },
  { icon: LayoutGrid, label: "Board", active: true },
  { icon: Bot, label: "Agents" },
  { icon: FileText, label: "Files" },
  { icon: Clock3, label: "History" },
];

type PreviewTone = "neutral" | "info" | "warn" | "review" | "done";

const PREVIEW_COLUMNS: {
  name: string;
  tone: PreviewTone;
  cards: {
    label: string;
    live?: boolean;
    title: string;
    summary?: string;
    question?: string;
    who: string;
    comments?: number;
    files?: number;
  }[];
}[] = [
  {
    name: "Posted",
    tone: "neutral",
    cards: [
      { label: "Posted", title: "Plan the onboarding flow", who: "Priya Rao", comments: 3 },
    ],
  },
  {
    name: "Working",
    tone: "info",
    cards: [
      {
        label: "Working",
        live: true,
        title: "Write the launch announcement",
        summary: "Agents are working",
        who: "Ada Lin",
        comments: 6,
        files: 2,
      },
    ],
  },
  {
    name: "Needs attention",
    tone: "warn",
    cards: [
      {
        label: "Needs input",
        title: "Clarify the launch audience",
        summary: "Waiting for your answer",
        question: "1 question needs an answer",
        who: "Sam Ortiz",
        comments: 4,
      },
    ],
  },
  {
    name: "Review",
    tone: "review",
    cards: [
      {
        label: "In review",
        title: "Review the landing page copy",
        summary: "Ready for you to take a look",
        who: "Ada Lin",
        comments: 2,
        files: 1,
      },
    ],
  },
  {
    name: "Completed",
    tone: "done",
    cards: [
      {
        label: "Completed",
        title: "Document the project principles",
        summary: "All done. You can reopen this anytime.",
        who: "Priya Rao",
        files: 1,
      },
    ],
  },
];

/**
 * A still of the workspace, drawn with the same primitives the real board
 * uses. Static on purpose: nothing here is focusable, and the whole frame is
 * one image to assistive technology, described once.
 */
function WorkspacePreview() {
  return (
    <div
      role="img"
      aria-label="A CoFlow workspace. The task board shows a task agents are working on, a question waiting for an answer, and a change ready for review."
      className="relative mx-auto mt-14 w-full max-w-6xl animate-rise [animation-delay:240ms] sm:mt-20"
    >
      <div aria-hidden="true" className="contents">
        <div className="absolute inset-x-8 -top-6 h-40 rounded-full bg-navy-300/40 blur-3xl dark:bg-navy-600/25" />

        <div className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-lg [mask-image:linear-gradient(to_bottom,#000_78%,transparent_100%)]">
          {/* Window chrome */}
          <div className="flex h-11 items-center gap-3 border-b border-border bg-muted/50 px-4">
            <span className="flex gap-1.5">
              <span className="size-2.5 rounded-full bg-ink-300 dark:bg-ink-600" />
              <span className="size-2.5 rounded-full bg-ink-300 dark:bg-ink-600" />
              <span className="size-2.5 rounded-full bg-ink-300 dark:bg-ink-600" />
            </span>
            <span className="ml-2 hidden items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground sm:inline-flex">
              <LogoMark className="size-3.5 text-navy-800 dark:text-navy-100" />
              <span className="font-medium text-foreground">Launch room</span>
              <span>· Board</span>
            </span>
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="flex -space-x-1.5">
                <Avatar name="Ada Lin" size="sm" className="ring-2 ring-card" />
                <Avatar name="Priya Rao" size="sm" className="ring-2 ring-card" />
                <Avatar name="Sam Ortiz" size="sm" className="ring-2 ring-card" />
              </span>
              <span className="hidden sm:inline">3 here now</span>
            </span>
          </div>

          <div className="grid md:grid-cols-[224px_1fr]">
            {/* Sidebar */}
            <aside className="hidden flex-col gap-5 border-r border-border bg-card p-4 md:flex">
              <Wordmark />
              <div className="rounded-xl border border-border bg-muted/40 p-2.5">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-navy-800 font-display text-[13px] font-semibold text-white dark:bg-navy-100 dark:text-navy-900">
                    L
                  </span>
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[13px] font-semibold">Launch room</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      Shared workspace
                    </span>
                  </span>
                </span>
              </div>
              <div>
                <p className="mb-2 px-3 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                  Workspace
                </p>
                <div className="grid gap-0.5">
                  {PREVIEW_NAV.map(({ icon: Icon, label, active, count }) => (
                    <span
                      key={label}
                      className={cn(
                        "relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium",
                        active
                          ? "bg-secondary text-secondary-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {active && (
                        <span className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-navy-600 dark:bg-navy-300" />
                      )}
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{label}</span>
                      {count !== undefined && (
                        <Badge tone="neutral" size="sm" className="ml-auto tabular-nums">
                          {count}
                        </Badge>
                      )}
                    </span>
                  ))}
                </div>
              </div>
              <div className="mt-auto flex items-center gap-2.5 border-t border-border px-1 pt-3">
                <Avatar name="Ada Lin" />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[12px] font-medium">Ada</span>
                  <span className="block text-[10.5px] text-muted-foreground">Host</span>
                </span>
              </div>
            </aside>

            {/* Board */}
            <div className="min-w-0 bg-background p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1.5">
                  <Eyebrow>Your shared workspace</Eyebrow>
                  <p className="font-display text-[22px] leading-tight font-semibold tracking-[-0.03em] sm:text-[26px]">
                    Good work starts here.
                  </p>
                  <p className="text-[12.5px] text-muted-foreground">
                    Bring an idea. Shape it together. Ship something useful.
                  </p>
                </div>
                <span className={cn(buttonVariants({ variant: "primary" }), "shrink-0")}>
                  <Plus />
                  Post a task
                </span>
              </div>

              <div className="mt-5 flex items-center justify-between gap-3 border-b border-border pb-3">
                <span className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
                  Task board
                  <Badge size="sm" className="tabular-nums">
                    5
                  </Badge>
                </span>
                <span className="hidden h-8 w-48 items-center gap-2 rounded-lg border border-input bg-card px-2.5 text-[11.5px] text-muted-foreground/70 shadow-xs sm:flex">
                  <Search className="size-3.5" />
                  Search tasks…
                </span>
              </div>

              <div className="mt-4 grid grid-cols-[repeat(5,minmax(176px,1fr))] gap-3">
                {PREVIEW_COLUMNS.map((column) => (
                  <div key={column.name} className="min-w-0">
                    <p className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold tracking-tight">
                      <Dot tone={column.tone} />
                      <span className="truncate">{column.name}</span>
                      <Badge size="sm" tone={column.tone} className="ml-auto shrink-0 tabular-nums">
                        {column.cards.length}
                      </Badge>
                    </p>
                    <div className="grid gap-2.5">
                      {column.cards.map((card) => (
                        <div
                          key={card.title}
                          className="rounded-xl border border-border bg-card p-3 shadow-xs"
                        >
                          <Badge tone={column.tone} size="sm">
                            <Dot tone={column.tone} live={card.live} />
                            {card.label}
                          </Badge>
                          <p className="mt-2 text-[12.5px] leading-snug font-semibold tracking-tight">
                            {card.title}
                          </p>
                          {card.summary && (
                            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                              {card.summary}
                            </p>
                          )}
                          {card.question && (
                            <span className="mt-2 flex items-center gap-1.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                              <HelpCircle className="size-3.5 shrink-0" />
                              {card.question}
                            </span>
                          )}
                          <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2 text-[10px] text-muted-foreground">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <Avatar name={card.who} size="sm" />
                              <span className="truncate">{card.who}</span>
                            </span>
                            <span className="flex shrink-0 items-center gap-2 tabular-nums">
                              {card.comments && (
                                <span className="flex items-center gap-1">
                                  <MessageSquare className="size-3" />
                                  {card.comments}
                                </span>
                              )}
                              {card.files && (
                                <span className="flex items-center gap-1">
                                  <Paperclip className="size-3" />
                                  {card.files}
                                </span>
                              )}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- features */

function SectionHeading({
  eyebrow,
  title,
  children,
  id,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  id?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <Eyebrow className="text-navy-700 dark:text-navy-300">{eyebrow}</Eyebrow>
      <h2
        id={id}
        className="mt-3 text-[30px] leading-[1.1] font-semibold tracking-[-0.035em] text-balance sm:text-[40px]"
      >
        {title}
      </h2>
      {children && (
        <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground text-pretty">
          {children}
        </p>
      )}
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  children,
  className,
  illustration,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  className?: string;
  illustration?: ReactNode;
}) {
  return (
    <article
      className={cn(
        "group flex flex-col rounded-2xl border border-border bg-card p-6 shadow-xs transition-all duration-150 hover:-translate-y-0.5 hover:border-navy-300 hover:shadow-md dark:hover:border-navy-600",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="grid size-10 place-items-center rounded-xl border border-navy-200/70 bg-navy-50 text-navy-700 dark:border-navy-800 dark:bg-navy-950/60 dark:text-navy-300"
      >
        <Icon className="size-[18px]" />
      </span>
      <h3 className="mt-4 text-[16px] font-semibold tracking-tight">{title}</h3>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground text-pretty">
        {children}
      </p>
      {illustration && <div className="mt-6 flex-1">{illustration}</div>}
    </article>
  );
}

/** Two collaborators mid-sentence in the same draft. */
function DraftIllustration() {
  const caret = (name: string, className: string) => (
    <span className={cn("relative mx-0.5 inline-block h-[1.1em] w-0.5 align-text-bottom", className)}>
      <span
        className={cn(
          "absolute -top-[15px] left-0 rounded-md px-1.5 py-px text-[9px] leading-[13px] font-semibold whitespace-nowrap text-white",
          className,
        )}
      >
        {name}
      </span>
    </span>
  );
  return (
    <div
      aria-hidden="true"
      className="rounded-xl border border-border bg-background p-4 font-mono text-[11.5px] leading-7 text-foreground/80"
    >
      <p className="mb-2 flex items-center gap-2 text-[10.5px] font-sans text-muted-foreground">
        <FileText className="size-3.5" />
        drafts/announcement.md
        <Badge tone="done" size="sm" className="ml-auto">
          <Dot tone="done" live />
          Live
        </Badge>
      </p>
      <p>
        <span className="text-navy-700 dark:text-navy-300"># </span>Introducing the launch room
      </p>
      <p>
        Today we are opening CoFlow to{caret("Ada", "bg-navy-600 dark:bg-navy-400")} every
        team that
      </p>
      <p>
        wants agents in the loop{caret("Priya", "bg-emerald-600")} without
      </p>
      <p className="text-muted-foreground/60">losing the review.</p>
    </div>
  );
}

/** What the Inbox surfaces when you come back. */
function InboxIllustration() {
  const rows = [
    {
      tone: "warn" as const,
      icon: HelpCircle,
      kicker: "Question from the Analyst",
      title: "Which audience is the announcement for?",
      when: "2 min ago",
    },
    {
      tone: "review" as const,
      icon: ShieldCheck,
      kicker: "Ready for review",
      title: "Write the launch announcement",
      when: "18 min ago",
    },
    {
      tone: "info" as const,
      icon: Bot,
      kicker: "Working · Writer, Coder",
      title: "Build the getting-started guide",
      when: "just now",
    },
  ];
  return (
    <ul aria-hidden="true" className="grid gap-2">
      {rows.map(({ tone, icon: Icon, kicker, title, when }) => (
        <li
          key={title}
          className="flex items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Icon className="size-4" />
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="flex items-center gap-1.5 text-[10.5px] font-medium text-muted-foreground">
              <Dot tone={tone} live={tone === "info"} />
              {kicker}
            </span>
            <span className="mt-0.5 block truncate text-[12.5px] font-semibold">{title}</span>
          </span>
          <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">{when}</span>
        </li>
      ))}
    </ul>
  );
}

function Features() {
  return (
    <section
      id="product"
      aria-labelledby="product-heading"
      className="mx-auto w-full max-w-6xl scroll-mt-20 px-6 py-20 sm:py-28"
    >
      <SectionHeading
        id="product-heading"
        eyebrow="What you get"
        title="Everything a task needs, in one room."
      >
        Planning, discussion, shared drafts and agent-made work sit side by
        side, so nobody has to carry context between tools.
      </SectionHeading>

      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {PILLARS.map(({ icon, title, body }) => (
          <FeatureCard key={title} icon={icon} title={title}>
            {body}
          </FeatureCard>
        ))}
        <FeatureCard
          icon={Users}
          title="Edit drafts together"
          className="md:col-span-2 lg:col-span-1"
          illustration={<DraftIllustration />}
        >
          Shared drafts sync between everyone connected. You see each other's
          cursors, who is present, and whether the document is saved.
        </FeatureCard>
        <FeatureCard
          icon={Inbox}
          title="Catch up in a minute"
          className="md:col-span-1 lg:col-span-2"
          illustration={<InboxIllustration />}
        >
          The Inbox gathers agent questions and blockers, the Agents page shows
          progress, and Overview writes an activity briefing for when you were
          away.
        </FeatureCard>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- how it works */

function HowItWorks() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-heading"
      className="border-y border-border bg-card/60 scroll-mt-20"
    >
      <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28">
        <SectionHeading id="how-heading" eyebrow="How it works" title="Four steps, and you stay in charge of every one.">
          Nothing runs on its own. Start is a button somebody presses, and apply
          is a decision somebody makes.
        </SectionHeading>

        <ol className="relative mt-14 grid gap-8 md:grid-cols-2 lg:grid-cols-4 lg:gap-6">
          <span
            aria-hidden="true"
            className="absolute top-5 right-[12.5%] left-[12.5%] hidden border-t border-dashed border-navy-300 lg:block dark:border-navy-700"
          />
          {STEPS.map(({ icon: Icon, title, body }, index) => (
            <li key={title} className="relative flex gap-4 lg:flex-col lg:gap-5">
              <span className="relative z-10 flex shrink-0 items-center gap-2">
                <span className="grid size-10 place-items-center rounded-full bg-navy-800 text-white shadow-md ring-4 ring-background dark:bg-navy-100 dark:text-navy-900">
                  <Icon className="size-[18px]" aria-hidden="true" />
                </span>
              </span>
              <div>
                <span className="block text-[10.5px] font-semibold tracking-[0.14em] text-navy-700 uppercase dark:text-navy-300">
                  Step {index + 1}
                </span>
                <h3 className="mt-1 text-[16px] font-semibold tracking-tight">{title}</h3>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground text-pretty">
                  {body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- teams */

function Teams() {
  return (
    <section
      id="teams"
      aria-labelledby="teams-heading"
      className="mx-auto w-full max-w-6xl scroll-mt-20 px-6 py-20 sm:py-28"
    >
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
        <div>
          <Eyebrow className="text-navy-700 dark:text-navy-300">For teams</Eyebrow>
          <h2
            id="teams-heading"
            className="mt-3 text-[30px] leading-[1.1] font-semibold tracking-[-0.035em] text-balance sm:text-[40px]"
          >
            Built for the whole room, not just the person who pressed Start.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground text-pretty">
            One account, as many workspaces as you like, and they follow you to
            any device you sign in from. Invite people with a link, give them the
            role that fits, and archive a project when it is done without losing
            a thing.
          </p>
          <ul className="mt-6 grid gap-2.5 text-[13.5px]">
            {[
              "Switch between workspaces from the sidebar",
              "Shared guidance that people and agents both follow",
              "Stop an attempt, answer a question, or retry from saved work",
              "Archive finished projects and restore them later",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-navy-100 text-navy-800 dark:bg-navy-800/70 dark:text-navy-100"
                >
                  <CheckCheck className="size-3" />
                </span>
                <span className="text-foreground/90">{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <ul className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
          {ROLES.map(({ icon: Icon, name, body }) => (
            <li
              key={name}
              className="flex gap-4 rounded-2xl border border-border bg-card p-5 shadow-xs"
            >
              <span
                aria-hidden="true"
                className="grid size-10 shrink-0 place-items-center rounded-xl border border-navy-200/70 bg-navy-50 text-navy-700 dark:border-navy-800 dark:bg-navy-950/60 dark:text-navy-300"
              >
                <Icon className="size-[18px]" />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold tracking-tight">{name}</span>
                  {name === "Host" && (
                    <Badge tone="brand" size="sm">
                      Creator
                    </Badge>
                  )}
                </span>
                <span className="mt-1 block text-[13px] leading-relaxed text-muted-foreground">
                  {body}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- closing */

function ClosingCall() {
  return (
    <section aria-labelledby="closing-heading" className="mx-auto w-full max-w-6xl px-6 pb-20 sm:pb-28">
      <div className="relative overflow-hidden rounded-3xl bg-navy-800 px-6 py-14 text-center text-white shadow-lg sm:px-12 sm:py-20 dark:bg-navy-100 dark:text-navy-950">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(to_right,rgb(255_255_255/0.12)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.12)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_70%_80%_at_50%_50%,#000_20%,transparent_100%)] dark:[background-image:linear-gradient(to_right,rgb(19_30_51/0.12)_1px,transparent_1px),linear-gradient(to_bottom,rgb(19_30_51/0.12)_1px,transparent_1px)]"
        />
        <div className="relative mx-auto flex max-w-2xl flex-col items-center">
          <LogoMark className="size-10 text-white/90 dark:text-navy-900" />
          <h2
            id="closing-heading"
            className="mt-6 text-[32px] leading-[1.08] font-semibold tracking-[-0.04em] text-balance text-white sm:text-[46px] dark:text-navy-950"
          >
            Ready when your team is.
          </h2>
          <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-white/75 text-pretty dark:text-navy-800">
            Open a workspace, bring an idea, and let the room and its agents do
            the rest — with you reading every change before it lands.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
            <ButtonLink
              size="lg"
              to="/signin?mode=up"
              className="w-full border-transparent bg-white text-navy-900 hover:bg-navy-50 sm:w-auto dark:bg-navy-900 dark:text-white dark:hover:bg-navy-800"
            >
              Get started
              <ArrowRight aria-hidden="true" />
            </ButtonLink>
            <ButtonLink
              size="lg"
              to="/signin"
              className="w-full border-white/20 bg-white/10 text-white hover:bg-white/15 sm:w-auto dark:border-navy-900/20 dark:bg-navy-900/10 dark:text-navy-950 dark:hover:bg-navy-900/15"
            >
              Sign in
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}
