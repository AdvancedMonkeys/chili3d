// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    evaluateExpression,
    type FeatureItem,
    type IDocument,
    Id,
    type IEdge,
    type IFace,
    type INode,
    type IShape,
    LENGTH_UNITS,
    Material,
    Matrix4,
    type ParameterValue,
    Plane,
    resolveUnitSpec,
    type Scope,
    ShapeNode,
    ShapeTypes,
    type UnitSpec,
    VisualNode,
    XYZ,
} from "@chili3d/core";
import { isBodyTrackingNode } from "../features/bodyTracking";
import { captureEdgeRef } from "../features/edgeRef";
import type {
    BooleanOperation,
    ExtrudeFeatureData,
    FeatureData,
    RevolveFeatureData,
} from "../features/feature";
import { ParametricBodyNode } from "../parametricBodyNode";
import { captureFaceRef, type PlaneFaceRef, sketchPlaneOfFace } from "../sketch/planeRef";
import {
    ConstraintKind,
    type SketchConstraintData,
    type SketchData,
    type SketchEntityData,
    type SketchEntityType,
} from "../sketch/sketchModel";
import { SketchNode } from "../sketch/sketchNode";
import { SketchSolver } from "../sketch/solver";

/**
 * A parametric program: an ordered list of sketch and feature operations, driven from a
 * plain-JSON payload. The engine owns no geometry of its own — every step delegates to
 * the same API the interactive commands use (`SketchSolver`, `SketchNode`,
 * `ParametricBodyNode.setFeaturesEmitShapeChanged`), so an AI-built body is
 * indistinguishable from a hand-built one.
 *
 * Contract: synchronous, and **throws on any failure** so the caller's `Transaction`
 * rolls the whole program back. Nothing is written to history and the visual is not
 * refreshed here — that is the caller's job.
 */

export type ParametricOp =
    | SketchOp
    | ExtrudeOp
    | RevolveOp
    | FilletChamferOp
    | BooleanOp
    | EditFeatureOp
    | TransformOp
    | StyleOp
    | ImportOp
    | FeaturesOp;

export interface SketchOp {
    op: "sketch";
    id: string;
    /** The node id to mint (ExternalSoul passes a deterministic one so a replay on another device yields the same ids). */
    nodeId?: string;
    name?: string;
    /**
     * A datum plane, a datum plane moved along its normal (`{ base: "ZX", offset: 32 }` is the
     * plane y = 32 with ZX's u/v), or a planar face of an existing node. Defaults to XY.
     */
    plane?:
        | "XY"
        | "YZ"
        | "ZX"
        | { base: "XY" | "YZ" | "ZX"; offset: number }
        | { nodeId: string; faceIndex: number };
    /**
     * Entities in sketch (u,v). A param may be a NUMBER or an EXPRESSION naming document variables
     * ("unit * 2"). Two macros expand before solving: `grid` [x0, y0, w, h, nx, ny, pitchX, pitchY] —
     * nx × ny rectangles of w × h whose first lower-left corner is (x0, y0); `circles` [x0, y0, r, nx,
     * ny, pitchX, pitchY] — a grid of circles centred from (x0, y0).
     */
    entities: { type: SketchEntityType | "grid" | "circles"; params: (number | string)[] }[];
    constraints?: {
        kind: string;
        refs: { entity: number; point: number }[];
        datum?: ParameterValue;
        datums?: ParameterValue[];
    }[];
}

export interface ExtrudeOp {
    op: "extrude";
    id: string;
    /** The feature id to mint (ExternalSoul passes `<stepId>:<opId>` so editFeature can name it on any device). */
    featureId?: string;
    /** A colour for a NEW body ("#c08457" or "c08457"), with an optional opacity 0..1 — the same as a `style` op after it. */
    color?: string;
    opacity?: number;
    /** The node id to mint for a NEW body (ignored when `body` is set). */
    nodeId?: string;
    name?: string;
    /** The sketch op id, or an existing sketch's node id. */
    sketch: string;
    /** A length, an expression, or "through" — a cut all the way through the body (symmetric, re-measured on every rebuild). */
    depth: ParameterValue | "through";
    symmetric?: boolean;
    startOffset?: ParameterValue;
    /** Omit to create a new body; otherwise the body to append the feature to. */
    body?: string;
    operation?: BooleanOperation;
}

export interface RevolveOp {
    op: "revolve";
    id: string;
    /** The feature id to mint (ExternalSoul passes `<stepId>:<opId>` so editFeature can name it on any device). */
    featureId?: string;
    /** A colour for a NEW body ("#c08457" or "c08457"), with an optional opacity 0..1 — the same as a `style` op after it. */
    color?: string;
    opacity?: number;
    /** The node id to mint. */
    nodeId?: string;
    name?: string;
    sketch: string;
    axis: { point: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } };
    /** Degrees. Defaults to 360. Always starts a new body — revolve has no join/cut form. */
    angle?: ParameterValue;
}

/**
 * Which edges of a body a fillet/chamfer takes, without indexes: every filter must hold. Directions
 * compare the edge's chord (start→end); straight edges only unless `curved` is true.
 */
