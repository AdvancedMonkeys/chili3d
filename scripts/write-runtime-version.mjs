// Writes public/version.json from the runtime's RUNTIME_VERSION so an embedding host can ask the
// published site which build it serves (no-store fetch) and reload its viewer when a newer one is live.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const src = readFileSync(new URL("../packages/web/src/esoul.ts", import.meta.url), "utf8");
const m = /const RUNTIME_VERSION = "([^"]+)"/.exec(src);
if (!m) throw new Error("RUNTIME_VERSION not found in packages/web/src/esoul.ts");
mkdirSync(new URL("../public", import.meta.url), { recursive: true });
writeFileSync(
    new URL("../public/version.json", import.meta.url),
    `${JSON.stringify({ runtimeVersion: m[1], builtAt: new Date().toISOString() })}\n`,
);
console.log(`public/version.json: ${m[1]}`);
