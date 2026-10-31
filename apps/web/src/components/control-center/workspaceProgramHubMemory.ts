import { WorkspaceProgramHubMemory } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeHubMemory = Schema.decodeUnknownSync(WorkspaceProgramHubMemory);

export function parseWorkspaceProgramHubMemory(input: {
  commitLimitMb: string;
  concurrencyGroup: string;
  concurrencySlots: string;
  sharedDatasets: string;
}): WorkspaceProgramHubMemory {
  const group = input.concurrencyGroup.trim() || null;
  if (group === null && input.concurrencySlots.trim()) {
    throw new Error("동시 실행 슬롯을 지정하려면 그룹 이름을 입력하세요.");
  }
  const names = new Set<string>();
  const sharedDatasets = input.sharedDatasets.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    const separator = line.indexOf("=");
    if (separator <= 0 || !line.slice(separator + 1).trim()) {
      throw new Error(
        `공유 데이터셋 ${index + 1}번째 줄을 이름=프로젝트 내 상대 경로 형식으로 입력하세요.`,
      );
    }
    const name = line.slice(0, separator).trim().toUpperCase();
    if (names.has(name)) throw new Error(`공유 데이터셋 이름 ${name}이 중복됐습니다.`);
    names.add(name);
    return [{ name, relativeSource: line.slice(separator + 1).trim() }];
  });
  return decodeHubMemory({
    commitLimitMb: input.commitLimitMb.trim() ? Number(input.commitLimitMb) : null,
    concurrencyGroup: group,
    concurrencySlots:
      group === null ? null : input.concurrencySlots.trim() ? Number(input.concurrencySlots) : 1,
    sharedDatasets,
  });
}
