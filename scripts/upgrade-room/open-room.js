"use strict";

async function enterRoom() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname);
  const token = fragment.get("token");
  const options = { cache: "no-store", credentials: "same-origin", redirect: "error" };
  if (!token || fragment.size !== 1 || location.hostname !== "127.0.0.1") throw new Error();
  const descriptor = await fetch("/.well-known/t3/environment", options);
  if (!descriptor.ok) throw new Error();
  const environmentId = (await descriptor.json()).environmentId;
  if (typeof environmentId !== "string" || !/^[A-Za-z0-9_-]+$/.test(environmentId))
    throw new Error();
  const paired = await fetch("/api/auth/browser-session", {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential: token }),
  });
  if (!paired.ok) throw new Error();
  location.replace("/" + encodeURIComponent(environmentId) + "/autousage-upgrade-room");
}

enterRoom().catch(() => {
  document.querySelector("p").textContent =
    "연결할 수 없습니다. 바로가기에서 업그레이드 방을 다시 열어 주세요.";
});
