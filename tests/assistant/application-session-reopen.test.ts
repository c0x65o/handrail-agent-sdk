import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ApplicationConversationSession, InMemoryApplicationConversationPendingStore,
  type ApplicationConversationReader, type ConversationDisplayControl, type ConversationDisplayPage,
} from '../../src/assistant/client/index.js';

const id = 'reopen-conversation';
const disposals: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); });
function fixture() {
  let generation = 1;
  const page = (): ConversationDisplayPage => ({ schemaVersion: 1, conversationId: id, status: 'ready',
    generation, revision: generation, canonicalRevision: generation, activeTurnId: null, nextCursor: null,
    records: generation === 1 ? [{ kind: 'message', id: 'saved-message', turnId: null, revision: 1, bytes: 100,
      deferred: false, value: { message_id: 'saved-message' as never, role: 'assistant',
        content: [{ type: 'text', text: 'Private saved answer' }], attachments: [], created_at: null, attribution: null } }] : [],
  });
  const control = (): ConversationDisplayControl => ({ ...page(), activeTurn: null, requestedTurn: null, latestTurn: null });
  const reader = {
    control: vi.fn(async () => control()),
    page: vi.fn<ApplicationConversationReader['page']>(async input => ({ ...page(),
      records: input.view?.type === 'context' ? [] : page().records })),
    changes: vi.fn(async () => ({ ...page(), records: [], throughRevision: generation })),
  };
  const session = new ApplicationConversationSession({ conversationId: id as never, clientId: 'test' as never,
    reader, resources: { appendMutations: vi.fn() }, transport: {} as never,
    pendingStore: new InMemoryApplicationConversationPendingStore(),
  });
  disposals.push(() => session.dispose());
  return { session, reader, control, clear: () => { generation++; } };
}

it('retains its bounded message window and saved anchor through close and delayed revalidation', async () => {
  const { session, reader, control } = fixture();
  await session.initialize();
  const records = session.getSnapshot().window.records;
  const position = { messageId: 'saved-message', generation: 1, offset: -27, following: false };
  session.savePosition(position);
  session.setFollowingLatest(false);
  await session.setActive(false);
  expect(session.getSnapshot().window.records).toBe(records);
  reader.page.mockClear();
  let release!: (value: ConversationDisplayControl) => void;
  reader.control.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const reopening = session.setActive(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(session.getSnapshot().window.records).toBe(records);
  expect(session.getSnapshot().loading).toBe(false);
  release(control()); await reopening;
  expect(session.getSnapshot().window.records).toBe(records);
  expect(session.getPosition()).toEqual(position);
  expect(reader.page.mock.calls.filter(([input]) => input.view?.type !== 'context')).toHaveLength(0);
});

it.each(['forbidden', 'permission_denied', 'unauthenticated', 'not_found'])(
  'evicts retained content on %s during reopen', async code => {
    const { session, reader } = fixture();
    await session.initialize(); await session.setActive(false);
    reader.control.mockRejectedValueOnce({ code, retryable: false });
    await expect(session.setActive(true)).rejects.toMatchObject({ code });
    expect(session.getSnapshot().window.records).toEqual([]);
    expect(session.getSnapshot().related).toEqual([]);
  },
);

it.each([false, true])('invalidates a generation change (observed while hidden: %s)', async observeHidden => {
  const { session, clear } = fixture();
  await session.initialize(); await session.setActive(false);
  clear();
  if (observeHidden) {
    await session.refresh();
    expect(session.getSnapshot().window.records).toEqual([]);
  }
  await session.setActive(true);
  expect(session.getSnapshot().window.generation).toBe(2);
  expect(session.getSnapshot().window.records).toEqual([]);
});

it('account disposal drops retained content and ignores late reads from that account', async () => {
  const { session, reader, control } = fixture();
  await session.initialize(); await session.setActive(false);
  let release!: (value: ConversationDisplayControl) => void;
  reader.control.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = session.setActive(true);
  await vi.advanceTimersByTimeAsync(1);
  session.dispose();
  release(control()); await pending;
  expect(session.getSnapshot().window.records).toEqual([]);
  expect(session.getPosition()).toBeUndefined();
});
