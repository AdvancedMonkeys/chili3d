// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.
//
// The ExternalSoul runtime entry (AdvancedMonkeys fork): the full Chili3D UI (ribbon, viewport,
// property panel) plus a postMessage bridge, embedded by the ExternalSoul CAD app as an iframe.
// Two things flow over the bridge:
//   - the parent REPLAYS the model's intent (steps: chili's own `ParametricOp` programs, or a
//     person's earlier edit as a document snapshot) and asks the same AI tool handlers the in-app
//     assistant uses (run_program, capture_screenshot, document_variables, …);
//   - every transaction a person commits by hand in this UI is reported back as an EDIT (the
//     command's name + the serialized document), so the parent can record it on its timeline.
// Nothing here holds a credential; the parent is the only writer of record, and only the origin
// named in `?parent=` may talk to us.

import type { Tool, ToolResult } from "@chili3d/ai/src/llm/types";
import { buildTools } from "@chili3d/ai/src/tools";
import { AppBuilder } from "@chili3d/builder";
import {
    History,
    type IApplication,
    type IDocument,
    type IHistoryRecord,
    type INode,
    Logger,
    VisualNode,
} from "@chili3d/core";
import { Editor, MainWindow } from "@chili3d/ui";
import { Loading } from "./loading";

const TAG = "esoulCad";
const VERSION = 1;
const RUNTIME_VERSION = "chili3d-0.7.1+esoul.9";
const EDIT_DEBOUNCE_MS = 1200;

const params = new URLSearchParams(window.location.search);
const parentOrigin = params.get("parent");

type ThemeMode = "light" | "dark" | "system";
function applyThemeMode(mode: unknown) {
    if (mode !== "light" && mode !== "dark" && mode !== "system") return;
    Config.instance.themeMode = mode as ThemeMode;
}

let app: IApplication | undefined;
let tools: Tool[] = [];
/** True while the bridge itself mutates the document (a replay, a tool call): those are not a person's edits. */
let driving = 0;

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
    driving++;
    try {
        return await tool(name).handler(args);
    } finally {
        driving--;
    }
}

function dropDocument(prev: IDocument | undefined, keep: IDocument) {
    if (!app || !prev || prev === keep) return;
    // The UI reads `activeView.document` whenever the view list changes: point it at the kept
    // document FIRST, then remove the old views, then dispose.
    const keepView = app.views.filter((v) => v.document === keep)[0];
    if (keepView) app.activeView = keepView;
    const views = app.views.filter((x) => x.document === prev);
    app.views.remove(...views);
    app.documents.delete(prev);
    try {
        (prev as unknown as { dispose?: () => void }).dispose?.();
    } catch (err) {
        // chili's Node.disposeInternal reads `document.visual` after the document's own fields are
        // cleared (a FolderNode child trips it); the kept document is unaffected. Logged, not fatal.
        Logger.warn(`esoul: previous document not fully disposed: ${(err as Error).message}`);
    }
    if (keepView && app.activeView !== keepView) app.activeView = keepView;
}

/** A fresh document in the viewport. The previous one is dropped WITHOUT the save prompt `close()` shows. */
async function openFresh(): Promise<IDocument> {
    if (!app) throw new Error("not booted");
    driving++;
    try {
        const prev = app.activeView?.document;
        const doc = await app.newDocument("esoul");
        dropDocument(prev, doc);
        return doc;
    } finally {
        driving--;
        forgetPendingEdit();
    }
}

/** Load a serialized document (a person's earlier edit) in place of the current one. */
async function openSnapshot(serialized: string): Promise<IDocument> {
    if (!app) throw new Error("not booted");
    const prev = app.activeView?.document;
    driving++;
    try {
        const data = JSON.parse(serialized);
        const doc = await app.loadDocument(data);
        if (!doc)
            throw new Error(
                "the snapshot could not be loaded (its document version does not match this runtime)",
            );
        dropDocument(prev, doc);
        return doc;
    } finally {
        driving--;
        forgetPendingEdit();
    }
}

/** Creating ops mint deterministic node ids: `<stepId>:<opId>` — the same on every device, every replay. */
function withDeterministicIds(stepId: string, ops: unknown[]): unknown[] {
    return ops.map((raw) => {
        const op = raw as { op?: string; id?: string; nodeId?: string; body?: string };
        if (!op || typeof op !== "object" || op.nodeId || !op.id) return raw;
        const creates = op.op === "sketch" || op.op === "revolve" || (op.op === "extrude" && !op.body);
        return creates ? { ...op, nodeId: `${stepId}:${op.id}` } : raw;
    });
}