export interface EdgeSelector {
    /** The chord is parallel to this axis (within 5°). */
    parallelTo?: "x" | "y" | "z";
    /** The chord lies in this plane's normal direction? No — the chord is PERPENDICULAR to this axis. */
    perpendicularTo?: "x" | "y" | "z";
    /** Both ends inside this box (world coordinates; any bound may be omitted). */
    minX?: number;
    maxX?: number;
    minY?: number;
    maxY?: number;
    minZ?: number;
    maxZ?: number;
    /** The edge's midpoint within `within` (default 1) of this point. */
    near?: { x: number; y: number; z: number };
    within?: number;
    longerThan?: number;
    shorterThan?: number;
    /** Include curved edges (circles, arcs) — off by default. */
    curved?: boolean;
}

export interface FilletChamferOp {
    op: "fillet" | "chamfer";
    id: string;
    /** The feature id to mint (ExternalSoul passes `<stepId>:<opId>` so editFeature can name it on any device). */
    featureId?: string;
    name?: string;
    body: string;
    /** Indexes into the body's current edge list (findSubShapes order). */
    /** Explicit edge indexes (findSubShapes order), or a selector; one of the two. */
    edgeIndexes?: number[];
    edges?: EdgeSelector;
    radius?: ParameterValue;
    distance?: ParameterValue;
}

export interface BooleanOp {
    op: "boolean";
    id: string;
    /** The feature id to mint (ExternalSoul passes `<stepId>:<opId>` so editFeature can name it on any device). */
    featureId?: string;
    name?: string;
    body: string;
    operation: BooleanOperation;
    /** Node ids (or op ids) of the tool bodies. */
    tools: string[];
    consumeTools?: boolean;
}

export interface EditFeatureOp {
    op: "editFeature";
    body: string;
    featureId: string;
    action: "setParameter" | "rename" | "suppress" | "moveTo" | "remove";
    key?: string;
    value?: ParameterValue | boolean;
    index?: number;
}

/** Move a finished part: rotate about an axis (degrees, about `origin` or the world origin), then translate. */
export interface TransformOp {
    op: "transform";
    id: string;
    /** The node to move (an op id or a node id); booleans read tools in world space, so a moved tool cuts where it now is. */
    node: string;
    translate?: { x?: number; y?: number; z?: number };
    rotate?: {
        axis: { x: number; y: number; z: number };
        angle: number;
        origin?: { x: number; y: number; z: number };
    };
}

/**
 * Bring a CAD file in as a body (one per solid in the file): STEP or IGES bytes (base64), or BRep
 * text. The body starts from a `base` feature holding the geometry, so everything a built body
 * takes — cuts, fuses, fillets, a sketch on one of its faces, a transform — applies to it.
 */
export interface ImportOp {
    op: "import";
    id: string;
    nodeId?: string;
    featureId?: string;
    name?: string;
    format: ".step" | ".iges" | ".brep";
    /** The file's bytes, base64 (STEP/IGES), or for ".brep" the text itself in `brep`. */
    base64?: string;
    brep?: string;
    color?: string;
    opacity?: number;
}

/** Colour a node (a body, an imported shape): a material with that colour is found or made in the document. */
export interface StyleOp {
    op: "style";
    id: string;
    node: string;
    /** "#c08457" or "c08457". */
    color: string;
    /** 0 (clear) .. 1 (solid); default 1. */
    opacity?: number;
}

export interface FeaturesOp {
    op: "features";
    id?: string;
    body: string;
}

/**
 * A feature row as it leaves the engine. `FeatureItem` cannot be returned as-is: its
 * `references` hold live `INode`s, which own their parent and document right back, so
 * serializing it throws "cyclic structures". Everything here is plain data.
 */
export interface FeatureSummary {
    id: string;
    type: string;
    display: string;
    /** The user-given name of the feature (the op's `name`), when it has one. */
    name?: string;
    suppressed: boolean;
    error?: string;
    warning?: string;
    reselectable?: boolean;
    references: { key: string; display: string; nodeId: string }[];
    parameters: { key: string; display: string; value: number | string | boolean; unit?: UnitSpec }[];
}

/** What one program produced, in the same envelope shape `run_program` uses. */
export interface ProgramResult {
    created: { id: string; nodeId: string; name: string }[];
    /** The feature list of every body the program touched. */
    bodies: { nodeId: string; name: string; features: FeatureSummary[] }[];
    /** Nodes adopted by a boolean feature — hidden children of the body, not deleted. */
    consumed: { nodeId: string; name: string; ownerId: string }[];
    results: Record<string, unknown>;
}

interface State {
    readonly document: IDocument;
    readonly refs: Map<string, string>;
    readonly out: ProgramResult;
    readonly touched: Set<ParametricBodyNode>;
}

/**
 * Op id -> node id, per document. Only node ids are kept: a node survives rebuilds and
 * undo/redo, so a stale entry resolves to "node not found" on its own — no live-shape
 * cache and therefore no rollback patching.
 */
const refsByDocument = new WeakMap<IDocument, Map<string, string>>();
const MAX_REFS_PER_DOCUMENT = 512;

