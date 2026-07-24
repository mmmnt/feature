// Pure mapping: stream record → CapturedRecord. Always runs (no instrument) —
// the package never reports zero tests when DynamoDB Local is unavailable.
import { describe, expect, it } from "vitest";
import { mapStreamRecord } from "./src/index.js";

describe("stream record mapping", () => {
  it("INSERT maps NewImage with a canonical key and ms timestamp", () => {
    const r = mapStreamRecord({
      eventName: "INSERT",
      dynamodb: {
        Keys: { PK: { S: "SYSTEM#BETA" }, SK: { S: "REQUEST#1" } },
        NewImage: {
          PK: { S: "SYSTEM#BETA" },
          SK: { S: "REQUEST#1" },
          email: { S: "a@b.c" },
          agents: { N: "3" },
          pending: { BOOL: true },
        },
        ApproximateCreationDateTime: new Date(1_700_000_000_000),
      },
    });
    expect(r.type).toBe("INSERT");
    expect(r.key).toBe("PK=SYSTEM#BETA|SK=REQUEST#1");
    expect(r.payload).toEqual({ PK: "SYSTEM#BETA", SK: "REQUEST#1", email: "a@b.c", agents: 3, pending: true });
    expect(r.timestamp).toBe(1_700_000_000_000);
  });

  it("REMOVE maps OldImage when no NewImage exists", () => {
    const r = mapStreamRecord({
      eventName: "REMOVE",
      dynamodb: {
        Keys: { PK: { S: "A" } },
        OldImage: { PK: { S: "A" }, gone: { BOOL: true } },
      },
    });
    expect(r.type).toBe("REMOVE");
    expect(r.payload).toEqual({ PK: "A", gone: true });
    expect(r.timestamp).toBe(0);
  });

  it("falls back to Keys when the stream carries no images", () => {
    const r = mapStreamRecord({
      eventName: "MODIFY",
      dynamodb: { Keys: { PK: { S: "A" }, SK: { S: "B" } } },
    });
    expect(r.payload).toEqual({ PK: "A", SK: "B" });
    expect(r.key).toBe("PK=A|SK=B");
  });
});
