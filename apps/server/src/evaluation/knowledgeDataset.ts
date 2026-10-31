import {
  ProjectId,
  WorkspaceKnowledgeItemId,
  type WorkspaceKnowledgeItem,
  type WorkspacePromptComposeInput,
} from "@t3tools/contracts";

export const KNOWLEDGE_DATASET_VERSION = "ko-knowledge-v1";
export const EVALUATION_NOW = "2026-10-23T10:00:00.000Z";
export interface KnowledgeCase {
  readonly id: string;
  readonly category:
    | "semantic"
    | "correction"
    | "temporal"
    | "scope"
    | "exclusion"
    | "history"
    | "code";
  readonly split: "development" | "holdout";
  readonly request: WorkspacePromptComposeInput;
  readonly items: readonly WorkspaceKnowledgeItem[];
  readonly expected: readonly string[];
  readonly forbidden: readonly string[];
  readonly evidenceText?: readonly string[];
}

function source(
  projectId: ProjectId,
  id: string,
  title: string,
  content: string,
  extra: Partial<WorkspaceKnowledgeItem> = {},
): WorkspaceKnowledgeItem {
  return {
    projectId,
    id: WorkspaceKnowledgeItemId.make(id),
    title,
    content,
    kind: "rag-source",
    origin: "user",
    status: "active",
    scope: "project",
    relativeFolder: null,
    tags: [],
    originalChars: null,
    storedChars: null,
    promptUses: 0,
    lastUsedAt: null,
    createdAt: EVALUATION_NOW,
    updatedAt: EVALUATION_NOW,
    ...extra,
  };
}
function research(subject: string, revision = 1, supersedes: string[] = []) {
  return {
    query: subject,
    sources: [`https://example.test/evidence/${encodeURIComponent(subject)}`],
    capturedAt: "2026-10-20T01:00:00.000Z",
    verification: "verified" as const,
    lineage: {
      canonicalId: subject,
      revision,
      supersedes: supersedes.map((id) => WorkspaceKnowledgeItemId.make(id)),
    },
  };
}
const cases: KnowledgeCase[] = [];
function add(
  category: KnowledgeCase["category"],
  index: number,
  task: string,
  build: (p: ProjectId) => Pick<KnowledgeCase, "items" | "expected" | "forbidden" | "evidenceText">,
  request: Partial<WorkspacePromptComposeInput> = {},
) {
  const id = `${category}-${String(index + 1).padStart(2, "0")}`;
  const projectId = ProjectId.make(`eval-${id}`);
  cases.push({
    id,
    category,
    split: index % 4 === 3 ? "holdout" : "development",
    request: { projectId, task, contextMode: "relevant", maxContextChars: 12_000, ...request },
    ...build(projectId),
  });
}

