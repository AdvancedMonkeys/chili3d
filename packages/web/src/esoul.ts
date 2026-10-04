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
    Config,
    History,
    I18n,
    type IApplication,
    type IDocument,
    type IHistoryRecord,
    type INode,
    type IShape,
    Logger,
    Matrix4,
    VisualNode,
} from "@chili3d/core";
import { Editor, MainWindow, RibbonUI } from "@chili3d/ui";
import { Loading } from "./loading";

const TAG = "esoulCad";
const VERSION = 1;
const RUNTIME_VERSION = "chili3d-0.7.1+esoul.21";
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
        const doc = await app.newDocument(DOCUMENT_NAME);
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
    return ops.flatMap((raw) => {
        const op = raw as {
            op?: string;
            id?: string;
            nodeId?: string;
            body?: string;
            color?: string;
            opacity?: number;
        };
        if (!op || typeof op !== "object" || !op.id) return [raw];
        const creates =
            op.op === "sketch" ||
            op.op === "revolve" ||
            op.op === "import" ||
            (op.op === "extrude" && !op.body);
        const makesFeature =
            op.op === "extrude" ||
            op.op === "revolve" ||
            op.op === "fillet" ||
            op.op === "chamfer" ||
            op.op === "boolean" ||
            op.op === "import";
        const withFeature =
            makesFeature && !(op as { featureId?: string }).featureId
                ? { featureId: `${stepId}:${op.id}` }
                : {};
        const withNode = creates && !op.nodeId ? { nodeId: `${stepId}:${op.id}` } : {};
        const out: unknown[] = [creates || makesFeature ? { ...op, ...withFeature, ...withNode } : raw];
        // `color` on a body-making op is sugar for a `style` op right after it (the body exists by then).
        if (creates && op.op !== "sketch" && typeof op.color === "string") {
            out.push({
                op: "style",
                id: `${op.id}__style`,
                node: op.id,
                color: op.color,
                ...(op.opacity !== undefined ? { opacity: op.opacity } : {}),
            });
        }
        return out;
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
    return withExtents(doc, parsed.bodies ?? []);
}

/** Where each reported body IS (world space) and how big: an agent reads this from the fold, no kernel round trip. */
function withExtents(doc: IDocument, reported: unknown[]): unknown[] {
    return reported.map((pb) => {
        const id = (pb as { nodeId?: string }).nodeId;
        const node = id ? doc.modelManager.findNodes((x) => x.id === id)[0] : undefined;
        const e = node ? worldExtents(node) : undefined;
        return e ? { ...(pb as object), ...e } : pb;
    });
}

/** A node's shape in world space (a copy when the node is transformed) — the caller disposes `owned`. */
function worldShape(node: INode): { shape: IShape; owned: boolean } | undefined {
    const sn = node as { shape?: { isOk: boolean; value: IShape }; worldTransform?: () => Matrix4 };
    if (!sn.shape?.isOk || typeof sn.worldTransform !== "function") return undefined;
    const m = sn.worldTransform();
    if (m.equals(Matrix4.identity())) return { shape: sn.shape.value, owned: false };
    return { shape: sn.shape.value.transformedMul(m), owned: true };
}
const disposeOwned = (w: { shape: IShape; owned: boolean } | undefined) => {
    if (w?.owned) (w.shape as { dispose?: () => void }).dispose?.();
};
const r3 = (n: number) => Math.round(n * 1000) / 1000;
function worldExtents(node: INode): { bbox: unknown; volume: number } | undefined {
    const w = worldShape(node);
    if (!w) return undefined;
    try {
        const bb = w.shape.boundingBox();
        return {
            bbox: {
                min: { x: r3(bb.min.x), y: r3(bb.min.y), z: r3(bb.min.z) },
                max: { x: r3(bb.max.x), y: r3(bb.max.y), z: r3(bb.max.z) },
            },
            volume: r3(w.shape.volume()),
        };
    } finally {
        disposeOwned(w);
    }
}

/** Read-only measurement: never creates, consumes or moves a node (run_program's boolean methods do all three). */
function measure(args: { nodes?: string[]; pairs?: [string, string][] }): string {
    const doc = activeDocument();
    const byId = (id: string): INode => {
        const n = doc.modelManager.findNodes((x) => x.id === id)[0];
        if (!n) throw new Error(`no node "${id}" in the document`);
        return n;
    };
    const nodes = (args.nodes ?? []).map((id) => {
        const n = byId(id);
        return { id, name: n.name, ...(worldExtents(n) ?? { bbox: null, volume: null }) };
    });
    const pairs = (args.pairs ?? []).map(([aId, bId]) => {
        const a = worldShape(byId(aId));
        const b = worldShape(byId(bId));
        if (!a || !b) return { a: aId, b: bId, error: "a node without a shape" };
        try {
            const distance = a.shape.extremaDistance(b.shape);
            const common = shapeFactory.booleanCommon([a.shape.clone()], [b.shape.clone()]);
            let interference: number | null = null;
            if (common.isOk) {
                interference = r3(common.value.volume());
                (common.value as { dispose?: () => void }).dispose?.();
            }
            return { a: aId, b: bId, distance: r3(distance), interference };
        } finally {
            disposeOwned(a);
            disposeOwned(b);
        }
    });
    return JSON.stringify({ nodes, pairs });
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
                    bodies: withExtents(activeDocument(), parsed.bodies ?? []),
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
    if (app?.activeView?.document) lastKnownNames = topNames(app.activeView.document);
    settleView();
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
        case "esoul.measure":
            return measure(args as { nodes?: string[]; pairs?: [string, string][] });
        default:
            if (method === "capture_screenshot" || method === "fit_content" || method === "rotate_view")
                settleView();
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

/** Top-level node names, for describing what a gesture changed. */
function topNames(doc: IDocument): string[] {
    return doc.modelManager.findNodes((n) => n.parent === doc.modelManager.rootNode).map((n) => n.name);
}
/** The top-level names as of the last capture or replay — the "before" of the next gesture. */
let lastKnownNames: string[] = [];
let namesBeforeEdit: string[] | undefined;

/** A record's name as a person would say it: chili's commands name their transactions
 *  `excute <i18n key>` (sometimes with no key at all), so translate the key, or describe the
 *  change by the nodes it added or removed. */
function describeLabels(labels: string[], before: string[] | undefined, after: string[]): string {
    const spoken = Array.from(new Set(labels))
        .map((l) => l.replace(/^excute\s*/i, "").trim())
        .filter((l) => l && l !== "undefined")
        .map((l) => {
            if (!l.includes(".")) return l;
            try {
                const t = I18n.translate(l as never);
                return typeof t === "string" && t && t !== l ? t : (l.split(".").pop() ?? l);
            } catch {
                return l.split(".").pop() ?? l;
            }
        });
    if (spoken.length > 0) return spoken.join(", ");
    const was = new Set(before ?? []);
    const now = new Set(after);
    const added = after.filter((n) => !was.has(n));
    const removed = (before ?? []).filter((n) => !now.has(n));
    if (added.length && !removed.length) return `added ${added.join(", ")}`;
    if (removed.length && !added.length) return `deleted ${removed.join(", ")}`;
    if (added.length || removed.length) return `replaced ${removed.join(", ")} with ${added.join(", ")}`;
    return "edited";
}

function flushEdit() {
    editTimer = undefined;
    const labels = editLabels;
    editLabels = [];
    const before = namesBeforeEdit;
    namesBeforeEdit = undefined;
    if (!app?.activeView?.document || labels.length === 0) return;
    const doc = app.activeView.document;
    try {
        const serialized = JSON.stringify(doc.serialize());
        const after = topNames(doc);
        post({
            type: "edit",
            label: describeLabels(labels, before, after),
            summary: summarize(doc),
            serialized,
        });
        lastKnownNames = after;
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
    if (namesBeforeEdit === undefined) namesBeforeEdit = lastKnownNames;
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
// One model per ExternalSoul instance: no document tabs to open or close.
RibbonUI.documentTabs = false;

// The host's own light/dark, not the OS's: first paint from the URL, later changes over the bridge.
applyThemeMode(params.get("theme"));

const loading = new Loading();
// The stock overlay is a black veil; here it is the host's own surface while the kernel downloads.
loading.style.backgroundColor = "var(--background-color)";
document.body.appendChild(loading);

/** Title-bar chrome of the standalone app that has no meaning inside ExternalSoul: the version chip, the
 *  GitHub link, the home button, the "new document" plus and the document tab's close — one model, one tab,
 *  named after the ExternalSoul app instance (`?name=`). */
function tidyChrome() {
    document.getElementById("appName")?.remove();
    tidyStatusBar();
    document.querySelector('a[href*="github.com/xiangechen"]')?.remove();
    for (const use of Array.from(document.querySelectorAll("svg use"))) {
        const href = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";
        if (href.endsWith("icon-home")) use.closest("svg")?.parentElement?.remove();
        else if (href.endsWith("icon-plus") || href.endsWith("icon-times")) {
            const svg = use.closest("svg");
            if (svg && svg.closest("[class*=titleBar], [class*=title-bar], [class*=center]")) svg.remove();
        }
    }
}

/**
 * The status bar in a narrow frame: chili lets the hint wrap under the snap toggles (two lines
 * fighting for one row). One line each: the hint ends in an ellipsis, the snap row scrolls.
 */
/**
 * Size the view to its element NOW. The three view resizes through a DEBOUNCED ResizeObserver, so a
 * capture right after a fast boot or replay saw the 300×150 default canvas (every server view came
 * back as a thumbnail); the explicit resize + update makes the next capture the real viewport.
 */
function settleView(): void {
    const view = app?.activeView;
    const el = view?.dom;
    if (!view || !el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w > 0 && h > 0) view.resize(w, h);
    view.update();
}

function tidyStatusBar(attempt = 0): void {
    // ONLY the status bar element itself: a loose "[class*=statusbar]" fallback once matched the main
    // layout and collapsed the 3D view to a 300×150 canvas (every server view came back as a thumbnail).
    const bar = document.querySelector("chili-statusbar");
    if (!(bar instanceof HTMLElement)) {
        if (attempt < 40) setTimeout(() => tidyStatusBar(attempt + 1), 250);
        return;
    }
    const [left, right] = Array.from(bar.children) as HTMLElement[];
    Object.assign(bar.style, { minWidth: "0", overflow: "hidden", gap: "8px", alignItems: "center" });
    if (left) {
        Object.assign(left.style, { minWidth: "0", flex: "1 1 auto", overflow: "hidden" });
        const tip = left.firstElementChild as HTMLElement | null;
        if (tip)
            Object.assign(tip.style, {
                display: "block",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
            });
    }
    if (right)
        Object.assign(right.style, {
            flex: "0 1 auto",
            minWidth: "0",
            overflowX: "auto",
            overflowY: "hidden",
            whiteSpace: "nowrap",
            scrollbarWidth: "none",
        });
}

const DOCUMENT_NAME = (params.get("name") ?? "").trim().slice(0, 60) || "Model";

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
