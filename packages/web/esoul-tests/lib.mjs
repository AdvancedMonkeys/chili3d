// The esoul runtime, driven the way the CAD app drives it: a headless Chrome opens dist/esoul.html from a local
// static server (the bridge trusts only the `?parent=` origin, which is the page's own here) and every test speaks
// the postMessage bridge. Chrome: CHROME_PATH, else a system chrome, else a Chrome for Testing under ~/.cache/puppeteer.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DIST = path.resolve(HERE, "../../../dist");
export const OUT = path.join(HERE, "out");

export function findChrome() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
        try {
            const p = execFileSync("which", [name], { encoding: "utf8" }).trim();
            if (p && fs.existsSync(p)) return p;
        } catch {
            /* not here */
        }
    }
    const root = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
    if (fs.existsSync(root)) {
        for (const v of fs
            .readdirSync(root)
            .filter((d) => d.startsWith("linux-"))
            .sort()
            .reverse()) {
            const bin = path.join(root, v, "chrome-linux64", "chrome");
            if (fs.existsSync(bin)) return bin;
        }
    }
    throw new Error(
        "no Chrome: set CHROME_PATH (apt's google-chrome-stable works; so does a Chrome for Testing under ~/.cache/puppeteer)",
    );
}

const MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ico": "image/x-icon",
    ".step": "application/octet-stream",
};
/** Serve `dir` on an ephemeral port; resolves to the origin. */
export function serveStatic(dir) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://x");
            const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
            const file = path.join(dir, rel);
            if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                res.writeHead(404);
                res.end("not found");
                return;
            }
            // HEAD and Range, as a blob store answers them: the runtime reads big inputs in ranges (runtime 35).
            const size = fs.statSync(file).size;
            const base = {
                "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
                "cache-control": "no-store",
                "accept-ranges": "bytes",
            };
            if (req.method === "HEAD") {
                res.writeHead(200, { ...base, "content-length": size });
                res.end();
                return;
            }
            const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
            if (m) {
                const start = Number(m[1]);
                const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
                res.writeHead(206, {
                    ...base,
                    "content-length": end - start + 1,
                    "content-range": `bytes ${start}-${end}/${size}`,
                });
                fs.createReadStream(file, { start, end }).pipe(res);
                return;
            }
            res.writeHead(200, { ...base, "content-length": size });
            fs.createReadStream(file).pipe(res);
        });
        server.listen(0, "127.0.0.1", () =>
            resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }),
        );
    });
}

/** A runtime page with an rpc(method, args) that speaks the bridge. */
export async function openRuntime(pageUrl) {
    const origin = new URL(pageUrl).origin;
    const browser = await puppeteer.launch({
        executablePath: findChrome(),
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--use-gl=swiftshader",
            "--enable-unsafe-swiftshader",
        ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 750 });
    page.on("dialog", async (d) => {
        await d.dismiss();
    });
    await page.evaluateOnNewDocument(() => {
        window.__msgs = [];
        window.addEventListener("message", (e) => {
            if (e.data && e.data.esoulCad === 1) window.__msgs.push(e.data);
        });
    });
    await page.goto(`${pageUrl}?parent=${encodeURIComponent(origin)}&name=tests&t=${Date.now()}`, {
        waitUntil: "load",
    });
    await page.waitForFunction(() => window.__msgs.some((m) => m.type === "ready"), { timeout: 120000 });
    let n = 0;
    async function rpc(method, args) {
        const id = `${method}-${n++}`;
        const t = Date.now();
        await page.evaluate((m) => window.postMessage(m, location.origin), { esoulCad: 1, id, method, args });
        await page.waitForFunction(
            (id) => window.__msgs.some((m) => m.id === id && "ok" in m),
            { timeout: 300000 },
            id,
        );
        const r = await page.evaluate((id) => window.__msgs.find((m) => m.id === id && "ok" in m), id);
        r.ms = Date.now() - t;
        return r;
    }
    return { browser, page, rpc, origin, close: () => browser.close() };
}