type ReplayStep =
    | { id: string; kind: "program"; ops: unknown[] }
    | { id: string; kind: "edit"; serialized: string };
interface ReplayArgs {
    variables?: { name: string; type: string; expression: string }[];
    steps?: ReplayStep[];
}
interface Applied {
    stepId: string;
    ok: boolean;
    error?: string;
    created: unknown[];
    bodies: unknown[];
}

function isParametricBody(n: INode): boolean {
    return "featuresJson" in (n as object);
}

/** The feature lists of every parametric body in the document, as `run_parametric`'s `features` op reports them. */
async function describeBodies(doc: IDocument): Promise<unknown[]> {
    const bodies = doc.modelManager.findNodes(isParametricBody);
    if (bodies.length === 0) return [];
    const r = await callTool("run_parametric", {
        ops: bodies.map((b, i) => ({ op: "features", id: `f${i}`, body: b.id })),
    });
    const parsed = JSON.parse(typeof r === "string" ? r : r.content) as {
        bodies?: unknown[];
        error?: string;
    };
    if (parsed.error) throw new Error(parsed.error);
    return parsed.bodies ?? [];
}

/** Rebuild the model from intent, starting at the last snapshot (it contains everything before it). */
async function replay(args: ReplayArgs): Promise<ToolResult> {
    driving++;
    try {
        const steps = args.steps ?? [];
        const lastEdit = steps.map((s) => s.kind).lastIndexOf("edit");
        const applied: Applied[] = [];
        if (lastEdit >= 0) {
            const edit = steps[lastEdit] as Extract<ReplayStep, { kind: "edit" }>;
            try {
                const doc = await openSnapshot(edit.serialized);
                applied.push({ stepId: edit.id, ok: true, created: [], bodies: await describeBodies(doc) });
            } catch (err) {
                const e = err as Error;
                applied.push({
                    stepId: edit.id,
                    ok: false,
                    error: `${e.message} | ${String(e.stack ?? "")
                        .split("\n")
                        .slice(1, 4)
                        .join(" | ")}`,
                    created: [],
                    bodies: [],
                });
                return finish(applied);
            }
        } else {
            await openFresh();
        }
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
        for (const step of steps.slice(lastEdit + 1)) {
            if (step.kind !== "program") continue;
            try {
                const r = await callTool("run_parametric", { ops: withDeterministicIds(step.id, step.ops) });
                const parsed = JSON.parse(typeof r === "string" ? r : r.content) as {
                    error?: string;
                    created?: unknown[];
                    bodies?: unknown[];
                };
                if (parsed.error) throw new Error(parsed.error);
                applied.push({
                    stepId: step.id,
                    ok: true,
                    created: parsed.created ?? [],
                    bodies: parsed.bodies ?? [],
                });
            } catch (err) {
                applied.push({
                    stepId: step.id,
                    ok: false,
                    error: (err as Error).message,
                    created: [],
                    bodies: [],
                });
                break;
            }
        }
        return finish(applied);
    } finally {
        driving--;
    }
}

async function finish(applied: Applied[]): Promise<ToolResult> {
    try {
        await callTool("fit_content", {});
    } catch (err) {
        Logger.warn(`fit_content: ${(err as Error).message}`);
    }
    let images: ToolResult["images"];
    try {
        const shot = await callTool("capture_screenshot", {});
        images = typeof shot === "string" ? undefined : shot.images;
    } catch (err) {
        Logger.warn(`capture_screenshot: ${(err as Error).message}`);
    }
    return { content: JSON.stringify({ applied, runtimeVersion: RUNTIME_VERSION }), images };
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
        case "esoul.theme":
            applyThemeMode(args["mode"]);
            return JSON.stringify({ ok: true, mode: Config.instance.themeMode });
        case "esoul.bodies":
            return JSON.stringify({ bodies: await describeBodies(activeDocument()) });
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
        const e = err as Error;
        post({
            id,
            ok: false,
            error: e?.message ?? String(err),
            stack: typeof e?.stack === "string" ? e.stack.split("\n").slice(0, 6).join(" | ") : undefined,
        });
    }
});

