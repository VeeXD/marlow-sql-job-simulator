import { migrate, pool, waitForDatabase } from "./db.js";
import { ensureTemplate } from "./sandbox.js";

await waitForDatabase();
await migrate();
await ensureTemplate(true);
console.log("marlow_template rebuilt.");
await pool.end();
