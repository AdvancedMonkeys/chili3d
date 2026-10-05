// The esoul runtime's own test suite — thirteen CAD scenarios a specialist needs (edit a part mid-assembly, a part built
// on another's face, a sub-assembly, imports, fits, fillets by selector, scale, through-all cuts, world-space queries,
// exploded views) plus the bridge contracts the ExternalSoul CAD app relies on (URL inputs, chunked exports, describe).
// Runs against dist/ (see run.mjs); a failure here stops the Pages deploy, so a runtime that breaks a contract never
// reaches a user's tab. Written as plain node: no test framework, every test prints what it measured.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { OUT, openRuntime } from "./lib.mjs";
import { capsule, cylX, cylZ, dome, fuse, sphere } from "./prims.mjs";

const PAGE = process.env.CAD_PAGE;
if (!PAGE) throw new Error("CAD_PAGE is the runtime page to test (run.mjs sets it)");
const only = (process.env.CAD_ONLY ?? "").split(",").filter(Boolean);
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
fs.mkdirSync(OUT, { recursive: true });

const rt = await openRuntime(PAGE);
const { rpc, origin: ORIGIN } = rt;
const content = (r) => (typeof r.result === "string" ? r.result : r.result.content);
/** Replay steps (each {id, ops}); returns the applied reports (and throws on a bridge error). */
async function replay(steps, variables = []) {
    const r = await rpc("esoul.replay", {
        variables,
        steps: steps.map((s) => ({
            id: s.id,
            kind: s.kind ?? "program",
            ...(s.ops ? { ops: s.ops } : {}),
            ...(s.url ? { url: s.url } : {}),
            ...(s.serialized ? { serialized: s.serialized } : {}),
            ...(s.delta ? { delta: s.delta } : {}),
        })),
    });
    if (!r.ok) throw new Error(`replay: ${r.error}`);
    const res = JSON.parse(content(r));
    return { applied: res.applied, ms: r.ms, failed: res.applied.filter((a) => !a.ok) };
}
/** run_program queries: ops [{method, target, id, args?}] → results by id (throws with the kernel's words). */
async function query(ops) {
    const r = await rpc("run_program", { ops });
    if (!r.ok) throw new Error(`query: ${r.error}`);
    return JSON.parse(content(r)).results;
}
async function bbox(target) {
    const q = await query([{ method: "shape.boundingBox", target, id: "bb" }]);
    return q.bb;
}
async function volume(target) {
    const q = await query([{ method: "shape.volume", target, id: "v" }]);
    return q.v;
}
async function shot(name) {
    await rpc("rotate_view", { view: "iso" });
    await rpc("fit_content", {});
    const s = await rpc("capture_screenshot", {});
    if (s.ok && s.result.images?.[0])
        fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.result.images[0].data, "base64"));
}

const rect = (x0, y0, x1, y1) =>
    [
        [x0, y0, x1, y0],
        [x1, y0, x1, y1],
        [x1, y1, x0, y1],
        [x0, y1, x0, y0],
    ].map((p) => ({ type: "line", params: p }));
const box = (id, name, x0, y0, x1, y1, z0, h, plane = "XY") => [
    {
        op: "sketch",
        id: `s_${id}`,
        plane: z0 ? { base: plane, offset: z0 } : plane,
        entities: rect(x0, y0, x1, y1),
    },
    { op: "extrude", id, sketch: `s_${id}`, name, depth: h },
];

