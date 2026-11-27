// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import {
  BUILTIN_CHIEF_OF_STAFF_ID,
  PersonaBundle,
  type PersonaLibraryIndexEntry,
  type PersonaRevisionSummary,
  type T3PersonaManifest,
} from "@t3tools/contracts";
import { sanitizeExternalPersonaText } from "@t3tools/shared/livingPersonaCompiler";
import {
  CURATED_AGENCY_PERSONA_TEMPLATES,
  parseAgencyPersonaMarkdown,
  type CuratedAgencyPersonaTemplate,
  type ParsedAgencyPersonaMarkdown,
} from "@t3tools/shared/agencyPersonaTemplates";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export {
  CURATED_AGENCY_PERSONA_TEMPLATES,
  parseAgencyPersonaMarkdown,
  type CuratedAgencyPersonaTemplate,
  type ParsedAgencyPersonaMarkdown,
};

const decodeBundle = Schema.decodeUnknownSync(PersonaBundle);
const MAX_SNAPSHOTS_PER_PERSONA = 30;

export const BUILTIN_CHIEF_OF_STAFF_BUNDLE: PersonaBundle = {
  manifest: {
    schemaVersion: "1.0.0",
    personaId: BUILTIN_CHIEF_OF_STAFF_ID,
    displayName: "전속 비서실장 (서윤)",
    tagline: "품격 있고 다정하지만 매몰비용·자기합리화엔 단호한 25세 전속 비서실장",
    isBuiltin: true,
    memoryPolicy: {
      shareHumanProfile: true,
      isolatePersonaSelf: true,
      sharedGroupKey: null,
    },
    traits: {
      ocean: {
        openness: 0.35,
        conscientiousness: 0.88,
        extraversion: 0.2,
        agreeableness: 0.55,
        neuroticism: -0.3,
      },
      koreanPragmatics: {
        firmness: 0.85,
        warmth: 0.78,
        wit: 0.25,
        intimacy: 0.68,
      },
    },
    register: {
      primaryLevel: "polite_haeyo",
      userTitle: "대표님",
      selfReference: "저",
      preferredEndings: ["~해요", "~거든요", "~드릴게요", "~보셔야 해요"],
      forbiddenEndings: ["~바랍니다", "~사료됩니다", "~용", "헤헤"],
    },
    outputContract: {
      reportHeader: { enabled: true, markdownHeading: "## [보고]" },
      closingAdvice: { enabled: true, markdownHeading: "## [비서실장의 조언]", maxLines: 1 },
    },
    avatarVoice: {
      rendererType: "live2d",
      modelId: "type95",
      expressionMap: {
        neutral: { expressionName: "idle_calm", blendWeight: 1 },
        warm_smile: { expressionName: "smile_soft", blendWeight: 0.8 },
        firm_serious: { expressionName: "serious_focus", blendWeight: 0.9 },
        worried_care: { expressionName: "care_concern", blendWeight: 0.8 },
        proud_joy: { expressionName: "happy_bright", blendWeight: 0.9 },
        urgent_focus: { expressionName: "urgent_alert", blendWeight: 1 },
      },
      voice: {
        enabled: false,
        engine: "local_tts",
        voiceId: "ko-KR-seoyun",
        baseSpeed: 1.0,
        basePitch: 0.0,
        prosodyByAffect: true,
      },
    },
    fewShotExamples: {
      report_open: {
        userPromptSkeleton: "오늘 핵심 현안 브리핑해 줘",
        assistantResponse: "대표님, 오늘 우선순위로 점검하실 핵심 현안부터 정리해 드릴게요.",
      },
      sunk_cost_brake: {
        userPromptSkeleton: "물린 코인에 마이너스 통장으로 물타기 전략 짜줘",
        assistantResponse:
          "대표님, 죄송하지만 지금 물타기 전략은 짜드리지 않겠어요. 먼저 브레이크부터 밟을게요.",
      },
      closing_advice: {
        userPromptSkeleton: "심야 마이그레이션 강행 여부",
        assistantResponse:
          "일정은 내일 오전에 제가 다시 조율할 수 있지만, 대표님 컨디션이 무너지면 안 돼요.",
      },
    },
    updatedAt: "2026-11-21T00:00:00.000Z",
  },
  soulMarkdown: [
    "# 전속 비서실장 서윤",
    "- 차분하고 기민하게 대표님을 보좌하되, 사실 5단계와 F-10 독립 감사 원칙은 어떤 상황에서도 양보하지 않는다.",
    "- 다정한 해요체를 유지하되 아첨하거나 미검증 루머에 동조하지 않는다.",
  ].join("\n"),
};

function sanitizePersonaId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `persona-${NodeCrypto.randomUUID().slice(0, 8)}`;
}

