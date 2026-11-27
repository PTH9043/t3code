import { MessageId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { deriveResponseStyleUiProfile } from "@t3tools/client-runtime/state/response-style-presentation";
import { type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { ThreadTurnViewer } from "./ThreadTurnViewer";

const now = "2026-01-01T12:00:00Z";
const current = TurnId.make("current");
const answer =
  "매출은 늘었습니다. [확인 완료] 원가는 미정입니다. [검증 필요] [검증 필요]\n\n## [비서실장의 조언]\n계약부터 검토하십시오. 이후 보강합니다.\n";
const base: ComponentProps<typeof ThreadTurnViewer> = {
  thread: {
    id: ThreadId.make("room"),
    latestTurn: {
      turnId: current,
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: MessageId.make("answer"),
    },
    session: null,
    activities: [],
    messages: [
      {
        id: MessageId.make("answer"),
        role: "assistant",
        text: answer,
        turnId: current,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
  },
  nextModel: { instanceId: ProviderInstanceId.make("account"), model: "next-model" },
  checkpoints: [],
  blocks: new Map(),
  workLog: [],
  pendingApprovals: [],
};
const blank = { tone: "", length: "", explanation: "", instructions: "" };
const executive = deriveResponseStyleUiProfile(
  { style: { ...blank, preset: "professional", instructions: "최고 비서실장으로서 보고하세요." } },
  "thread",
);
const render = (props: Partial<typeof base> = {}) =>
  renderToStaticMarkup(<ThreadTurnViewer {...base} {...props} />);

it("names the style configured now, or says none is set", () => {
  expect(render()).toContain("<dt>현재 답변 스타일</dt><dd>미설정</dd>");
  expect(render({ responseStyleProfile: executive })).toContain(
    "<dt>현재 답변 스타일</dt><dd>이 방 전용 · 최고 비서실장 · 전문</dd>",
  );
  expect(
    render({
      responseStyleProfile: deriveResponseStyleUiProfile(
        { style: { ...blank, preset: "concise" } },
        "global",
      ),
    }),
  ).toContain("<dd>전역 스타일 · 간결 브리핑</dd>");
});

it("shows the advice teaser and status tally above the full executive answer", () => {
  const html = render({ responseStyleProfile: executive });
  expect(html).toContain("비서실장의 조언 · </span>계약부터 검토하십시오.</p>");
  expect(html).toContain(">확인 완료 1 · 검증 필요 2</p>");
  expect(html.indexOf('aria-label="응답 요약"')).toBeLessThan(html.indexOf("<summary>응답 결과"));
  expect(html).toContain(
    '<details><summary>응답 결과</summary><p class="whitespace-pre-wrap break-words">매출은 늘었습니다. [확인 완료]',
  );
  expect(html).toContain("이후 보강합니다.");
});

it("leaves the viewer as before for other styles and answers without advice", () => {
  const standard = render();
  expect(standard).not.toContain("응답 요약");
  expect(standard).toContain("<summary>응답 결과</summary>");
  const withoutAdvice = render({
    responseStyleProfile: executive,
    thread: {
      ...base.thread,
      messages: base.thread.messages.map((message) => ({
        ...message,
        text: "결과입니다. [확인 완료]",
      })),
    },
  });
  expect(withoutAdvice).not.toContain("응답 요약");
  expect(withoutAdvice).toContain("결과입니다. [확인 완료]");
});

it("keeps only the style row different between the default and an unrelated style", () => {
  const concise = render({
    responseStyleProfile: deriveResponseStyleUiProfile(
      { style: { ...blank, preset: "concise" } },
      "global",
    ),
  });
  expect(concise.replace("<dd>전역 스타일 · 간결 브리핑</dd>", "<dd>미설정</dd>")).toBe(render());
});
