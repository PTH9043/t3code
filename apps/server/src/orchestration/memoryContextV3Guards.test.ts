import { describe, expect, it } from "@effect/vitest";
import {
  isValidKoreanBizRegNo,
  isValidLuhnCardNumber,
  redactMemorySensitiveData,
} from "./memoryPrivacyGuard.ts";
import {
  buildTemporalIndexTail,
  computeTemporalProximityScore,
  parseKoreanTemporalRange,
} from "./koreanTemporalParser.ts";

describe("memoryPrivacyGuard", () => {
  it("redacts Korean RRNs, Luhn payment cards, mobile numbers, and NTS business reg numbers", () => {
    const sample = [
      "주민번호: 900115-1234567",
      "테스트 카드: 4532-0151-1283-0366",
      "담당자 연락처: 010-9876-5432",
      "사업자번호: 220-81-62517",
      "정상 날짜 2026-11-24 와 커밋 900115-abcdef1 및 무효 사업자 123-45-67899 는 유지",
    ].join("\n");

    expect(isValidLuhnCardNumber("4532015112830366")).toBe(true);
    expect(isValidKoreanBizRegNo("2208162517")).toBe(true);
    expect(isValidKoreanBizRegNo("1234567899")).toBe(false);

    const result = redactMemorySensitiveData(sample);
    expect(result.redactionCount).toBe(4);
    expect(result.content).toContain("[민감정보 제거: 주민등록번호]");
    expect(result.content).toContain("[민감정보 제거: 카드번호]");
    expect(result.content).toContain("[민감정보 제거: 휴대전화]");
    expect(result.content).toContain("[민감정보 제거: 사업자등록번호]");
    expect(result.content).toContain("2026-11-24");
    expect(result.content).toContain("900115-abcdef1");
    expect(result.content).toContain("123-45-67899");
  });

  it("allows disabling phone masking while still scrubbing RRNs and API keys", () => {
    const result = redactMemorySensitiveData(
      "연락처 010-1234-5678, RRN 881231-2345678, key=sk-proj-1234567890abcdefghij",
      { maskPhoneNumbers: false },
    );
    expect(result.content).toContain("010-1234-5678");
    expect(result.content).not.toContain("881231-2345678");
    expect(result.content).not.toContain("1234567890abcdefghij");
  });
});

describe("koreanTemporalParser", () => {
  // Reference: 2026-11-24T12:00:00+09:00 (Tuesday in KST)
  const nowMs = Date.parse("2026-11-24T12:00:00+09:00");

  it("resolves 어제, 그저께, N일 전, 지난주, 저번 달, N개월 전, and 작년 M월 in KST", () => {
    const yesterday = parseKoreanTemporalRange("어제 결정한 내용 알려줘", nowMs);
    expect(yesterday?.startIsoDate).toBe("2026-11-23");
    expect(yesterday?.endIsoDate).toBe("2026-11-23");

    const threeDaysAgo = parseKoreanTemporalRange("3일 전에 왜 기각했지?", nowMs);
    expect(threeDaysAgo?.startIsoDate).toBe("2026-11-21");
    expect(threeDaysAgo?.endIsoDate).toBe("2026-11-21");

    const lastWeek = parseKoreanTemporalRange("지난주 회의 결론", nowMs);
    expect(lastWeek?.startIsoDate).toBe("2026-11-16");
    expect(lastWeek?.endIsoDate).toBe("2026-11-22");

    const lastMonth = parseKoreanTemporalRange("저번 달 아키텍처 검토", nowMs);
    expect(lastMonth?.startIsoDate).toBe("2026-10-01");
    expect(lastMonth?.endIsoDate).toBe("2026-10-31");

    const threeMonthsAgo = parseKoreanTemporalRange("세 달 전 비용 문제로 B안 채택", nowMs);
    expect(threeMonthsAgo).not.toBeNull();
    expect(threeMonthsAgo!.startIsoDate <= "2026-08-01").toBe(true);
    expect(threeMonthsAgo!.endIsoDate >= "2026-08-31").toBe(true);

    const lastYearNov = parseKoreanTemporalRange("작년 11월 초 배포 기록", nowMs);
    expect(lastYearNov?.startIsoDate).toBe("2025-11-01");
    expect(lastYearNov?.endIsoDate).toBe("2025-11-10");
  });

  it("scores in-window records at 1.0 and decays smoothly outside the window", () => {
    const range = parseKoreanTemporalRange("어제", nowMs)!;
    const hitMs = Date.parse("2026-11-23T15:00:00+09:00");
    const nearMissMs = Date.parse("2026-11-21T15:00:00+09:00");
    const farMissMs = Date.parse("2026-06-01T15:00:00+09:00");

    expect(computeTemporalProximityScore(hitMs, range, nowMs)).toBe(1.0);
    expect(computeTemporalProximityScore(nearMissMs, range, nowMs)).toBeGreaterThan(0.6);
    expect(computeTemporalProximityScore(farMissMs, range, nowMs)).toBeLessThan(0.01);

    const tail = buildTemporalIndexTail("어제 비용 문제로 B안을 선택했다", nowMs);
    expect(tail).toContain("기준일: 2026-11-24");
    expect(tail).toContain("2026-11-23");
  });
});
