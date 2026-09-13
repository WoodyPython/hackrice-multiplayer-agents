import { useSearchParams } from 'react-router-dom';
import { Inbox as InboxIcon } from 'lucide-react';
import { inboxTypeSchema, type InboxItem, type InboxType } from '@app/contracts';
import type { InboxState } from '../inbox';
import { EmptyState } from '../components/EmptyState';
import { PageHeading } from '../components/PageHeading';
import { Badge } from '../components/ui/badge';
import { Button, ButtonLink } from '../components/ui/button';
import { Label, Select } from '../components/ui/field';
import { ErrorText, Skeleton } from '../components/ui/misc';

const labels: Record<InboxType, string> = {
  question: 'Agent questions', review: 'Pending reviews', failed_run: 'Failed runs', blocker: 'Blockers',
};
const actions: Record<InboxType, string> = {
  question: 'Answer question', review: 'Review task', failed_run: 'Inspect run', blocker: 'Resolve blocker',
};

export function inboxTarget(workspaceId: string, item: InboxItem) {
  const tab = item.type === 'question' ? 'Discussion'
    : item.type === 'review' || (item.type === 'blocker' && item.reviewId) ? 'Changes' : 'Agents';
  return `/w/${workspaceId}/tasks/${item.taskId}?tab=${tab}`;
}

export function Inbox({ workspaceId, state }: { workspaceId: string; state: InboxState }) {
  const [params, setParams] = useSearchParams();
  const parsed = inboxTypeSchema.safeParse(params.get('type'));
  const filter = parsed.success ? parsed.data : 'all';
  const { items, failure, reload } = state;
  const visible = items?.filter((item) => filter === 'all' || item.type === filter);
  return <>
    <PageHeading eyebrow="Needs your attention" title="Inbox"
      description="Questions, reviews, failed runs, and blockers across this workspace. Items clear when the issue is resolved." />
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="w-full max-w-xs space-y-2">
        <Label htmlFor="inbox-type">Filter by type</Label>
        <Select id="inbox-type" value={filter} onChange={(event) => {
          const next = new URLSearchParams(params);
          if (event.target.value === 'all') next.delete('type'); else next.set('type', event.target.value);
          setParams(next, { replace: true });
        }}>
          <option value="all">All types{items ? ` (${items.length})` : ''}</option>
          {inboxTypeSchema.options.map((type) => <option key={type} value={type}>
            {labels[type]}{items ? ` (${items.filter((item) => item.type === type).length})` : ''}
          </option>)}
        </Select>
      </div>
      <Button size="sm" onClick={reload}>Refresh inbox</Button>
    </div>
    {failure && <div role="alert" className="mb-5 flex flex-wrap items-center gap-3">
      <ErrorText>{failure}{items ? ' Showing the last loaded items.' : ''}</ErrorText>
      <Button size="sm" onClick={reload}>Try again</Button>
    </div>}
    {items === null ? !failure && <div aria-busy="true" className="space-y-3">
      <p role="status" className="sr-only">Loading inbox…</p>
      <Skeleton aria-hidden="true" className="h-28" /><Skeleton aria-hidden="true" className="h-28" />
    </div> : visible?.length === 0 ? <EmptyState icon={InboxIcon}
      title={items.length === 0 ? 'You’re all caught up' : 'No items of this type'}>
      {items.length === 0 ? 'There are no actionable items in this workspace.' : 'Choose another type to see what needs attention.'}
    </EmptyState> : <ul className="max-w-4xl space-y-3" aria-label="Actionable items">
      {visible?.map((item) => <li key={item.id} className="rounded-xl border border-border bg-card p-4 shadow-xs sm:p-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="min-w-0 break-words text-[14px] font-semibold">{item.taskTitle}</h2>
          <Badge size="sm" tone={item.type === 'review' ? 'brand' : 'warn'}>{labels[item.type]}</Badge>
          <time dateTime={item.timestamp} className="text-[12px] text-muted-foreground sm:ml-auto">
            {new Date(item.timestamp).toLocaleString()}
          </time>
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted-foreground">{item.summary}</p>
        <ButtonLink className="mt-4" size="sm" to={inboxTarget(workspaceId, item)}>{actions[item.type]}</ButtonLink>
      </li>)}
    </ul>}
  </>;
}
