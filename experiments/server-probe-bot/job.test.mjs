import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { summarize, validateJob } from "./job.mjs";

NodeTest.test("the independent arithmetic oracle is preserved", () => {
  NodeAssert.deepEqual(summarize([2, -3, 5, 0]), { count: 4, sum: 4, min: -3, max: 5 });
  NodeAssert.deepEqual(summarize([1_000_000, -1_000_000]), {
    count: 2,
    sum: 0,
    min: -1_000_000,
    max: 1_000_000,
  });
});

NodeTest.test("malformed, unbounded and ambiguous jobs are rejected", () => {
  for (const value of [
    null,
    [],
    { id: "../escape", samples: [1] },
    { id: "valid", samples: [] },
    { id: "valid", samples: Array(65).fill(1) },
    { id: "valid", samples: [NaN] },
    { id: "valid", samples: [Infinity] },
    { id: "valid", samples: [0.5] },
    { id: "valid", samples: [1_000_001] },
    { id: "valid", samples: ["1"] },
  ]) {
    NodeAssert.throws(() => validateJob(value));
  }
});

NodeTest.test("manual inputs cannot reserve a future scheduled job ID", () => {
  NodeAssert.throws(
    () => validateJob({ id: "scheduled-999999", samples: [1] }),
    /reserved for scheduled work/,
  );
  NodeAssert.deepEqual(validateJob({ id: "manual-999999", samples: [1] }), {
    id: "manual-999999",
    samples: [1],
  });
});
