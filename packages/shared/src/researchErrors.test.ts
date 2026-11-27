import { expect, it } from "vite-plus/test";
import { researchErrorMessage } from "./researchErrors.ts";

it("retains error details from Error instances, decoded objects, and strings", () => {
  expect(researchErrorMessage(new Error("HTTP 429"), "fallback")).toBe("HTTP 429");
  expect(researchErrorMessage({ message: "HTTP 401" }, "fallback")).toBe("HTTP 401");
  expect(researchErrorMessage("connection failed", "fallback")).toBe("connection failed");
  expect(researchErrorMessage({ message: "" }, "fallback")).toBe("fallback");
  expect(researchErrorMessage(null, "fallback")).toBe("fallback");
});
