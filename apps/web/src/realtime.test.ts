import { afterEach, expect, it, vi } from 'vitest';
import { refreshLoop, subscribeRefresh } from './realtime';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
const cleanups: (() => void)[] = [];
class Source extends EventTarget {
  static instances: Source[] = [];
  readyState = 0;
  close = vi.fn();
  constructor(readonly url: string) { super(); Source.instances.push(this); }
  hint(overrides = {}) {
    this.dispatchEvent(new MessageEvent('refresh', { data: JSON.stringify({
      workspaceId, taskId, eventType: 'discussion.posted', eventId: '1', ...overrides,
    }) }));
  }
}
function setup() {
  vi.useFakeTimers();
  Source.instances = [];
  vi.stubGlobal('EventSource', Source);
}
afterEach(() => { cleanups.splice(0).forEach((stop) => stop()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shares a stream, validates workspace hints and reconciles on reconnect', () => {
  setup();
  const a = vi.fn(), b = vi.fn();
  const stop = subscribeRefresh(workspaceId, a);
  cleanups.push(subscribeRefresh(workspaceId, b));
  expect(Source.instances).toHaveLength(1);
  const source = Source.instances[0]!;
  source.hint({ workspaceId: taskId });
  source.dispatchEvent(new MessageEvent('refresh', { data: 'invalid' }));
  expect(a).not.toHaveBeenCalled();
  source.hint();
  expect(a).toHaveBeenCalledTimes(1);
  stop();
  expect(source.close).not.toHaveBeenCalled();
  source.dispatchEvent(new MessageEvent('ready', { data: '{}' }));
  expect(b).toHaveBeenLastCalledWith(null);
  cleanups.pop()!();
  expect(source.close).toHaveBeenCalledOnce();
});

it('refreshes immediately, coalesces bursts during a slow request and filters other tasks', async () => {
  setup();
  let finish!: () => void;
  const pull = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  cleanups.push(refreshLoop(workspaceId, taskId, pull, () => 5000));
  const source = Source.instances[0]!;
  source.hint(); source.hint(); source.hint();
  expect(pull).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(pull).toHaveBeenCalledTimes(2);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  source.hint({ taskId: workspaceId });
  expect(pull).toHaveBeenCalledTimes(2);
  source.hint();
  expect(pull).toHaveBeenCalledTimes(3);
  finish();
});

it('uses a slow safety poll while connected, restores fallback and cleans up', async () => {
  setup();
  const pull = vi.fn(async () => {});
  const stop = refreshLoop(workspaceId, taskId, pull, () => 5000);
  cleanups.push(stop);
  const source = Source.instances[0]!;
  source.readyState = 1;
  await vi.advanceTimersByTimeAsync(5000);
  expect(pull).toHaveBeenCalledTimes(1);
  source.readyState = 0;
  source.dispatchEvent(new Event('error'));
  await vi.advanceTimersByTimeAsync(0);
  expect(pull).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(pull).toHaveBeenCalledTimes(3);
  stop();
  await vi.advanceTimersByTimeAsync(60000);
  expect(pull).toHaveBeenCalledTimes(3);
});
