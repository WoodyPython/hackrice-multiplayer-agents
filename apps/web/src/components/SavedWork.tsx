import type { SavedOutputOption } from "@app/contracts";

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
    <section className="notice saved-work" aria-label="Saved work">
      <h3>Work the last attempt finished</h3>
      <p>
        These files were completed before the attempt stopped. Keep them and the
        next attempt starts from them instead of redoing the work. A retry is a
        new attempt — it does not give an agent back the time or tokens it
        already spent.
      </p>
      <ul className="saved-list">
        {outputs.map((output) => {
          const key = `${output.agentInstanceId}:${output.path}`;
          return (
            <li key={key}>
              <label>
                <input
                  type="checkbox"
                  checked={keep.includes(key)}
                  onChange={() => onToggle(key)}
                />
                <code className="path">{output.path}</code>
              </label>
            </li>
          );
        })}
      </ul>
      {keep.length === 0 && (
        <p className="muted">
          Nothing selected — the next attempt will redo all of this from the
          current requirements.
        </p>
      )}
    </section>
  );
}
