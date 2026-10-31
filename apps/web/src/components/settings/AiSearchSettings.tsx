import { useEffect, useState } from "react";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsSection, SettingsRow } from "./settingsLayout";

export function AiSearchSettingsSection() {
  const settings = usePrimarySettings();
  const update = useUpdatePrimarySettings();
  const [draft, setDraft] = useState(settings.aiSearch);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(settings.aiSearch), [settings.aiSearch]);
  const save = () => {
    try {
      const endpoint = new URL(draft.embeddingEndpoint);
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
        !["http:", "https:"].includes(endpoint.protocol)
      )
        throw new Error("임베딩 주소는 서버 환경의 localhost HTTP 주소여야 합니다.");
      if (!draft.embeddingModel.trim() || !draft.researchModel.trim())
        throw new Error("모델 이름을 입력하세요.");
      if (
        !Number.isInteger(draft.researchMaxTurns) ||
        draft.researchMaxTurns < 1 ||
        draft.researchMaxTurns > 8
      )
        throw new Error("조사 호출 단계는 1–8로 설정하세요.");
      update({ aiSearch: draft });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "설정 값을 확인하세요.");
    }
  };
  return (
    <SettingsSection title="AI 문서 검색과 조사" id="ai-search">
      <SettingsRow
        title="키워드 + 로컬 의미 검색"
        description="Ollama 임베딩을 이용합니다. 연결할 수 없으면 키워드 검색을 유지합니다. 원격 연결에서도 서버가 문서를 처리합니다."
        control={
          <Switch
            checked={draft.semanticEnabled}
            onCheckedChange={(value) => setDraft({ ...draft, semanticEnabled: value })}
          />
        }
      />
      <SettingsRow
        title="스캔 PDF 로컬 OCR"
        description="한국어·영어를 인식하고 표의 열 간격을 보존합니다. 문서당 최대 12페이지이며 인식 결과와 원본을 함께 보관합니다."
        control={
          <Switch
            checked={draft.ocrEnabled}
            onCheckedChange={(value) => setDraft({ ...draft, ocrEnabled: value })}
          />
        }
      />
      <SettingsRow
        title="로컬 임베딩 주소"
        description="이 서버가 실행 중인 환경의 Ollama HTTP 주소입니다."
        control={
          <Input
            aria-label="로컬 임베딩 주소"
            value={draft.embeddingEndpoint}
            onChange={(event) =>
              setDraft({ ...draft, embeddingEndpoint: event.currentTarget.value })
            }
          />
        }
      />
      <SettingsRow
        title="동일 문서 추출 결과 재사용"
        description="같은 프로젝트에서 원본과 추출 설정이 같을 때 재사용합니다. 원본이 바뀌거나 부분 추출이면 다시 처리합니다. Claude·Codex 등 모든 AI에 적용됩니다."
        control={
          <Switch
            checked={draft.documentCacheEnabled !== false}
            onCheckedChange={(value) => setDraft({ ...draft, documentCacheEnabled: value })}
          />
        }
      />
      <SettingsRow
        title="문서 캐시 새로고침"
        description="다음 첨부부터 다시 추출합니다. 기존 대화와 근거 파일은 보존됩니다."
        control={
          <Button
            onClick={() => {
              const epoch = (draft.documentCacheEpoch ?? 0) + 1;
              setDraft({ ...draft, documentCacheEpoch: epoch });
              update({ aiSearch: { documentCacheEpoch: epoch } });
            }}
          >
            새로고침
          </Button>
        }
      />
      <SettingsRow
        title="임베딩 모델"
        description="Ollama에 설치된 문서 검색용 임베딩 모델입니다."
        control={
          <Input
            aria-label="임베딩 모델"
            value={draft.embeddingModel}
            onChange={(event) => setDraft({ ...draft, embeddingModel: event.currentTarget.value })}
          />
        }
      />
      <SettingsRow
        title="Grok 조사 모델"
        description="프로젝트의 지식·RAG 화면에서 API 키, 출처 필터와 비용 상한을 설정하고 조사합니다."
        control={
          <Input
            aria-label="Grok 조사 모델"
            value={draft.researchModel}
            onChange={(event) => setDraft({ ...draft, researchModel: event.currentTarget.value })}
          />
        }
      />
      <SettingsRow
        title="조사 단계 상한"
        description="한 조사 호출에서 Grok이 반복하는 단계 수를 제한합니다."
        control={
          <Input
            type="number"
            min={1}
            max={8}
            aria-label="조사 단계 상한"
            value={draft.researchMaxTurns}
            onChange={(event) =>
              setDraft({ ...draft, researchMaxTurns: Number(event.currentTarget.value) })
            }
          />
        }
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button onClick={save}>AI 검색 설정 저장</Button>
    </SettingsSection>
  );
}
