import { describe, expect, it } from "vitest";
import { WsMessage, WsMessageFormatException } from "./wsMessage";
import { WsMessageTypes } from "./wsMessageTypes";

describe("WsMessage", () => {
  it("round-trips through encode/decode", () => {
    const message = new WsMessage({
      type: WsMessageTypes.hello,
      payload: { deviceId: "abc", deviceName: "Téléphone du gérant" },
    });

    const decoded = WsMessage.decode(message.encode());

    expect(decoded.type).toBe(WsMessageTypes.hello);
    expect(decoded.payload).toEqual({ deviceId: "abc", deviceName: "Téléphone du gérant" });
    expect(decoded.correlationId).toBe(message.correlationId);
    expect(decoded.timestamp.toISOString()).toBe(message.timestamp.toISOString());
  });

  it("fills in payload/correlationId/timestamp defaults when omitted", () => {
    const message = new WsMessage({ type: WsMessageTypes.ping });
    expect(message.payload).toEqual({});
    expect(message.correlationId).toBeTruthy();
    expect(message.timestamp).toBeInstanceOf(Date);
  });

  it("rejects invalid JSON", () => {
    expect(() => WsMessage.decode("{not json")).toThrow(WsMessageFormatException);
  });

  it("rejects a JSON value that isn't an object", () => {
    expect(() => WsMessage.decode("42")).toThrow(WsMessageFormatException);
    expect(() => WsMessage.decode("[]")).toThrow(WsMessageFormatException);
  });

  it("rejects a message missing type", () => {
    expect(() => WsMessage.decode(JSON.stringify({ payload: {} }))).toThrow(WsMessageFormatException);
  });

  it("rejects a payload that isn't an object", () => {
    expect(() => WsMessage.decode(JSON.stringify({ type: "hello", payload: "nope" }))).toThrow(
      WsMessageFormatException,
    );
  });

  it("rejects an invalid timestamp", () => {
    expect(() =>
      WsMessage.decode(JSON.stringify({ type: "hello", timestamp: "not-a-date" })),
    ).toThrow(WsMessageFormatException);
  });

  it("decodes a message of an unknown type without throwing (forward compatibility)", () => {
    const decoded = WsMessage.decode(JSON.stringify({ type: "futureThing", payload: { x: 1 } }));
    expect(decoded.type).toBe("futureThing");
    expect(decoded.payload).toEqual({ x: 1 });
  });

  it("builds an error reply referencing the original correlationId", () => {
    const original = new WsMessage({ type: WsMessageTypes.hello });
    const reply = original.errorReply("BAD_TOKEN", "jeton de pairage invalide");

    expect(reply.type).toBe(WsMessageTypes.error);
    expect(reply.correlationId).toBe(original.correlationId);
    expect(reply.payload).toEqual({ code: "BAD_TOKEN", message: "jeton de pairage invalide" });
  });
});
