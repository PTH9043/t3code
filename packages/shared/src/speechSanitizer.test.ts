import { assert, describe, it } from "@effect/vitest";
import {
  charToVisemeWeights,
  sanitizeLineForSpeech,
  sanitizeTextForSpeech,
  SpeechSanitizerStream,
} from "./speechSanitizer.ts";

describe("SpeechSanitizerStream (Gate 2: 50-sample zero-code-read verification)", () => {
  it("streams 50 mixed code/SQL/table/path/array-index/link replies with 0 code syntax read aloud", () => {
    const forbiddenTokens = [
      "SELECT ",
      "INSERT INTO",
      "DELETE FROM",
      "const result =",
      "function run()",
      "items[0]",
      "arr[idx]",
      "matrix[row][col]",
      "D:\\__NewAutoUsage",
      "apps/server/src/",
      "https://",
      "http://",
      "| 컬럼 |",
      "---",
      "```",
      "[joy]",
      "[anger]",
      '"questions"',
    ];

    const corpus: string[] = Array.from({ length: 50 }, (_, idx) => {
      const n = idx + 1;
      const codeFenceClose = n % 5 === 0 ? "```Ble" : "```";
      return [
        `## [보고]`,
        `테스트 사례 ${n}번 작업이 정상적으로 완료되었습니다. 참고 문서는 [공식 가이드](https://example.com/docs/${n})에서 확인하세요.`,
        `세부 구현은 \`apps/server/src/module${n}.ts\`의 \`items[0]\`과 arr[idx] 및 matrix[row][col] 경로(D:\\__NewAutoUsage\\apps\\server\\src\\f${n}.ts)를 점검했습니다.`,
        "```ts",
        `const result = items[0] + ${n};`,
        `function run() { return arr[idx]; }`,
        codeFenceClose,
        "```sql",
        `SELECT id, count(*) FROM workspace_delegations WHERE id = ${n};`,
        "```",
        `| 컬럼 | 수치 |`,
        `| :--- | ---: |`,
        `| 응답 ${n} | ${n * 10}ms |`,
        `[joy] 상태 요약입니다. [anger] 태그는 제거되고 자연어만 남습니다.`,
        `## [비서실장의 조언]`,
        `${n}번 항목은 검증이 끝났으니 다음 단계로 바로 넘어가셔도 좋습니다.`,
        ...(n % 7 === 0
          ? [
              `{"questions":[{"id":"q${n}","header":"확인","question":"계속할까요?","options":[{"label":"예","description":"진행"}]}]}`,
            ]
          : []),
      ].join("\n");
    });

    assert.lengthOf(corpus, 50);

    for (let i = 0; i < corpus.length; i += 1) {
      const original = corpus[i]!;
      const stream = new SpeechSanitizerStream({ maxChunkChars: 140 });
      const emitted: string[] = [];
      // Feed arbitrary variable-sized streaming deltas (3..17 chars)
      let offset = 0;
      let step = 5;
      while (offset < original.length) {
        const size = ((step + i) % 15) + 3;
        emitted.push(...stream.push(original.slice(offset, offset + size)));
        offset += size;
        step += 3;
      }
      emitted.push(...stream.flush());

      const spoken = emitted.join(" ");
      // Must preserve natural prose and closing advice
      assert.include(spoken, `테스트 사례 ${i + 1}번 작업이 정상적으로 완료되었습니다.`);
      assert.include(spoken, "공식 가이드");
      assert.include(
        spoken,
        `${i + 1}번 항목은 검증이 끝났으니 다음 단계로 바로 넘어가셔도 좋습니다.`,
      );

      // Must contain ZERO code/SQL/table/path/URL/array-index/inline-tag artifacts
      for (const bad of forbiddenTokens) {
        assert.notInclude(
          spoken,
          bad,
          `Sample #${i + 1} leaked forbidden token "${bad}" into TTS: ${spoken}`,
        );
      }
    }
  });

  it("returns empty array when reply consists solely of code or file paths", () => {
    const onlyCode = [
      "```bash",
      "npm run build",
      "```",
      "D:\\__NewAutoUsage\\apps\\server\\src\\server.ts",
      "SELECT * FROM state;",
    ].join("\n");
    assert.deepStrictEqual(sanitizeTextForSpeech(onlyCode), []);
    assert.strictEqual(sanitizeLineForSpeech("| a | b |"), "");
  });

  it("maps Korean Hangul medial vowels to 5-vowel viseme buckets", () => {
    assert.isAbove(charToVisemeWeights("아").a, 0.7);
    assert.isAbove(charToVisemeWeights("이").i, 0.7);
    assert.isAbove(charToVisemeWeights("우").u, 0.7);
    assert.isAbove(charToVisemeWeights("에").e, 0.7);
    assert.isAbove(charToVisemeWeights("오").o, 0.7);
    assert.strictEqual(charToVisemeWeights(" ").silence, 1);
  });
});
