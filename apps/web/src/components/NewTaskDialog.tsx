import { postTaskRequestSchema, type PostTaskRequest } from '@app/contracts';
import { Check, Plus, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';

interface NewTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (request: PostTaskRequest) => void;
}

export function NewTaskDialog({ open, onClose, onSubmit }: NewTaskDialogProps) {
  const [title, setTitle] = useState('');
  const [outcome, setOutcome] = useState('');
  const [criteria, setCriteria] = useState(['']);
  const [outputPaths, setOutputPaths] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!open) return null;

  function close() {
    setErrors({});
    onClose();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = postTaskRequestSchema.safeParse({
      kind: 'agent_task',
      title,
      outcome,
      criteria: criteria.map((item) => item.trim()).filter(Boolean),
      outputPaths: outputPaths.split(',').map((item) => item.trim()).filter(Boolean),
      inputs: [],
      creatorGuestLabel: 'Guest Cedar',
      clientRequestId: crypto.randomUUID(),
    });

    if (!result.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        nextErrors[String(issue.path[0] ?? 'form')] ??= issue.message;
      }
      setErrors(nextErrors);
      return;
    }

    onSubmit(result.data);
    setTitle('');
    setOutcome('');
    setCriteria(['']);
    setOutputPaths('');
    setErrors({});
  }

  return (
    <div className="dialog-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-task-heading">
        <header className="dialog-header">
          <div>
            <span className="eyebrow">New task</span>
            <h2 id="new-task-heading">What should we work on?</h2>
            <p>Post the brief first. You can discuss and refine it before starting agents.</p>
          </div>
          <button className="icon-button" onClick={close} aria-label="Close dialog"><X size={20} /></button>
        </header>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="task-title">Task title</label>
            <input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Draft the launch FAQ" autoFocus />
            {errors.title && <span className="field-error">{errors.title}</span>}
          </div>
          <div className="field">
            <label htmlFor="task-outcome">Desired outcome</label>
            <textarea id="task-outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)} placeholder="Describe what a successful result should accomplish…" rows={4} />
          </div>
          <fieldset className="criteria-fieldset">
            <legend>Acceptance criteria</legend>
            <p>Give collaborators a concrete checklist for review.</p>
            <div className="criteria-list">
              {criteria.map((criterion, index) => (
                <div className="criterion-row" key={index}>
                  <span className="criterion-check"><Check size={14} /></span>
                  <input
                    aria-label={`Acceptance criterion ${index + 1}`}
                    value={criterion}
                    onChange={(event) => setCriteria((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}
                    placeholder="What must be true when this is done?"
                  />
                  {criteria.length > 1 && (
                    <button type="button" className="remove-criterion" onClick={() => setCriteria((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove criterion ${index + 1}`}>
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button type="button" className="text-button" onClick={() => setCriteria((current) => [...current, ''])}>
              <Plus size={15} /> Add criterion
            </button>
            {errors.criteria && <span className="field-error">{errors.criteria}</span>}
          </fieldset>
          <div className="field">
            <label htmlFor="output-paths">Intended output paths <span>Optional</span></label>
            <input id="output-paths" value={outputPaths} onChange={(event) => setOutputPaths(event.target.value)} placeholder="documents/faq.md, code/example.ts" />
            <small>Separate multiple paths with commas.</small>
            {errors.outputPaths && <span className="field-error">{errors.outputPaths}</span>}
          </div>

          <footer className="dialog-footer">
            <span><span className="post-dot" /> Posting won’t start agents</span>
            <div>
              <button type="button" className="button button-secondary" onClick={close}>Cancel</button>
              <button type="submit" className="button button-primary">Post task</button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