function refsFor(document: IDocument): Map<string, string> {
    const existing = refsByDocument.get(document);
    if (existing !== undefined) return existing;
    const refs = new Map<string, string>();
    refsByDocument.set(document, refs);
    return refs;
}

/** Runs every op in order, returning the result envelope. Throws on the first failure. */
export function runParametricProgram(document: IDocument, ops: readonly ParametricOp[]): ProgramResult {
    const refs = refsFor(document);
    if (refs.size > MAX_REFS_PER_DOCUMENT) refs.clear();
    const state: State = {
        document,
        refs,
        out: { created: [], bodies: [], consumed: [], results: {} },
        touched: new Set(),
    };
    ops.forEach((op, index) => {
        try {
            runOp(state, op);
        } catch (err) {
            throw new Error(`op ${index} ("${op.op}") failed: ${(err as Error).message}`);
        }
    });
    state.out.bodies = [...state.touched].map((body) => ({
        nodeId: body.id,
        name: body.name,
        features: summarizeFeatures(body),
    }));
    return state.out;
}

function runOp(state: State, op: ParametricOp): void {
    switch (op.op) {
        case "sketch":
            runSketchOp(state, op);
            break;
        case "extrude":
            runExtrudeOp(state, op);
            break;
        case "revolve":
            runRevolveOp(state, op);
            break;
        case "fillet":
        case "chamfer":
            runEdgeCornerOp(state, op);
            break;
        case "boolean":
            runBooleanOp(state, op);
            break;
        case "transform":
            runTransformOp(state, op);
            break;
        case "style":
            runStyleOp(state, op);
            break;
        case "import":
            runImportOp(state, op);
            break;
        case "editFeature":
            runEditFeatureOp(state, op);
            break;
        case "features":
            runFeaturesOp(state, op);
            break;
        default:
            throw new Error(`unknown op "${(op as { op: string }).op}"`);
    }
}

// ------------------------------------------------------------------ Reference resolution

/** Resolves an op id (or a plain node id) to a node. */
function resolveNode(state: State, ref: unknown, what: string): INode {
    const key = String(ref ?? "");
    if (key === "") throw new Error(`${what} is required`);
    const id = state.refs.get(key) ?? key;
    const node = state.document.modelManager.findNodes((n) => n.id === id)[0];
    if (node === undefined) {
        const known = state.refs.size > 0 ? [...state.refs.keys()].join(", ") : "none defined yet";
        throw new Error(
            `unknown ${what} "${key}": no node with id "${id}" (op ids defined in this session: ${known})`,
        );
    }
    return node;
}

function resolveSketch(state: State, ref: unknown): SketchNode {
    const node = resolveNode(state, ref, "sketch");
    if (!(node instanceof SketchNode)) {
        throw new Error(`"${ref}" is a ${node.constructor.name}, not a sketch`);
    }
    return node;
}

function resolveBody(state: State, ref: unknown): ParametricBodyNode {
    const node = resolveNode(state, ref, "body");
    if (!(node instanceof ParametricBodyNode)) {
        throw new Error(`"${ref}" is a ${node.constructor.name}, not a parametric body`);
    }
    return node;
}

// ------------------------------------------------------------------ Sketch

function runSketchOp(state: State, op: SketchOp): void {
    const { planeRef, plane, refPositions } = resolveSketchPlane(state, op);
    const data = buildSketchData(state.document, op, plane);
    if (refPositions !== undefined) data.refPositions = refPositions;

    const sketch = new SketchNode({ document: state.document, plane, planeRef, data, id: op.nodeId });
    state.document.modelManager.addNode(sketch);
    // The node builds its edges lazily and reports failure only through `shape` — this
    // read is both the trigger and the single place a bad sketch can be caught.
    const shape = sketch.shape;
    if (!shape.isOk) throw new Error(`the sketch is not usable: ${shape.error}`);
    if (op.name !== undefined) sketch.name = op.name;

    state.refs.set(op.id, sketch.id);
    state.out.created.push({ id: op.id, nodeId: sketch.id, name: sketch.name });
}

