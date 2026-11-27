import { createHash } from "node:crypto";

export const knowledgeContentHash = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");