// Paraphrases are paired with independently written evidence, not inserted as search tags.
const semantic: readonly (readonly [string, string, string])[] = [
  [
    "사진을 마우스로 끌어 넣으면 어떻게 첨부돼?",
    "이미지 드롭",
    "탐색기 파일을 대화로 드래그하면 초안의 이미지 첨부로 등록한다.",
  ],
  [
    "인터넷이 끊긴 뒤 작업을 이어가는 방법",
    "연결 복구",
    "네트워크 재접속 시 저장된 실행 상태와 마지막 영수증을 이용해 재개한다.",
  ],
  [
    "똑같은 명령이 두 번 돌아가지 않게 하려면?",
    "실행 멱등성",
    "동일 commandId의 요청은 한 번만 수락하며 중복 receipt를 재사용한다.",
  ],
  [
    "그만하라고 한 뒤 늦게 도착한 응답은?",
    "취소 결과",
    "중단된 작업의 지연 응답은 새 실행을 시작하거나 성공 상태를 덮어쓰지 않는다.",
  ],
  [
    "지난번에 고친 답이 예전 답보다 먼저 나와야 해",
    "정정 우선순위",
    "사용자의 명시적인 수정본이 supersedes로 연결된 이전 기억을 대체한다.",
  ],
  [
    "다음 달 끝낼 일을 이미 끝난 일로 보지 마",
    "계획과 사실",
    "향후 완료 예정이라는 기록은 실제 완료 증거와 구분한다.",
  ],
  [
    "다른 폴더의 자료가 섞이지 않게 해",
    "문맥 격리",
    "프로젝트와 디렉터리 범위에 맞는 지식만 현재 요청에 적용한다.",
  ],
  [
    "답변이 어느 문서에서 나왔는지 찾고 싶어",
    "원문 추적",
    "검색 청크의 출처와 문서 위치 및 버전 정보를 근거에 보존한다.",
  ],
  [
    "긴 대화에서 옛날 결정을 다시 찾으려면?",
    "대화 아카이브",
    "장기 이력의 과거 의사결정은 날짜와 주제를 통해 다시 조회한다.",
  ],
  [
    "쓰는 토큰이 이중으로 계산되는지 확인해",
    "사용량 정산",
    "공급자 이벤트의 고유 식별자로 소비량 중복 집계를 차단한다.",
  ],
  [
    "휴대폰에서 컴퓨터 작업을 이어볼 수 있나?",
    "기기 전환",
    "모바일 클라이언트는 원격 환경의 같은 스레드와 진행 상태를 구독한다.",
  ],
  [
    "컴퓨터를 다시 켜도 앱이 보여야 해",
    "로그인 자동 시작",
    "Windows 로그인 예약 작업이 관리자 데스크톱 창을 비활성 상태로 표시한다.",
  ],
  [
    "창이 다른 작업의 포커스를 가져가면 안 돼",
    "비활성 표시",
    "Electron showInactive는 사용자의 작업 창에 입력 초점을 남긴다.",
  ],
  [
    "파일 선택 창에서 여러 문서를 고르고 싶어",
    "복수 첨부",
    "작성창의 더하기 버튼으로 원본 파일 여덟 개까지 선택할 수 있다.",
  ],
  [
    "사진이 너무 크면 전송 전에 줄여줘",
    "이미지 압축",
    "전송 바이트 제한을 초과하는 그림은 해상도를 낮춰 인코딩한다.",
  ],
  [
    "엑셀 문서의 내용도 찾아볼 수 있어?",
    "스프레드시트 색인",
    "XLSX의 시트와 셀 텍스트를 문서 검색 청크로 변환한다.",
  ],
  [
    "PDF 몇 쪽의 말인지 보여줘",
    "문서 위치",
    "첨부 자료의 페이지 번호를 원문 인용 정보에 기록한다.",
  ],
  [
    "AI가 만든 제안이 확정된 사실로 쓰이면 안 돼",
    "검증 상태",
    "에이전트 가설에는 unverified 표시를 유지하고 독립 근거가 있어야 확정한다.",
  ],
  [
    "한 번 실패한 똑같은 수리를 반복하지 마",
    "복구 장벽",
    "동일 코드 지문에 같은 전략을 재시도하려면 새로운 관찰 증거가 필요하다.",
  ],
  [
    "서버가 응답했는데 명령이 전달됐는지 모르겠어",
    "전달 불명",
    "수락 여부를 확인할 수 없는 제출은 delivery-unknown 상태로 남기며 자동 재실행하지 않는다.",
  ],
  [
    "예전 버전 설명과 현재 코드를 구분해",
    "소프트웨어 버전",
    "canonicalId와 revision 및 유효 기간으로 현재 구현 근거를 선택한다.",
  ],
  [
    "삭제한 내용이 검색에 계속 나오면 안 돼",
    "색인 삭제",
    "원본 항목을 제거하면 파생 검색 청크와 벡터 참조를 함께 정리한다.",
  ],
  [
    "비밀번호 같은 설정을 건드리지 않고 시험해",
    "격리 검증",
    "별도 데이터 홈과 읽기 전용 스냅샷으로 후보 프로그램을 테스트한다.",
  ],
  [
    "질문 모드를 켰는데 실행으로 바뀌면 안 돼",
    "요청 모드 유지",
    "사용자가 선택한 질문하기와 계획 및 권한 값을 작업 전환 때 그대로 전달한다.",
  ],
  [
    "추가 설명 없이 파일만 AI에 보낼 수 있어?",
    "파일 단독 전송",
    "메시지 본문이 비어 있어도 첨부 자료가 있으면 전송할 수 있다.",
  ],
  [
    "브라우저가 원격 PC의 경로를 직접 알 필요 없지?",
    "원격 업로드",
    "클라이언트의 파일 바이트를 실행 환경으로 업로드해 에이전트가 읽는다.",
  ],
  [
    "일 끝나면 다시 열어서 이어갈 수 있게 해",
    "대화 재개",
    "완료 처리한 스레드는 다시 열어 기존 대화 기록을 보존한 채 계속할 수 있다.",
  ],
  [
    "모델 설치가 안 됐을 때도 자료를 찾고 싶어",
    "검색 대체 경로",
    "임베딩 모델이 없으면 키워드 FTS 검색을 유지하고 설치 오류를 안내한다.",
  ],
  [
    "느려진 검색을 숫자로 비교하고 싶어",
    "성능 측정",
    "동일 조건의 응답 지연 중앙값과 95백분위 및 입력 토큰 수를 기록한다.",
  ],
  [
    "대화 내용을 잃지 않고 새 버전을 적용해",
    "프로그램 교체",
    "검증한 후보만 운영에 반영하고 기존 데이터 홈과 사용자 설정을 보존한다.",
  ],
];
semantic.forEach(([task, title, content], i) =>
  add("semantic", i, task, (p) => ({
    items: [
      source(p, "answer", title, content),
      source(p, "noise", "식당 예약", "저녁 식사 예약 인원은 네 명이다."),
    ],
    expected: ["answer"],
    forbidden: ["noise"],
  })),
);