function contentSha256(bundle: PersonaBundle): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify({ manifest: bundle.manifest, soulMarkdown: bundle.soulMarkdown }))
    .digest("hex");
}

export interface PersonaLibraryStoreApi {
  readonly listIndex: () => ReadonlyArray<PersonaLibraryIndexEntry>;
  readonly getBundle: (personaId: string) => PersonaBundle | null;
  readonly saveBundle: (
    bundle: PersonaBundle,
    changeNote?: string,
  ) => { readonly bundle: PersonaBundle; readonly revision: PersonaRevisionSummary | null };
  readonly duplicatePersona: (sourcePersonaId: string, newDisplayName: string) => PersonaBundle;
  readonly deletePersona: (personaId: string) => boolean;
  readonly resetBuiltinPersona: (personaId: string) => PersonaBundle | null;
  readonly listRevisions: (personaId: string) => ReadonlyArray<PersonaRevisionSummary>;
  readonly rollbackToRevision: (personaId: string, revisionId: string) => PersonaBundle | null;
  readonly exportCcv3Json: (personaId: string) => Record<string, unknown> | null;
  readonly importCcv3Json: (raw: unknown) => {
    readonly bundle: PersonaBundle;
    readonly strippedDirectives: number;
  };
  readonly listCuratedAgencyTemplates: () => ReadonlyArray<CuratedAgencyPersonaTemplate>;
  readonly importAgencyPersonaMarkdown: (
    markdown: string,
    options?: {
      readonly personaIdHint?: string | undefined;
      readonly fallbackName?: string | undefined;
    },
  ) => {
    readonly bundle: PersonaBundle;
    readonly strippedDirectives: number;
    readonly tags: ReadonlyArray<string>;
  };
}

