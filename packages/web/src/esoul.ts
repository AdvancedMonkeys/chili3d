// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.
//
// The ExternalSoul runtime entry (AdvancedMonkeys fork). A page with the kernel, the parametric
// engine and a Three viewport — and no ribbon. It is embedded by the ExternalSoul CAD app as a
// sandboxed iframe and driven over postMessage: the parent replays the model's program list
// (chili's own `ParametricOp` JSON) and asks the same AI tool handlers the in-app assistant uses
// (run_program, capture_screenshot, document_variables, …). Nothing here holds a credential; the
// parent is the only writer of record, and only the origin named in `?parent=` may talk to us.

import type { Tool, ToolResult } from "@chili3d/ai/src/llm/types";
import { buildTools } from "@chili3d/ai/src/tools";
import { AppBuilder } from "@chili3d/builder";
import { type IApplication, type IDocument, type IView, Logger, VisualNode } from "@chili3d/core";

const TAG = "esoulCad";
const VERSION = 1;
const RUNTIME_VERSION = "chili3d-0.7.1+esoul.1";

const params = new URLSearchParams(window.location.search);
const parentOrigin = params.get("parent");

const viewport = document.getElementById("viewport") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;

let app: IApplication | undefined;
let tools: Tool[] = [];

function say(text: string) {
    status.textContent = text;
    status.style.display = text ? "block" : "none";
}

function post(message: Record<string, unknown>) {
    if (!parentOrigin) return;
    window.parent.postMessage({ [TAG]: VERSION, ...message }, parentOrigin);
}

function activeDocument(): IDocument {
    const doc = app?.activeView?.document;
    if (!doc) throw new Error("no document is open");
    return doc;
}

function tool(name: string): Tool {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`unknown method "${name}"; known: ${tools.map((x) => x.name).join(", ")}`);
    return t;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string | ToolResult> {
    return tool(name).handler(args);
}

/** A fresh document in the viewport. The previous one is dropped WITHOUT the save prompt `close()` shows. */
async function openFresh(): Promise<IDocument> {
    if (!app) throw new Error("not booted");
    const prev = app.activeView?.document;
    const doc = await app.newDocument("esoul");
    const view = app.activeView as IView & { setDom?(el: HTMLElement): void };
    view.setDom?.(viewport);
    if (prev && prev !== doc) {
        const views = app.views.filter((x) => x.document === prev);
        app.views.remove(...views);
        app.documents.delete(prev);
        (prev as unknown as { dispose?: () => void }).dispose?.();
        app.activeView = view;
    }
    return doc;
}

interface ReplayArgs {
    variables?: { name: string; type: string; expression: string }[];
    programs?: { id: string; ops: unknown[] }[];
}

/** Rebuild the whole model from intent. Each program's outcome is reported separately; a failure stops the replay there. */
async function replay(args: ReplayArgs): Promise<ToolResult> {
    await openFresh();
    const applied: {
        programId: string;
        ok: boolean;
        error?: string;
        created: unknown[];
        bodies: unknown[];
    }[] = [];
    if (args.variables && args.variables.length > 0) {
        const r = await callTool("document_variables", { action: "set", variables: args.variables });
        const text = typeof r === "string" ? r : r.content;
        let parsed: { error?: string } = {};
        try {
            parsed = JSON.parse(text);
        } catch {
            /* a plain sentence */
        }
        if (parsed.error) throw new Error(`variables: ${parsed.error}`);
    }
    for (const program of args.programs ?? []) {
        try {
            const r = await callTool("run_parametric", { ops: program.ops });
            const text = typeof r === "string" ? r : r.content;
            const parsed = JSON.parse(text) as { error?: string; created?: unknown[]; bodies?: unknown[] };
            if (parsed.error) throw new Error(parsed.error);
            applied.push({
                programId: program.id,
                ok: true,
                created: parsed.created ?? [],
                bodies: parsed.bodies ?? [],
            });
        } catch (err) {
            applied.push({
                programId: program.id,
                ok: false,
                error: (err as Error).message,
                created: [],
                bodies: [],
            });
            break;
        }
    }
    try {
        await callTool("fit_content", {});
    } catch (err) {
        Logger.warn(`fit_content: ${(err as Error).message}`);
    }
    const shot = await callTool("capture_screenshot", {});
    return {
        content: JSON.stringify({ applied, runtimeVersion: RUNTIME_VERSION }),
        images: typeof shot === "string" ? undefined : shot.images,
    };
}

