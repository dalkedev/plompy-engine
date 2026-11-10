import assert from "node:assert/strict";
import test from "node:test";
import { parseQuantity } from "../src/quantity.mjs";

test("accepts zero, positive quantities, whitespace, and leading zeros", () => {
  for (const [input, expected] of [
    ["0", 0],
    ["000", 0],
    ["-0", 0],
    ["7", 7],
    [" 0042 ", 42],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ]) assert.equal(parseQuantity(input), expected);
});

test("rejects negative quantities", () => {
  for (const input of ["-1", " -20 ", "-0007"])
    assert.throws(() => parseQuantity(input), RangeError);
});

test("rejects malformed values and unsafe integers", () => {
  for (const input of [undefined, null, 0, -1, "", " ", "1.5", "1e2", "+1", "2kg"])
    assert.throws(() => parseQuantity(input), TypeError);
  for (const input of ["9007199254740992", "-9007199254740992"])
    assert.throws(() => parseQuantity(input), RangeError);
});
