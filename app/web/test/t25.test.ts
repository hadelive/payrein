// T25: an op id or timestamp above 2^53 survives the real path from the vault's view to the bytes
// of the owner's `approve` action, so the approval matches the stored op exactly.

import { actionCreators } from "@near-js/transactions";
import { describe, expect, it } from "vitest";
import { decodeView, type OpRecord } from "../src/chain";
import { safeAmount } from "../src/explain";

const raw =
  '[{"op":{"op_id":"9007199254740993","merchant_id":"shop.near","token_id":"nep141:wrap.near",' +
  '"amount":"340282366920938463463374607431768211455","invoice_ref":"INV-1",' +
  '"expires_at_ns":"18446744073709551615","policy_version":4294967295},' +
  '"status":"AwaitingApproval","day":null,"created_ns":"1","dispatched_ns":null,"finished_ns":null}]';

describe("T25", () => {
  it("keeps every field exact from view bytes to approve args", () => {
    const [rec] = decodeView<OpRecord[]>([...new TextEncoder().encode(raw)]);
    const action = actionCreators.functionCall("approve", { op: rec!.op }, 100_000_000_000_000n, 1n);
    const sent = new TextDecoder().decode(action.functionCall!.args);
    expect(sent).toContain('"op_id":"9007199254740993"');
    expect(sent).toContain('"amount":"340282366920938463463374607431768211455"');
    expect(sent).toContain('"expires_at_ns":"18446744073709551615"');
    expect(JSON.parse(sent).op).toEqual(JSON.parse(raw)[0].op);
  });
});

describe("untrusted amounts", () => {
  it("shows non-numbers as given instead of throwing", () => {
    expect(safeAmount("not-an-amount", 24)).toBe("not-an-amount");
    expect(safeAmount("2000000000000000000000", 24)).toBe("0.002");
  });
});
