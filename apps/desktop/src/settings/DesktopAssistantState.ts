// @effect-diagnostics nodeBuiltinImport:off -- The desktop controller serializes native Promise callbacks.
import {
  DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
  DesktopAssistantSettings,
  DesktopAssistantModelUpdate,
  type DesktopAssistantConversationRef,
  type DesktopAssistantSettings as Settings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const decode = Schema.decodeUnknownSync(DesktopAssistantSettings);
const decodeModels = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, DesktopAssistantModelUpdate),
);
const modelKey = (ref: DesktopAssistantConversationRef) =>
  JSON.stringify([ref.environmentId, ref.threadId]);

/** The desktop process serializes updates from all its renderer windows. */
export class DesktopAssistantState {
  private readonly path: string;
  private current: Settings = DEFAULT_DESKTOP_ASSISTANT_SETTINGS;
  private models: Readonly<Record<string, DesktopAssistantModelUpdate>> = {};
  private queue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<Settings> {
    try {
      const document: unknown = JSON.parse(await readFile(this.path, "utf8"));
      this.current = decode(document);
      if (typeof document === "object" && document !== null && "modelSelections" in document) {
        this.models = decodeModels(document.modelSelections);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  async getModel(
    ref: DesktopAssistantConversationRef,
  ): Promise<DesktopAssistantModelUpdate | null> {
    await this.queue;
    return this.models[modelKey(ref)] ?? null;
  }

  private async persist(settings: Settings, models: typeof this.models): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ ...settings, modelSelections: models }, null, 2)}\n`,
        "utf8",
      );
      await rename(temporaryPath, this.path);
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  setModel(update: DesktopAssistantModelUpdate): Promise<void> {
    const operation = this.queue.then(async () => {
      const models = { ...this.models, [modelKey(update)]: update };
      await this.persist(this.current, models);
      this.models = models;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  update(patch: Partial<Settings>): Promise<Settings> {
    const operation = this.queue.then(async () => {
      const next = decode({ ...this.current, ...patch });
      await this.persist(next, this.models);
      this.current = next;
      return next;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
