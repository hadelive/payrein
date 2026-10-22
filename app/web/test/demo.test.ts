// The demo strip holds its buttons while the agent's latest run is still going.

import { describe, expect, it } from "vitest";
import type { Step } from "../src/agentLog";
import { runInFlight } from "../src/App";

const step = (seq: number, run: string, kind: Step["kind"], text: string): Step => ({ seq, at: "", run, kind, text });

describe("runInFlight", () => {
  it("is false with no steps", () => {
    expect(runInFlight([])).toBe(false);
  });

  it("is true while the latest run has no terminal step", () => {
    expect(runInFlight([step(1, "r1", "task", "Buy"), step(2, "r1", "request", "request_payment")])).toBe(true);
  });

  it("ends on delivery, error, refusal, approval wait, or the parallel summary", () => {
    for (const [kind, text] of [
      ["deliver", "report delivered"],
      ["error", "boom"],
      ["vault", "refused: MerchantNotAllowed"],
      ["vault", "op 3 awaits the owner's approval"],
      ["vault", "5 accepted, 3 refused"],
    ] as const) {
      expect(runInFlight([step(1, "r1", "task", "Buy"), step(2, "r1", kind, text)]), text).toBe(false);
    }
  });

  it("only looks at the latest run", () => {
    const steps = [step(1, "r1", "task", "Buy"), step(2, "r1", "deliver", "done"), step(3, "r2", "task", "Buy again")];
    expect(runInFlight(steps)).toBe(true);
  });

  it("does not end on a plain acceptance, which a delivery follows", () => {
    expect(runInFlight([step(1, "r1", "task", "Buy"), step(2, "r1", "vault", "accepted as op 4")])).toBe(true);
  });
});
