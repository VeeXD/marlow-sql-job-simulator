import { buildApp, attachSocket } from "./app.js";
import { config } from "./config.js";
import { migrate, pool, waitForDatabase } from "./db.js";
import { ensureTemplate } from "./sandbox.js";
import { startWorker } from "./worker.js";

export async function start(port = config.apiPort) {
  await waitForDatabase();
  await migrate();
  await ensureTemplate();
  const app = await buildApp();
  await app.listen({ port, host: "0.0.0.0" });
  const io = attachSocket(app);
  const worker = config.enableWorker ? await startWorker().catch((err) => {
    app.log.error({ err }, "BullMQ worker failed to start; clock still advances on API reads");
    return null;
  }) : null;
  const address = app.server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${bound}`,
    close: async () => {
      await io.close();
      await worker?.close();
      await app.close();
    },
  };
}

const invokedDirectly = process.argv[1]?.includes("index");
if (invokedDirectly) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export async function shutdownPool(): Promise<void> {
  await pool.end();
}
