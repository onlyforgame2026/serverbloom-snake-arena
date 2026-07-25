import test from "node:test";
import assert from "node:assert/strict";
import {
  DIRECTIONS,
  sanitizeName,
  samePoint,
  makeSnake,
  outsideBoard
} from "../server.js";

test("sanitizeName removes markup and limits length", () => {
  assert.equal(sanitizeName("  <Alyona>   Yona  "), "Alyona Yona");
  assert.equal(sanitizeName("12345678901234567890"), "1234567890123456");
});

test("makeSnake grows backwards from its heading", () => {
  assert.deepEqual(makeSnake(5, 5, DIRECTIONS.right, 4), [
    { x: 5, y: 5 },
    { x: 4, y: 5 },
    { x: 3, y: 5 },
    { x: 2, y: 5 }
  ]);
});

test("point helpers behave correctly", () => {
  assert.equal(samePoint({ x: 1, y: 2 }, { x: 1, y: 2 }), true);
  assert.equal(samePoint({ x: 1, y: 2 }, { x: 2, y: 1 }), false);
  assert.equal(outsideBoard({ x: -1, y: 2 }), true);
  assert.equal(outsideBoard({ x: 10, y: 10 }), false);
});
