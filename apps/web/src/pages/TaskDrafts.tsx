import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { draftFileSchema, uuidSchema, type DraftFile } from '@app/contracts';
import { EmptyState } from '../components/EmptyState';

const SharedEditor = lazy(() => import('../components/SharedEditor').then((module) => ({ default: module.SharedEditor })));

export function TaskDrafts({ workspaceId }: { workspaceId: string }) {
  const { taskId } = useParams();
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const [selected, setSelected] = useState('');
  const [status, setStatus] = useState('loading');
  const [retry, setRetry] = useState(0);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    if (!uuidSchema.safeParse(taskId).success) { setStatus('missing'); return; }
    void fetch(`/api/workspaces/${workspaceId}/tasks/${taskId}/drafts`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? 'missing' : 'error');
        const data = await response.json();
        const files = draftFileSchema.array().parse(data.drafts);
        if (!controller.signal.aborted) { setDrafts(files); setSelected(files[0]?.id ?? ''); setStatus('ready'); }
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setStatus(error instanceof Error && error.message === 'missing' ? 'missing' : 'error');
      });
    return () => controller.abort();
  }, [workspaceId, taskId, retry]);
  const draft = drafts.find((file) => file.id === selected);
  return <>
    <Link to={`/w/${workspaceId}`}>Back to workspace</Link>
    <h1>Shared drafts</h1>
    {status === 'loading' ? <p role="status">Loading drafts…</p> : status !== 'ready' ?
      <EmptyState title={status === 'missing' ? 'Task not found' : 'Could not load drafts'} action={<button onClick={() => setRetry(retry + 1)}>Try again</button>}>Check the editing link or try again.</EmptyState> : !draft ?
      <EmptyState title="No shared drafts yet">This task has no open documents.</EmptyState> : <>
        <label>Document<select value={selected} onChange={(event) => {
          if (saved || window.confirm('This draft has unsaved changes. Switch and discard those changes?')) {
            setSaved(false); setSelected(event.target.value);
          }
        }}>{drafts.map((file) => <option key={file.id} value={file.id}>{file.path}</option>)}</select></label>
        <Suspense fallback={<p role="status">Loading editor…</p>}>
          <SharedEditor key={`${draft.id}:${draft.epoch}`} room={{ workspaceId, taskId: taskId!, draftFileId: draft.id, epoch: draft.epoch }} draft={draft} onSaved={setSaved} />
        </Suspense>
      </>}
  </>;
}
