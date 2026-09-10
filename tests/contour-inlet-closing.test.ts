import assert from "node:assert/strict";
import { test } from "node:test";

import { closeContourInlets } from "../client/src/lib/contour-inlet-closing.ts";

type Point = { x: number; y: number };

const coreModules = await Promise.all([
  import("../client/src/lib/contour-trace-core.ts"),
  import("../client/src/builders/spot-uv/lib/contour-trace-core.ts"),
]);

function quiet<T>(fn: () => T): T {
  const methods = ["log", "warn", "error", "table"] as const;
  const original = methods.map(method => [method, console[method]] as const);
  for (const [method] of original) {
    (console as any)[method] = () => undefined;
  }
  try {
    return fn();
  } finally {
    for (const [method, value] of original) {
      (console as any)[method] = value;
    }
  }
}

function notchedRectangle(notchWidth: number): Point[] {
  const left = (20 - notchWidth) / 2;
  const right = (20 + notchWidth) / 2;
  return [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: right, y: 20 },
    { x: right, y: 5 },
    { x: left, y: 5 },
    { x: left, y: 20 },
    { x: 0, y: 20 },
  ];
}

function bounds(points: Point[]) {
  return {
    minX: Math.min(...points.map(point => point.x)),
    minY: Math.min(...points.map(point => point.y)),
    maxX: Math.max(...points.map(point => point.x)),
    maxY: Math.max(...points.map(point => point.y)),
  };
}

function minYInNotch(points: Point[], notchWidth: number): number {
  const left = (20 - notchWidth) / 2;
  const right = (20 + notchWidth) / 2;
  const inNotch = points.filter(point => point.x >= left && point.x <= right);
  assert.ok(inNotch.length > 0, "closed path should retain points near its inlet");
  return Math.min(...inNotch.map(point => point.y));
}

for (const [name, core] of [
  ["shared contour core", coreModules[0]],
  ["Spot UV contour core", coreModules[1]],
] as const) {
  test(`${name}: vector close closes a narrow concavity without spending bounds`, () => {
    const input = notchedRectangle(4);
    const inputBounds = bounds(input);
    const closed = quiet(() =>
      closeContourInlets(input, 3, core.vectorCloseMerge),
    );

    assert.notStrictEqual(closed, input);
    assert.ok(closed.length >= 3);
    assert.ok(minYInNotch(closed, 4) > 15, "the narrow inlet should be filled");
    assert.deepEqual(bounds(closed), inputBounds);
  });

  test(`${name}: a wide concavity remains open at a smaller close radius`, () => {
    const input = notchedRectangle(12);
    const closed = quiet(() =>
      closeContourInlets(input, 3, core.vectorCloseMerge),
    );

    assert.ok(closed.length >= 3);
    assert.ok(
      minYInNotch(closed, 12) <= 6,
      "a wide inlet should not be bridged by a radius smaller than its width",
    );
  });
}

test("inlet envelope rejects an equal-width translated close result", () => {
  const input = notchedRectangle(4);
  let called = false;
  const result = closeContourInlets(input, 3, points => {
    called = true;
    return points.map(point => ({ x: point.x + 2, y: point.y }));
  });

  assert.equal(called, true);
  assert.strictEqual(result, input);
});

test("inlet closure accepts <=.75px overshoot and clamps every side", () => {
  const input = notchedRectangle(4);
  const result = closeContourInlets(input, 3, () => [
    { x: -0.75, y: -0.75 },
    { x: 20.75, y: -0.75 },
    { x: 20.75, y: 20.75 },
    { x: -0.75, y: 20.75 },
  ]);

  assert.deepEqual(result, [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
  ]);
});

test("invalid or empty close results preserve the traced contour", () => {
  const input = notchedRectangle(4);
  const cases: Point[][] = [
    [],
    [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }, { x: 1, y: 0 }],
    [{ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 1 }, { x: 1, y: 0 }],
  ];

  for (const invalid of cases) {
    const result = closeContourInlets(input, 3, () => invalid);
    assert.strictEqual(result, input);
  }
});

test("disabled radius and short input do not call the close merge", () => {
  const input = notchedRectangle(4);
  for (const radius of [0, -1, Number.NaN]) {
    let called = false;
    const result = closeContourInlets(input, radius, points => {
      called = true;
      return points;
    });
    assert.equal(called, false);
    assert.strictEqual(result, input);
  }

  const shortInput = input.slice(0, 2);
  let called = false;
  const result = closeContourInlets(shortInput, 3, points => {
    called = true;
    return points;
  });
  assert.equal(called, false);
  assert.strictEqual(result, shortInput);
});