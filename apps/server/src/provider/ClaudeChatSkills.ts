import { WorkspaceWorkflowError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  makeWorkflowSkills,
  parseWorkflowSkill,
  workflowSkillSupport,
} from "../orchestration/WorkflowSkills.ts";

const encodePluginManifest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String })),
);

/** One SDK plugin per conversation; installed skills never share another thread's directory. */
export const makeClaudeChatSkillPlugin = Effect.fn("makeClaudeChatSkillPlugin")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workflow = yield* makeWorkflowSkills;
  const parent = path.join(stateDir, "claude-chat-skills");
  yield* fs.makeDirectory(parent, { recursive: true });
  const root = yield* fs.makeTempDirectory({ directory: parent, prefix: "session-" });
  const name = `t3-chat-${path.basename(root).slice("session-".length).toLowerCase()}`;
  const dispose = fs
    .remove(root, { recursive: true, force: true })
    .pipe(Effect.retry(Schedule.max([Schedule.exponential("100 millis"), Schedule.recurs(4)])));
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(path.join(root, ".claude-plugin"), { recursive: true });
    yield* fs.makeDirectory(path.join(root, "skills"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, ".claude-plugin", "plugin.json"),
      encodePluginManifest({ name, version: "1.0.0" }),
    );
  }).pipe(Effect.onError(() => dispose.pipe(Effect.ignore)));
  const lock = yield* Semaphore.make(1);
  const installed = new Map<string, string>();

  const install = (
    skills: ReadonlyArray<{ name: string; path: string }>,
    policy: { runtimeMode: string; model: string; allowAdditionalWorkers: boolean },
    canReplace: boolean,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const result: Array<{ qualifiedName: string; manualOnly: boolean }> = [];
        for (const skill of skills) {
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(skill.name))
            return yield* new WorkspaceWorkflowError({ message: "Claude 스킬 이름을 확인하세요." });
          const source = yield* workflow.manifest(skill.path);
          const contents = yield* fs.readFileString(skill.path);
          const metadata = yield* Effect.try({
            try: () => parseWorkflowSkill(contents, skill.name),
            catch: (cause) =>
              new WorkspaceWorkflowError({ message: "스킬 설정을 읽지 못했습니다.", cause }),
          });
          if (metadata.name !== skill.name)
            return yield* new WorkspaceWorkflowError({
              message: "선택한 스킬 이름이 변경되었습니다. 다시 선택하세요.",
            });
          const unsupported = workflowSkillSupport(metadata, "native", "claudeAgent", policy);
          if (unsupported) return yield* new WorkspaceWorkflowError({ message: unsupported });
          const existing = installed.get(skill.name);
          if (existing !== source.digest) {
            if (existing && !canReplace)
              return yield* new WorkspaceWorkflowError({
                message: "실행 중인 스킬이 변경되었습니다. 현재 작업이 끝난 뒤 다시 요청하세요.",
              });
            yield* Effect.scoped(
              Effect.gen(function* () {
                const stage = yield* Effect.acquireRelease(
                  fs.makeTempDirectory({ directory: root, prefix: "stage-" }),
                  (directory) =>
                    fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
                );
                const stagedSkill = path.join(stage, skill.name);
                for (const resource of source.resources) {
                  const destination = path.join(stagedSkill, resource.path);
                  yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
                  yield* fs.copyFile(path.join(source.root, resource.path), destination);
                }
                if (
                  (yield* workflow.manifest(path.join(stagedSkill, "SKILL.md"))).digest !==
                  source.digest
                )
                  return yield* new WorkspaceWorkflowError({
                    message: "스킬을 복사하는 동안 내용이 변경되었습니다. 다시 요청하세요.",
                  });
                const target = path.join(root, "skills", skill.name);
                const previous = path.join(stage, "previous");
                if (existing) yield* fs.rename(target, previous);
                yield* fs
                  .rename(stagedSkill, target)
                  .pipe(
                    Effect.catch((error) =>
                      (existing ? fs.rename(previous, target) : Effect.void).pipe(
                        Effect.andThen(Effect.fail(error)),
                      ),
                    ),
                  );
              }),
            );
            installed.set(skill.name, source.digest);
          }
          result.push({
            qualifiedName: `${name}:${skill.name}`,
            manualOnly: metadata.invocation === "manual",
          });
        }
        return result;
      }),
    );
  return { root, name, install, dispose };
});