// ------------------------------------------------------------------ a person's edits → the parent

let editTimer: ReturnType<typeof setTimeout> | undefined;
let editLabels: string[] = [];

/** Anything the bridge itself just did is not a person's edit. */
function forgetPendingEdit() {
    if (editTimer) clearTimeout(editTimer);
    editTimer = undefined;
    editLabels = [];
}

function summarize(doc: IDocument): string {
    const top = doc.modelManager.findNodes((n) => n.parent === doc.modelManager.rootNode);
    const names = top
        .slice(0, 12)
        .map(
            (n) =>
                `${n.name}${isParametricBody(n) ? " (parametric)" : ""}${n.visible === false ? " (hidden)" : ""}`,
        );
    return `${top.length} top-level node${top.length === 1 ? "" : "s"}: ${names.join(", ")}${top.length > 12 ? ", …" : ""}`;
}

function flushEdit() {
    editTimer = undefined;
    const labels = editLabels;
    editLabels = [];
    if (!app?.activeView?.document || labels.length === 0) return;
    const doc = app.activeView.document;
    try {
        const serialized = JSON.stringify(doc.serialize());
        post({
            type: "edit",
            label: Array.from(new Set(labels)).join(", "),
            summary: summarize(doc),
            serialized,
        });
    } catch (err) {
        Logger.error(`esoul edit capture failed: ${(err as Error).message}`);
    }
}

/** Every committed transaction lands in History.add. A burst of them (one gesture) becomes one edit. */
const originalAdd = History.prototype.add;
History.prototype.add = function esoulCapturingAdd(this: History, record: IHistoryRecord) {
    originalAdd.call(this, record);
    if (driving > 0 || !parentOrigin) return;
    if (this.isUndoing || this.isRedoing) return;
    editLabels.push(String((record as { name?: string }).name ?? "edit"));
    if (editTimer) clearTimeout(editTimer);
    editTimer = setTimeout(flushEdit, EDIT_DEBOUNCE_MS);
};

// --------------------------------------------------------------------------------------------- boot

/** Ribbon items that make no sense inside ExternalSoul (its own assistant is the AI; no Wechat). */
const HIDDEN_RIBBON_ITEMS = new Set(["ai.toggleChat", "wechat.group"]);

class EsoulAppBuilder extends AppBuilder {
    override async getRibbonTabs() {
        const tabs = await super.getRibbonTabs();
        return tabs.map((tab) => ({
            ...tab,
            groups: tab.groups
                .map((group) => ({
                    ...group,
                    items: group.items.filter(
                        (item) => typeof item !== "string" || !HIDDEN_RIBBON_ITEMS.has(item),
                    ),
                }))
                .filter((group) => group.items.length > 0),
        }));
    }
}

// ExternalSoul's assistant is the AI here: chili's own chat stays closed.
Editor.autoShowChat = false;
// A document is always open here; the home screen must not flash while a replay swaps documents.
MainWindow.homeWhenNoView = false;

// The host's own light/dark, not the OS's: first paint from the URL, later changes over the bridge.
applyThemeMode(params.get("theme"));

const loading = new Loading();
document.body.appendChild(loading);

/** Title-bar chrome of the standalone app that has no meaning inside ExternalSoul. */
function tidyChrome() {
    document.getElementById("appName")?.remove();
    document.querySelector('a[href*="github.com/xiangechen"]')?.remove();
    for (const use of Array.from(document.querySelectorAll("svg use"))) {
        const href = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";
        if (href.endsWith("icon-home")) use.closest("svg")?.parentElement?.remove();
    }
}

if (!parentOrigin) Logger.warn("esoul runtime: no ?parent=<origin> — the bridge is off; the UI still works.");

// prettier-ignore
new EsoulAppBuilder()
    .useIndexedDB()
    .useWasmOcc()
    .useParametric()
    .useThree()
    .useUI()
    .build()
    .then(async (built) => {
        app = built;
        tools = buildTools();
        await openFresh();
        loading.remove();
        tidyChrome();
        post({ type: "ready", version: RUNTIME_VERSION, tools: tools.map((t) => t.name) });
    })
    .catch((err: Error) => {
        loading.remove();
        post({ type: "error", error: err.message });
        alert(`The CAD runtime failed to start: ${err.message}`);
    });
