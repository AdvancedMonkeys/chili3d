// CAD primitives for chili3d ParametricOp programs on OFFSET datum planes (fork 2026-10-04).
// World: z up, the bear faces +x, symmetric about y = 0.
// Plane u/v → world: XY u→x v→y (normal +z) · YZ u→y v→z (normal +x) · ZX u→−x v→z (normal +y).
// 9 decimals: a 3-decimal rounding moved an arc END off its circle (the solver projects it back) → a 0.5 µm gap → "Failed to revolve profile".
export const r3 = (n) => Math.round(n * 1e9) / 1e9;
const PL = {
    XY: {
        toUV: ([x, y, z]) => [x, y],
        off: ([x, y, z]) => z,
        dirUV: ([x, y, z]) => [x, y],
        world: (u, v, o) => [u, v, o],
    },
    YZ: {
        toUV: ([x, y, z]) => [y, z],
        off: ([x, y, z]) => x,
        dirUV: ([x, y, z]) => [y, z],
        world: (u, v, o) => [o, u, v],
    },
    ZX: {
        toUV: ([x, y, z]) => [-x, z],
        off: ([x, y, z]) => y,
        dirUV: ([x, y, z]) => [-x, z],
        world: (u, v, o) => [-u, o, v],
    },
};
const plane = (base, offset) => (offset === 0 ? base : { base, offset: r3(offset) });
const pt = ([x, y, z]) => ({ x: r3(x), y: r3(y), z: r3(z) });
const norm = ([a, b]) => {
    const l = Math.hypot(a, b);
    return [a / l, b / l];
};

/** A sphere at any centre: a half-disc on the plane `base` through the centre, revolved about the vertical axis through it. */
export const sphere = (id, name, c, r, base = "ZX") => {
    const P = PL[base];
    const [cu, cv] = P.toUV(c);
    const o = P.off(c);
    const vdir = norm(P.dirUV(base === "XY" ? [1, 0, 0] : [0, 0, 1])); // an in-plane axis direction through the centre
    const n = [vdir[1], -vdir[0]];
    const A = [cu - r * vdir[0], cv - r * vdir[1]],
        B = [cu + r * vdir[0], cv + r * vdir[1]];
    const M = [cu + r * n[0], cv + r * n[1]];
    return [
        {
            op: "sketch",
            id: `s_${id}`,
            plane: plane(base, o),
            entities: [
                { type: "arc", params: [cu, cv, ...A, ...B].map(r3) },
                { type: "line", params: [...B, ...A].map(r3) },
            ],
        },
        {
            op: "revolve",
            id,
            sketch: `s_${id}`,
            name,
            axis: { point: pt(c), direction: pt(base === "XY" ? [1, 0, 0] : [0, 0, 1]) },
        },
    ];
};
// NOTE sphere(): the arc runs ccw from A (angle −90° of vdir) to B (+90°) → through +n side; fine for a full revolve.

/** A capsule from world point a to world point b (both on one plane `base`), radius r: a half-stadium revolved about its own axis. */
export const capsule = (id, name, a, b, r, base) => {
    const P = PL[base];
    const o = P.off(a);
    if (Math.abs(P.off(b) - o) > 1e-6) throw new Error(`capsule ${id}: a and b are not on one ${base} plane`);
    const A = P.toUV(a),
        B = P.toUV(b);
    const d = norm([B[0] - A[0], B[1] - A[1]]);
    const n = [d[1], -d[0]]; // d rotated −90°: cap arcs run ccw
    const P1 = [A[0] + r * n[0], A[1] + r * n[1]],
        P2 = [B[0] + r * n[0], B[1] + r * n[1]];
    const Bd = [B[0] + r * d[0], B[1] + r * d[1]],
        Ad = [A[0] - r * d[0], A[1] - r * d[1]];
    const dirW = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    return [
        {
            op: "sketch",
            id: `s_${id}`,
            plane: plane(base, o),
            entities: [
                { type: "line", params: [...P1, ...P2].map(r3) },
                { type: "arc", params: [...B, ...P2, ...Bd].map(r3) },
                { type: "line", params: [...Bd, ...Ad].map(r3) },
                { type: "arc", params: [...A, ...Ad, ...P1].map(r3) },
            ],
        },
        { op: "revolve", id, sketch: `s_${id}`, name, axis: { point: pt(a), direction: pt(dirW) } },
    ];
};

/** A plano-convex dome: base circle radius a centred at world point c, rising h along the unit world direction dir (dir must lie in plane `base`). */
export const dome = (id, name, c, dir, a, h, base) => {
    const P = PL[base];
    const o = P.off(c);
    const C = P.toUV(c);
    const d = norm(P.dirUV(dir));
    const n = [-d[1], d[0]]; // d rotated +90°: apex→rim runs ccw
    const R = (a * a + h * h) / (2 * h);
    const apex = [C[0] + h * d[0], C[1] + h * d[1]],
        rim = [C[0] + a * n[0], C[1] + a * n[1]];
    const centre = [C[0] + (h - R) * d[0], C[1] + (h - R) * d[1]];
    return [
        {
            op: "sketch",
            id: `s_${id}`,
            plane: plane(base, o),
            entities: [
                { type: "line", params: [...C, ...apex].map(r3) },
                { type: "arc", params: [...centre, ...apex, ...rim].map(r3) },
                { type: "line", params: [...rim, ...C].map(r3) },
            ],
        },
        { op: "revolve", id, sketch: `s_${id}`, name, axis: { point: pt(c), direction: pt(dir) } },
    ];
};

/** A cylinder along +x from x0, length len, centred at (cy, cz): a circle on the YZ plane extruded with an offset. */
export const cylX = (id, name, cy, cz, r, x0, len, body, operation = "fuse") => [
    { op: "sketch", id: `s_${id}`, plane: "YZ", entities: [{ type: "circle", params: [cy, cz, r].map(r3) }] },
    {
        op: "extrude",
        id,
        sketch: `s_${id}`,
        name,
        depth: r3(len),
        startOffset: r3(x0),
        ...(body ? { body, operation } : {}),
    },
];
/** A cylinder along +z from z0, centred at (cx, cy). */
export const cylZ = (id, name, cx, cy, r, z0, len, body, operation = "fuse") => [
    { op: "sketch", id: `s_${id}`, plane: "XY", entities: [{ type: "circle", params: [cx, cy, r].map(r3) }] },
    {
        op: "extrude",
        id,
        sketch: `s_${id}`,
        name,
        depth: r3(len),
        startOffset: r3(z0),
        ...(body ? { body, operation } : {}),
    },
];
/** A slab: a rectangle on the ZX plane (y = 0) with corners (x0,z0)-(x1,z1), pushed along +y from y0 by w. */
export const slabZX = (id, name, x0, z0, x1, z1, y0, w, body, operation) => [
    {
        op: "sketch",
        id: `s_${id}`,
        plane: "ZX",
        entities: [
            [-x0, z0, -x1, z0],
            [-x1, z0, -x1, z1],
            [-x1, z1, -x0, z1],
            [-x0, z1, -x0, z0],
        ].map((p) => ({ type: "line", params: p.map(r3) })),
    },
    { op: "extrude", id, sketch: `s_${id}`, name, depth: r3(w), startOffset: r3(y0), body, operation },
];
export const fuse = (id, body, tools) => ({ op: "boolean", id, body, operation: "fuse", tools });