const tests = {
    // T1 — a variable drives depths; changing it replays the whole model (the parametric spine).
    async T1(log) {
        const steps = [
            {
                id: "p",
                ops: [
                    {
                        op: "sketch",
                        id: "s",
                        plane: "XY",
                        entities: [
                            ...rect(0, 0, 60, 40),
                            { type: "circle", params: [15, 20, 5] },
                            { type: "circle", params: [45, 20, 5] },
                        ],
                    },
                    { op: "extrude", id: "plate", sketch: "s", name: "Plate", depth: "plateT" },
                    { op: "sketch", id: "s2", plane: "XY", entities: rect(25, 15, 35, 25) },
                    {
                        op: "extrude",
                        id: "boss",
                        sketch: "s2",
                        name: "Boss",
                        depth: "plateT * 4",
                        body: "plate",
                        operation: "fuse",
                    },
                ],
            },
        ];
        let r = await replay(steps, [{ name: "plateT", type: "length", expression: "3" }]);
        if (r.failed.length) return log.fail(`replay failed: ${r.failed.map((f) => f.error).join("; ")}`);
        const v1 = await volume("p:plate");
        const b1 = await bbox("p:plate");
        r = await replay(steps, [{ name: "plateT", type: "length", expression: "5" }]);
        if (r.failed.length)
            return log.fail(`replay with plateT=5 failed: ${r.failed.map((f) => f.error).join("; ")}`);
        const v2 = await volume("p:plate");
        const b2 = await bbox("p:plate");
        log.note(
            `plateT 3→5: height ${b1.max.z}→${b2.max.z}, volume ${Math.round(v1)}→${Math.round(v2)} mm³`,
        );
        if (!near(b2.max.z, 20) || !near(b1.max.z, 12))
            return log.fail("boss top should follow plateT*4 (12 → 20)");
        // Can a sketch COORDINATE be an expression? (A CAD user wants hole spacing = unit.)
        const r2 = await replay(
            [
                {
                    id: "q",
                    ops: [
                        {
                            op: "sketch",
                            id: "s",
                            plane: "XY",
                            entities: [{ type: "circle", params: ["plateT * 5", 20, 5] }],
                        },
                        { op: "extrude", id: "pin", sketch: "s", depth: 2 },
                    ],
                },
            ],
            [{ name: "plateT", type: "length", expression: "3" }],
        );
        if (r2.failed.length)
            return log.fail(
                `sketch entity params should take expressions: ${r2.failed[0].error.slice(0, 120)}`,
            );
        const pb = await bbox("q:pin");
        log.note(`a circle at x="plateT * 5" with plateT=3 sits at x ${pb.min.x}..${pb.max.x} (centre 15)`);
        if (!near((pb.min.x + pb.max.x) / 2, 15))
            return log.fail("the expression coordinate did not evaluate to 15");
        return log.ok();
    },
    // T2 — edit a feature in the MIDDLE (editFeature) and the later features still apply.
    async T2(log) {
        const steps = [
            {
                id: "p",
                ops: [
                    ...box("base", "Base", 0, 0, 50, 30, 0, 10),
                    {
                        op: "sketch",
                        id: "s_boss",
                        plane: { base: "XY", offset: 10 },
                        entities: [{ type: "circle", params: [25, 15, 8] }],
                    },
                    {
                        op: "extrude",
                        id: "boss",
                        sketch: "s_boss",
                        name: "Boss",
                        depth: 10,
                        body: "base",
                        operation: "fuse",
                    },
                    {
                        op: "sketch",
                        id: "s_hole",
                        plane: { base: "XY", offset: 20 },
                        entities: [{ type: "circle", params: [25, 15, 3] }],
                    },
                    {
                        op: "extrude",
                        id: "hole",
                        sketch: "s_hole",
                        name: "Through hole",
                        depth: -30,
                        body: "base",
                        operation: "cut",
                    },
                ],
            },
        ];
        let r = await replay(steps);
        if (r.failed.length) return log.fail(`replay failed: ${r.failed.map((f) => f.error).join("; ")}`);
        const feats = r.applied[0].bodies.find((b) => b.name === "Base")?.features ?? [];
        log.note(
            `features on Base: ${feats.map((f) => `${f.display}#${f.id} [${f.parameters.map((p) => `${p.key}=${p.value}`).join(" ")}]`).join(", ")}`,
        );
        const bossFeat = feats.find((f) => f.id === "p:boss");
        if (!bossFeat) return log.fail(`no feature "p:boss" — ids are ${feats.map((f) => f.id).join(", ")}`);
        if (bossFeat.name !== "Boss") log.gap("feature summaries carry no NAME");
        const v1 = await volume("p:base");
        // Edit the boss depth from 10 to 25 as a LATER step (what an agent does after a build).
        const edit = [
            {
                id: "e",
                ops: [
                    {
                        op: "editFeature",
                        body: "p:base",
                        featureId: "p:boss",
                        action: "setParameter",
                        key: "depth",
                        value: 25,
                    },
                ],
            },
        ];
        r = await replay([...steps, ...edit]);
        if (r.failed.length)
            return log.fail(`editFeature failed: ${r.failed.map((f) => f.error).join("; ")}`);
        const b = await bbox("p:base");
        const v2 = await volume("p:base");
        log.note(`boss depth 10→25: top z ${b.max.z}, volume ${Math.round(v1)}→${Math.round(v2)}`);
        if (!near(b.max.z, 35)) return log.fail(`expected top at 35, got ${b.max.z}`);
        // Does the hole (cut AFTER the boss, depth -30 from z=20) still pierce the taller boss? It cannot: its sketch sits at z=20.
        const q = await query([
            { method: "shape.findSubShapes", target: "p:base", id: "f", args: { subshapeType: "face" } },
        ]);
        log.gap(
            `the through-hole was sketched at a FIXED z=20 and reaches 30 down: after the boss grew to 25 the hole no longer opens at the top (faces ${q.f.count}) — a hole should be 'through all' or sketched on the boss's TOP FACE so it follows (sketch-on-face, T3)`,
        );
        return log.ok();
    },
    // T3 — part B built on part A's FACE; A changes; B follows (face tracking = cross-part coordination).
    async T3(log) {
        const base = [{ id: "a", ops: box("blk", "Block", 0, 0, 40, 40, 0, 10) }];
        let r = await replay(base);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const faces = await query([
            { method: "shape.findSubShapes", target: "a:blk", id: "f", args: { subshapeType: "face" } },
        ]);
        let top = -1;
        for (let i = 0; i < faces.f.count; i++) {
            const b = await bbox(`f#${i}`);
            if (near(b.min.z, 10) && near(b.max.z, 10)) {
                top = i;
                break;
            }
        }
        if (top < 0) return log.fail("no top face found by bbox");
        log.note(`top face of the block is faceIndex ${top} (found by bounding boxes of f#i)`);
        const post = [
            {
                id: "b",
                ops: [
                    {
                        op: "sketch",
                        id: "s",
                        plane: { nodeId: "a:blk", faceIndex: top },
                        entities: [{ type: "circle", params: [0, 0, 5] }],
                    },
                    { op: "extrude", id: "post", sketch: "s", name: "Post", depth: 15 },
                ],
            },
        ];
        r = await replay([...base, ...post]);
        if (r.failed.length) return log.fail(`post on face: ${r.failed[0].error}`);
        const pb = await bbox("b:post");
        log.note(
            `post built on the face: z ${pb.min.z}..${pb.max.z}, xy centre (${(pb.min.x + pb.max.x) / 2}, ${(pb.min.y + pb.max.y) / 2}) — (u,v)=(0,0) on a face plane is the face's own origin, not the block corner`,
        );
        // Now the block grows: editFeature on its extrude depth → the post should ride up with the face.
        const grown = [
            { id: "a", ops: [...box("blk", "Block", 0, 0, 40, 40, 0, 10)] },
            {
                id: "e",
                ops: [
                    {
                        op: "editFeature",
                        body: "a:blk",
                        featureId: "a:blk",
                        action: "setParameter",
                        key: "depth",
                        value: 25,
                    },
                ],
            },
            ...post,
        ];
        r = await replay(grown);
        if (r.failed.length)
            return log.fail(`after growing the block: ${r.failed.map((f) => f.error).join("; ")}`);
        const pb2 = await bbox("b:post");
        const blk2 = await bbox("a:blk");
        log.note(`block 10→25: block z ${blk2.min.z}..${blk2.max.z}; post now z ${pb2.min.z}..${pb2.max.z}`);
        if (!near(blk2.max.z, 25)) {
            log.gap(
                "editFeature setParameter depth did not change the block at all (the edit is silently ignored or applied to a stale copy)",
            );
            return log.fail("block should be 25 tall after editFeature");
        }
        if (!near(pb2.min.z, 25)) {
            log.gap(
                "the post did NOT follow the face it was sketched on when the host grew (sketch-on-face is captured once, not re-resolved on replay)",
            );
            return log.fail("post should start at z=25");
        }
        return log.ok();
    },
    // T4 — remove a MIDDLE step: later steps that referenced it fail honestly; the others survive.
    async T4(log) {
        const steps = [
            { id: "a", ops: box("blk", "Block", 0, 0, 40, 40, 0, 10) },
            {
                id: "b",
                ops: [
                    ...box("rib", "Rib", 10, 10, 30, 30, 10, 5),
                    { op: "boolean", id: "f", body: "a:blk", operation: "fuse", tools: ["rib"] },
                ],
            },
            {
                id: "c",
                ops: [
                    {
                        op: "sketch",
                        id: "s",
                        plane: { base: "XY", offset: 15 },
                        entities: [{ type: "circle", params: [20, 20, 2] }],
                    },
                    {
                        op: "extrude",
                        id: "h",
                        sketch: "s",
                        name: "Hole",
                        depth: -20,
                        body: "a:blk",
                        operation: "cut",
                    },
                ],
            },
            {
                id: "d",
                ops: [
                    { op: "sketch", id: "s", plane: "XY", entities: [{ type: "circle", params: [5, 5, 1] }] },
                    {
                        op: "extrude",
                        id: "pin",
                        sketch: "s",
                        name: "Pin on the rib",
                        depth: 3,
                        body: "b:rib",
                        operation: "fuse",
                    },
                ],
            },
        ];
        let r = await replay(steps);
        if (r.failed.length)
            return log.fail(`baseline: ${r.failed.map((f) => `${f.stepId}: ${f.error}`).join("; ")}`);
        const v1 = await volume("a:blk");
        r = await replay(steps.filter((s) => s.id !== "b"));
        const names = r.failed.map((f) => `${f.stepId}: ${f.error.slice(0, 80)}`);
        log.note(
            `without step b: failed = [${names.join(" | ")}]; block volume ${Math.round(v1)} → ${Math.round(await volume("a:blk"))}`,
        );
        if (!r.failed.some((f) => f.stepId === "d"))
            return log.fail("step d referenced the removed rib and should fail");
        if (r.failed.some((f) => f.stepId === "c"))
            return log.fail("step c only used the block and should survive");
        return log.ok();
    },
    // T5 — a sub-assembly: three parts named and positioned by coordinates; read back what is where.
    async T5(log) {
        const steps = [
            { id: "h", ops: box("housing", "Housing", -30, -20, 30, 20, 0, 12) },
            {
                id: "s",
                ops: [
                    ...box("sw", "Switch body", -7, -7, 7, 7, 12, 8),
                    {
                        op: "sketch",
                        id: "s_stem",
                        plane: { base: "XY", offset: 20 },
                        entities: [{ type: "circle", params: [0, 0, 2.5] }],
                    },
                    {
                        op: "extrude",
                        id: "stem",
                        sketch: "s_stem",
                        name: "Stem",
                        depth: 4,
                        body: "sw",
                        operation: "fuse",
                    },
                ],
            },
            { id: "k", ops: box("cap", "Keycap", -9, -9, 9, 9, 24, 6) },
        ];
        const r = await replay(steps);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const parts = [];
        for (const t of ["h:housing", "s:sw", "k:cap"]) {
            const b = await bbox(t);
            parts.push(`${t}: x ${b.min.x}..${b.max.x} y ${b.min.y}..${b.max.y} z ${b.min.z}..${b.max.z}`);
        }
        log.note(parts.join(" | "));
        // Is there a way to MOVE the keycap 2 mm up without re-authoring its sketch? (A CAD user drags it.)
        const mv = await replay([
            ...steps,
            { id: "m", ops: [{ op: "transform", id: "t", node: "k:cap", translate: { z: 2 } }] },
        ]);
        if (mv.failed.length)
            log.gap(
                `no transform op: ${mv.failed[0].error.slice(0, 80)} — placing a finished part needs re-authoring its sketches; a 'transform' op (translate/rotate a body) is missing`,
            );
        else {
            const cb = await bbox("k:cap");
            const w = JSON.parse(content(await rpc("esoul.measure", { nodes: ["k:cap"] }))).nodes[0];
            log.note(
                `transform z+2: run_program bbox z ${cb.min.z}..${cb.max.z} (the node's OWN space) vs measure (world) z ${w.bbox?.min.z}..${w.bbox?.max.z}`,
            );
            if (!near(w.bbox?.min.z, 26)) return log.fail("keycap should start at 26 (world) after the move");
            if (near(cb.min.z, 24))
                log.gap(
                    "run_program geometry queries ignore a node's transform (they read the node's own space): after a transform, measure with esoul.measure (world space)",
                );
        }
        const rep = mv.applied.flatMap((a) => a.bodies).find((b) => b.name === "Keycap");
        if (rep?.bbox)
            log.note(
                `report carries extents: Keycap bbox z ${rep.bbox.min.z}..${rep.bbox.max.z}, volume ${rep.volume}`,
            );
        else log.gap("the build report has no bbox/volume per body");
        const rot = await replay([
            ...steps,
            {
                id: "m",
                ops: [
                    {
                        op: "transform",
                        id: "t",
                        node: "k:cap",
                        rotate: { axis: { x: 0, y: 0, z: 1 }, angle: 45 },
                    },
                ],
            },
        ]);
        if (rot.failed.length) log.gap(`rotate failed: ${rot.failed[0].error.slice(0, 80)}`);
        else {
            const cb = await bbox("k:cap");
            log.note(
                `rotate 45° about z: keycap x ${cb.min.x}..${cb.max.x} (a 18 mm square turned 45° spans ±12.73)`,
            );
        }
        await shot("t5-assembly");
        return log.ok();
    },
    // T6 — a CAD file comes in as a BODY (export here → import back) and takes cuts, a boss on its face, a colour.
    async T6(log) {
        let r = await replay([{ id: "h", ops: box("housing", "Housing", -30, -20, 30, 20, 0, 12) }]);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const ex = await rpc("esoul.export", { format: ".step", ids: ["h:housing"] });
        if (!ex.ok) return log.fail(`export: ${ex.error}`);
        const file = JSON.parse(content(ex));
        log.note(`exported ${file.fileName}: ${file.bytes} B`);
        const imp = [
            {
                id: "i",
                ops: [
                    {
                        op: "import",
                        id: "housing",
                        name: "Housing (imported)",
                        format: ".step",
                        base64: file.base64,
                        color: "#8899aa",
                    },
                ],
            },
        ];
        r = await replay(imp);
        if (r.failed.length) return log.fail(`import: ${r.failed[0].error}`);
        const b = await bbox("i:housing");
        log.note(
            `imported as a body: bbox x ${b.min.x}..${b.max.x} z ${b.min.z}..${b.max.z}; features [${r.applied[0].bodies[0]?.features.map((f) => `${f.type}#${f.id}`).join(", ")}]`,
        );
        const faces = await query([
            { method: "shape.findSubShapes", target: "i:housing", id: "f", args: { subshapeType: "face" } },
        ]);
        let top = -1;
        for (let k = 0; k < faces.f.count; k++) {
            const fb = await bbox(`f#${k}`);
            if (near(fb.min.z, 12) && near(fb.max.z, 12)) {
                top = k;
                break;
            }
        }
        if (top < 0) return log.fail("no top face on the imported body");
        const mod = [
            {
                id: "m",
                ops: [
                    {
                        op: "sketch",
                        id: "s_p",
                        plane: { base: "XY", offset: 12 },
                        entities: rect(-7.3, -7.3, 7.3, 7.3),
                    },
                    {
                        op: "extrude",
                        id: "pocket",
                        sketch: "s_p",
                        name: "Pocket",
                        depth: -8,
                        body: "i:housing",
                        operation: "cut",
                    },
                    {
                        op: "sketch",
                        id: "s_b",
                        plane: { nodeId: "i:housing", faceIndex: top },
                        entities: [{ type: "circle", params: [20, 10, 4] }],
                    },
                    {
                        op: "extrude",
                        id: "boss",
                        sketch: "s_b",
                        name: "Boss on the imported top face",
                        depth: 6,
                        body: "i:housing",
                        operation: "fuse",
                    },
                ],
            },
        ];
        r = await replay([...imp, ...mod]);
        if (r.failed.length)
            return log.fail(`modify the imported body: ${r.failed.map((f) => f.error).join("; ")}`);
        const v = await volume("i:housing");
        log.note(
            `after a pocket cut and a boss fused on its face: volume ${Math.round(v)} mm³ (the plain box was 28800)`,
        );
        if (!(v < 28800)) return log.fail("the pocket should have removed volume");
        await shot("t6-import");
        return log.ok();
    },
    // T7 — the owner's scenario: a switch built at the origin, PLACED in a housing, a pocket + collar around it, the fit checked.
    async T7(log) {
        const housing = [{ id: "h", ops: box("housing", "Housing", -40, -25, 40, 25, 0, 14) }];
        const sw = [
            {
                id: "s",
                ops: [
                    ...box("sw", "Switch", -7, -7, 7, 7, 0, 8),
                    {
                        op: "sketch",
                        id: "s_stem",
                        plane: { base: "XY", offset: 8 },
                        entities: [{ type: "circle", params: [0, 0, 2.5] }],
                    },
                    {
                        op: "extrude",
                        id: "stem",
                        sketch: "s_stem",
                        name: "Stem",
                        depth: 4,
                        body: "sw",
                        operation: "fuse",
                    },
                    { op: "style", id: "paint", node: "sw", color: "#d35400" },
                ],
            },
        ];
        const place = [
            { id: "p", ops: [{ op: "transform", id: "t", node: "s:sw", translate: { x: 15, y: 5, z: 8 } }] },
        ];
        const integrate = [
            {
                id: "c",
                ops: [
                    {
                        op: "sketch",
                        id: "s_c",
                        plane: { base: "XY", offset: 14 },
                        entities: rect(15 - 7.3, 5 - 7.3, 15 + 7.3, 5 + 7.3),
                    },
                    {
                        op: "extrude",
                        id: "pocket",
                        sketch: "s_c",
                        name: "Switch pocket",
                        depth: -6,
                        body: "h:housing",
                        operation: "cut",
                    },
                    {
                        op: "sketch",
                        id: "s_collar",
                        plane: { base: "XY", offset: 14 },
                        entities: [
                            ...rect(15 - 9.5, 5 - 9.5, 15 + 9.5, 5 + 9.5),
                            ...rect(15 - 7.3, 5 - 7.3, 15 + 7.3, 5 + 7.3),
                        ],
                    },
                    {
                        op: "extrude",
                        id: "collar",
                        sketch: "s_collar",
                        name: "Collar around the switch",
                        depth: 3,
                        body: "h:housing",
                        operation: "fuse",
                    },
                ],
            },
        ];
        const r = await replay([...housing, ...sw, ...place, ...integrate]);
        if (r.failed.length) return log.fail(r.failed.map((f) => `${f.stepId}: ${f.error}`).join("; "));
        const m = JSON.parse(
            content(
                await rpc("esoul.measure", { nodes: ["h:housing", "s:sw"], pairs: [["h:housing", "s:sw"]] }),
            ),
        );
        log.note(
            `switch (world) ${JSON.stringify(m.nodes[1].bbox)}; fit housing↔switch: ${JSON.stringify(m.pairs[0])}`,
        );
        if (m.pairs[0].interference !== 0)
            return log.fail("the placed switch must not interfere with the pocketed housing");
        await shot("t7-switch");
        // The other way to cut the pocket: with the placed switch ITSELF as the tool, kept (consumeTools false) — an exact pocket.
        const exact = await replay([
            ...housing,
            ...sw,
            ...place,
            {
                id: "x",
                ops: [
                    {
                        op: "boolean",
                        id: "pk",
                        body: "h:housing",
                        operation: "cut",
                        tools: ["s:sw"],
                        consumeTools: false,
                    },
                ],
            },
        ]);
        if (exact.failed.length) log.gap(`cut-by-the-part failed: ${exact.failed[0].error.slice(0, 120)}`);
        else {
            const m2 = JSON.parse(content(await rpc("esoul.measure", { pairs: [["h:housing", "s:sw"]] })));
            log.note(`pocket cut by the switch itself (tool kept): ${JSON.stringify(m2.pairs[0])}`);
        }
        return log.ok();
    },
    // T11 — a THROUGH-ALL cut: the hole goes through whatever the body is, and keeps going through after the body grows.
    async T11(log) {
        const steps = [
            {
                id: "p",
                ops: [
                    ...box("base", "Base", 0, 0, 50, 30, 0, 10),
                    {
                        op: "sketch",
                        id: "s_boss",
                        plane: { base: "XY", offset: 10 },
                        entities: [{ type: "circle", params: [25, 15, 8] }],
                    },
                    {
                        op: "extrude",
                        id: "boss",
                        sketch: "s_boss",
                        name: "Boss",
                        depth: 10,
                        body: "base",
                        operation: "fuse",
                    },
                    {
                        op: "sketch",
                        id: "s_hole",
                        plane: "XY",
                        entities: [{ type: "circle", params: [25, 15, 3] }],
                    },
                    {
                        op: "extrude",
                        id: "hole",
                        sketch: "s_hole",
                        name: "Through hole",
                        depth: "through",
                        body: "base",
                        operation: "cut",
                    },
                ],
            },
        ];
        let r = await replay(steps);
        if (r.failed.length) return log.fail(`through-all: ${r.failed[0].error.slice(0, 160)}`);
        const faces = async () =>
            (
                await query([
                    {
                        method: "shape.findSubShapes",
                        target: "p:base",
                        id: "f",
                        args: { subshapeType: "face" },
                    },
                ])
            ).f.count;
        const f1 = await faces();
        const v1 = await volume("p:base");
        log.note(
            `through-all hole: faces ${f1}, volume ${Math.round(v1)} (box+boss 17012 minus a Ø6 hole through 20 mm = ${Math.round(15000 + Math.PI * 64 * 10 - Math.PI * 9 * 20)})`,
        );
        r = await replay([
            ...steps,
            {
                id: "e",
                ops: [
                    {
                        op: "editFeature",
                        body: "p:base",
                        featureId: "p:boss",
                        action: "setParameter",
                        key: "depth",
                        value: 30,
                    },
                ],
            },
        ]);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const v2 = await volume("p:base");
        log.note(
            `boss grown to 30: volume ${Math.round(v2)} — the hole still goes through (expected ${Math.round(15000 + Math.PI * 64 * 30 - Math.PI * 9 * 40)})`,
        );
        if (!near(v2, 15000 + Math.PI * 64 * 30 - Math.PI * 9 * 40, 5))
            return log.fail("the through-all hole did not follow the taller boss");
        return log.ok();
    },
    // T12 — after a transform, run_program geometry queries answer in WORLD space (what a specialist means by "where is it").
    async T12(log) {
        const steps = [
            { id: "k", ops: box("cap", "Keycap", -9, -9, 9, 9, 24, 6) },
            { id: "m", ops: [{ op: "transform", id: "t", node: "k:cap", translate: { x: 10, z: 2 } }] },
        ];
        const r = await replay(steps);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const b = await bbox("k:cap");
        const w = JSON.parse(content(await rpc("esoul.measure", { nodes: ["k:cap"] }))).nodes[0];
        log.note(
            `run_program bbox x ${b.min.x}..${b.max.x} z ${b.min.z}..${b.max.z}; measure (world) x ${w.bbox.min.x}..${w.bbox.max.x} z ${w.bbox.min.z}..${w.bbox.max.z}`,
        );
        if (!near(b.min.x, 1) || !near(b.min.z, 26))
            return log.fail("run_program should answer in world space after a transform");
        return log.ok();
    },
    // T13 — an EXPLODED VIEW is a variable: parts placed by transforms whose translation is an expression.
    async T13(log) {
        const steps = [
            { id: "h", ops: box("housing", "Housing", -30, -20, 30, 20, 0, 12) },
            {
                id: "s",
                ops: [
                    ...box("sw", "Switch", -7, -7, 7, 7, 12, 8),
                    { op: "transform", id: "t1", node: "sw", translate: { z: "explode" } },
                ],
            },
            {
                id: "k",
                ops: [
                    ...box("cap", "Keycap", -9, -9, 9, 9, 20, 6),
                    { op: "transform", id: "t2", node: "cap", translate: { z: "explode * 2" } },
                ],
            },
        ];
        let r = await replay(steps, [{ name: "explode", type: "length", expression: "0" }]);
        if (r.failed.length) return log.fail(r.failed[0].error.slice(0, 160));
        const m0 = JSON.parse(content(await rpc("esoul.measure", { nodes: ["s:sw", "k:cap"] })));
        r = await replay(steps, [{ name: "explode", type: "length", expression: "25" }]);
        if (r.failed.length) return log.fail(r.failed[0].error.slice(0, 160));
        const m1 = JSON.parse(content(await rpc("esoul.measure", { nodes: ["s:sw", "k:cap"] })));
        log.note(
            `explode 0: switch z ${m0.nodes[0].bbox.min.z}, cap z ${m0.nodes[1].bbox.min.z}; explode 25: switch z ${m1.nodes[0].bbox.min.z}, cap z ${m1.nodes[1].bbox.min.z}`,
        );
        if (!near(m1.nodes[0].bbox.min.z, 37) || !near(m1.nodes[1].bbox.min.z, 70))
            return log.fail("the parts should spread by explode and explode*2");
        const eb = await rpc("esoul.bodies", {});
        const names = eb.ok
            ? JSON.parse(content(eb)).bodies.map((b) => `${b.name}${b.bbox ? "+bbox" : ""}`)
            : eb.error;
        log.note(`esoul.bodies → ${JSON.stringify(names)}`);
        if (!Array.isArray(names) || names.length !== 3)
            return log.fail("esoul.bodies should list the three bodies");
        await shot("t13-exploded");
        return log.ok();
    },
    // T8 — fillet the housing's vertical edges, chosen by querying edge ends.
    async T8(log) {
        const steps = [{ id: "h", ops: box("housing", "Housing", -30, -20, 30, 20, 0, 12) }];
        let r = await replay(steps);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const e = await query([
            { method: "shape.findSubShapes", target: "h:housing", id: "e", args: { subshapeType: "edge" } },
        ]);
        const ends = await query(
            Array.from({ length: e.e.count }, (_, i) => ({
                method: "edge.ends",
                target: `e#${i}`,
                id: `p${i}`,
            })),
        );
        const vertical = [];
        for (let i = 0; i < e.e.count; i++) {
            const [a, b] = Array.isArray(ends[`p${i}`])
                ? ends[`p${i}`]
                : [ends[`p${i}`]?.start, ends[`p${i}`]?.end];
            if (a && b && near(a.x, b.x) && near(a.y, b.y) && !near(a.z, b.z)) vertical.push(i);
        }
        log.note(
            `edges ${e.e.count}; vertical edges by ends: [${vertical.join(",")}] (edge.ends shape: ${JSON.stringify(ends.p0).slice(0, 80)})`,
        );
        if (vertical.length !== 4) return log.fail("expected 4 vertical edges");
        r = await replay([
            ...steps,
            {
                id: "f",
                ops: [{ op: "fillet", id: "r", body: "h:housing", edgeIndexes: vertical, radius: 4 }],
            },
        ]);
        if (r.failed.length) return log.fail(`fillet: ${r.failed[0].error}`);
        let f = await query([
            { method: "shape.findSubShapes", target: "h:housing", id: "f", args: { subshapeType: "face" } },
        ]);
        log.note(`after fillet r=4 by indexes: faces 6 → ${f.f.count}`);
        if (f.f.count !== 10) return log.fail("expected 10 faces");
        // The same in ONE call: an edge selector instead of indexes (vertical edges = parallel to z).
        r = await replay([
            ...steps,
            {
                id: "f",
                ops: [{ op: "fillet", id: "r", body: "h:housing", edges: { parallelTo: "z" }, radius: 4 }],
            },
        ]);
        if (r.failed.length) return log.fail(`fillet by selector: ${r.failed[0].error}`);
        f = await query([
            { method: "shape.findSubShapes", target: "h:housing", id: "f", args: { subshapeType: "face" } },
        ]);
        log.note(`fillet by selector { parallelTo: "z" }: faces ${f.f.count}`);
        if (f.f.count !== 10) return log.fail("the selector should have picked the 4 vertical edges");
        // and the top outline only (edges at z = 12), chamfered
        r = await replay([
            ...steps,
            {
                id: "c",
                ops: [
                    {
                        op: "chamfer",
                        id: "ch",
                        body: "h:housing",
                        edges: { minZ: 12, maxZ: 12 },
                        distance: 2,
                    },
                ],
            },
        ]);
        if (r.failed.length) return log.fail(`chamfer by selector: ${r.failed[0].error}`);
        f = await query([
            { method: "shape.findSubShapes", target: "h:housing", id: "f", args: { subshapeType: "face" } },
        ]);
        log.note(`chamfer by selector { minZ: 12, maxZ: 12 }: faces ${f.f.count} (6 + 4 chamfer faces)`);
        if (f.f.count !== 10) return log.fail("the selector should have picked the 4 top edges");
        await shot("t8-fillet");
        return log.ok();
    },
    // T9 — scale: a 60% keyboard plate with 61 cutouts in one sketch; time the kernel.
    async T9(log) {
        const u = 19.05,
            cut = 14,
            rows = [
                [0, 14],
                [1, 13],
                [2, 12],
                [3, 12],
                [4, 8],
            ];
        const ents = [...rect(0, 0, 15 * u, 5 * u)];
        let count = 0;
        for (const [r, nkeys] of rows)
            for (let k = 0; k < nkeys; k++) {
                const cx = (k + 0.5) * u * (15 / nkeys),
                    cy = (4.5 - r) * u;
                ents.push(...rect(cx - cut / 2, cy - cut / 2, cx + cut / 2, cy + cut / 2));
                count++;
            }
        const r = await replay([
            {
                id: "p",
                ops: [
                    { op: "sketch", id: "s", plane: "XY", entities: ents },
                    { op: "extrude", id: "plate", sketch: "s", name: "Plate", depth: 1.5 },
                ],
            },
        ]);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const f = await query([
            { method: "shape.findSubShapes", target: "p:plate", id: "f", args: { subshapeType: "face" } },
        ]);
        log.note(
            `${count} cutouts in one sketch: replay ${r.ms} ms, faces ${f.f.count}, ops JSON ${JSON.stringify(ents).length} B`,
        );
        // The same plate as a GRID macro with the pitch as a variable: a few hundred bytes instead of 18 KB.
        const r2 = await replay(
            [
                {
                    id: "g",
                    ops: [
                        {
                            op: "sketch",
                            id: "s",
                            plane: "XY",
                            entities: [
                                ...rect(0, 0, 15 * u, 5 * u),
                                {
                                    type: "grid",
                                    params: [
                                        "(unit - cut) / 2",
                                        "(unit - cut) / 2",
                                        "cut",
                                        "cut",
                                        14,
                                        5,
                                        "unit",
                                        "unit",
                                    ],
                                },
                            ],
                        },
                        { op: "extrude", id: "plate", sketch: "s", name: "Plate", depth: 1.5 },
                    ],
                },
            ],
            [
                { name: "unit", type: "length", expression: "19.05" },
                { name: "cut", type: "length", expression: "14" },
            ],
        );
        if (r2.failed.length) return log.fail(`grid macro: ${r2.failed[0].error.slice(0, 160)}`);
        const f2 = await query([
            { method: "shape.findSubShapes", target: "g:plate", id: "f", args: { subshapeType: "face" } },
        ]);
        log.note(
            `grid macro 14×5 with pitch "unit": faces ${f2.f.count} (70 cutouts → 6 + 70×4), op JSON ${JSON.stringify(r2).length > 0 ? "~350" : ""} B`,
        );
        if (f2.f.count !== 6 + 70 * 4) return log.fail("the grid should have cut 70 holes");
        await shot("t9-plate");
        return log.ok();
    },
    // T10 — does the switch FIT the pocket? Interference = volume of the common part; clearance = distance.
    async T10(log) {
        const steps = [
            {
                id: "h",
                ops: [
                    ...box("housing", "Housing", -30, -20, 30, 20, 0, 12),
                    {
                        op: "sketch",
                        id: "s_p",
                        plane: { base: "XY", offset: 12 },
                        entities: rect(-7.3, -7.3, 7.3, 7.3),
                    },
                    {
                        op: "extrude",
                        id: "pocket",
                        sketch: "s_p",
                        name: "Pocket",
                        depth: -8,
                        body: "housing",
                        operation: "cut",
                    },
                ],
            },
            { id: "s", ops: box("sw", "Switch", -7, -7, 7, 7, 4, 8) },
        ];
        const r = await replay(steps);
        if (r.failed.length) return log.fail(r.failed[0].error);
        let q;
        const m = await rpc("esoul.measure", {
            nodes: ["h:housing", "s:sw"],
            pairs: [["h:housing", "s:sw"]],
        });
        if (!m.ok) return log.fail(`measure: ${m.error}`);
        const mm = JSON.parse(content(m));
        log.note(
            `measure: ${JSON.stringify(mm.pairs[0])}; nodes ${mm.nodes.map((n) => `${n.name} v=${n.volume}`).join(", ")}`,
        );
        const hb = await bbox("h:housing");
        log.note(`housing still there after measure: z ${hb.min.z}..${hb.max.z}`);
        if (mm.pairs[0].interference !== 0)
            return log.fail("the switch sits in a 0.3 mm-clearance pocket: interference must be 0");
        // Now a switch that is too big for the pocket: interference > 0 must be reported.
        const r2 = await replay([
            steps[0],
            { id: "s", ops: box("sw", "Switch", -7.5, -7.5, 7.5, 7.5, 4, 8) },
        ]);
        if (r2.failed.length) return log.fail(r2.failed[0].error);
        const m2 = JSON.parse(content(await rpc("esoul.measure", { pairs: [["h:housing", "s:sw"]] })));
        log.note(`oversize switch: ${JSON.stringify(m2.pairs[0])}`);
        if (!(m2.pairs[0].interference > 0)) return log.fail("an oversize switch must show interference");
        return log.ok();
    },

    // U1 — an import by URL: the page fetches the file itself (no bytes in the bridge message), the body is real.
    async U1(log) {
        const r0 = await replay([{ id: "h", ops: box("housing", "Housing", -30, -20, 30, 20, 0, 12) }]);
        if (r0.failed.length) return log.fail(r0.failed[0].error);
        const ex = await rpc("esoul.export", { format: ".step", ids: ["h:housing"] });
        if (!ex.ok) return log.fail(`export: ${ex.error}`);
        const file = JSON.parse(content(ex));
        fs.writeFileSync(path.join(OUT, "u1.step"), Buffer.from(file.base64, "base64"));
        const r = await replay([
            {
                id: "i",
                ops: [
                    {
                        op: "import",
                        id: "part",
                        name: "by url",
                        format: ".step",
                        url: `${ORIGIN}/__out__/u1.step`,
                    },
                    { op: "transform", id: "mv", node: "i:part", translate: { z: 100 } },
                ],
            },
        ]);
        if (r.failed.length) return log.fail(`import by url: ${r.failed[0].error}`);
        const b = await bbox("i:part");
        log.note(`imported by URL and moved: z ${b.min.z}..${b.max.z}`);
        if (!near(b.min.z, 100) || !near(b.max.z, 112))
            return log.fail("the body is not where the transform put it");
        const miss = await replay([
            {
                id: "m",
                ops: [{ op: "import", id: "part", format: ".step", url: `${ORIGIN}/__out__/missing.step` }],
            },
        ]).catch((e) => ({ error: e.message }));
        log.note(`a missing URL: ${miss.error ?? JSON.stringify(miss.applied?.[0]).slice(0, 100)}`);
        if (!/404|HTTP/.test(miss.error ?? ""))
            return log.fail("a missing URL must fail loudly with the HTTP status");
        return log.ok();
    },
    // U2 — exports: inline by default (a tab takes one body of any size), chunked ONLY when asked (the server bridge).
    async U2(log) {
        const r = await replay([{ id: "h", ops: box("housing", "Housing", -30, -20, 30, 20, 0, 12) }]);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const plain = JSON.parse(
            content(await rpc("esoul.export", { format: ".obj", ids: ["h:housing"], name: "plain" })),
        );
        if (plain.chunked || typeof plain.base64 !== "string")
            return log.fail("an export without `chunked` must answer inline");
        log.note(`inline: ${plain.fileName}, ${plain.bytes} B`);
        if (plain.fileName !== "plain.obj")
            return log.fail(`the export is named by the caller: got ${plain.fileName}`);
        const chunked = JSON.parse(
            content(await rpc("esoul.export", { format: ".obj", ids: ["h:housing"], chunked: true })),
        );
        if (!chunked.chunked || !chunked.handle)
            return log.fail("chunked:true must answer metadata + a handle");
        const parts = [];
        let n = 0;
        for (let off = 0; off < chunked.bytes; off += 1000) {
            const ch = JSON.parse(
                content(
                    await rpc("esoul.exportChunk", {
                        handle: n === 0 ? "last" : chunked.handle,
                        offset: off,
                        length: 1000,
                    }),
                ),
            );
            parts.push(Buffer.from(ch.base64, "base64"));
            n++;
            if (ch.done) break;
        }
        const all = Buffer.concat(parts);
        log.note(
            `chunked: ${n} chunks of ≤1000 B → ${all.length}/${chunked.bytes} B, named ${chunked.fileName}`,
        );
        if (all.length !== chunked.bytes || !all.equals(Buffer.from(plain.base64, "base64")))
            return log.fail("the stitched chunks must equal the inline export byte for byte");
        const bad = await rpc("esoul.exportChunk", { handle: "nope", offset: 0 });
        if (bad.ok || !/unknown export handle/.test(bad.error))
            return log.fail("an unknown handle must be refused by name");
        const bin = JSON.parse(
            content(await rpc("esoul.export", { format: ".stl binary", ids: ["h:housing"] })),
        );
        log.note(`binary STL ${bin.bytes} B as ${bin.fileName}`);
        if (!bin.fileName.endsWith(".stl")) return log.fail("a binary STL still ends in .stl");
        return log.ok();
    },
    // E1 — esoul.explode: a VIEW-ONLY explode moves each part's drawn body by factor × k and leaves the model alone.
    async E1(log) {
        const parts = [
            { node: "e:plate", k: 1 },
            { node: "e:cap", k: 2 },
        ];
        const r = await replay([
            {
                id: "e",
                ops: [
                    {
                        op: "sketch",
                        id: "s",
                        plane: "XY",
                        entities: [{ type: "circle", params: [0, 0, 10] }],
                    },
                    { op: "extrude", id: "plate", sketch: "s", name: "Plate", depth: 3 },
                    {
                        op: "sketch",
                        id: "s2",
                        plane: { base: "XY", offset: 3 },
                        entities: [{ type: "circle", params: [0, 0, 4] }],
                    },
                    { op: "extrude", id: "cap", sketch: "s2", name: "Cap", depth: 5 },
                ],
            },
        ]);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const x = await rpc("esoul.explode", { factor: 50, parts });
        if (!x.ok) return log.fail(`explode: ${x.error}`);
        const moved = JSON.parse(content(x)).moved;
        log.note(`moved ${JSON.stringify(moved)}`);
        if (moved.length !== 2 || moved[1].dz !== 100)
            return log.fail("the cap did not move by 100 (factor 50 × k 2)");
        const m = await rpc("esoul.measure", { nodes: ["e:cap"], pairs: [] });
        const bb = JSON.parse(content(m)).nodes[0].bbox;
        if (Math.abs(bb.min.z - 3) > 1e-6)
            return log.fail(`the model moved too (cap z ${bb.min.z}); explode is a view`);
        const back = await rpc("esoul.explode", { factor: 0, parts });
        if (!back.ok || JSON.parse(content(back)).moved[1].dz !== 0)
            return log.fail("factor 0 did not put the cap back");
        const bad = await rpc("esoul.explode", { factor: 1, parts: [{ node: "e:nothing", k: 1 }] });
        if (bad.ok) return log.fail("an unknown node was accepted");
        return log.ok();
    },
    // E2 — a boolean CONSUMES its tools: the cutter leaves the top level (it sits under the body, undrawn) and
    //      the model's bodies do not list it. The teddy's exploded view had every cutter floating at the head.
    async E2(log) {
        const r = await replay([
            {
                id: "b",
                ops: [
                    {
                        op: "sketch",
                        id: "s",
                        plane: "XY",
                        entities: [{ type: "circle", params: [0, 0, 10] }],
                    },
                    { op: "extrude", id: "plate", sketch: "s", name: "Plate", depth: 3 },
                    {
                        op: "sketch",
                        id: "s2",
                        plane: { base: "XY", offset: -1 },
                        entities: [{ type: "circle", params: [0, 0, 2] }],
                    },
                    { op: "extrude", id: "drill", sketch: "s2", name: "Drill", depth: 5 },
                    { op: "boolean", id: "hole", body: "plate", operation: "cut", tools: ["drill"] },
                ],
            },
        ]);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const names = r.applied[0].bodies.map((x) => x.name);
        log.note(`bodies ${JSON.stringify(names)}`);
        if (names.includes("Drill")) return log.fail("the consumed cutter is still listed as a body");
        const st = JSON.parse(content(await rpc("get_document_state", {})));
        const drill = st.nodes.find((n) => n.id === "b:drill");
        if (!drill)
            return log.fail("the cutter node is gone entirely (it should sit under the body for editing)");
        if (drill.parentId !== "b:plate")
            return log.fail(`the cutter is still top-level (parent ${drill.parentId})`);
        const m = JSON.parse(content(await rpc("esoul.measure", { nodes: ["b:plate"], pairs: [] }))).nodes[0];
        if (Math.abs(m.volume - (Math.PI * 100 * 3 - Math.PI * 4 * 3)) > 1)
            return log.fail(`the cut did not happen (volume ${m.volume})`);
        return log.ok();
    },
    // E3 — esoul.camera: a rotate moves the camera and answers where it is; a lookAt puts it where it was told.
    async E3(log) {
        const r = await replay([
            {
                id: "c",
                ops: [
                    {
                        op: "sketch",
                        id: "s",
                        plane: "XY",
                        entities: [{ type: "circle", params: [0, 0, 10] }],
                    },
                    { op: "extrude", id: "plate", sketch: "s", name: "Plate", depth: 3 },
                ],
            },
        ]);
        if (r.failed.length) return log.fail(r.failed[0].error);
        await rpc("fit_content", {});
        const a = JSON.parse(content(await rpc("esoul.camera", {})));
        const b = JSON.parse(content(await rpc("esoul.camera", { rotate: { dx: 120, dy: 0 } })));
        log.note(`before ${JSON.stringify(a.position)} after ${JSON.stringify(b.position)}`);
        if (
            Math.hypot(
                a.position.x - b.position.x,
                a.position.y - b.position.y,
                a.position.z - b.position.z,
            ) < 1
        )
            return log.fail("rotate did not move the camera");
        const c = JSON.parse(
            content(
                await rpc("esoul.camera", {
                    lookAt: { eye: { x: 0, y: -200, z: 50 }, target: { x: 0, y: 0, z: 0 } },
                }),
            ),
        );
        if (Math.abs(c.position.y + 200) > 1 || Math.abs(c.target.x) > 1)
            return log.fail(`lookAt landed at ${JSON.stringify(c)}`);
        return log.ok();
    },
    // E4 — esoul.snapshot { shapes }: a snapshot that carries every built shape loads back as the same geometry without
    //      re-running the chain, a later step still cuts into a cached body, a plain snapshot carries no shapes, and a big
    //      one leaves in chunks that stitch back byte for byte.
    async E4(log) {
        const plate = [
            {
                op: "sketch",
                id: "s",
                plane: "XY",
                entities: [...rect(0, 0, 60, 40), { type: "circle", params: [30, 20, 4] }],
            },
            { op: "extrude", id: "plate", sketch: "s", name: "Plate", depth: 3 },
            {
                op: "sketch",
                id: "s2",
                plane: { base: "XY", offset: 3 },
                entities: [{ type: "circle", params: [10, 10, 6] }],
            },
            {
                op: "extrude",
                id: "boss",
                sketch: "s2",
                name: "Boss",
                depth: 8,
                body: "plate",
                operation: "fuse",
            },
        ];
        const r = await replay([{ id: "p", ops: plate }]);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const vol = async () =>
            JSON.parse(content(await rpc("esoul.measure", { nodes: ["p:plate"], pairs: [] }))).nodes[0]
                .volume;
        const v0 = await vol();
        const plain = JSON.parse(content(await rpc("esoul.snapshot", {})));
        if (plain.serialized.includes("shapeCache")) return log.fail("a plain snapshot carries shapes");
        const full = JSON.parse(content(await rpc("esoul.snapshot", { shapes: true })));
        if (!full.serialized.includes("shapeCache")) return log.fail("a shapes snapshot carries no shapes");
        log.note(`snapshot ${plain.bytes} B plain, ${full.bytes} B with shapes`);
        // a fresh document from the shapes snapshot alone: same geometry, same ids
        const r2 = await replay([{ id: "c", kind: "edit", serialized: full.serialized }]);
        if (r2.failed.length) return log.fail(`loading the cache: ${r2.failed[0].error}`);
        const v1 = await vol();
        if (Math.abs(v1 - v0) > 1e-6) return log.fail(`the cached body differs: ${v1} vs ${v0}`);
        const d = await rpc("esoul.describe", { nodes: ["p:plate"] });
        if (!d.ok || !JSON.parse(content(d)).bodies[0].holes.length)
            return log.fail("describe on the cached body found no hole");
        // a step after the cache cuts into the cached body (the chain runs for real then)
        const r3 = await replay([
            { id: "c", kind: "edit", serialized: full.serialized },
            {
                id: "q",
                ops: [
                    {
                        op: "sketch",
                        id: "s3",
                        plane: { base: "XY", offset: -1 },
                        entities: [{ type: "circle", params: [50, 30, 3] }],
                    },
                    { op: "extrude", id: "drill", sketch: "s3", depth: 6, body: "p:plate", operation: "cut" },
                ],
            },
        ]);
        if (r3.failed.length) return log.fail(`a cut after the cache: ${r3.failed[0].error}`);
        const v2 = await vol();
        if (!(v2 < v0 - 50)) return log.fail(`the cut after the cache removed nothing (${v2} vs ${v0})`);
        // chunks: forced small, stitched back to the same text
        const big = JSON.parse(
            content(await rpc("esoul.snapshot", { shapes: true, chunked: true, chunkBytes: 65536 })),
        );
        if (!big.chunked) return log.fail("a snapshot above the chunk size did not chunk");
        let text = "",
            off = 0;
        for (let i = 0; i < 400 && off < big.bytes; i++) {
            const c = JSON.parse(
                content(await rpc("esoul.exportChunk", { handle: big.handle, offset: off, length: 65536 })),
            );
            text += atob(c.base64);
            off += c.length;
            if (c.done) break;
        }
        const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0));
        const stitched = new TextDecoder().decode(bytes);
        if (
            stitched.length !== new TextDecoder().decode(new TextEncoder().encode(stitched)).length ||
            !stitched.includes("shapeCache") ||
            bytes.length !== big.bytes
        )
            return log.fail(`chunks stitched to ${bytes.length} of ${big.bytes} bytes`);
        return log.ok();
    },
    // E5 — esoul.snapshot { gzip }: the runtime gzips its own snapshot (the app's geometry cache on the wire: 22 MB of
    //      BRep text travels as 5); by URL it inflates and loads like the plain one; a URL that answers 404 fails the replay with the status, not a half-built document.
    async E5(log) {
        const r = await replay([{ id: "p", ops: box("plate", "Plate", 0, 0, 60, 40, 0, 3) }]);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const vol = async () =>
            JSON.parse(content(await rpc("esoul.measure", { nodes: ["p:plate"], pairs: [] }))).nodes[0]
                .volume;
        const v0 = await vol();
        const full = JSON.parse(content(await rpc("esoul.snapshot", { shapes: true })));
        const packed = JSON.parse(content(await rpc("esoul.snapshot", { shapes: true, gzip: true })));
        if (!packed.gzip || typeof packed.base64 !== "string")
            return log.fail("a gzip snapshot answered no base64");
        const gz = Buffer.from(packed.base64, "base64");
        if (gz.length !== packed.bytes || gz[0] !== 0x1f || gz[1] !== 0x8b)
            return log.fail(`the gzip snapshot is not gzip (${gz.length} B, ${gz[0]} ${gz[1]})`);
        if (zlib.gunzipSync(gz).toString("utf8") !== full.serialized)
            return log.fail("the gzip snapshot does not inflate to the plain one");
        fs.writeFileSync(path.join(OUT, "e5.json.gz"), gz);
        log.note(`${full.bytes} B with shapes, ${gz.length} B gzipped by the runtime`);
        const r2 = await replay([{ id: "c", kind: "edit", url: `${ORIGIN}/__out__/e5.json.gz` }]);
        if (r2.failed.length) return log.fail(`loading the gzipped cache: ${r2.failed[0].error}`);
        const v1 = await vol();
        if (Math.abs(v1 - v0) > 1e-6)
            return log.fail(`the body from the gzipped cache differs: ${v1} vs ${v0}`);
        const bad = await rpc("esoul.replay", {
            steps: [{ id: "c", kind: "edit", url: `${ORIGIN}/__out__/missing.json.gz` }],
        });
        if (bad.ok || !/HTTP 404/.test(bad.error ?? ""))
            return log.fail(`a missing cache URL answered ${bad.ok ? "ok" : bad.error}`);
        // a file above one range (64 KB) by URL is read in RANGES (the test server answers HEAD + 206): a plate with
        // forty holes, its plain shapes snapshot, loaded back to the same volume
        const holes = [];
        for (let i = 0; i < 40; i++)
            holes.push({ type: "circle", params: [8 + (i % 10) * 20, 15 + Math.floor(i / 10) * 25, 3] });
        const r3 = await replay([
            {
                id: "big",
                ops: [
                    { op: "sketch", id: "s", plane: "XY", entities: [...rect(0, 0, 210, 110), ...holes] },
                    { op: "extrude", id: "plate", sketch: "s", name: "Plate", depth: 4 },
                ],
            },
        ]);
        if (r3.failed.length) return log.fail(`the forty-hole plate: ${r3.failed[0].error}`);
        const bigVol = JSON.parse(content(await rpc("esoul.measure", { nodes: ["big:plate"], pairs: [] })))
            .nodes[0].volume;
        const bigSnap = JSON.parse(content(await rpc("esoul.snapshot", { shapes: true })));
        if (bigSnap.bytes <= 65_536)
            return log.fail(`the big fixture is ${bigSnap.bytes} B — too small to exercise ranges`);
        fs.writeFileSync(path.join(OUT, "e5-big.json"), bigSnap.serialized);
        const r4 = await replay([{ id: "c2", kind: "edit", url: `${ORIGIN}/__out__/e5-big.json` }]);
        if (r4.failed.length) return log.fail(`loading the big snapshot by URL: ${r4.failed[0].error}`);
        const v4 = JSON.parse(content(await rpc("esoul.measure", { nodes: ["big:plate"], pairs: [] })))
            .nodes[0].volume;
        if (Math.abs(v4 - bigVol) > 1e-6)
            return log.fail(`the plate from the ranged load differs: ${v4} vs ${bigVol}`);
        log.note(`big snapshot ${bigSnap.bytes} B read in ${Math.ceil(bigSnap.bytes / 65536)} ranges`);
        return log.ok();
    },
    // E6 — a hand edit leaves as a DELTA (what the gesture changed, with the value it replaced), not the whole
    //      document: a move, a feature change and a delete, each replayed onto a fresh build to the same geometry;
    //      a delta step after a program step applies onto it (no document reset); the delta is kilobytes.
    async E6(log) {
        const program = [
            { op: "sketch", id: "s", plane: "XY", entities: [...rect(0, 0, 60, 40)] },
            { op: "extrude", id: "plate", sketch: "s", name: "Plate", depth: 3 },
            {
                op: "sketch",
                id: "s2",
                plane: { base: "XY", offset: 3 },
                entities: [{ type: "circle", params: [50, 30, 5] }],
            },
            { op: "extrude", id: "post", sketch: "s2", name: "Post", depth: 10 },
        ];
        const r = await replay([{ id: "p", ops: program }]);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const edits = async (since) =>
            rt.page.evaluate((since) => window.__msgs.filter((m) => m.type === "edit").slice(since), since);
        const editCount = async () =>
            rt.page.evaluate(() => window.__msgs.filter((m) => m.type === "edit").length);
        const waitForEdit = async (n) => {
            await rt.page.waitForFunction(
                (n) => window.__msgs.filter((m) => m.type === "edit").length > n,
                { timeout: 15000 },
                n,
            );
            return (await edits(n))[0];
        };
        // 1. a move: the Post's transform, as chili's Move command sets it (one transaction, history on)
        const bb0 = await bbox("p:post");
        let n = await editCount();
        const lift = { __cla$$__: "Matrix4", array: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 25, 1] };
        await rpc("esoul.simulateEdit", { ops: [{ nodeId: "p:post", property: "transform", value: lift }] });
        const e1 = await waitForEdit(n);
        if (e1.serialized !== undefined || !e1.delta)
            return log.fail(`the move left as ${e1.serialized !== undefined ? "a snapshot" : "no delta"}`);
        const sets = e1.delta.ops.filter((o) => o.op === "set");
        if (sets.length !== 1 || sets[0].target.nodeId !== "p:post" || sets[0].property !== "transform")
            return log.fail(`the move's delta: ${JSON.stringify(e1.delta).slice(0, 200)}`);
        if (!e1.base?.["node:p:post"]?.transform)
            return log.fail("the move's delta carries no base transform");
        const weight = JSON.stringify(e1.delta).length;
        if (weight > 20_000) return log.fail(`the delta weighs ${weight} chars`);
        // replayed onto a fresh build: the post sits 25 higher
        const r2 = await replay([
            { id: "p", ops: program },
            { id: "e1", kind: "edit", delta: e1.delta },
        ]);
        if (r2.failed.length) return log.fail(`replaying the move: ${r2.failed[0].error}`);
        const bb1 = await bbox("p:post");
        if (Math.abs(bb1.max.z - bb0.max.z - 25) > 1e-6)
            return log.fail(`the replayed move put the post at z ${bb1.max.z} (was ${bb0.max.z})`);
        if (!r2.applied[1].ok || !r2.applied[1].bodies.some((b) => b.nodeId === "p:post"))
            return log.fail("the delta step's report does not name the post");
        // 2. a feature change: the post's extrude depth doubled through featuresJson, as the feature editor sets it
        const v0 = await volume("p:post");
        n = await editCount();
        const features = await rt.page.evaluate(async () => {
            const id = `feat-${Date.now()}`;
            window.postMessage(
                {
                    esoulCad: 1,
                    id,
                    method: "run_parametric",
                    args: { ops: [{ op: "features", id: "f", body: "p:post" }] },
                },
                location.origin,
            );
            for (let i = 0; i < 200; i++) {
                const m = window.__msgs.find((m) => m.id === id && "ok" in m);
                if (m) return JSON.parse(typeof m.result === "string" ? m.result : m.result.content);
                await new Promise((r) => setTimeout(r, 50));
            }
            return null;
        });
        const feats = features?.results?.f;
        if (!Array.isArray(feats) || !feats.length) return log.fail("could not read the post's features");
        const doc = JSON.parse(content(await rpc("esoul.serialize", {})));
        const postNode = doc.models.nodes.find((x) => x.id === "p:post");
        const current = JSON.parse(postNode.featuresJson);
        const changed = current.map((f) => (f.type === "extrude" ? { ...f, depth: 20 } : f));
        await rpc("esoul.simulateEdit", {
            ops: [{ nodeId: "p:post", property: "featuresJson", value: JSON.stringify(changed) }],
        });
        const e2 = await waitForEdit(n);
        // runtime 37: a feature-list change is an OPERATION on features by id, never the whole list
        const fop = e2.delta?.ops.find((o) => o.op === "features" && o.target.nodeId === "p:post");
        if (!fop)
            return log.fail(
                `the feature change left ${JSON.stringify(e2.delta ?? e2.serialized?.length).slice(0, 160)}`,
            );
        if (
            fop.change.length !== 1 ||
            fop.add.length !== 0 ||
            fop.remove.length !== 0 ||
            fop.change[0].feature.depth !== 20
        )
            return log.fail(`the feature change as an op: ${JSON.stringify(fop).slice(0, 200)}`);
        if (e2.base?.["node:p:post"]?.featuresJson !== postNode.featuresJson)
            return log.fail("the feature change carries no base list");
        const r3 = await replay([
            { id: "p", ops: program },
            { id: "e1", kind: "edit", delta: e1.delta },
            { id: "e2", kind: "edit", delta: e2.delta },
        ]);
        if (r3.failed.length) return log.fail(`replaying the feature change: ${r3.failed[0].error}`);
        const v1 = await volume("p:post");
        if (!(v1 > v0 * 1.9))
            return log.fail(`the replayed feature change left the post at ${v1} (was ${v0})`);
        // 3. a delete
        n = await editCount();
        await rpc("esoul.simulateEdit", { ops: [{ nodeId: "p:post", remove: true }] });
        const e3 = await waitForEdit(n);
        if (!e3.delta || !e3.delta.ops.some((o) => o.op === "remove" && o.nodeId === "p:post"))
            return log.fail(
                `the delete left ${JSON.stringify(e3.delta ?? e3.serialized?.length).slice(0, 120)}`,
            );
        const r4 = await replay([
            { id: "p", ops: program },
            { id: "e3", kind: "edit", delta: e3.delta },
        ]);
        if (r4.failed.length) return log.fail(`replaying the delete: ${r4.failed[0].error}`);
        let gone = false;
        try {
            await volume("p:post");
        } catch {
            gone = true;
        }
        if (!gone) return log.fail("the post is still there after the replayed delete");
        // 4. applyStep: the move lands on a built document in place
        const r5 = await replay([{ id: "p", ops: program }]);
        if (r5.failed.length) return log.fail(r5.failed[0].error);
        const ap = await rpc("esoul.applyStep", { step: { id: "e1", kind: "edit", delta: e1.delta } });
        if (!ap.ok) return log.fail(`applyStep: ${ap.error}`);
        const bb2 = await bbox("p:post");
        if (Math.abs(bb2.max.z - bb0.max.z - 25) > 1e-6)
            return log.fail(`applyStep left the post at z ${bb2.max.z}`);
        const ap2 = await rpc("esoul.applyStep", {
            step: {
                id: "q",
                kind: "program",
                ops: [
                    {
                        op: "sketch",
                        id: "s3",
                        plane: "XY",
                        entities: [{ type: "circle", params: [10, 10, 2] }],
                    },
                    { op: "extrude", id: "pin", sketch: "s3", name: "Pin", depth: 6 },
                ],
            },
        });
        if (!ap2.ok || !JSON.parse(content(ap2)).applied[0].ok)
            return log.fail(
                `applyStep program: ${ap2.ok ? JSON.parse(content(ap2)).applied[0].error : ap2.error}`,
            );
        const vPin = await volume("q:pin");
        if (!(vPin > 70)) return log.fail(`the applied program step made a pin of ${vPin}`);
        // 5. the feature change COMPOSES with a feature that reached the body meanwhile (an agent's cut): applied onto
        //    the list as it is, the post ends up with the doubled depth AND the hole — neither side's work is lost
        const r6 = await replay([{ id: "p", ops: program }]);
        if (r6.failed.length) return log.fail(r6.failed[0].error);
        const cut = await rpc("esoul.applyStep", {
            step: {
                id: "c",
                kind: "program",
                ops: [
                    {
                        op: "sketch",
                        id: "s5",
                        plane: { base: "XY", offset: 3 },
                        entities: [{ type: "circle", params: [50, 30, 1.5] }],
                    },
                    { op: "extrude", id: "hole", sketch: "s5", body: "p:post", operation: "cut", depth: 30 },
                ],
            },
        });
        if (!cut.ok || !JSON.parse(content(cut)).applied[0].ok)
            return log.fail(`the cut: ${cut.ok ? JSON.parse(content(cut)).applied[0].error : cut.error}`);
        const listWithCut = JSON.parse(
            JSON.parse(content(await rpc("esoul.serialize", {}))).models.nodes.find((x) => x.id === "p:post")
                .featuresJson,
        );
        if (listWithCut.length !== current.length + 1)
            return log.fail(
                `the cut did not join the post's features (${listWithCut.length} vs ${current.length})`,
            );
        const vCut = await volume("p:post");
        const ap3 = await rpc("esoul.applyStep", { step: { id: "e2", kind: "edit", delta: e2.delta } });
        if (!ap3.ok || !JSON.parse(content(ap3)).applied[0].ok)
            return log.fail(
                `the feature change on a body with a new cut: ${ap3.ok ? JSON.parse(content(ap3)).applied[0].error : ap3.error}`,
            );
        const both = JSON.parse(
            JSON.parse(content(await rpc("esoul.serialize", {}))).models.nodes.find((x) => x.id === "p:post")
                .featuresJson,
        );
        const cutId = listWithCut[listWithCut.length - 1].id;
        if (both.length !== listWithCut.length || !both.some((f) => f.id === cutId))
            return log.fail("the feature change dropped the cut");
        if (!both.some((f) => f.type === "extrude" && f.depth === 20))
            return log.fail("the cut dropped the feature change");
        const vBoth = await volume("p:post");
        if (!(vBoth > vCut * 1.9 && vBoth < v1))
            return log.fail(
                `post with the doubled depth and the hole: ${vBoth} (hole alone ${vCut}, depth alone ${v1})`,
            );
        log.note(
            `move delta ${weight} chars; feature delta ${JSON.stringify(e2.delta).length} chars; composed ${vBoth.toFixed(0)} < ${v1.toFixed(0)}`,
        );
        return log.ok();
    },
    // D1 — esoul.describe: a plate with three holes and a boss is read back as holes (Ø, centre) + a boss + its planes.
    async D1(log) {
        const r = await replay([
            {
                id: "p",
                ops: [
                    {
                        op: "sketch",
                        id: "s",
                        plane: "XY",
                        entities: [
                            ...rect(0, 0, 60, 40),
                            { type: "circle", params: [10, 10, 1.35] },
                            { type: "circle", params: [50, 10, 1.35] },
                            { type: "circle", params: [30, 32, 2.5] },
                        ],
                    },
                    { op: "extrude", id: "plate", sketch: "s", name: "Plate", depth: 3 },
                    {
                        op: "sketch",
                        id: "s2",
                        plane: { base: "XY", offset: 3 },
                        entities: [{ type: "circle", params: [30, 15, 6] }],
                    },
                    {
                        op: "extrude",
                        id: "boss",
                        sketch: "s2",
                        name: "Boss",
                        depth: 8,
                        body: "plate",
                        operation: "fuse",
                    },
                ],
            },
        ]);
        if (r.failed.length) return log.fail(r.failed[0].error);
        const d = await rpc("esoul.describe", { nodes: ["p:plate"] });
        if (!d.ok) return log.fail(`describe: ${d.error}`);
        const body = JSON.parse(content(d)).bodies[0];
        log.note(
            `faces ${body.faces}: holes ${body.holes.map((h) => `Ø${h.diameter}@(${h.centre.x},${h.centre.y})`).join(" ")}; bosses ${body.bosses.map((h) => `Ø${h.diameter}@(${h.centre.x},${h.centre.y})`).join(" ")}; planes ${body.planes.length}`,
        );
        const hole = (x, y, dia) =>
            body.holes.find(
                (h) => near(h.centre.x, x, 0.05) && near(h.centre.y, y, 0.05) && near(h.diameter, dia, 0.01),
            );
        if (!hole(10, 10, 2.7) || !hole(50, 10, 2.7) || !hole(30, 32, 5))
            return log.fail("the three holes must be read back with their centres and diameters");
        if (body.holes.length !== 3) return log.fail(`three holes, not ${body.holes.length}`);
        const boss = body.bosses.find(
            (b) => near(b.centre.x, 30, 0.05) && near(b.centre.y, 15, 0.05) && near(b.diameter, 12, 0.01),
        );
        if (!boss || !near(boss.length, 8, 0.05))
            return log.fail("the Ø12 × 8 boss must be read back as a boss");
        const top = body.planes.find((p) => near(p.normal.z, 1) && near(p.point.z, 3, 0.01));
        const bottom = body.planes.find((p) => near(p.normal.z, -1) && near(p.point.z, 0, 0.01));
        if (!top || !bottom)
            return log.fail(
                "the plate's top (+z at 3) and bottom (−z at 0) planes must be read back with their normals",
            );
        return log.ok();
    },
};

const results = [];
for (const [name, fn] of Object.entries(tests)) {
    if (only.length && !only.includes(name)) continue;
    const log = {
        notes: [],
        gaps: [],
        status: "?",
        ok() {
            this.status = this.status === "?" ? "ok" : this.status;
            return true;
        },
        fail(m) {
            this.status = `FAIL: ${m}`;
            return false;
        },
        note(m) {
            this.notes.push(m);
        },
        gap(m) {
            this.gaps.push(m);
        },
    };
    const t = Date.now();
    try {
        await fn(log);
    } catch (err) {
        log.status = `ERROR: ${err.message}`;
    }
    results.push({ name, ...log, ms: Date.now() - t });
    console.log(`\n== ${name} ${log.status} (${Date.now() - t} ms)`);
    for (const x of log.notes) console.log(`   · ${x}`);
    for (const x of log.gaps) console.log(`   ✗ GAP: ${x}`);
}
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
await rt.close();
const bad = results.filter((r) => r.status !== "ok");
console.log(
    `\n${results.length - bad.length}/${results.length} passed${bad.length ? ` — FAILED: ${bad.map((r) => r.name).join(", ")}` : ""}`,
);
process.exit(bad.length ? 1 : 0);
