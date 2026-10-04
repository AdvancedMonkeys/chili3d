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
    type IEdge,
    type IFace,
    type IHistoryRecord,
    type INode,
    type IShape,
    type ISurface,
    type IWire,
    Logger,
    Matrix4,
    ShapeTypes,
    VisualNode,
    type XYZ,
} from "@chili3d/core";
import { withShapeCache } from "@chili3d/parametric";
import { Editor, MainWindow, RibbonUI } from "@chili3d/ui";
import { Loading } from "./loading";

const TAG = "esoulCad";
const VERSION = 1;
const RUNTIME_VERSION = "chili3d-0.7.1+esoul.35";
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
    | { id: string; kind: "edit"; serialized?: string; url?: string };
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

/** A consumed boolean tool sits under its body (runtime 30) and is not a body of the model. */
function isConsumedTool(n: INode): boolean {
    return n.parent !== undefined && "featuresJson" in (n.parent as object);
}
function isParametricBody(n: INode): boolean {
    return "featuresJson" in (n as object) && !isConsumedTool(n);
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
        results?: Record<string, unknown>;
        error?: string;
    };
    if (parsed.error) throw new Error(parsed.error);
    // A `features` op READS a body and so never lists it among the bodies the program touched: the
    // list is built from the per-body results (esoul.bodies used to answer [] for every document).
    const reported = bodies.map((b, i) => ({
        nodeId: b.id,
        name: b.name,
        features: (parsed.results?.[`f${i}`] as unknown[] | undefined) ?? [],
    }));
    return withExtents(doc, reported);
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
/**
 * A node's world matrix from the MODEL's own transforms (its local one, then its parents'), never from the
 * drawn object: a view-only explode (esoul.explode) moves what is drawn, and measure, describe and the
 * extents in every report must keep answering the model as the fold made it.
 */