async function exportModel(args: { format?: string; ids?: string[] }): Promise<ToolResult> {
    if (!app) throw new Error("not booted");
    const doc = activeDocument();
    const format = String(args.format ?? "");
    const formats = app.dataExchange.exportFormats();
    if (!formats.includes(format))
        throw new Error(`unknown format "${format}", expected one of ${formats.join(", ")}`);
    let nodes: VisualNode[];
    if (Array.isArray(args.ids) && args.ids.length > 0) {
        const wanted = new Set(args.ids.map(String));
        nodes = doc.modelManager
            .findNodes((n) => wanted.has(n.id))
            .filter((n): n is VisualNode => n instanceof VisualNode);
        if (nodes.length !== wanted.size)
            throw new Error(`some ids are not visual nodes: ${args.ids.join(", ")}`);
    } else {
        nodes = doc.modelManager
            .findNodes((n) => n.parent === doc.modelManager.rootNode && n.visible !== false)
            .filter((n): n is VisualNode => n instanceof VisualNode);
    }
    if (nodes.length === 0) throw new Error("nothing to export");
    const parts = await app.dataExchange.export(format, nodes);
    if (!parts) throw new Error("the exporter produced nothing");
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const ext = format.replace(" binary", "");
    return {
        content: JSON.stringify({ format, fileName: `model${ext}`, bytes: bytes.length, base64: btoa(bin) }),
    };
}

async function dispatch(method: string, args: Record<string, unknown>): Promise<string | ToolResult> {
    switch (method) {
        case "esoul.ping":
            return JSON.stringify({ ok: true, version: RUNTIME_VERSION });
        case "esoul.tools":
            return JSON.stringify(
                tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
            );
        case "esoul.replay":
            return replay(args as ReplayArgs);
        case "esoul.export":
            return exportModel(args as { format?: string; ids?: string[] });
        case "esoul.serialize":
            return JSON.stringify(activeDocument().serialize());
        default:
            return callTool(method, args);
    }
}

window.addEventListener("message", async (event: MessageEvent) => {
    if (!parentOrigin || event.origin !== parentOrigin) return;
    const m = event.data as { [k: string]: unknown } | null;
    if (!m || m[TAG] !== VERSION || typeof m["id"] !== "string" || typeof m["method"] !== "string") return;
    const id = m["id"] as string;
    const method = m["method"] as string;
    const args = (m["args"] as Record<string, unknown> | undefined) ?? {};
    if (!app) {
        post({ id, ok: false, error: "the runtime is still booting" });
        return;
    }
    try {
        const result = await dispatch(method, args);
        post({ id, ok: true, result });
    } catch (err) {
        post({ id, ok: false, error: (err as Error)?.message ?? String(err) });
    }
});

say("Loading the CAD kernel…");
if (!parentOrigin)
    say("This runtime is driven by an embedding page (missing ?parent=<origin>). Loading anyway…");

// prettier-ignore
new AppBuilder()
    .useIndexedDB()
    .useWasmOcc()
    .useParametric()
    .useThree()
    .build()
    .then(async (built) => {
        app = built;
        tools = buildTools();
        await openFresh();
        say("");
        post({ type: "ready", version: RUNTIME_VERSION, tools: tools.map((t) => t.name) });
    })
    .catch((err: Error) => {
        say(`The CAD kernel failed to start: ${err.message}`);
        post({ type: "error", error: err.message });
    });
