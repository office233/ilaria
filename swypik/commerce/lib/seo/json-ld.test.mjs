import test from "node:test";
import assert from "node:assert/strict";

import { safeJsonLd } from "./json-ld.ts";

test("safeJsonLd escapes script-breaking characters", () => {
  const serialized = safeJsonLd({
    name: "</script><script>alert(1)</script>",
    description: "<img src=x onerror=alert(1)>",
  });

  assert.equal(serialized.includes("</script>"), false);
  assert.equal(serialized.includes("<img"), false);
  assert.match(serialized, /\\u003c\/script>/);
  assert.match(JSON.parse(serialized).name, /alert\(1\)/);
});
