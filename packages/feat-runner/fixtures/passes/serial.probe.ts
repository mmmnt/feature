import { expect, it } from "vitest";
it("runs in the serial pass: FEAT_SERIAL=1", () => { expect(process.env.FEAT_SERIAL).toBe("1"); });