const subjects = [
  "사진 첨부",
  "검색 모델",
  "단축키",
  "취소 기한",
  "토큰 집계",
  "문서 색인",
  "원격 접속",
  "로그인 실행",
  "계획 모드",
  "권한 선택",
  "파일 용량",
  "대화 복구",
  "프로젝트 분리",
  "공용 기억",
  "이미지 미리보기",
  "모바일 연결",
  "원문 인용",
  "실행 영수증",
  "검증 보고서",
  "코드 버전",
];
subjects.forEach((subject, i) =>
  add("correction", i, `${subject}의 현재 기준은 무엇인가?`, (p) => ({
    items: [
      source(p, "old", subject, `${subject}의 이전 기준은 구형 설정이다.`, {
        research: research(subject),
      }),
      source(p, "new", subject, `${subject}의 정정된 기준은 새 설정이다.`, {
        research: research(subject, 2, ["old"]),
      }),
    ],
    expected: ["new"],
    forbidden: ["old"],
    evidenceText: [research(subject).sources[0]!],
  })),
);
subjects.forEach((subject, i) =>
  add("temporal", i, `${subject}의 지금 적용되는 기록을 확인해`, (p) => {
    const current = research(subject);
    const future = {
      ...research(subject, 2),
      lineage: {
        ...research(subject, 2).lineage,
        validFrom: "2026-11-01T00:00:00.000Z",
        supersedes: [WorkspaceKnowledgeItemId.make("current")],
      },
    };
    return {
      items: [
        source(
          p,
          "current",
          subject,
          `${subject}은 다음 달 완료 예정이다. 실제 완료 기록은 없다.`,
          { research: current },
        ),
        source(p, "future", subject, `${subject}의 새 규칙은 11월부터 적용된다.`, {
          research: future,
        }),
      ],
      expected: ["current"],
      forbidden: ["future"],
      evidenceText: [current.capturedAt, "예정·계획을 완료 사실로 바꾸지"],
    };
  }),
);
subjects.forEach((subject, i) =>
  add(
    "scope",
    i,
    `${subject}의 폴더 지침을 찾아줘`,
    (p) => ({
      items: [
        source(p, "allowed", subject, `${subject}의 해당 폴더 근거다.`, {
          scope: "folder",
          appliesToFolder: "apps/web",
        }),
        source(p, "sibling", subject, `${subject}의 형제 폴더 비공개 자료다.`, {
          scope: "folder",
          appliesToFolder: "apps/web-extra",
        }),
        source(
          ProjectId.make(`foreign-${p}`),
          "foreign",
          subject,
          `${subject}의 다른 프로젝트 자료다.`,
        ),
      ],
      expected: ["allowed"],
      forbidden: ["sibling", "foreign"],
    }),
    { contextPaths: [i % 2 ? "apps\\web\\src" : "apps/web/src"] },
  ),
);
subjects.slice(0, 10).forEach((subject, i) =>
  add("exclusion", i, `${subject}의 활성 자료를 검색해`, (p) => ({
    items: [
      source(p, "active", subject, `${subject}의 활성 자료를 유지한다.`),
      source(p, "archived", subject, `${subject}의 폐기 자료다.`, { status: "archived" }),
      source(p, "candidate", subject, `${subject}의 미승인 자료다.`, { status: "candidate" }),
    ],
    expected: ["active"],
    forbidden: ["archived", "candidate"],
  })),
);
subjects.slice(0, 10).forEach((subject, i) =>
  add(
    "history",
    i,
    `${subject}의 과거와 현재 변경 이력을 비교해`,
    (p) => ({
      items: [
        source(
          p,
          "historic",
          subject,
          `${subject}의 과거 결정이다.\n` +
            "관계없는 오래된 회의 기록.\n".repeat(250) +
            `${subject}의 마지막 원문 근거다.`,
          { research: research(subject) },
        ),
        source(p, "current", subject, `${subject}의 현재 결정이다.`, {
          research: research(subject, 2, ["historic"]),
        }),
      ],
      expected: ["historic", "current"],
      forbidden: [],
      evidenceText: ["과거 기록"],
    }),
    { includeHistory: true, maxChunksPerItem: 3 },
  ),
);
const codeSubjects = [
  "readDesktopDrop",
  "composeWorkspacePrompt",
  "semanticSearch",
  "ProviderCommandReactor",
  "ProjectionWorkspaceRag",
  "OllamaEmbeddings",
  "WorkspaceAgentExecutor",
  "ChatComposer",
  "WorkspaceDevelopment",
  "TokenUsageProjection",
];
codeSubjects.forEach((subject, i) =>
  add("code", i, `${subject}의 현재 코드와 원본 근거를 확인해`, (p) => ({
    items: [
      source(p, "v1", subject, `${subject}의 폐기된 구현은 v1이다.`, {
        research: research(subject),
      }),
      source(p, "v2", subject, `${subject}의 현재 구현은 v2이다.`, {
        research: {
          ...research(subject, 2, ["v1"]),
          lineage: {
            ...research(subject, 2, ["v1"]).lineage,
            evidenceRefs: [`repo://source/${subject}.ts#v2`],
          },
        },
      }),
    ],
    expected: ["v2"],
    forbidden: ["v1"],
    evidenceText: [`repo://source/${subject}.ts#v2`],
  })),
);

export const knowledgeCases: readonly KnowledgeCase[] = cases;
