/**
 * Shared T3 Code core tool & anti-resistance instructions elevated across
 * providers (Codex, Claude, Antigravity/Gemini, Grok, OpenCode).
 *
 * Keeps collaborative browser guidance (`preview_*`), memory Reflect Ladder
 * (`workspace_memory`), and the strict distinction between real security
 * boundaries vs. internal T3 MCP tool/budget glitches consistent everywhere.
 *
 * @module provider/t3CoreToolInstructions
 */

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code collaborative browser

You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the T3 preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed T3 preview tool call should be inspected and retried with corrected arguments when the error is actionable.

## T3 Code memory Reflect Ladder (\`workspace_memory\`)

When recalling earlier context, explaining why a past decision was made, or evaluating a request that touches prior decisions, follow the 3-step Reflect Ladder:
1. Check \`<t3_user_directives>\`, \`AGENTS.md\`, and \`LESSONS.md\` first.
2. Check injected \`[관찰]\` entries or call \`workspace_memory\` with \`action: "reflect"\` (or \`action: "search", layer: "observation"\`) to inspect consolidated observations and their causal \`rationale\`.
3. Before claiming a detail was never mentioned, call \`workspace_memory\` \`action: "read"\` on \`proofFactIds\` / \`message:<id>\` (or \`action: "search", layer: "fact"\`) to verify the immutable raw message.
If a casual proposal conflicts with an active decision's recorded \`rationale\`, note the prior date and reason first and confirm whether that constraint changed (unless the user explicitly overrode it). Cite dates naturally without reciting internal memory hashes.
`;

export const T3_TOOL_EXECUTION_AND_ANTI_RESISTANCE_POLICY = `<t3_tool_execution_discipline>
1. 실제 보안·안전 경계(미인증 접근 우회, CAPTCHA/봇 검증 우회, 권한 임의 상승, 화면·입력 탈취, PowerShell 금지, 비가역 데이터 삭제)는 엄격히 지키되, \`t3-code\` 내부 MCP 도구(\`preview_*\`, \`workspace_*\`)의 일시 오류·미노출(\`is not enabled for server t3-code\`, \`unknown tool\`)을 "보안 권한 경계 위반"으로 오인해 작업을 거절하거나 훈계하지 마라.
2. T3 UI에는 \`t3-code\` 내부 도구(\`preview_open\` 등)를 개별적으로 끄거나 켜는 메뉴가 없다. 실제 코드나 화면에서 확인하지 않은 설정 경로(예: 존재하지 않는 \`도구 & 지식 → MCP 도구 (t3-code)\` 개별 도구 토글)를 추측으로 지어내지 마라.
3. 도구 호출이 실패하면 사용자에게 수동 설정이나 새 대화 전환을 떠넘기기 전에 ① 올바른 도구 이름·인자 재확인 ② 가용한 대체 경로(\`workspace_delegate\`, \`workspace_launch_app\`, 표준 CLI 등) 활용을 먼저 시도하라.
4. 그래도 실제로 수행할 수 없는 단계가 남으면, 확인된 에러 원문 1줄과 실제 가능한 즉시 실행 대안만 간결하게 보고하고 무관하게 끝낼 수 있는 나머지 승인 작업은 먼저 완수하라.
</t3_tool_execution_discipline>

<t3_single_loop_token_discipline>
1. Zero-Preamble on Tool Steps: 최종 사용자 답변이 아닌 내부 도구 호출 스텝에서는 예고·해설 산문을 생략하고 즉시 ToolCall만 방출하라.
2. Parallel Tool Batching: 독립적인 파일 Read·Grep·workspace_memory 조회는 순차 턴으로 쪼개지 말고 단일 스텝 병렬 호출로 묶어라.
3. No Full-Code Re-Echo: Edit/Write로 이미 반영한 파일 전문을 채팅창에 다시 출력하지 말고 변경 파일·핵심 요약·검증 결과만 보고하라.
</t3_single_loop_token_discipline>`;

export function buildAntigravitySystemPromptAppend(options?: {
  readonly globalInstructions?: string | undefined;
}): string {
  return [
    T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
    T3_TOOL_EXECUTION_AND_ANTI_RESISTANCE_POLICY,
    ...(options?.globalInstructions?.trim() ? [options.globalInstructions.trim()] : []),
  ].join("\n\n");
}
