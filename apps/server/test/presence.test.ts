import { describe, expect, it } from 'vitest';
import { PRESENCE_MAX_PARTICIPANTS, PRESENCE_TTL_MS } from '@app/contracts';
import { PresenceRegistry } from '../src/events/presence.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = (n: number, name = `Guest ${n}`) => ({ presenceId: id(n), name, color: '#2c4270' });

describe('workspace presence', () => {
  it('reports a change only when the visible roster actually changes', () => {
    let now = 1000;
    const registry = new PresenceRegistry(() => now);

    expect(registry.announce('w', entry(1))).toBe(true);
    // A repeat heartbeat is the common case and must not wake every other
    // browser in the room with a redundant broadcast.
    now += 20_000;
    expect(registry.announce('w', entry(1))).toBe(false);
    // A rename is visible, so it is worth sending.
    expect(registry.announce('w', entry(1, 'Ada'))).toBe(true);
    expect(registry.list('w')).toEqual([
      { presenceId: id(1), name: 'Ada', color: '#2c4270', since: 1000 },
    ]);
  });

  it('keeps the server-derived account marker with the live participant', () => {
    const registry = new PresenceRegistry(() => 1000);
    registry.announce('w', { ...entry(1, 'Ada'), isAccount: true });
    expect(registry.list('w')[0]).toMatchObject({ name: 'Ada', isAccount: true });
  });

  it('drops a browser that stopped saying it was here', () => {
    let now = 1000;
    const registry = new PresenceRegistry(() => now);
    registry.announce('w', entry(1));
    registry.announce('w', entry(2));

    now += PRESENCE_TTL_MS + 1;
    registry.announce('w', entry(2));
    // Someone who closes a laptop never sends a leave, so the only thing that
    // removes them is the clock. Listing must not wait for the sweep either.
    expect(registry.list('w').map((p) => p.presenceId)).toEqual([id(2)]);
    expect(registry.sweep()).toEqual(['w']);
    expect(registry.sweep()).toEqual([]);
  });

  it('keeps arrival order stable so the list does not reshuffle under people', () => {
    let now = 1000;
    const registry = new PresenceRegistry(() => now);
    registry.announce('w', entry(3));
    now += 5;
    registry.announce('w', entry(1));
    now += 5;
    registry.announce('w', entry(2));
    expect(registry.list('w').map((p) => p.presenceId)).toEqual([id(3), id(1), id(2)]);
  });

  it('broadcasts typing by burst and expires it without persisting anything', () => {
    let now = 1000;
    const registry = new PresenceRegistry(() => now);
    registry.announce('w', entry(1));
    expect(registry.setTyping('w', id(1), id(90))).toBe(true);
    expect(registry.list('w')[0]?.typingTaskId).toBe(id(90));
    // Refreshing the same burst updates its clock without another broadcast.
    now += 3_000;
    expect(registry.setTyping('w', id(1), id(90))).toBe(false);
    now += 5_001;
    expect(registry.list('w')[0]?.typingTaskId).toBeUndefined();
  });

  it('caps a room, because the presence ID is chosen by the browser', () => {
    const registry = new PresenceRegistry(() => 1000);
    for (let n = 0; n < PRESENCE_MAX_PARTICIPANTS; n++) {
      expect(registry.announce('w', entry(n))).toBe(true);
    }
    // A link holder can mint unlimited IDs and this registry is in memory, so
    // the ceiling cannot be the attacker's patience.
    expect(registry.announce('w', entry(9999))).toBe(false);
    expect(registry.list('w')).toHaveLength(PRESENCE_MAX_PARTICIPANTS);
  });

  it('keeps workspaces separate and forgets an empty one', () => {
    const registry = new PresenceRegistry(() => 1000);
    registry.announce('a', entry(1));
    registry.announce('b', entry(2));
    expect(registry.list('a').map((p) => p.presenceId)).toEqual([id(1)]);
    expect(registry.list('b').map((p) => p.presenceId)).toEqual([id(2)]);

    expect(registry.leave('a', id(1))).toBe(true);
    expect(registry.leave('a', id(1))).toBe(false);
    expect(registry.list('a')).toEqual([]);
    expect(registry.list('b')).toHaveLength(1);
  });
});
