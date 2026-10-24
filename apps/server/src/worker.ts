import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config.js";
import { reapOldSandboxes, scanActiveSessions, setLlmCache } from "./session.js";

export async function startWorker(): Promise<{ close: () => Promise<void> }> {
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  setLlmCache(
    (key) => connection.get(key),
    async (key, value) => {
      await connection.set(key, value, "EX", 60 * 60);
    },
  );
  const queue = new Queue("director", { connection });
  const worker = new Worker(
    "director",
    async (job) => {
      if (job.name === "scan") {
        await scanActiveSessions();
        if (new Date().getUTCHours() === 7 && new Date().getUTCMinutes() < 1) await reapOldSandboxes();
      }
    },
    { connection },
  );
  await queue.add("scan", {}, { repeat: { every: 2000 }, jobId: "director-scan" });
  return {
    close: async () => {
      await worker.close();
      await queue.close();
      await connection.quit();
    },
  };
}