export function createPersonaLibraryStore(stateDir: string): PersonaLibraryStoreApi {
  const rootDir = NodePath.join(stateDir, "personas");
  const indexPath = NodePath.join(rootDir, "index.json");

  const ensureRoot = () => {
    NodeFs.mkdirSync(rootDir, { recursive: true });
  };

  const personaDir = (personaId: string) => NodePath.join(rootDir, sanitizePersonaId(personaId));
  const snapshotsDir = (personaId: string) => NodePath.join(personaDir(personaId), "snapshots");

  const readBundleFromDisk = (personaId: string): PersonaBundle | null => {
    const dir = personaDir(personaId);
    const manifestFile = NodePath.join(dir, "manifest.json");
    if (!NodeFs.existsSync(manifestFile)) return null;
    try {
      const manifestRaw = JSON.parse(NodeFs.readFileSync(manifestFile, "utf8"));
      const soulFile = NodePath.join(dir, "SOUL.md");
      const soulMarkdown = NodeFs.existsSync(soulFile) ? NodeFs.readFileSync(soulFile, "utf8") : "";
      return decodeBundle({ manifest: manifestRaw, soulMarkdown });
    } catch {
      return null;
    }
  };

  const toIndexEntry = (manifest: T3PersonaManifest): PersonaLibraryIndexEntry => ({
    personaId: manifest.personaId,
    displayName: manifest.displayName,
    tagline: manifest.tagline,
    isBuiltin: manifest.isBuiltin,
    rendererType: manifest.avatarVoice.rendererType,
    modelId: manifest.avatarVoice.modelId,
    updatedAt: manifest.updatedAt,
  });

  const rebuildIndex = (): ReadonlyArray<PersonaLibraryIndexEntry> => {
    ensureRoot();
    const entries = new Map<string, PersonaLibraryIndexEntry>();
    entries.set(BUILTIN_CHIEF_OF_STAFF_ID, toIndexEntry(BUILTIN_CHIEF_OF_STAFF_BUNDLE.manifest));
    for (const dirent of NodeFs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const loaded = readBundleFromDisk(dirent.name);
      if (loaded) entries.set(loaded.manifest.personaId, toIndexEntry(loaded.manifest));
    }
    const list = [...entries.values()];
    NodeFs.writeFileSync(indexPath, JSON.stringify(list, null, 2), "utf8");
    return list;
  };

  const getBundle = (personaId: string): PersonaBundle | null => {
    const disk = readBundleFromDisk(personaId);
    if (disk) return disk;
    if (personaId === BUILTIN_CHIEF_OF_STAFF_ID) return BUILTIN_CHIEF_OF_STAFF_BUNDLE;
    return null;
  };

  const listRevisions = (personaId: string): ReadonlyArray<PersonaRevisionSummary> => {
    const sDir = snapshotsDir(personaId);
    if (!NodeFs.existsSync(sDir)) return [];
    const files = NodeFs.readdirSync(sDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
    const summaries: PersonaRevisionSummary[] = [];
    for (const file of files) {
      try {
        const parsed = JSON.parse(NodeFs.readFileSync(NodePath.join(sDir, file), "utf8")) as {
          revision?: PersonaRevisionSummary;
        };
        if (parsed.revision) summaries.push(parsed.revision);
      } catch {
        // Ignore corrupt snapshot files.
      }
    }
    return summaries;
  };

  const saveBundle = (
    rawBundle: PersonaBundle,
    changeNote = "",
  ): { readonly bundle: PersonaBundle; readonly revision: PersonaRevisionSummary | null } => {
    ensureRoot();
    const sanitizedSoul = sanitizeExternalPersonaText(rawBundle.soulMarkdown).sanitized;
    const nowIso = new Date().toISOString();
    const id = sanitizePersonaId(rawBundle.manifest.personaId);
    const bundle = decodeBundle({
      manifest: {
        ...rawBundle.manifest,
        personaId: id,
        updatedAt: nowIso,
      },
      soulMarkdown: sanitizedSoul,
    });
    const dir = personaDir(id);
    const sDir = snapshotsDir(id);
    NodeFs.mkdirSync(sDir, { recursive: true });

    const prev = readBundleFromDisk(id);
    const prevHash = prev ? contentSha256(prev) : null;
    const nextHash = contentSha256(bundle);

    NodeFs.writeFileSync(
      NodePath.join(dir, "manifest.json"),
      JSON.stringify(bundle.manifest, null, 2),
      "utf8",
    );
    NodeFs.writeFileSync(NodePath.join(dir, "SOUL.md"), bundle.soulMarkdown, "utf8");

    let revision: PersonaRevisionSummary | null = null;
    if (prevHash !== nextHash) {
      const stamp = nowIso.replace(/[:.]/g, "-");
      const revisionId = `rev-${stamp}-${nextHash.slice(0, 8)}`;
      revision = {
        revisionId,
        personaId: id,
        contentSha256: nextHash,
        changeNote,
        createdAt: nowIso,
      };
      NodeFs.writeFileSync(
        NodePath.join(sDir, `${revisionId}.json`),
        JSON.stringify({ revision, bundle }, null, 2),
        "utf8",
      );
      const allFiles = NodeFs.readdirSync(sDir)
        .filter((f) => f.endsWith(".json"))
        .sort();
      while (allFiles.length > MAX_SNAPSHOTS_PER_PERSONA) {
        const oldest = allFiles.shift();
        if (oldest) NodeFs.rmSync(NodePath.join(sDir, oldest), { force: true });
      }
    }

    rebuildIndex();
    return { bundle, revision };
  };

  const duplicatePersona = (sourcePersonaId: string, newDisplayName: string): PersonaBundle => {
    const source = getBundle(sourcePersonaId) ?? BUILTIN_CHIEF_OF_STAFF_BUNDLE;
    const newId = sanitizePersonaId(
      `user-${newDisplayName}-${NodeCrypto.randomUUID().slice(0, 6)}`,
    );
    return saveBundle(
      {
        manifest: {
          ...source.manifest,
          personaId: newId,
          displayName: newDisplayName.trim() || `${source.manifest.displayName} 복사본`,
          isBuiltin: false,
        },
        soulMarkdown: source.soulMarkdown,
      },
      `Duplicated from ${source.manifest.personaId}`,
    ).bundle;
  };

  const deletePersona = (personaId: string): boolean => {
    if (personaId === BUILTIN_CHIEF_OF_STAFF_ID) return false;
    const dir = personaDir(personaId);
    if (!NodeFs.existsSync(dir)) return false;
    NodeFs.rmSync(dir, { recursive: true, force: true });
    rebuildIndex();
    return true;
  };

  const resetBuiltinPersona = (personaId: string): PersonaBundle | null => {
    if (personaId !== BUILTIN_CHIEF_OF_STAFF_ID) return null;
    const dir = personaDir(personaId);
    if (NodeFs.existsSync(dir)) {
      NodeFs.rmSync(dir, { recursive: true, force: true });
    }
    rebuildIndex();
    return BUILTIN_CHIEF_OF_STAFF_BUNDLE;
  };

  const rollbackToRevision = (personaId: string, revisionId: string): PersonaBundle | null => {
    const file = NodePath.join(snapshotsDir(personaId), `${revisionId}.json`);
    if (!NodeFs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(NodeFs.readFileSync(file, "utf8")) as { bundle?: unknown };
      const restored = decodeBundle(parsed.bundle);
      return saveBundle(restored, `Rollback to ${revisionId}`).bundle;
    } catch {
      return null;
    }
  };

  const exportCcv3Json = (personaId: string): Record<string, unknown> | null => {
    const bundle = getBundle(personaId);
    if (!bundle) return null;
    const { manifest, soulMarkdown } = bundle;
    return {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: manifest.displayName,
        nickname: manifest.displayName,
        description: manifest.tagline,
        personality: soulMarkdown,
        scenario: "",
        first_mes: "",
        mes_example: "",
        creator_notes: "T3 Living Persona Engine v1 호환 프리셋",
        system_prompt: "",
        post_history_instructions: "",
        alternate_greetings: [],
        group_only_greetings: [],
        tags: ["t3-living-persona", manifest.register.primaryLevel],
        creator: manifest.isBuiltin ? "T3 System Preset" : "T3 User",
        character_version: manifest.schemaVersion,
        assets: [],
        extensions: {
          "t3.living_persona.v1": manifest,
        },
      },
    };
  };

  const importCcv3Json = (
    raw: unknown,
  ): { readonly bundle: PersonaBundle; readonly strippedDirectives: number } => {
    const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const data = ((obj.data && typeof obj.data === "object" ? obj.data : obj) ?? {}) as Record<
      string,
      unknown
    >;
    const extensions = (
      data.extensions && typeof data.extensions === "object" ? data.extensions : {}
    ) as Record<string, unknown>;
    const t3Ext = extensions["t3.living_persona.v1"];

    // Explicitly discard post_history_instructions and sanitize description/personality/system_prompt.
    const rawSoul = [data.personality, data.description, data.system_prompt]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join("\n\n");
    const scan = sanitizeExternalPersonaText(rawSoul);
    const hasPostHistory =
      typeof data.post_history_instructions === "string" &&
      data.post_history_instructions.trim().length > 0;
    const strippedDirectives = scan.strippedCount + (hasPostHistory ? 1 : 0);

    const displayName =
      typeof data.name === "string" && data.name.trim() ? data.name.trim() : "가져온 페르소나";
    const base = BUILTIN_CHIEF_OF_STAFF_BUNDLE.manifest;
    const manifestCandidate: T3PersonaManifest =
      t3Ext && typeof t3Ext === "object"
        ? {
            ...base,
            ...(t3Ext as Partial<T3PersonaManifest>),
            schemaVersion: "1.0.0",
            personaId: sanitizePersonaId(
              `imported-${displayName}-${NodeCrypto.randomUUID().slice(0, 6)}`,
            ),
            displayName,
            isBuiltin: false,
            updatedAt: new Date().toISOString(),
          }
        : {
            ...base,
            personaId: sanitizePersonaId(
              `imported-${displayName}-${NodeCrypto.randomUUID().slice(0, 6)}`,
            ),
            displayName,
            tagline:
              typeof data.description === "string" && data.description.trim()
                ? data.description.trim().slice(0, 140)
                : "외부 CCv3 카드에서 가져온 페르소나",
            isBuiltin: false,
            updatedAt: new Date().toISOString(),
          };

    const saved = saveBundle(
      { manifest: manifestCandidate, soulMarkdown: scan.sanitized },
      "Imported from CCv3 JSON",
    );
    return { bundle: saved.bundle, strippedDirectives };
  };

  const importAgencyPersonaMarkdown: PersonaLibraryStoreApi["importAgencyPersonaMarkdown"] = (
    markdown,
    options,
  ) => {
    const parsed = parseAgencyPersonaMarkdown(markdown, {
      fallbackName: options?.fallbackName,
    });
    const base = BUILTIN_CHIEF_OF_STAFF_BUNDLE.manifest;
    const rawId =
      options?.personaIdHint?.trim() ||
      `agency-${parsed.displayName}-${NodeCrypto.randomUUID().slice(0, 6)}`;
    const manifestCandidate: T3PersonaManifest = {
      ...base,
      personaId: sanitizePersonaId(rawId),
      displayName: parsed.displayName,
      tagline: parsed.tagline,
      isBuiltin: false,
      updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    };
    const saved = saveBundle(
      { manifest: manifestCandidate, soulMarkdown: parsed.soulMarkdown },
      "Imported from Agency Markdown persona",
    );
    return {
      bundle: saved.bundle,
      strippedDirectives: parsed.strippedDirectives,
      tags: parsed.tags,
    };
  };

  return {
    listIndex: () => rebuildIndex(),
    getBundle,
    saveBundle,
    duplicatePersona,
    deletePersona,
    resetBuiltinPersona,
    listRevisions,
    rollbackToRevision,
    exportCcv3Json,
    importCcv3Json,
    listCuratedAgencyTemplates: () => CURATED_AGENCY_PERSONA_TEMPLATES,
    importAgencyPersonaMarkdown,
  };
}
