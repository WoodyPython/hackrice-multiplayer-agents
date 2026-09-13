import { useEffect, useState } from "react";
import { ArrowRight, CircleCheckBig, Loader2 } from "lucide-react";
import { currentReview, type Review, type TaskDetail } from "@app/contracts";
import { useBrowser } from "../browser-context";
import { Button } from "./ui/button";

/**
 * "The work is done and it is your turn", said where someone will see it.
 *
 * A task reaching `ready_for_review` was previously visible only as a status
 * chip and a tab someone had to think to open, which is how the most important
 * moment in the flow became the easiest one to miss.
 *
 * **It is one click, not zero.** §4.6 states that a review is requested and
 * never automatic, for two reasons worth keeping: preparing builds a Git
 * candidate that refuses from about a dozen states, and those refusals are only
 * intelligible as the answer to something a person asked for; and it stops two
 * people opening the same tab from racing each other into a candidate build.
 * So this makes asking obvious and immediate rather than removing the ask.
 *
 * **It says what happened, not what the system is.** "Ready for review" is a
 * status name; "the agents have finished their work" is what occurred. Nothing
 * here uses the words candidate, SHA, integrate, or artifact.
 */
export function ReviewReady({
  task,
  onOpenReview,
  staleSignal,
}: {
  task: TaskDetail;
  /** Switches the task screen to Changes. */
  onOpenReview: () => void;
  /** Re-reads when §7.6 invalidation fires, so "waiting" cannot go stale. */
  staleSignal?: string;
}) {
  const { api } = useBrowser();
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const relevant = task.status === "ready_for_review";

  useEffect(() => {
    if (!relevant) return;
    const controller = new AbortController();
    void api
      .listTaskReviews(task.workspaceId, task.id, controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setReviews(list);
      })
      .catch(() => {
        // A banner that cannot read the review list still knows the task is
        // ready, which is the part worth saying. Offer the action anyway.
        if (!controller.signal.aborted) setReviews([]);
      });
    return () => controller.abort();
  }, [api, task.workspaceId, task.id, relevant, staleSignal]);

  if (!relevant) return null;
  const review = reviews ? currentReview(reviews) : null;

  // Copy is chosen by what the reader has to do next, not by status name.
  const { title, detail, label, action } = (() => {
    switch (review?.status) {
      case "building":
        return {
          title: "Putting the changes together",
          detail:
            "This takes a moment. The changes will be ready to read here shortly.",
          label: "Open the review",
          action: onOpenReview,
        };
      case "ready":
        return {
          title: "The changes are ready to read",
          detail:
            "Nothing has been published yet. Read what changed, then decide whether to apply it.",
          label: "Read the changes",
          action: onOpenReview,
        };
      case "conflict":
        return {
          title: "A few files need your decision",
          detail:
            "The same file was written in more than one place. Choose which version to keep.",
          label: "Make the decisions",
          action: onOpenReview,
        };
      case "stale":
        return {
          title: "Someone has typed since these changes were prepared",
          detail:
            "The changes need to be rebuilt against the current text before they can be applied.",
          label: "Rebuild and read",
          action: onOpenReview,
        };
      default:
        return {
          title: "The agents have finished their work",
          detail:
            "Nothing has been published yet. Put the changes together to read them, then decide whether to apply.",
          label: "Review the changes",
          action: onOpenReview,
        };
    }
  })();

  return (
    <section
      // Polite, not assertive: this appears during ordinary polling, and an
      // assertive live region would interrupt whatever is being read.
      role="status"
      aria-live="polite"
      className="rounded-xl border border-navy-200/80 bg-navy-50/60 p-5 shadow-xs dark:border-navy-800 dark:bg-navy-950/40"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-full bg-navy-800 text-white dark:bg-navy-200 dark:text-navy-950"
        >
          {review?.status === "building" ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <CircleCheckBig className="size-5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-tight text-navy-900 dark:text-navy-100">
            {title}
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground text-pretty">
            {detail}
          </p>
        </div>
        <Button
          variant="primary"
          className="shrink-0"
          onClick={action}
        >
          {label}
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