function resolveSketchPlane(
    state: State,
    op: SketchOp,
): { plane: Plane; planeRef?: PlaneFaceRef; refPositions?: Record<string, number> } {
    const picked = op.plane;
    if (picked === undefined || picked === "XY") return { plane: Plane.XY };
    if (picked === "YZ") return { plane: Plane.YZ };
    if (picked === "ZX") return { plane: Plane.ZX };
    if ("base" in picked) {
        // An offset datum plane: the base plane carried along its own normal, u/v unchanged.
        const base = picked.base === "YZ" ? Plane.YZ : picked.base === "ZX" ? Plane.ZX : Plane.XY;
        const offset = Number(picked.offset);
        if (!Number.isFinite(offset))
            throw new Error(`plane offset must be a finite number (got ${String(picked.offset)})`);
        return {
            plane: new Plane({
                origin: base.origin.add(base.normal.multiply(offset)),
                normal: base.normal,
                xvec: base.xvec,
            }),
        };
    }

    const host = resolveNode(state, picked.nodeId, "plane host");
    if (!(host instanceof ShapeNode) || !host.shape.isOk) {
        throw new Error(`node "${picked.nodeId}" has no valid shape to build a sketch plane on`);
    }
    const faces = host.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const local = faces[picked.faceIndex];
    if (local === undefined) {
        throw new Error(
            `faceIndex ${picked.faceIndex} is out of range on "${picked.nodeId}" (0..${faces.length - 1})`,
        );
    }
    if (!local.surface().isPlanar()) {
        throw new Error(`face ${picked.faceIndex} of "${picked.nodeId}" is not planar`);
    }
    // Sketch planes and face refs are captured in world coordinates (planeRef.ts).
    const transform = host.worldTransform();
    const isIdentity = transform.equals(Matrix4.identity());
    const world = isIdentity ? local : (local.transformedMul(transform) as IFace);
    try {
        const planeRef = captureFaceRef(host.id, world);
        if (isBodyTrackingNode(host)) {
            const faceId = host.faceIdAt(picked.faceIndex);
            if (faceId !== undefined) planeRef.faceId = faceId;
        }
        // The plane belongs to the host's shape at capture time: anchor the sketch's
        // timeline there so a later feature moving the face does not drag the plane.
        const refPositions =
            host instanceof ParametricBodyNode ? { [host.id]: host.features.length } : undefined;
        return { plane: sketchPlaneOfFace(world), planeRef, refPositions };
    } finally {
        if (!isIdentity) world.dispose();
    }
}

/** A sketch param: a number, or an expression over the document's variables (unit-free numbers and lengths both read as mm). */
function sketchNumber(value: number | string, scope: Scope, where: string): number {
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error(`${where}: ${value} is not a finite number`);
        return value;
    }
    const r = evaluateExpression(value, scope);
    if (!r.isOk) throw new Error(`${where}: "${value}" — ${r.error}`);
    return r.value.value;
}

/** Expand the `grid`/`circles` macros into plain entities and evaluate every param. */
function expandSketchEntities(op: SketchOp, scope: Scope): { type: SketchEntityType; params: number[] }[] {
    const out: { type: SketchEntityType; params: number[] }[] = [];
    op.entities.forEach((entity, index) => {
        const where = `sketch "${op.id}" entity ${index} (${entity.type})`;
        const nums = entity.params.map((p, k) => sketchNumber(p, scope, `${where} param ${k}`));
        if (entity.type === "grid") {
            if (nums.length !== 8)
                throw new Error(`${where}: grid takes [x0, y0, w, h, nx, ny, pitchX, pitchY]`);
            const [x0, y0, w, h, nx, ny, px, py] = nums;
            if (nx < 1 || ny < 1 || nx * ny > 2000)
                throw new Error(`${where}: grid of ${nx}×${ny} is out of range (1..2000 cells)`);
            for (let j = 0; j < ny; j++)
                for (let i = 0; i < nx; i++) {
                    const a = x0 + i * px,
                        b = y0 + j * py,
                        c = a + w,
                        d = b + h;
                    out.push(
                        { type: "line", params: [a, b, c, b] },
                        { type: "line", params: [c, b, c, d] },
                        { type: "line", params: [c, d, a, d] },
                        { type: "line", params: [a, d, a, b] },
                    );
                }
            return;
        }
        if (entity.type === "circles") {
            if (nums.length !== 7)
                throw new Error(`${where}: circles takes [x0, y0, r, nx, ny, pitchX, pitchY]`);
            const [x0, y0, r, nx, ny, px, py] = nums;
            if (nx < 1 || ny < 1 || nx * ny > 2000)
                throw new Error(`${where}: ${nx}×${ny} circles is out of range (1..2000)`);
            for (let j = 0; j < ny; j++)
                for (let i = 0; i < nx; i++)
                    out.push({ type: "circle", params: [x0 + i * px, y0 + j * py, r] });
            return;
        }
        out.push({ type: entity.type, params: nums });
    });
    return out;
}

function buildSketchData(document: IDocument, op: SketchOp, plane: Plane): SketchData {
    const scope = document.variables.evaluate().scope;
    const entities: SketchEntityData[] = expandSketchEntities(op, scope).map((entity, index) => ({
        id: index + 1,
        type: entity.type,
        params: entity.params,
    }));
    const data: SketchData = {
        entities,
        constraints: [],
        // Explicit ids are handed out by index, so the counter has to start past them.
        entityIdSeq: entities.length + 1,
    };
    const constraints = op.constraints ?? [];
    if (constraints.length === 0) return data;

    data.constraints = constraints.map((constraint, index) => {
        const refs = constraint.refs.map((ref) => ({ entityId: ref.entity, pointIndex: ref.point }));
        const entry: SketchConstraintData = {
            id: index + 1,
            kind: parseConstraintKind(constraint.kind),
            refs,
        };
        if (constraint.datum !== undefined) entry.datum = constraint.datum;
        if (constraint.datums !== undefined) entry.datums = constraint.datums;
        return entry;
    });
    return solveSketch(plane, data, document.variables.evaluate().scope);
}

