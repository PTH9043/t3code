import type { ThreadAssistantComputer } from "@t3tools/contracts/settings";
import * as NodeCrypto from "node:crypto";
import type { AssistantComputer } from "./isolatedComputer.ts";

type Computer = {
  resolveImage(image: string): Promise<string>;
  create(input: {
    image: string;
    network: "none" | "bridge";
    ownerId: string;
    kind?: "container" | "vm";
  }): Promise<AssistantComputer>;
  findByOwner(ownerId: string): Promise<AssistantComputer | null>;
  start(computer: AssistantComputer): Promise<void>;
  stop(computer: AssistantComputer): Promise<void>;
  remove(computer: AssistantComputer): Promise<void>;
  status(computer: AssistantComputer): Promise<string>;
  execute(computer: AssistantComputer, args: readonly string[]): Promise<string>;
};

export type ComputerAction =
  | {
      readonly action: "create";
      readonly image: string;
      readonly network: "none" | "bridge";
      readonly kind?: "container" | "vm";
    }
  | { readonly action: "status" | "start" | "stop" | "remove" }
  | { readonly action: "wait_ready"; readonly timeoutMs: number }
  | {
      readonly action: "execute";
      readonly args: readonly string[];
      readonly timeoutMs?: number | undefined;
    };

const lifecycleLocks = new Map<string, Promise<void>>();
const PENDING_CONTAINER = "pending";

