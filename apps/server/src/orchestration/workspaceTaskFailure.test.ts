import { expect, it } from "vite-plus/test";
import { classifyDeterministicWorkspaceFailure } from "./workspaceTaskFailure.ts";

it("distinguishes explicit handoff failures without guessing unknown causes", () => {
  expect(classifyDeterministicWorkspaceFailure("handoff input file ENOENT: test.txt")).toBe(
    "handoff-missing",
  );
  expect(classifyDeterministicWorkspaceFailure("인계 파일 해시 불일치")).toBe(
    "handoff-hash-mismatch",
  );
  expect(classifyDeterministicWorkspaceFailure("입력 파일 EACCES")).toBe("handoff-permission");
  expect(classifyDeterministicWorkspaceFailure("Expected 'function.name' to be a string.")).toBe(
    "request-format",
  );
  expect(classifyDeterministicWorkspaceFailure("ENOENT")).toBeNull();
  expect(
    classifyDeterministicWorkspaceFailure(
      "이전 입력의 전달·종료가 미확인입니다. 자동 재전송을 중단했습니다.",
    ),
  ).toBe("delivery-unconfirmed");
  expect(classifyDeterministicWorkspaceFailure("503 temporary timeout")).toBeNull();
});