/**
 * Runs the constraint solver once over freshly built data, returning the solved form.
 * The solver loads (and solves) in its constructor; this only adds the datum-error check
 * the node itself would swallow — an expression that does not resolve would otherwise
 * leave the sketch silently under-solved.
 */
function solveSketch(plane: Plane, data: SketchData, scope: Scope): SketchData {
    const solver = new SketchSolver(plane, data, scope);
    try {
        solver.solve(true);
        if (solver.datumErrors.size > 0) {
            const [id, message] = [...solver.datumErrors][0];
            throw new Error(`constraint ${id} has an unusable value: ${message}`);
        }
        return solver.toData();
    } finally {
        solver.dispose();
    }
}

function parseConstraintKind(kind: unknown): ConstraintKind {
    if (typeof kind === "number" && ConstraintKind[kind] !== undefined) return kind as ConstraintKind;
    const name = String(kind);
    const resolved = (ConstraintKind as unknown as Record<string, ConstraintKind | undefined>)[name];
    if (resolved !== undefined) return resolved;
    const valid = Object.keys(ConstraintKind).filter((key) => Number.isNaN(Number(key)));
    throw new Error(`unknown constraint kind "${name}" — valid kinds: ${valid.join(", ")}`);
}

// ------------------------------------------------------------------ Features

function runExtrudeOp(state: State, op: ExtrudeOp): void {
    const sketch = resolveSketch(state, op.sketch);
    const scope = state.document.variables.evaluate().scope;
    const through = op.depth === "through";
    if (through) {
        if (op.body === undefined || (op.operation !== "cut" && op.operation !== "common"))
            throw new Error(
                'depth "through" is for a cut (or common) into an existing body: give "body" and "operation"',
            );
    } else ensureUnit(op.depth, scope, LENGTH_UNITS, "depth");
    if (op.startOffset !== undefined) ensureUnit(op.startOffset, scope, LENGTH_UNITS, "startOffset");

    // `profiles` is deliberately left out: an absent list extrudes every closed profile
    // of the sketch, which is what a whole-sketch extrude means.
    const feature: ExtrudeFeatureData = {
        id: op.featureId ?? Id.generate(),
        ...(op.name ? { name: op.name } : {}),
        type: "extrude",
        sketchId: sketch.id,
        depth: op.depth,
        ...(op.symmetric === true || through ? { symmetric: true } : {}),
        ...(op.startOffset !== undefined ? { startOffset: op.startOffset } : {}),
    };
    if (op.body === undefined) {
        createBody(
            state,
            op.id,
            op.name,
            [feature],
            () => {
                sketch.visible = false;
            },
            op.nodeId,
        );
        return;
    }
    if (op.operation === undefined) {
        throw new Error('appending an extrude to an existing body requires "operation" (fuse/cut/common)');
    }
    const body = resolveBody(state, op.body);
    appendFeature(state, body, { ...feature, operation: op.operation });
    // An op that edits a body is registered as another name for it, so a later op can
    // reference the result of this one the same way it references a freshly built body.
    state.refs.set(op.id, body.id);
}

function runRevolveOp(state: State, op: RevolveOp): void {
    const sketch = resolveSketch(state, op.sketch);
    const scope = state.document.variables.evaluate().scope;
    ensureAxis(op.axis);
    if (op.angle !== undefined) ensureUnit(op.angle, scope, ANGLE_UNITS, "angle");

    const feature: RevolveFeatureData = {
        id: op.featureId ?? Id.generate(),
        ...(op.name ? { name: op.name } : {}),
        type: "revolve",
        sketchId: sketch.id,
        // A world-space snapshot; without an `axisSource` there is nothing to re-derive
        // the axis from, and the snapshot is what the handler falls back to anyway.
        axis: { point: { ...op.axis.point }, direction: { ...op.axis.direction } },
        angle: op.angle ?? 360,
    };
    createBody(
        state,
        op.id,
        op.name,
        [feature],
        () => {
            sketch.visible = false;
        },
        op.nodeId,
    );
}

const AXIS: Record<"x" | "y" | "z", XYZ> = { x: new XYZ(1, 0, 0), y: new XYZ(0, 1, 0), z: new XYZ(0, 0, 1) };

