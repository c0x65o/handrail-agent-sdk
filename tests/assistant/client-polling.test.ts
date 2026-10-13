import { afterEach, expect, it, vi } from "vitest";
import { createHandrailAiClient, type HandrailAiClientBootstrapOptions } from "../../src/assistant/client/bootstrap.js";
import { pollingGateway } from "./fixtures/polling-gateway.js";

type Timings = Pick<HandrailAiClientBootstrapOptions<unknown, unknown, unknown>,
  "activityPollingMilliseconds" | "synchronizationPollingMilliseconds" | "idleSynchronizationPollingMilliseconds">;
const clients: Awaited<ReturnType<typeof createHandrailAiClient>>[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.dispose(); vi.useRealTimers(); });
async function fixture(timings: Timings = {}, running = false) {
  const gateway = pollingGateway(); gateway.setRunning(running);
  const client = await createHandrailAiClient({ baseUrl: "https://fixture.test/assistant", fetch: gateway.fetch, ...timings,
    restoreActiveTurns: false, conversations: { mode: "multiple", clientId: "test" as never, authorize: () => "allow" } });
  clients.push(client);
  const runtime = await client.workspace!.open({ conversationId: "chat" as never, authorizationContext: {} });
  return { client, gateway, runtime };
}

it.each([
  { timings: {}, active: 1000, idle: 15000, activity: 5000 },
  { timings: { synchronizationPollingMilliseconds: 3000, idleSynchronizationPollingMilliseconds: 9000,
    activityPollingMilliseconds: 7000 }, active: 3000, idle: 9000, activity: 7000 },
])("honors successful visible/hidden/running polling and defaults: $timings", async ({ timings, active, idle, activity }) => {
  vi.useFakeTimers();
  const { client, gateway, runtime } = await fixture(timings, true);
  await vi.advanceTimersByTimeAsync(active);
  const controls = gateway.count("control"), changes = gateway.count("changes");
  await vi.advanceTimersByTimeAsync(active - 1);
  expect(gateway.count("control")).toBe(controls);
  await vi.advanceTimersByTimeAsync(1);
  expect(gateway.count("control")).toBe(controls + 1);
  // An unchanged authoritative revision does not refetch display records.
  expect(gateway.count("changes")).toBe(changes);
  gateway.setRunning(false);
  await runtime.synchronize!();
  client.workspace!.setVisible(false);
  await vi.advanceTimersByTimeAsync(0);
  const hiddenControls = gateway.count("control"), hiddenChanges = gateway.count("changes");
  await vi.advanceTimersByTimeAsync(idle - 1);
  expect(gateway.count("control")).toBe(hiddenControls);
  await vi.advanceTimersByTimeAsync(idle * 3 + 1);
  expect(gateway.count("control")).toBeGreaterThan(hiddenControls);
  expect(gateway.count("changes")).toBe(hiddenChanges);
  // A newly observed active turn restores the configured fast cadence while hidden.
  gateway.setRunning(true);
  await runtime.synchronize!();
  const runningControls = gateway.count("control");
  await vi.advanceTimersByTimeAsync(active - 1);
  expect(gateway.count("control")).toBe(runningControls);
  await vi.advanceTimersByTimeAsync(1);
  expect(gateway.count("control")).toBe(runningControls + 1);
  const activityReads = gateway.reads.filter(read => read.operation === "activity");
  expect(activityReads.length).toBeGreaterThan(1);
  expect(activityReads.slice(1).every((read, index) => read.at - activityReads[index]!.at >= activity)).toBe(true);
  await client.dispose();
  const stopped = gateway.reads.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(gateway.reads).toHaveLength(stopped);
});

it("retains the Retry-After minimum above configured activity and display intervals", async () => {
  vi.useFakeTimers();
  const { gateway } = await fixture({ activityPollingMilliseconds: 500, synchronizationPollingMilliseconds: 500,
    idleSynchronizationPollingMilliseconds: 1000 });
  gateway.throttle.add("control"); gateway.throttle.add("activity");
  // Idle backoff means the two readers need not fire together. Capture each
  // throttled read, then prove its own subsequent read respects Retry-After.
  const starts = new Map<string, number>();
  for (let tick = 0; tick < 1000 && starts.size < 2; tick++) {
    await vi.advanceTimersByTimeAsync(100);
    for (const operation of ["control", "activity"]) {
      if (!gateway.throttle.has(operation) && !starts.has(operation)) {
        starts.set(operation, gateway.reads.findLast(read => read.operation === operation)!.at);
      }
    }
  }
  expect(starts.size).toBe(2);
  await vi.advanceTimersByTimeAsync(60000);
  for (const [operation, at] of starts) {
    const next = gateway.reads.find(read => read.operation === operation && read.at > at);
    expect(next).toBeDefined();
    expect(next!.at - at).toBeGreaterThanOrEqual(20000);
  }

});

it.each(["activityPollingMilliseconds", "synchronizationPollingMilliseconds", "idleSynchronizationPollingMilliseconds"] as const)(
  "uses existing bootstrap validation for %s", async option => {
    vi.useFakeTimers();
    const minimum = option === "activityPollingMilliseconds" ? 500 : 100;
    for (const value of [0, minimum - 1, 300001, 1000.5, NaN, Infinity]) {
      await expect(fixture({ [option]: value })).rejects.toThrow(option === "activityPollingMilliseconds"
        ? "intervalMilliseconds must be between 500 and 300000" : "Invalid conversation polling interval");
    }
    for (const value of [minimum, 300000]) await fixture({ [option]: value });
  });
