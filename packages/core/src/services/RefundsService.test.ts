import { describe, expect, it } from "vitest";
import { allocateAcrossMagnitudes } from "./RefundsService";

describe("allocateAcrossMagnitudes", () => {
  const magnitudes = [
    { batchId: 1, qty: 5 },
    { batchId: 2, qty: 3 },
  ];

  it("fills the first batch before spilling into the next one (FEFO order)", () => {
    const result = allocateAcrossMagnitudes(magnitudes, 7);
    expect(result.get("1")).toBe(5);
    expect(result.get("2")).toBe(2);
  });

  it("returns an empty map for a zero amount", () => {
    expect(allocateAcrossMagnitudes(magnitudes, 0).size).toBe(0);
  });

  it("caps at the total available across all batches", () => {
    const result = allocateAcrossMagnitudes(magnitudes, 100);
    expect(result.get("1")).toBe(5);
    expect(result.get("2")).toBe(3);
  });

  it("keys unbatched stock (batchId null) under the string 'null'", () => {
    const result = allocateAcrossMagnitudes([{ batchId: null, qty: 4 }], 2);
    expect(result.get("null")).toBe(2);
  });

  it("supports the incremental prior/new allocation diff used by createRefund for repeated partial refunds", () => {
    // Reproduit le scénario réel : un premier remboursement restitue 4
    // unités, puis un second en restitue 3 de plus (cumul 7) — la remise en
    // stock du second remboursement doit correspondre exactement à la
    // différence entre les deux allocations, lot par lot.
    const prior = allocateAcrossMagnitudes(magnitudes, 4);
    const next = allocateAcrossMagnitudes(magnitudes, 4 + 3);

    const delta = new Map<string, number>();
    for (const m of magnitudes) {
      const key = String(m.batchId);
      const before = prior.get(key) ?? 0;
      const after = next.get(key) ?? 0;
      if (after - before > 0) delta.set(key, after - before);
    }

    expect(delta.get("1")).toBe(1); // batch 1 passe de 4/5 à 5/5 restitué
    expect(delta.get("2")).toBe(2); // batch 2 passe de 0/3 à 2/3 restitué
  });
});