/** The indexes of the body's edges an EdgeSelector picks, in world coordinates. */
function selectEdges(edges: IEdge[], sel: EdgeSelector, host: { worldTransform(): Matrix4 }): number[] {
    const m = host.worldTransform();
    const identity = m.equals(Matrix4.identity());
    const cos5 = Math.cos((5 * Math.PI) / 180);
    const out: number[] = [];
    edges.forEach((edge, index) => {
        const [s0, e0] = edge.ends();
        const s = identity ? s0 : m.ofPoint(s0),
            e = identity ? e0 : m.ofPoint(e0);
        const chord = e.sub(s);
        const len = edge.length();
        const straight = Math.abs(len - chord.length()) < 1e-3 * Math.max(1, len);
        if (!straight && !sel.curved) return;
        const dir = chord.length() > 1e-9 ? chord.normalize() : undefined;
        if (sel.parallelTo) {
            if (!dir || Math.abs(dir.dot(AXIS[sel.parallelTo])) < cos5) return;
        }
        if (sel.perpendicularTo) {
            if (!dir || Math.abs(dir.dot(AXIS[sel.perpendicularTo])) > Math.sin((5 * Math.PI) / 180)) return;
        }
        const inside = (p: XYZ) =>
            (sel.minX === undefined || p.x >= sel.minX - 1e-6) &&
            (sel.maxX === undefined || p.x <= sel.maxX + 1e-6) &&
            (sel.minY === undefined || p.y >= sel.minY - 1e-6) &&
            (sel.maxY === undefined || p.y <= sel.maxY + 1e-6) &&
            (sel.minZ === undefined || p.z >= sel.minZ - 1e-6) &&
            (sel.maxZ === undefined || p.z <= sel.maxZ + 1e-6);
        if (!inside(s) || !inside(e)) return;
        if (sel.near) {
            const mid = s.add(e).multiply(0.5);
            if (mid.distanceTo(new XYZ(sel.near.x, sel.near.y, sel.near.z)) > (sel.within ?? 1)) return;
        }
        if (sel.longerThan !== undefined && !(len > sel.longerThan)) return;
        if (sel.shorterThan !== undefined && !(len < sel.shorterThan)) return;
        out.push(index);
    });
    return out;
}

function runEdgeCornerOp(state: State, op: FilletChamferOp): void {
    const body = resolveBody(state, op.body);
    const shape = body.shape;
    if (!shape.isOk) throw new Error(`body "${op.body}" has no valid shape: ${shape.error}`);
    const scope = state.document.variables.evaluate().scope;
    const value = op.op === "fillet" ? op.radius : op.distance;
    if (value === undefined)
        throw new Error(`"${op.op}" requires "${op.op === "fillet" ? "radius" : "distance"}"`);
    ensureUnit(value, scope, LENGTH_UNITS, op.op === "fillet" ? "radius" : "distance");

    const edges = shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    const indexes = op.edgeIndexes ?? (op.edges ? selectEdges(edges, op.edges, body) : undefined);
    if (indexes === undefined) throw new Error(`"${op.op}" needs "edgeIndexes" or an "edges" selector`);
    if (indexes.length === 0)
        throw new Error(
            `"${op.op}": the edge selector matched no edge of body "${op.body}" (${edges.length} edges)`,
        );
    state.out.results[`${op.id}.edges`] = indexes;
    const refs = indexes.map((index) => {
        const edge = edges[index];
        if (edge === undefined) {
            throw new Error(
                `edgeIndex ${index} is out of range on body "${op.body}" (0..${edges.length - 1})`,
            );
        }
        // Same capture the interactive fillet uses: the tracked id is what makes the
        // ref survive a rebuild, the fingerprint is what matches when it does not.
        const id = body.edgeIdAt(index);
        return captureEdgeRef(edge, id, body.edgeIdIsShared(id));
    });

    const feature: FeatureData =
        op.op === "fillet"
            ? {
                  id: op.featureId ?? Id.generate(),
                  ...(op.name ? { name: op.name } : {}),
                  type: "fillet",
                  radius: value,
                  edges: refs,
              }
            : {
                  id: op.featureId ?? Id.generate(),
                  ...(op.name ? { name: op.name } : {}),
                  type: "chamfer",
                  distance: value,
                  edges: refs,
              };
    appendFeature(state, body, feature);
    state.refs.set(op.id, body.id);
}

function runBooleanOp(state: State, op: BooleanOp): void {
    const body = resolveBody(state, op.body);
    const tools = op.tools.map((tool) => resolveNode(state, tool, "boolean tool"));
    for (const tool of tools) {
        if (tool.id === body.id) throw new Error(`cannot use the body "${op.body}" as its own boolean tool`);
        if (!(tool instanceof ShapeNode)) {
            throw new Error(`boolean tool "${tool.name}" is a ${tool.constructor.name}, not a shape node`);
        }
    }
    appendFeature(state, body, {
        id: op.featureId ?? Id.generate(),
        ...(op.name ? { name: op.name } : {}),
        type: "boolean",
        operation: op.operation,
        toolIds: tools.map((tool) => tool.id),
        ...(op.consumeTools === false ? { consumeTools: false } : {}),
    });
    // The body adopts the tools itself (`syncConsumedTools`); this only reports it.
    for (const tool of tools) {
        state.out.consumed.push({ nodeId: tool.id, name: tool.name, ownerId: body.id });
    }
    state.refs.set(op.id, body.id);
}

function runEditFeatureOp(state: State, op: EditFeatureOp): void {
    const body = resolveBody(state, op.body);
    if (!body.features.some((feature) => feature.id === op.featureId)) {
        const known = body.features.map((f) => `${f.id}${f.name ? ` ("${f.name}")` : ""}`).join(", ");
        throw new Error(
            `no feature "${op.featureId}" on body "${op.body}" — its features: ${known || "none"}`,
        );
    }
    const before = erroredFeatureIds(body);
    switch (op.action) {
        case "setParameter":
            if (op.key === undefined) throw new Error('"setParameter" requires "key"');
            if (op.value === undefined) throw new Error('"setParameter" requires "value"');
            body.setFeatureParameter(op.featureId, op.key, op.value);
            break;
        case "rename":
            body.renameFeature(op.featureId, typeof op.value === "string" ? op.value : "");
            return;
        case "suppress":
            body.setFeatureSuppressed(op.featureId, op.value === true);
            break;
        case "moveTo":
            if (typeof op.index !== "number") throw new Error('"moveTo" requires a numeric "index"');
            body.moveFeatureTo(op.featureId, op.index);
            break;
        case "remove":
            body.removeFeature(op.featureId);
            break;
        default:
            throw new Error(`unknown editFeature action "${(op as { action: string }).action}"`);
    }
    checkBody(state, body, before);
}

