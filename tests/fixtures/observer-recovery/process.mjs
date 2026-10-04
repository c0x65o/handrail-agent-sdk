import { composition, start } from './composition.mjs';
process.once('message', async ({ schema, key }) => {
  let s;
  try {
    s = await composition(schema, key);
    const recovery = await s.durable.recoverTurn(start.conversationId, start.conversationTurnId);
    const deadline = Date.now() + 5000;
    while (s.durable.activeWorkerCount) {
      if (Date.now() > deadline) throw Error('recovery_timeout');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    process.send({ recovery, status: (await s.document()).record.status, modelRequests: s.model.requests });
  } catch { process.send({ error: 'cold_process_recovery_failed' }); }
  finally { await s?.close(); process.disconnect(); }
});
