import { z } from "zod";
import { resolve } from "node:path";
import { root, save, log } from "../src/io.ts";

if (await Bun.file(resolve(root, ".env")).exists()) throw new Error(".env already exists; refusing to overwrite credentials");
const processResult = Bun.spawn(["local-base", "--json", "keys", "create", "--name", "local-job-assistant"], { stdout: "pipe", stderr: "pipe" });
const [output, code] = await Promise.all([new Response(processResult.stdout).text(), processResult.exited]);
if (code !== 0) throw new Error("LocalBase key creation failed; inspect local-base service status");
const result = z.object({ ok: z.literal(true), data: z.object({ secret: z.string().regex(/^[a-zA-Z0-9_-]+$/), key: z.object({ id: z.string() }) }) }).parse(JSON.parse(output));
await save(".env", `LOCALBASE_URL=http://127.0.0.1:2273\nLOCALBASE_API_KEY=${result.data.secret}\n`);
await save("data/localbase-key.json", { id: result.data.key.id, name: "local-job-assistant" });
log("localbase_connected", { credentialFile: ".env", permissions: "0600" });