function runTransformOp(state: State, op: TransformOp): void {
    const node = resolveNode(state, op.node, "transform target");
    if (!(node instanceof VisualNode))
        throw new Error(`"${op.node}" is not a visual node and cannot be moved`);
    let delta = Matrix4.identity();
    if (op.rotate !== undefined) {
        const a = op.rotate.axis;
        const axis = new XYZ(a.x, a.y, a.z);
        if (axis.length() < 1e-9) throw new Error("rotate.axis must not be zero");
        const o = op.rotate.origin ?? { x: 0, y: 0, z: 0 };
        delta = delta.multiply(
            Matrix4.fromAxisRad(new XYZ(o.x, o.y, o.z), axis, (op.rotate.angle * Math.PI) / 180),
        );
    }
    if (op.translate !== undefined) {
        const t = op.translate;
        delta = delta.multiply(Matrix4.fromTranslation(t.x ?? 0, t.y ?? 0, t.z ?? 0));
    }
    node.transform = node.transform.multiply(delta);
    state.refs.set(op.id, node.id);
    if (node instanceof ParametricBodyNode) state.touched.add(node);
}

function parseHexColor(text: string): number {
    const hex = text.trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(hex))
        throw new Error(`color must be a 6-digit hex like "#c08457" (got "${text}")`);
    return Number.parseInt(hex, 16);
}

