import { useEffect, useState } from "react";
import "./AgustinaCharacter.css";

const root = "/agent-characters/agustina/august_";
const parts = [
  "base",
  "outfit_swimsuit",
  "eyes_open",
  "eyes_half",
  "eyes_closeddown",
  "eyebrows_normal",
  "mouth_smile",
] as const;

/** Keep every layer hidden until the swimsuit and face are available. */
export function AgustinaCharacter({ isWorking }: { isWorking: boolean }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let cancelled = false;
    const images = parts.map((part) => {
      const image = new Image();
      let onLoad = () => {};
      let onError = () => {};
      const loaded = new Promise<void>((resolve, reject) => {
        onLoad = () => resolve();
        onError = () => reject(new Error("Character image failed to load"));
        image.addEventListener("load", onLoad, { once: true });
        image.addEventListener("error", onError, { once: true });
      });
      image.src = `${root}${part}.png`;
      return { image, loaded, onLoad, onError };
    });
    void Promise.all(images.map((image) => image.loaded)).then(
      () => {
        if (!cancelled) setStatus("ready");
      },
      () => {
        if (!cancelled) setStatus("error");
      },
    );
    return () => {
      cancelled = true;
      for (const { image, onLoad, onError } of images) {
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", onError);
      }
    };
  }, []);

  if (status !== "ready") {
    return (
      <span className="text-xs text-muted-foreground">
        {status === "error" ? "캐릭터를 불러오지 못했습니다" : "캐릭터 불러오는 중…"}
      </span>
    );
  }
  return (
    <span
      className="agustina-character"
      role="img"
      aria-label={isWorking ? "Agustina 캐릭터가 작업 중입니다" : "Agustina 캐릭터가 대기 중입니다"}
    >
      {parts.map((part) => (
        <img
          key={part}
          src={`${root}${part}.png`}
          alt=""
          className={`agustina-layer agustina-${part}`}
        />
      ))}
    </span>
  );
}
