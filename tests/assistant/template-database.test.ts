import { expect, it, vi } from "vitest";
import { createDatabase } from "../../templates/standard-react-node/src/assistant/host/database.js";
import { createPostgresHarness } from "../helpers/postgres.js";

it("handles idle errors without exposing error or client details", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { pool } = createDatabase("postgres://fixture:private@127.0.0.1:1/unused");
  try {
    expect(() => pool.emit("error", new Error("private SQL and credentials"),
      { password: "private" })).not.toThrow();
    expect(log.mock.calls).toEqual([[JSON.stringify({ event: "database_pool_idle_connection_error" })]]);
    expect(pool.ending).toBe(false);
  } finally {
    await pool.end();
    log.mockRestore();
  }
});

it.skipIf(!process.env.HANDRAIL_TEST_POSTGRES_URL)(
  "replaces a terminated idle connection and rejects interrupted queries without replay",
  async () => {
    // Validates explicit disposable authorization and rejects ambient PG config
    // before the template creates any connections.
    const harness = await createPostgresHarness();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { pool } = createDatabase(process.env.HANDRAIL_TEST_POSTGRES_URL!);
    try {
      const control = await harness.client();
      const original = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const oldPid = original.rows[0]!.pid;
      expect(pool.idleCount).toBe(1);
      await control.query("SELECT pg_terminate_backend($1)", [oldPid]);
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
      expect(pool.totalCount).toBe(0);

      const replacement = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const newPid = replacement.rows[0]!.pid;
      expect(newPid).not.toBe(oldPid);
      expect(pool.idleCount).toBe(1);

      // Observe an actual in-flight query before terminating our own backend.
      // Attach rejection handling immediately so the test has no unhandled rejection.
      const pending = pool.query("SELECT pg_sleep(10)").then(
        () => ({ rejected: false }), () => ({ rejected: true }));
      await vi.waitFor(async () => {
        const state = await control.query<{ active: boolean }>(
          "SELECT state = 'active' AND query = 'SELECT pg_sleep(10)' AS active FROM pg_stat_activity WHERE pid = $1",
          [newPid]);
        expect(state.rows[0]?.active).toBe(true);
      });
      await control.query("SELECT pg_terminate_backend($1)", [newPid]);
      expect(await pending).toEqual({ rejected: true });
      expect((await pool.query("SELECT 42 AS value")).rows).toEqual([{ value: 42 }]);
      expect(log.mock.calls).toEqual([[JSON.stringify({ event: "database_pool_idle_connection_error" })]]);
    } finally {
      await pool.end();
      log.mockRestore();
      await harness.cleanup();
    }
  }, 15_000,
);
