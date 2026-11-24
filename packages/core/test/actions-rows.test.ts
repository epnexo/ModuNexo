import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { numberBigints } from "../src/actions/rows.ts";

const INT8 = 20;
const INT4 = 23;
const TEXT = 25;

describe("numberBigints", () => {
  it("turns a bigint column (which the driver gives as text) into a number when the number is exact", () => {
    const rows = numberBigints([{ id: "1", total: "42", name: "x" }], [{ name: "id", dataTypeID: INT8 }, { name: "total", dataTypeID: INT8 }, { name: "name", dataTypeID: TEXT }]);
    assert.deepEqual(rows, [{ id: 1, total: 42, name: "x" }]);
  });

  it("keeps the text when the number would not be exact, and never touches other columns", () => {
    const big = "9007199254740993";
    const rows = numberBigints([{ id: big, code: "7", n: 5 }], [{ name: "id", dataTypeID: INT8 }, { name: "code", dataTypeID: TEXT }, { name: "n", dataTypeID: INT4 }]);
    assert.deepEqual(rows, [{ id: big, code: "7", n: 5 }]);
  });

  it("leaves null alone and returns the rows untouched when no column is a bigint", () => {
    const rows = [{ id: null, a: "1" }];
    assert.deepEqual(numberBigints(rows, [{ name: "id", dataTypeID: INT8 }, { name: "a", dataTypeID: TEXT }]), [{ id: null, a: "1" }]);
    const plain = [{ a: 1 }];
    assert.equal(numberBigints(plain, [{ name: "a", dataTypeID: INT4 }]), plain);
  });

  it("does not rewrite a text that only looks like a number, such as 1e3 or 007", () => {
    const rows = numberBigints([{ a: "007", b: "1e3", c: "-12" }], [{ name: "a", dataTypeID: INT8 }, { name: "b", dataTypeID: INT8 }, { name: "c", dataTypeID: INT8 }]);
    assert.deepEqual(rows, [{ a: "007", b: "1e3", c: -12 }]);
  });
});
