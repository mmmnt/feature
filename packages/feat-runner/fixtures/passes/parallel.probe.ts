import { expect, it } from "vitest";
it("runs in the parallel pass: FEAT_SERIAL is not set", () => { expect(process.env.FEAT_SERIAL).toBeUndefined(); });
