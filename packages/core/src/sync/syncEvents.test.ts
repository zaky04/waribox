import { describe, expect, it, vi } from "vitest";
import { buildSyncEvent, emitSyncEvent, onSyncEvent } from "./syncEvents";

describe("buildSyncEvent", () => {
  it("generates a unique eventId and an ISO timestamp", () => {
    const event = buildSyncEvent("expense.created", { foo: "bar" });
    expect(event.type).toBe("expense.created");
    expect(event.payload).toEqual({ foo: "bar" });
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(new Date(event.createdAt).toISOString()).toBe(event.createdAt);
  });

  it("gives two events built back-to-back distinct eventIds", () => {
    const a = buildSyncEvent("expense.created", {});
    const b = buildSyncEvent("expense.created", {});
    expect(a.eventId).not.toBe(b.eventId);
  });
});

describe("onSyncEvent / emitSyncEvent", () => {
  it("delivers an emitted event to a subscribed listener", () => {
    const listener = vi.fn();
    const unsubscribe = onSyncEvent(listener);
    const event = buildSyncEvent("sale.created", { total: 1000 });

    emitSyncEvent(event);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
    unsubscribe();
  });

  it("stops delivering events after unsubscribing", () => {
    const listener = vi.fn();
    const unsubscribe = onSyncEvent(listener);
    unsubscribe();

    emitSyncEvent(buildSyncEvent("expense.created", {}));

    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers to every subscribed listener, independently", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = onSyncEvent(first);
    const unsubscribeSecond = onSyncEvent(second);

    const event = buildSyncEvent("stockLoss.created", {});
    emitSyncEvent(event);

    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);

    unsubscribeFirst();
    emitSyncEvent(buildSyncEvent("stockLoss.created", {}));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    unsubscribeSecond();
  });
});
