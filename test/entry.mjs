import assert from "node:assert/strict";
import { apply as namedApply, default as defaultApply } from "../index.js";

assert.equal(typeof namedApply, "function", "named apply must be a function");
assert.equal(typeof defaultApply, "function", "default export must be a function");
assert.equal(namedApply, defaultApply, "named and default must be the same function");

console.log("entry exports OK: apply + default");
