// Serve dist/ (and the tests' out/ dir as /__out__/ for URL-import fixtures), run the suite, exit non-zero on a failure.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DIST, HERE, OUT, serveStatic } from "./lib.mjs";

if (!fs.existsSync(path.join(DIST, "esoul.html")))
    throw new Error(`no ${DIST}/esoul.html — build first (npm run build)`);
fs.mkdirSync(OUT, { recursive: true });
const dist = await serveStatic(DIST);
const out = await serveStatic(OUT);
// one origin for both: a tiny proxy that routes /__out__/* to the out server
const proxy = http.createServer((req, res) => {
    const toOut = req.url?.startsWith("/__out__/");
    const target = new URL(
        toOut ? req.url.slice("/__out__".length) : (req.url ?? "/"),
        toOut ? out.origin : dist.origin,
    );
    http.get(target, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
    }).on("error", () => {
        res.writeHead(502);
        res.end();
    });
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${proxy.address().port}`;
console.log(
    `runtime: ${origin}/esoul.html (${JSON.parse(fs.readFileSync(path.join(DIST, "version.json"), "utf8")).runtimeVersion})`,
);
const child = spawn(process.execPath, [path.join(HERE, "runtime.test.mjs")], {
    stdio: "inherit",
    env: { ...process.env, CAD_PAGE: `${origin}/esoul.html` },
});
child.on("exit", (code) => {
    proxy.close();
    dist.close();
    out.close();
    process.exit(code ?? 1);
});
