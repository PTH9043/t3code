import { expect, it } from "vite-plus/test";
import { decodeDesignImage } from "./DesignImageUpload.ts";
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=";
it("accepts an actual PNG and rejects mismatched images and executable image formats", () => {
  expect(decodeDesignImage(png)).toMatchObject({ mimeType: "image/png" });
  expect(() => decodeDesignImage(png.replace("image/png", "image/jpeg"))).toThrow("파일 형식");
  expect(() => decodeDesignImage("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toThrow("PNG");
  expect(() => decodeDesignImage("data:image/png;base64,broken")).toThrow();
});