function nodeWorldTransform(node: INode): Matrix4 | undefined {
    if (!(node instanceof VisualNode)) return undefined;
    let m = node.transform;
    for (let p = node.parent; p !== undefined; p = p.parent)
        if (p instanceof VisualNode) m = m.multiply(p.transform);
    return m;
}
function worldShape(node: INode): { shape: IShape; owned: boolean } | undefined {
    const sn = node as { shape?: { isOk: boolean; value: IShape } };
    const m = nodeWorldTransform(node);
    if (!sn.shape?.isOk || !m) return undefined;
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

/**
 * The camera, driven from outside (runtime 31): `rotate` orbits by a mouse-like (dx, dy) in pixels — one render per
 * call, so a film orbits smoothly with a few dozen calls where a drag would send hundreds of pointer events, each
 * a render; `lookAt` sets eye/target/up outright. Answers where the camera is now.
 */
function camera(args: {
    rotate?: { dx: number; dy: number };
    lookAt?: { eye: XYZ; target: XYZ; up?: XYZ };
}): string {
    const view = app?.activeView;
    if (!view) throw new Error("no active view");
    const cc = view.cameraController;
    if (args.rotate) cc.rotate(Number(args.rotate.dx ?? 0), Number(args.rotate.dy ?? 0));
    if (args.lookAt) cc.lookAt(args.lookAt.eye, args.lookAt.target, args.lookAt.up ?? { x: 0, y: 0, z: 1 });
    view.update();
    const p = cc.cameraPosition;
    const t = cc.cameraTarget;
    return JSON.stringify({
        position: { x: r3(p.x), y: r3(p.y), z: r3(p.z) },
        target: { x: r3(t.x), y: r3(t.y), z: r3(t.z) },
    });
}

/**
 * A VIEW-ONLY explode (runtime 30): each part's DRAWN body moves along world z by factor × k while the
 * model itself stays where the fold put it — measure, describe and export keep answering the real
 * geometry. A film slides the parts apart smoothly by calling this per frame; a replay per factor would
 * rebuild everything (a document-variable change does not re-drive a transform op, which is evaluated once).
 */
function explodeView(args: { factor?: number; parts?: { node: string; k?: number }[] }): string {
    const doc = activeDocument();
    const factor = Number(args.factor ?? 0);
    if (!Number.isFinite(factor)) throw new Error("factor must be a number");
    const moved: { node: string; dz: number }[] = [];
    for (const p of args.parts ?? []) {
        const n = doc.modelManager.findNodes((x) => x.id === p.node)[0];
        if (!n) throw new Error(`no node "${p.node}" in the document`);
        if (!(n instanceof VisualNode)) throw new Error(`"${p.node}" is not a drawn body`);
        const visual = doc.visual.context.getVisual(n);
        if (!visual) continue;
        const dz = r3(factor * Number(p.k ?? 1));
        visual.transform = n.transform.multiply(Matrix4.fromTranslation(0, 0, dz));
        moved.push({ node: p.node, dz });
    }
    app?.activeView?.update();
    return JSON.stringify({ factor, moved });
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

// ── esoul.describe: what a body IS, read from the kernel ───────────────────────────────────────────────────────
// Building the teddy's switch mount (2026-10-04) meant finding the lid's three screw holes with a 725-pin probe
// grid and a face-by-face bounding-box sweep over three bridge calls. This answers in one: every planar face with
// its normal and level, every cylindrical face as a HOLE (concave — the body is outside the cylinder) or a BOSS
// (convex), with the axis, radius and extent, so an agent reads "Ø2.7 through-hole at (14, 19.22), z −14..2" and
// designs to it. World space, like esoul.measure.

type DescribedPlane = { kind: "plane"; normal: XYZ; point: XYZ; area: number; bbox: { min: XYZ; max: XYZ } };
type DescribedCylinder = {
    kind: "hole" | "boss";
    radius: number;
    diameter: number;
    axis: XYZ;
    centre: XYZ;
    length: number;
    area: number;
    bbox: { min: XYZ; max: XYZ };
};
type DescribedOther = { kind: string; area: number; bbox: { min: XYZ; max: XYZ } };

const xyz = (p: XYZ): XYZ => ({ x: r3(p.x), y: r3(p.y), z: r3(p.z) }) as XYZ;
function bboxOf(shape: IShape): { min: XYZ; max: XYZ } {
    const bb = shape.boundingBox();
    return { min: xyz(bb.min as XYZ), max: xyz(bb.max as XYZ) };
}
/** The face's outward normal at one of its own points (BRepGProp_Face honours a reversed face). */
function faceNormalAt(face: IFace, surface: ISurface, p: XYZ): XYZ | undefined {
    const uv = surface.parameter(p, 0.5);
    if (!uv) return undefined;
    const [, n] = face.normal(uv.u, uv.v);
    return n;
}
function firstPointOf(face: IFace): XYZ | undefined {
    const wire = face.outerWire() as IWire | undefined;
    const edges = (wire?.edgeLoop() ?? []) as IEdge[];
    const e = edges[0];
    if (!e) return undefined;
    // the middle of the first edge: a point of the face that is not a corner (corners sit on two surfaces)
    const a = e.firstParameter();
    const b = e.lastParameter();
    return e.pointAt((a + b) / 2);
}
/** A STEP face usually sits on a TRIMMED surface (or an offset one): the geometry that says "cylinder" is the basis. */
function basisOf(s: ISurface): { basis: ISurface; owned: boolean } {
    const o = s as unknown as { basisSurface?: unknown };
    if (typeof o.basisSurface === "function") {
        const b = (o.basisSurface as () => ISurface)();
        const inner = basisOf(b);
        if (inner.basis !== b) (b as unknown as { dispose?: () => void }).dispose?.();
        return { basis: inner.basis, owned: true };
    }
    if (o.basisSurface && typeof o.basisSurface === "object")
        return { basis: o.basisSurface as ISurface, owned: false };
    return { basis: s, owned: false };
}
const surfaceKind = (s: ISurface): "plane" | "cylinder" | "cone" | "sphere" | "torus" | "other" => {
    if (s.isPlanar()) return "plane";
    const o = s as unknown as Record<string, unknown>;
    if ("semiAngle" in o) return "cone";
    if ("majorRadius" in o) return "torus";
    if (!("radius" in o) || !("axis" in o)) return "other";
    // a cylinder and a sphere both carry radius + axis: a cylinder runs forever along v, a sphere's v is ±π/2
    try {
        const b = s.bounds();
        return !Number.isFinite(b.v1) || Math.abs(b.v1) > 1e5 ? "cylinder" : "sphere";
    } catch {
        return "other";
    }
};

function describeOne(node: INode, maxFaces: number): Record<string, unknown> {
    const w = worldShape(node);
    if (!w) return { id: node.id, name: node.name, error: "a node without a shape" };
    try {
        const faces = w.shape.findSubShapes(ShapeTypes.face) as IFace[];
        const planes: DescribedPlane[] = [];
        const cylinders: DescribedCylinder[] = [];
        const other: DescribedOther[] = [];
        for (const face of faces) {
            let surface: ISurface | undefined;
            let basis: { basis: ISurface; owned: boolean } | undefined;
            try {
                surface = face.surface();
                basis = basisOf(surface);
                const kind = surfaceKind(basis.basis);
                const area = r3(face.area());
                const bbox = bboxOf(face);
                if (kind === "plane") {
                    const p = firstPointOf(face);
                    const n = p ? faceNormalAt(face, surface, p) : undefined;
                    const c = {
                        x: (bbox.min.x + bbox.max.x) / 2,
                        y: (bbox.min.y + bbox.max.y) / 2,
                        z: (bbox.min.z + bbox.max.z) / 2,
                    } as XYZ;
                    planes.push({
                        kind: "plane",
                        normal: n ? xyz(n) : ({ x: 0, y: 0, z: 0 } as XYZ),
                        point: xyz(c),
                        area,
                        bbox,
                    });
                } else if (kind === "cylinder") {
                    const cyl = basis.basis as unknown as { radius: number; axis: XYZ; location: XYZ };
                    const p = firstPointOf(face);
                    const n = p ? faceNormalAt(face, surface, p) : undefined;
                    let concave = false;
                    if (p && n) {
                        // radial = the point's offset from the axis line; a hole's outward normal points INTO the axis
                        const d = {
                            x: p.x - cyl.location.x,
                            y: p.y - cyl.location.y,
                            z: p.z - cyl.location.z,
                        };
                        const t = d.x * cyl.axis.x + d.y * cyl.axis.y + d.z * cyl.axis.z;
                        const radial = {
                            x: d.x - t * cyl.axis.x,
                            y: d.y - t * cyl.axis.y,
                            z: d.z - t * cyl.axis.z,
                        };
                        concave = radial.x * n.x + radial.y * n.y + radial.z * n.z < 0;
                    }
                    const c = {
                        x: (bbox.min.x + bbox.max.x) / 2,
                        y: (bbox.min.y + bbox.max.y) / 2,
                        z: (bbox.min.z + bbox.max.z) / 2,
                    };
                    // the centre of the face's extent, dropped onto the axis line
                    const dc = { x: c.x - cyl.location.x, y: c.y - cyl.location.y, z: c.z - cyl.location.z };
                    const tc = dc.x * cyl.axis.x + dc.y * cyl.axis.y + dc.z * cyl.axis.z;
                    const centre = {
                        x: cyl.location.x + tc * cyl.axis.x,
                        y: cyl.location.y + tc * cyl.axis.y,
                        z: cyl.location.z + tc * cyl.axis.z,
                    } as XYZ;
                    const ext = [bbox.max.x - bbox.min.x, bbox.max.y - bbox.min.y, bbox.max.z - bbox.min.z];
                    const ax = [Math.abs(cyl.axis.x), Math.abs(cyl.axis.y), Math.abs(cyl.axis.z)];
                    const length = r3(ext[0] * ax[0] + ext[1] * ax[1] + ext[2] * ax[2]);
                    cylinders.push({
                        kind: concave ? "hole" : "boss",
                        radius: r3(cyl.radius),
                        diameter: r3(cyl.radius * 2),
                        axis: xyz(cyl.axis),
                        centre: xyz(centre),
                        length,
                        area,
                        bbox,
                    });
                } else {
                    other.push({ kind, area, bbox });
                }
            } catch (err) {
                other.push({
                    kind: `unreadable (${(err as Error).message.slice(0, 60)})`,
                    area: 0,
                    bbox: bboxOf(face),
                });
            } finally {
                if (basis?.owned) (basis.basis as unknown as { dispose?: () => void }).dispose?.();
                (surface as unknown as { dispose?: () => void } | undefined)?.dispose?.();
            }
        }
        // Holes first (what an agent attaches to), biggest planes first; the same hole's two half-faces merge.
        const merged: DescribedCylinder[] = [];
        for (const c of cylinders.sort((a, b) =>
            a.kind === b.kind ? b.area - a.area : a.kind === "hole" ? -1 : 1,
        )) {
            const same = merged.find(
                (m) =>
                    m.kind === c.kind &&
                    Math.abs(m.radius - c.radius) < 0.005 &&
                    Math.abs(m.centre.x - c.centre.x) +
                        Math.abs(m.centre.y - c.centre.y) +
                        Math.abs(m.centre.z - c.centre.z) <
                        0.05,
            );
            if (same) {
                same.area = r3(same.area + c.area);
                same.bbox = {
                    min: {
                        x: Math.min(same.bbox.min.x, c.bbox.min.x),
                        y: Math.min(same.bbox.min.y, c.bbox.min.y),
                        z: Math.min(same.bbox.min.z, c.bbox.min.z),
                    } as XYZ,
                    max: {
                        x: Math.max(same.bbox.max.x, c.bbox.max.x),
                        y: Math.max(same.bbox.max.y, c.bbox.max.y),
                        z: Math.max(same.bbox.max.z, c.bbox.max.z),
                    } as XYZ,
                };
            } else merged.push({ ...c });
        }
        planes.sort((a, b) => b.area - a.area);
        other.sort((a, b) => b.area - a.area);
        const extents = worldExtents(node);
        return {
            id: node.id,
            name: node.name,
            ...(extents ?? {}),
            faces: faces.length,
            holes: merged.filter((c) => c.kind === "hole").slice(0, maxFaces),
            bosses: merged.filter((c) => c.kind === "boss").slice(0, maxFaces),
            planes: planes.slice(0, maxFaces),
            other: other.slice(0, Math.min(12, maxFaces)),
            truncated: merged.length > maxFaces || planes.length > maxFaces || other.length > 12,
        };
    } finally {
        disposeOwned(w);
    }
}

/** esoul.describe {nodes, maxFaces?}: a read-only account of each body's faces — holes, bosses, planes — in world space. */
function describe(args: { nodes?: string[]; maxFaces?: number }): string {
    const doc = activeDocument();
    const maxFaces = Math.max(1, Math.min(200, Math.floor(Number(args.maxFaces ?? 40))));
    const ids = args.nodes ?? [];
    if (ids.length === 0) throw new Error("esoul.describe needs nodes: [node ids]");
    const bodies = ids.map((id) => {
        const n = doc.modelManager.findNodes((x) => x.id === id)[0];
        if (!n) throw new Error(`no node "${id}" in the document`);
        return describeOne(n, maxFaces);
    });
    return JSON.stringify({ bodies });
}

/** Rebuild the model from intent, starting at the last snapshot (it contains everything before it). */
function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
async function gunzip(b: Uint8Array): Promise<Uint8Array> {
    const inflated = new Blob([b as unknown as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(inflated).arrayBuffer());
}

/** One range of a URL input (64 KB — the size the platform measured as safe). */
const RANGE_CHUNK = 65_536;
/** Ranges in flight at once. */
const RANGE_PARALLEL = 8;
/** A range that has not answered in this long is asked for again, up to RANGE_RETRIES times. */
const RANGE_TIMEOUT_MS = 20_000;
const RANGE_RETRIES = 3;

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
        return await fetch(url, { ...init, signal: ctl.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * A URL input's bytes, read in RANGES. One unbounded GET of a big blob can stall at a few KB/s behind the CDN
 * while ranged reads of the same bytes finish in a second (the platform's own measurement, 2026-08-03, and the
 * geometry cache that answered its headers and then never its body inside a tab, 2026-10-05). Each range has its
 * own timeout and retries, so a stall costs seconds and a retry, never the whole load. A server that gives no
 * length, a small file, or a server that answers a range with the whole body (200) is read in one GET. A gzipped
 * file (the geometry cache: 22 MB of BRep text travels as 5) is inflated here, whatever the server called it —
 * the magic bytes decide, not the name or a header.
 */
async function fetchUrlBytes(url: string): Promise<Uint8Array> {
    const where = url.slice(0, 96);
    const inflate = (b: Uint8Array) => (isGzip(b) ? gunzip(b) : Promise.resolve(b));
    const head = await fetchWithTimeout(url, { method: "HEAD" }, RANGE_TIMEOUT_MS).catch(() => null);
    const total = Number(head?.headers.get("content-length") ?? 0);
    if (!head?.ok || !(total > RANGE_CHUNK)) {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`fetching ${where}: HTTP ${r.status}`);
        return inflate(new Uint8Array(await r.arrayBuffer()));
    }
    const n = Math.ceil(total / RANGE_CHUNK);
    const parts: Uint8Array[] = new Array(n);
    let next = 0;
    let whole: Uint8Array | null = null;
    const t0 = performance.now();
    const worker = async () => {
        while (next < n && !whole) {
            const k = next++;
            const start = k * RANGE_CHUNK;
            const end = Math.min(total, start + RANGE_CHUNK) - 1;
            let lastErr: unknown;
            for (let attempt = 0; attempt < RANGE_RETRIES && !whole; attempt++) {
                try {
                    const r = await fetchWithTimeout(
                        url,
                        { headers: { Range: `bytes=${start}-${end}` } },
                        RANGE_TIMEOUT_MS,
                    );
                    if (r.status === 200) {
                        // ranges ignored: the whole body came — take it
                        whole = new Uint8Array(await r.arrayBuffer());
                        return;
                    }
                    if (r.status !== 206)
                        throw new Error(`fetching ${where} (bytes ${start}-${end}): HTTP ${r.status}`);
                    parts[k] = new Uint8Array(await r.arrayBuffer());
                    lastErr = undefined;
                    break;
                } catch (err) {
                    lastErr = err;
                }
            }
            if (lastErr && !whole) throw lastErr;
        }
    };
    await Promise.all(Array.from({ length: Math.min(RANGE_PARALLEL, n) }, worker));
    if (whole) return inflate(whole);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    if (off !== total) throw new Error(`fetching ${where}: ${off} of ${total} bytes arrived`);
    console.info(`[esoul] fetched ${total} bytes in ${n} ranges, ${Math.round(performance.now() - t0)} ms`);
    return inflate(out);
}

/** Big inputs come by URL: the page fetches them itself, so no bridge message has to carry their bytes
 *  (an edit snapshot's `url` becomes its `serialized` text; an import op's `url` becomes its `base64`). */
async function resolveStepUrls(steps: ReplayStep[]): Promise<void> {
    const jobs: Promise<void>[] = [];
    const fetchBytes = fetchUrlBytes;
    for (const step of steps) {
        if (step.kind === "edit") {
            if (step.serialized === undefined && typeof step.url === "string") {
                const url = step.url;
                jobs.push(
                    fetchBytes(url).then((b) => {
                        step.serialized = new TextDecoder().decode(b);
                    }),
                );
            }
            continue;
        }
        for (const op of step.ops as unknown as {
            op?: string;
            base64?: string;
            brep?: string;
            url?: string;
        }[]) {
            if (
                op.op !== "import" ||
                op.base64 !== undefined ||
                op.brep !== undefined ||
                typeof op.url !== "string"
            )
                continue;
            const url = op.url;
            jobs.push(
                fetchBytes(url).then((b) => {
                    op.base64 = bytesToBase64(b);
                    delete op.url;
                }),
            );
        }
    }
    await Promise.all(jobs);
}

async function replay(args: ReplayArgs): Promise<ToolResult> {
    driving++;
    try {
        const steps = args.steps ?? [];
        const t0 = performance.now();
        const phase = (what: string) =>
            console.info(`[esoul] replay ${what} at ${Math.round(performance.now() - t0)} ms`);
        await resolveStepUrls(steps);
        phase(`inputs resolved (${steps.length} step(s))`);
        const lastEdit = steps.map((s) => s.kind).lastIndexOf("edit");
        const applied: Applied[] = [];
        if (lastEdit >= 0) {
            const edit = steps[lastEdit] as Extract<ReplayStep, { kind: "edit" }>;
            try {
                if (edit.serialized === undefined)
                    throw new Error("the edit step carries no snapshot (neither serialized nor url)");
                const doc = await openSnapshot(edit.serialized);
                phase(`snapshot "${edit.id}" opened (${edit.serialized.length} chars)`);
                applied.push({ stepId: edit.id, ok: true, created: [], bodies: await describeBodies(doc) });
                phase("bodies described");
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
        phase("variables set");
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
                // The bodies a step touched, less the boolean tools it consumed (they sit under their body now).
                const doc = activeDocument();
                const bodies = (parsed.bodies ?? []).filter((b) => {
                    const id = (b as { nodeId?: string }).nodeId;
                    const n = id ? doc.modelManager.findNodes((x) => x.id === id)[0] : undefined;
                    return n === undefined || !isConsumedTool(n);
                });
                applied.push({
                    stepId: step.id,
                    ok: true,
                    created: parsed.created ?? [],
                    bodies: withExtents(doc, bodies),
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
        phase("steps applied; answering");
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

/** A file name a workspace accepts: the caller's `name`, else the one exported body's own name, else "model". */
function exportFileName(name: unknown, nodes: VisualNode[], ext: string): string {
    const raw =
        typeof name === "string" && name.trim() ? name.trim() : nodes.length === 1 ? nodes[0].name : "model";
    const printable = Array.from(raw)
        .map((ch) => (ch.charCodeAt(0) < 32 ? " " : ch))
        .join("");
    const safe =
        printable
            .replace(/[\\/:*?"<>|]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || "model";
    return safe.toLowerCase().endsWith(ext) ? safe : `${safe}${ext}`;
}

/** Exports too big for one bridge reply wait here under a handle and leave in chunks (esoul.exportChunk). */
const EXPORT_STASH = new Map<string, { bytes: Uint8Array; fileName: string; format: string }>();
let lastExportHandle: string | null = null;
const EXPORT_CHUNK = 2_000_000; // raw bytes per chunk: 2.67 MB as base64, well under the bridge's 4 MB reply cap

function exportChunk(args: { handle?: string; offset?: number; length?: number }): string {
    const handle = args.handle === "last" ? lastExportHandle : args.handle;
    const e = typeof handle === "string" ? EXPORT_STASH.get(handle) : undefined;
    if (!e)
        throw new Error(
            `unknown export handle ${String(args.handle)}: the runtime has restarted since that export; run it again`,
        );
    const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)));
    const length = Math.max(1, Math.min(Math.floor(Number(args.length ?? EXPORT_CHUNK)), EXPORT_CHUNK));
    const slice = e.bytes.subarray(offset, Math.min(e.bytes.length, offset + length));
    return JSON.stringify({
        handle,
        offset,
        length: slice.length,
        total: e.bytes.length,
        done: offset + slice.length >= e.bytes.length,
        base64: bytesToBase64(slice),
    });
}

/**
 * The document as a snapshot an `esoul.replay` edit step loads back (runtime 32). With `shapes`, every built body
 * carries its finished shape, so the load is a BRep parse instead of a rebuild — the geometry cache behind "open
 * the model without rebuilding it". Big snapshots leave in chunks on request, through the export stash
 * (`esoul.exportChunk`), like an export.
 */
async function gzip(b: Uint8Array): Promise<Uint8Array> {
    const deflated = new Blob([b as unknown as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(deflated).arrayBuffer());
}

/** The document as it stands: plain, or with every built shape (`shapes`), gzipped at the source (`gzip` — the app's
 *  geometry cache: 22 MB of BRep text leaves as 5, in a quarter of the chunks), inline or chunked through the stash. */
async function snapshot(args: {
    shapes?: boolean;
    gzip?: boolean;
    chunked?: boolean;
    chunkBytes?: number;
}): Promise<string> {
    const doc = activeDocument();
    const serialized = args.shapes
        ? withShapeCache(() => JSON.stringify(doc.serialize()))
        : JSON.stringify(doc.serialize());
    const text = new TextEncoder().encode(serialized);
    const bytes = args.gzip ? await gzip(text) : text;
    const chunk = Math.max(
        65_536,
        Math.min(EXPORT_CHUNK, Math.floor(Number(args.chunkBytes ?? EXPORT_CHUNK))),
    );
    const meta = { shapes: !!args.shapes, gzip: !!args.gzip, bytes: bytes.length };
    if (!args.chunked || bytes.length <= chunk) {
        return JSON.stringify(
            args.gzip ? { ...meta, base64: bytesToBase64(bytes) } : { ...meta, serialized },
        );
    }
    const handle = `snapshot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    EXPORT_STASH.set(handle, {
        bytes,
        fileName: args.gzip ? "snapshot.json.gz" : "snapshot.json",
        format: args.gzip ? ".gz" : ".json",
    });
    lastExportHandle = handle;
    while (EXPORT_STASH.size > 8) EXPORT_STASH.delete(EXPORT_STASH.keys().next().value as string);
    return JSON.stringify({ ...meta, chunked: true, handle, chunkBytes: chunk });
}

async function exportModel(args: {
    format?: string;
    ids?: string[];
    name?: string;
    chunked?: boolean;
}): Promise<ToolResult> {
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
    const ext = format.replace(" binary", "");
    const fileName = exportFileName(args.name, nodes, ext);
    // Chunks only when asked: a tab takes any size in one reply (postMessage has no cap); the server bridge asks.
    if (args.chunked === true) {
        const handle = `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        EXPORT_STASH.set(handle, { bytes, fileName, format });
        lastExportHandle = handle;
        while (EXPORT_STASH.size > 8) EXPORT_STASH.delete(EXPORT_STASH.keys().next().value as string);
        return {
            content: JSON.stringify({
                format,
                fileName,
                bytes: bytes.length,
                chunked: true,
                handle,
                chunkBytes: EXPORT_CHUNK,
            }),
        };
    }
    return {
        content: JSON.stringify({ format, fileName, bytes: bytes.length, base64: bytesToBase64(bytes) }),
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
            return exportModel(args as { format?: string; ids?: string[]; name?: string; chunked?: boolean });
        case "esoul.exportChunk":
            return exportChunk(args as { handle?: string; offset?: number; length?: number });
        case "esoul.serialize":
            return JSON.stringify(activeDocument().serialize());
        case "esoul.snapshot":
            return snapshot(args as { shapes?: boolean; chunked?: boolean; chunkBytes?: number });
        case "esoul.theme":
            applyThemeMode(args["mode"]);
            return JSON.stringify({ ok: true, mode: Config.instance.themeMode });
        case "esoul.bodies":
            return JSON.stringify({ bodies: await describeBodies(activeDocument()) });
        case "esoul.describe":
            return describe(args as { nodes?: string[]; maxFaces?: number });
        case "esoul.measure":
            return measure(args as { nodes?: string[]; pairs?: [string, string][] });
        case "esoul.explode":
            return explodeView(args as { factor?: number; parts?: { node: string; k?: number }[] });
        case "esoul.camera":
            return camera(
                args as { rotate?: { dx: number; dy: number }; lookAt?: { eye: XYZ; target: XYZ; up?: XYZ } },
            );
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
    phoneLayout();
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

/**
 * The phone layout. Chili hides the Items/Properties sidebar under 680 px (display: none) and has no
 * way back to it; the ribbon's groups can be swiped but nothing says so. Here (the pattern of the
 * platform's Block Notes and My Computer apps): a round button over the viewport opens the sidebar
 * as a DRAWER over the content with a scrim; a close button in the drawer and a tap on the scrim put
 * it away. Wide again: every override is removed and chili's own layout returns.
 */
const NARROW_PX = 680;
let phoneUi:
    | {
          button: HTMLButtonElement;
          scrim: HTMLDivElement;
          close: HTMLButtonElement;
          observer?: ResizeObserver;
      }
    | undefined;
// Inline styles on the strokes: chili's stylesheet fills svg shapes, and a stylesheet beats a presentation attribute.
const PANEL_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><rect x="3" y="3" width="18" height="18" rx="2" style="fill:none;stroke:currentColor"/><path d="M9 3v18" style="fill:none;stroke:currentColor"/></svg>';
function phoneParts():
    | { root: HTMLElement; content: HTMLElement; sidebar: HTMLElement; viewport: HTMLElement }
    | undefined {
    const editor = document.querySelector("chili-editor");
    const root = editor?.firstElementChild;
    if (!(root instanceof HTMLElement) || root.children.length < 2) return undefined;
    const content = root.children[1];
    if (!(content instanceof HTMLElement) || content.children.length < 2) return undefined;
    const sidebar = content.children[0];
    const viewport = content.children[1];
    if (!(sidebar instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return undefined;
    return { root, content, sidebar, viewport };
}
function setDrawer(open: boolean): void {
    const parts = phoneParts();
    if (!parts || !phoneUi) return;
    parts.sidebar.style.display = open ? "flex" : "none";
    phoneUi.scrim.style.display = open ? "block" : "none";
    phoneUi.button.style.display = open ? "none" : "flex";
}
function phoneLayout(attempt = 0): void {
    const parts = phoneParts();
    if (!parts) {
        if (attempt < 40) setTimeout(() => phoneLayout(attempt + 1), 250);
        return;
    }
    const { root, content, sidebar, viewport } = parts;
    if (!phoneUi) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("aria-label", "Show the items and properties");
        button.title = "Items and properties";
        button.innerHTML = PANEL_ICON;
        // Bottom-left, clear of chili's view-mode label at the top-left (My Computer's bottom-left button is the precedent).
        Object.assign(button.style, {
            position: "absolute",
            left: "10px",
            bottom: "10px",
            zIndex: "5",
            width: "36px",
            height: "36px",
            borderRadius: "10px",
            border: "1px solid var(--border-color)",
            background: "var(--panel-background-color)",
            color: "var(--foreground-color)",
            display: "none",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            boxShadow: "0 4px 14px -6px rgba(0,0,0,0.45)",
            touchAction: "manipulation",
        });
        button.addEventListener("click", () => setDrawer(true));
        const scrim = document.createElement("div");
        Object.assign(scrim.style, {
            position: "absolute",
            inset: "0",
            zIndex: "30",
            background: "rgba(0,0,0,0.35)",
            display: "none",
        });
        scrim.addEventListener("click", () => setDrawer(false));
        const close = document.createElement("button");
        close.type = "button";
        close.setAttribute("aria-label", "Close the items and properties");
        close.textContent = "\u00d7";
        Object.assign(close.style, {
            position: "absolute",
            right: "8px",
            top: "6px",
            zIndex: "2",
            width: "32px",
            height: "32px",
            borderRadius: "8px",
            border: "1px solid var(--border-color)",
            background: "var(--panel-background-color)",
            color: "var(--foreground-color)",
            fontSize: "20px",
            lineHeight: "1",
            display: "none",
            cursor: "pointer",
            touchAction: "manipulation",
        });
        close.addEventListener("click", () => setDrawer(false));
        viewport.append(button);
        content.append(scrim);
        sidebar.prepend(close);
        phoneUi = { button, scrim, close };
        phoneUi.observer = new ResizeObserver(() => phoneLayout());
        phoneUi.observer.observe(root);
    }
    const narrow = root.clientWidth > 0 && root.clientWidth < NARROW_PX;
    // The ribbon's title row (app icon, quick commands, the empty tab centre) is 40 px a phone cannot spare.
    const ribbonTitle = root.children[0]?.children[0];
    if (ribbonTitle instanceof HTMLElement) {
        if (narrow) ribbonTitle.style.display = "none";
        else ribbonTitle.style.removeProperty("display");
    }
    // chili's narrow stylesheet hides the Items tree (chili-project-view) and keeps the sidebar's edge resizer:
    // inside the drawer the tree is the point, and there is no edge to drag.
    const tree = sidebar.querySelector("chili-project-view") as HTMLElement | null;
    const resizer = Array.from(sidebar.children).find((c) => c.tagName === "DIV" && c !== phoneUi?.close) as
        | HTMLElement
        | undefined;
    if (narrow) {
        Object.assign(sidebar.style, {
            position: "absolute",
            top: "0",
            left: "0",
            bottom: "0",
            width: "min(85%, 360px)",
            maxWidth: "none",
            zIndex: "31",
            boxShadow: "0 0 24px rgba(0,0,0,0.5)",
            borderRight: "1px solid var(--border-color)",
            paddingTop: "40px",
        });
        if (tree) tree.style.display = "flex";
        if (resizer) resizer.style.display = "none";
        phoneUi.close.style.display = "flex";
        phoneUi.close.style.alignItems = "center";
        phoneUi.close.style.justifyContent = "center";
        if (sidebar.style.display !== "flex") setDrawer(false);
    } else {
        for (const k of [
            "position",
            "top",
            "left",
            "bottom",
            "max-width",
            "z-index",
            "box-shadow",
            "border-right",
            "padding-top",
            "display",
        ])
            sidebar.style.removeProperty(k);
        // chili set the sidebar's width inline at render; a drawer width must not survive into the desktop layout
        if (sidebar.style.width.startsWith("min(")) sidebar.style.removeProperty("width");
        if (tree) tree.style.removeProperty("display");
        if (resizer) resizer.style.removeProperty("display");
        phoneUi.close.style.display = "none";
        phoneUi.scrim.style.display = "none";
        phoneUi.button.style.display = "none";
    }
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
