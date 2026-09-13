import type { SavedOutputOption } from "@app/contracts";
import { Checkbox } from "./ui/field";
import { Notice, Path } from "./ui/misc";

/**
 * Work a failed attempt finished, offered to the next one (design §2.4, §4.7).
 *
 * §4.7 requires a timed-out or exhausted agent to "show incomplete status and
 * preserved output/checkpoint; offer manual retry", and §2.4's `incomplete`
 * state exists precisely so that work stays inspectable rather than being
 * discarded with the attempt. This is the control that makes "preserved" mean
 * something the next attempt can actually use.
 *
 * Everything is kept by default. The failure mode worth avoiding is silently
 * throwing away completed work because nobody re-ticked a box — unchecking is
 * a deliberate act, re-checking should not have to be.
 *
 * §9.4: a retry is a new attempt, not a resumption. Carrying an output forward
 * does not restore its agent's budget or deadline, and the copy says so rather
 * than letting "retry" imply the clock rewinds.
 */
export function SavedWork({
  outputs,
  keep,
  onToggle,
}: {
  outputs: SavedOutputOption[];
  keep: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <section aria-label="Saved work">
      <Notice title="Work the last attempt finished">
        <p>
          These files were completed before the attempt stopped. Keep them and
          the next attempt starts from them instead of redoing the work. A retry
          is a new attempt — it does not give an agent back the time or tokens
          it already spent.
        </p>
        <ul className="grid gap-1.5">
          {outputs.map((output) => {
            const key = `${output.agentInstanceId}:${output.path}`;
            return (
              <li key={key}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2">
                  <Checkbox
                    checked={keep.includes(key)}
                    onChange={() => onToggle(key)}
                  />
                  <Path className="border-0 bg-transparent px-0">
                    {output.path}
                  </Path>
                </label>
              </li>
            );
          })}
        </ul>
        {keep.length === 0 && (
          <p>
            Nothing selected — the next attempt will redo all of this from the
            current requirements.
          </p>
        )}
      </Notice>
    </section>
  );
}