/** The document's material with exactly this colour and opacity, made when none exists. */
function ensureMaterial(document: IDocument, color: number, opacity: number): Material {
    const same = (m: Material) => {
        const c =
            typeof m.color === "number" ? m.color : Number.parseInt(String(m.color).replace(/^#/, ""), 16);
        return c === color && Math.abs((m.opacity ?? 1) - opacity) < 1e-6;
    };
    const existing = document.modelManager.materials.find(same);
    if (existing) return existing;
    const material = new Material({ document, name: `#${color.toString(16).padStart(6, "0")}`, color });
    material.opacity = opacity;
    document.modelManager.materials.push(material);
    return material;
}

function applyStyle(state: State, node: INode, color: string, opacity: number | undefined): void {
    const target = node as { materialId?: string | string[] };
    if (!("materialId" in target)) throw new Error(`"${node.name}" has no material and cannot be coloured`);
    const material = ensureMaterial(state.document, parseHexColor(color), opacity ?? 1);
    target.materialId = material.id;
}

function runStyleOp(state: State, op: StyleOp): void {
    const node = resolveNode(state, op.node, "style target");
    applyStyle(state, node, op.color, op.opacity);
    state.refs.set(op.id, node.id);
}

function bytesOfBase64(text: string): Uint8Array {
    const bin = atob(text.replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function runImportOp(state: State, op: ImportOp): void {
    const shapes: { shape: IShape; name?: string }[] = [];
    if (op.format === ".brep" || op.brep !== undefined) {
        const text = op.brep ?? (op.base64 ? new TextDecoder().decode(bytesOfBase64(op.base64)) : "");
        if (!text) throw new Error("import: a .brep needs `brep` text (or base64 of it)");
        const r = shapeConverter.convertFromBrep(text);
        if (!r.isOk) throw new Error(`import: the BRep could not be read: ${r.error}`);
        shapes.push({ shape: r.value });
    } else {
        if (!op.base64) throw new Error(`import: ${op.format} needs the file's bytes in \`base64\``);
        const bytes = bytesOfBase64(op.base64);
        const r =
            op.format === ".iges"
                ? shapeConverter.convertFromIGES(state.document, bytes)
                : shapeConverter.convertFromSTEP(state.document, bytes);
        if (!r.isOk) throw new Error(`import: the ${op.format} file could not be read: ${r.error}`);
        const folder = r.value;
        const walk = (n: INode | undefined): void => {
            for (let c = n; c !== undefined; c = c.nextSibling) {
                const sn = c as {
                    shape?: { isOk: boolean; value: IShape };
                    firstChild?: INode;
                    name?: string;
                };
                if (sn.shape?.isOk) shapes.push({ shape: sn.shape.value, name: sn.name });
                else if (sn.firstChild) walk(sn.firstChild);
            }
        };
        walk(folder.firstChild);
        if (shapes.length === 0) throw new Error(`import: no solid found in the ${op.format} file`);
    }
    const base = op.name ?? "Import";
    shapes.forEach((entry, i) => {
        const brep = shapeConverter.convertToBrep(entry.shape);
        if (!brep.isOk) throw new Error(`import: part ${i + 1} could not be kept as BRep: ${brep.error}`);
        const id = i === 0 ? op.id : `${op.id}:${i + 1}`;
        const nodeId = op.nodeId === undefined ? undefined : i === 0 ? op.nodeId : `${op.nodeId}:${i + 1}`;
        const featureId =
            op.featureId === undefined ? Id.generate() : i === 0 ? op.featureId : `${op.featureId}:${i + 1}`;
        const name =
            shapes.length === 1
                ? base
                : entry.name && entry.name !== "undefined"
                  ? entry.name
                  : `${base} ${i + 1}`;
        createBody(
            state,
            id,
            name,
            [{ id: featureId, type: "base", brep: brep.value, source: { format: op.format } }],
            undefined,
            nodeId,
        );
        if (op.color !== undefined)
            applyStyle(state, resolveNode(state, id, "imported body"), op.color, op.opacity);
    });
}

function runFeaturesOp(state: State, op: FeaturesOp): void {
    state.out.results[op.id ?? "features"] = summarizeFeatures(resolveBody(state, op.body));
}

/** Feature rows stripped of their live nodes — see `FeatureSummary`. */
function summarizeFeatures(body: ParametricBodyNode): FeatureSummary[] {
    const types = body.features.map((feature) => feature.type);
    return body.featureItems().map((item, index) => featureSummary(item, types[index]));
}

function featureSummary(item: FeatureItem, type: string | undefined): FeatureSummary {
    const summary: FeatureSummary = {
        id: item.id,
        ...(item.name ? { name: item.name } : {}),
        type: type ?? "unknown",
        display: item.display,
        suppressed: item.suppressed === true,
        references: (item.references ?? []).map((reference) => ({
            key: reference.key,
            display: reference.display,
            // The node itself is what cycles — keep its id, which is what a caller needs.
            nodeId: reference.node.id,
        })),
        parameters: item.parameters.map((parameter) => ({
            key: parameter.key,
            display: parameter.display,
            value: parameter.value,
            ...(parameter.unit !== undefined ? { unit: parameter.unit } : {}),
        })),
    };
    if (item.name !== undefined) summary.name = item.name;
    if (item.error !== undefined) summary.error = item.error;
    if (item.warning !== undefined) summary.warning = item.warning;
    if (item.reselectable === true) summary.reselectable = true;
    return summary;
}

// ------------------------------------------------------------------ Feature plumbing

function createBody(
    state: State,
    id: string,
    name: string | undefined,
    features: FeatureData[],
    afterAdd?: () => void,
    nodeId?: string,
): void {
    const body = new ParametricBodyNode({ document: state.document, features, id: nodeId });
    state.document.modelManager.addNode(body);
    if (name !== undefined) body.name = name;
    afterAdd?.();
    checkBody(state, body, undefined);
    state.refs.set(id, body.id);
    state.out.created.push({ id, nodeId: body.id, name: body.name });
}

/**
 * The single write gate for features. A failed rebuild is swallowed by the node — it
 * keeps the previous shape and only records the message on the feature row — so this
 * has to compare before and after and raise, or a broken model would be reported as a
 * success. Only *new* errors count: a stale failure from an earlier edit must not make
 * every later op look broken.
 */
function appendFeature(state: State, body: ParametricBodyNode, feature: FeatureData): void {
    const before = erroredFeatureIds(body);
    body.setFeaturesEmitShapeChanged([...body.features, feature]);
    checkBody(state, body, before);
}

function checkBody(state: State, body: ParametricBodyNode, before: Set<string> | undefined): void {
    const failed = body
        .featureItems()
        .find((item) => item.error !== undefined && (before === undefined || !before.has(item.id)));
    if (failed !== undefined) {
        throw new Error(`feature "${failed.display}" (${failed.id}) failed: ${failed.error}`);
    }
    const shape = body.shape;
    if (!shape.isOk) throw new Error(`the body could not be rebuilt: ${shape.error}`);
    state.touched.add(body);
}

function erroredFeatureIds(body: ParametricBodyNode): Set<string> {
    return new Set(
        body
            .featureItems()
            .filter((item) => item.error !== undefined)
            .map((item) => item.id),
    );
}

/** Resolves a parameter up front so a bad expression fails here, not inside a rebuild. */
function ensureUnit(value: ParameterValue, scope: Scope, expected: UnitSpec, what: string): void {
    const resolved = resolveUnitSpec(value, scope, expected);
    if (!resolved.isOk) throw new Error(`"${what}" is not usable: ${resolved.error}`);
}

function ensureAxis(axis: RevolveOp["axis"]): void {
    const finite = (v: { x: number; y: number; z: number } | undefined) =>
        v !== undefined && [v.x, v.y, v.z].every((n) => typeof n === "number" && Number.isFinite(n));
    if (!finite(axis?.point) || !finite(axis?.direction)) {
        throw new Error('"axis" must be { point: {x,y,z}, direction: {x,y,z} } with finite numbers');
    }
    const { x, y, z } = axis.direction;
    if (x === 0 && y === 0 && z === 0) throw new Error('"axis.direction" must be non-zero');
}
