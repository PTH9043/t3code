import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";

const HttpUrl = Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^https?:\/\//i));
export const WorkspaceDesignReference = Schema.Struct({
  version: Schema.String.check(Schema.isMaxLength(100)),
  components: Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(
    Schema.isMaxLength(40),
  ),
  layout: Schema.String.check(Schema.isMaxLength(4000)),
  images: Schema.Array(
    Schema.Struct({
      url: Schema.optionalKey(HttpUrl),
      attachmentId: Schema.optionalKey(
        Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,150}$/)),
      ),
      caption: Schema.String.check(Schema.isMaxLength(500)),
    }).check(Schema.makeFilter((image) => Boolean(image.url) !== Boolean(image.attachmentId))),
  ).check(Schema.isMaxLength(8)),
  sourceUrl: Schema.NullOr(HttpUrl),
});
export type WorkspaceDesignReference = typeof WorkspaceDesignReference.Type;

export function designReferenceText(reference: WorkspaceDesignReference): string {
  return [
    "[디자인 참고]",
    reference.version ? `버전: ${reference.version}` : "",
    reference.components.length ? `컴포넌트: ${reference.components.join(", ")}` : "",
    reference.layout ? `레이아웃: ${reference.layout}` : "",
    reference.sourceUrl ? `출처: ${reference.sourceUrl}` : "",
    ...reference.images.map(
      (image) =>
        `이미지: ${image.caption || "참고 화면"} ${image.url ?? `attachment:${image.attachmentId}`}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

export const DesignImageUploadInput = Schema.Struct({
  projectId: ProjectId,
  name: Schema.String.check(Schema.isMaxLength(500)),
  dataUrl: Schema.String.check(Schema.isMaxLength(11_000_000)),
});
export class DesignImageUploadError extends Schema.TaggedErrorClass<DesignImageUploadError>()(
  "DesignImageUploadError",
  { message: Schema.String },
) {}
