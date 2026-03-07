import { assertEquals } from "@std/assert";
import {
  hashStringFNV1a,
  stableStringify,
} from "../apps/runtime/src/utils/hash.ts";

Deno.test("stableStringify keeps object and array output deterministic", () => {
  assertEquals(
    stableStringify({
      zebra: 2,
      alpha: 1,
      skip: undefined,
      nested: {
        beta: false,
        alpha: true,
        skip: undefined,
      },
      list: [3, undefined, { beta: 2, alpha: 1 }],
    }),
    '{"alpha":1,"list":[3,null,{"alpha":1,"beta":2}],"nested":{"alpha":true,"beta":false},"zebra":2}',
  );
});

Deno.test("stableStringify covers nullish, primitive, and string-fallback cases", () => {
  assertEquals(stableStringify(undefined), "null");
  assertEquals(stableStringify(null), "null");
  assertEquals(stableStringify("kato"), '"kato"');
  assertEquals(stableStringify(42), "42");
  assertEquals(stableStringify(false), "false");
  assertEquals(stableStringify(Symbol.for("kato")), '"Symbol(kato)"');
  assertEquals(stableStringify(5n), '"5"');
});

Deno.test("hashStringFNV1a returns stable 64-bit hex digests", () => {
  assertEquals(hashStringFNV1a(""), "cbf29ce484222325");
  assertEquals(hashStringFNV1a("hello"), "a430d84680aabd0b");
  assertEquals(hashStringFNV1a("Kato 😀"), "a0b4bbf283bbd1fd");
});