/** The caller supplies the authenticated thread ID, never an ID chosen by a model. */
export function makeAssistantComputerController(input: {
  computer: Computer;
  read: (threadId: string) => Promise<ThreadAssistantComputer | null>;
  write: (threadId: string, value: ThreadAssistantComputer | null) => Promise<void>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}) {
  const now = input.now ?? Date.now;
  // @effect-diagnostics-next-line globalTimers:off - The Promise controller's readiness wait must not hold the lifecycle lock.
  const wait =
    input.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  async function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = lifecycleLocks.get(key);
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    lifecycleLocks.set(key, next);
    if (previous) await previous;
    try {
      return await run();
    } finally {
      release();
      if (lifecycleLocks.get(key) === next) lifecycleLocks.delete(key);
    }
  }
  async function existing(threadId: string) {
    const computer = await input.read(threadId);
    if (!computer) throw new Error("이 대화에 연결된 비서 컴퓨터가 없습니다.");
    return computer;
  }
  async function resolve(threadId: string, computer: ThreadAssistantComputer) {
    if (computer.containerId !== PENDING_CONTAINER) return computer;
    const found = await input.computer.findByOwner(computer.ownerId);
    if (!found) return computer;
    const recovered = { ...computer, containerId: found.containerId };
    await input.write(threadId, recovered);
    return recovered;
  }
  async function describe(threadId: string, unresolved: ThreadAssistantComputer) {
    const computer = await resolve(threadId, unresolved);
    return {
      configured: true,
      image: computer.image,
      network: computer.network,
      kind: computer.kind ?? "container",
      status:
        computer.containerId === PENDING_CONTAINER
          ? "pending"
          : await input.computer.status(computer),
    };
  }
  return {
    async invoke(threadId: string, action: ComputerAction): Promise<unknown> {
      if (action.action === "wait_ready") {
        if (
          !Number.isSafeInteger(action.timeoutMs) ||
          action.timeoutMs < 1 ||
          action.timeoutMs > 300_000
        )
          throw new Error("잘못된 준비 대기 시간입니다.");
        const deadline = now() + action.timeoutMs;
        while (true) {
          const state = await serial(threadId, async () => {
            const computer = await input.read(threadId);
            return computer ? describe(threadId, computer) : { configured: false as const };
          });
          if (!state.configured || state.status !== "starting")
            return { ...state, timedOut: false };
          const remaining = deadline - now();
          if (remaining <= 0) return { ...state, timedOut: true };
          await wait(Math.min(1_000, remaining));
        }
      }
      // Do not hold the lifecycle lock while a command runs: stop must be able
      // to interrupt a long-running command by stopping its container.
      if (action.action === "execute") {
        const computer = await serial(threadId, async () =>
          resolve(threadId, await existing(threadId)),
        );
        if (computer.containerId === PENDING_CONTAINER)
          throw new Error("컴퓨터 생성 결과를 확인해야 합니다.");
        if (action.timeoutMs === undefined) {
          return { output: await input.computer.execute(computer, action.args) };
        }
        if (
          !Number.isSafeInteger(action.timeoutMs) ||
          action.timeoutMs < 1 ||
          action.timeoutMs > 2_147_483_647
        ) {
          throw new Error("잘못된 실행 제한 시간입니다.");
        }
        return new Promise((resolve, reject) => {
          let settled = false;
          // @effect-diagnostics-next-line globalTimers:off - Stop must remain available while the Promise-based command runs.
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            void serial(threadId, () => input.computer.stop(computer)).then(
              () =>
                reject(
                  new Error("제한 시간이 지나 비서 컴퓨터를 중지했습니다. 파일은 보존됩니다."),
                ),
              (cause: unknown) =>
                reject(
                  new Error("제한 시간이 지났지만 비서 컴퓨터를 중지하지 못했습니다.", { cause }),
                ),
            );
          }, action.timeoutMs);
          void input.computer.execute(computer, action.args).then(
            (output) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve({ output });
            },
            (error: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(error);
            },
          );
        });
      }
      return serial(threadId, async () => {
        if (action.action === "status") {
          const computer = await input.read(threadId);
          return computer ? describe(threadId, computer) : { configured: false };
        }
        if (action.action === "create") {
          const current = await input.read(threadId);
          if (current) return describe(threadId, current);
          if (!action.image || action.image.startsWith("-") || /\s/.test(action.image)) {
            throw new Error("잘못된 Docker 이미지입니다.");
          }
          if (action.kind === "vm" && action.image !== "t3-assistant-vm:ubuntu-noble-20261017") {
            throw new Error("이 컴퓨터는 T3 Ubuntu VM 이미지가 필요합니다.");
          }
          if (action.network !== "none" && action.network !== "bridge") {
            throw new Error("잘못된 네트워크 설정입니다.");
          }
          // A missing image is a definite preflight failure, not an uncertain
          // create; keep the saved state empty so the user can correct it.
          const imageId = await input.computer.resolveImage(action.image);
          const ownerId = NodeCrypto.randomUUID();
          const reservation = {
            containerId: PENDING_CONTAINER,
            ownerId,
            image: action.image,
            network: action.network,
            ...(action.kind ? { kind: action.kind } : {}),
          };
          // Persist the owner before asking Docker to create anything: an
          // interrupted create can then be recovered by its exact owner label.
          await input.write(threadId, reservation);
          const created = await input.computer.create({ ...action, image: imageId, ownerId });
          const computer = { ...reservation, containerId: created.containerId };
          await input.write(threadId, computer);
          await input.computer.start(computer);
          return describe(threadId, computer);
        }
        const computer = await resolve(threadId, await existing(threadId));
        if (computer.containerId === PENDING_CONTAINER) {
          if (action.action === "remove") {
            await input.write(threadId, null);
            return { configured: false };
          }
          throw new Error("컴퓨터 생성 결과를 확인해야 합니다. 상태 확인 후 필요하면 삭제하세요.");
        }
        if (action.action === "start") await input.computer.start(computer);
        if (action.action === "stop") await input.computer.stop(computer);
        if (action.action === "remove") {
          if (
            computer.kind !== "vm" &&
            ["running", "starting"].includes(await input.computer.status(computer))
          )
            await input.computer.stop(computer);
          await input.computer.remove(computer);
          await input.write(threadId, null);
          return { configured: false };
        }
        return describe(threadId, computer);
      });
    },
  };
}
