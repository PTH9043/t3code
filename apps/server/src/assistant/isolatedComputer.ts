// @effect-diagnostics-next-line nodeBuiltinImport:off - Docker's Windows CLI must run without opening a console.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const OWNER_LABEL = "codes.t3.assistant-computer";
const OWNER_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

/** A Docker container is an isolation option, not a virtual machine. */
export interface AssistantComputer {
  readonly containerId: string;
  readonly ownerId: string;
  readonly kind?: "container" | "vm";
}

type Docker = (args: readonly string[]) => Promise<string>;

const docker: Docker = async (args) => {
  const options = { windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
  let result;
  try {
    result = await execFile("docker", [...args], options);
  } catch (error) {
    const fallback = `${process.env.ProgramFiles ?? "C:\\Program Files"}\\Docker\\Docker\\resources\\bin\\docker.exe`;
    if (
      !process.env.SystemRoot ||
      !process.env.ComSpec ||
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    result = await execFile(fallback, [...args], options);
  }
  return result.stdout;
};

/**
 * Explicit container lifecycle. Never mounts the host, exposes the Docker
 * socket, or looks up a container by a reusable name. The caller owns the
 * returned identity and decides when to stop or remove it. The owner label is
 * an accidental-misuse check, not authentication; callers must authorize access.
 * The supplied image must include Node. Removing the container deletes its
 * writable layer and anonymous image volumes; stopping it retains its data.
 */
export function makeIsolatedComputer(runDocker: Docker = docker) {
  async function resolveImage(image: string): Promise<string> {
    if (!image || image.startsWith("-") || /\s/.test(image)) {
      throw new Error("Invalid image reference");
    }
    let rawImageId: string;
    try {
      rawImageId = await runDocker(["image", "inspect", "--format", "{{.Id}}", image]);
    } catch (error) {
      if (
        error instanceof Error &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        /no such (image|object)/i.test(error.stderr)
      ) {
        throw new Error("선택한 Docker 이미지가 설치되어 있지 않습니다.", { cause: error });
      }
      throw error;
    }
    const imageId = rawImageId.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
      throw new Error("Docker returned an invalid image ID");
    }
    return imageId;
  }
  async function assertOwner(computer: AssistantComputer): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(computer.containerId) || !OWNER_ID.test(computer.ownerId)) {
      throw new Error("Invalid assistant computer identity");
    }
    const owner = await runDocker([
      "inspect",
      "--format",
      `{{ index .Config.Labels "${OWNER_LABEL}" }}`,
      computer.containerId,
    ]);
    if (owner.trim() !== computer.ownerId) throw new Error("Assistant computer ownership mismatch");
  }

  return {
    resolveImage,
    async create(input: {
      image: string;
      network: "none" | "bridge";
      ownerId?: string;
      kind?: "container" | "vm";
    }): Promise<AssistantComputer> {
      if (input.network !== "none" && input.network !== "bridge") {
        throw new Error("Invalid network mode");
      }
      // Resolve the tag first: the container must use the exact image inspected,
      // even if another process changes the tag before the create call.
      const imageId = await resolveImage(input.image);
      const ownerId = input.ownerId ?? NodeCrypto.randomUUID();
      if (!OWNER_ID.test(ownerId)) throw new Error("Invalid assistant computer owner ID");
      const vm = input.kind === "vm";
      const containerId = (
        await runDocker([
          "create",
          "--pull=never",
          "--restart",
          vm ? "no" : "unless-stopped",
          "--network",
          input.network,
          "--user",
          "1000:1000",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          ...(vm ? [] : ["--workdir", "/tmp"]),
          "--label",
          `${OWNER_LABEL}=${ownerId}`,
          ...(vm ? [] : ["--entrypoint", "node"]),
          imageId,
          ...(vm ? [] : ["-e", "setInterval(() => {}, 2147483647)"]),
        ])
      ).trim();
      if (!/^[a-f0-9]{64}$/.test(containerId))
        throw new Error("Docker returned an invalid container ID");
      return { containerId, ownerId };
    },
    async findByOwner(ownerId: string): Promise<AssistantComputer | null> {
      if (!OWNER_ID.test(ownerId)) throw new Error("Invalid assistant computer owner ID");
      const ids = (
        await runDocker([
          "ps",
          "--all",
          "--no-trunc",
          "--filter",
          `label=${OWNER_LABEL}=${ownerId}`,
          "--format",
          "{{.ID}}",
        ])
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length > 1)
        throw new Error("비서 컴퓨터가 여러 개 발견되어 자동으로 선택할 수 없습니다.");
      const id = ids[0];
      if (!id) return null;
      const computer = { containerId: id, ownerId };
      await assertOwner(computer);
      return computer;
    },
    async start(computer: AssistantComputer): Promise<void> {
      await assertOwner(computer);
      await runDocker(["start", computer.containerId]);
    },
    async status(computer: AssistantComputer): Promise<string> {
      await assertOwner(computer);
      const status = (
        await runDocker(["inspect", "--format", "{{.State.Status}}", computer.containerId])
      ).trim();
      if (status !== "running" || computer.kind !== "vm") return status;
      try {
        await runDocker([
          "exec",
          computer.containerId,
          "timeout",
          "20s",
          "/opt/t3-vm/exec.sh",
          "true",
        ]);
        return "running";
      } catch {
        return "starting";
      }
    },
    async execute(computer: AssistantComputer, args: readonly string[]): Promise<string> {
      if (args.length === 0 || !args[0] || args[0].startsWith("-")) {
        throw new Error("A command is required");
      }
      await assertOwner(computer);
      if (computer.kind === "vm") {
        // SSH executes a command through the guest shell; quote every argument
        // so host-supplied argv cannot change its intended boundaries.
        if (args.some((arg) => arg.includes("\0"))) throw new Error("Invalid command argument");
        const command = args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
        return runDocker(["exec", computer.containerId, "/opt/t3-vm/exec.sh", command]);
      }
      return runDocker(["exec", computer.containerId, ...args]);
    },
    async stop(computer: AssistantComputer): Promise<void> {
      await assertOwner(computer);
      if (computer.kind === "vm") {
        const status = (
          await runDocker(["inspect", "--format", "{{.State.Status}}", computer.containerId])
        ).trim();
        if (status !== "running") return;
        // Flush and shut down the guest before allowing QEMU to exit. Killing
        // QEMU directly can discard dirty guest filesystem data.
        let shutdownError: unknown;
        try {
          await runDocker([
            "exec",
            computer.containerId,
            "timeout",
            "90s",
            "/opt/t3-vm/exec.sh",
            "sync && sudo -n poweroff",
          ]);
        } catch (cause) {
          shutdownError = cause;
        }
        for (let attempt = 0; attempt < 90; attempt++) {
          const after = (
            await runDocker(["inspect", "--format", "{{.State.Status}}", computer.containerId])
          ).trim();
          if (after !== "running") return;
          await delay(2_000);
        }
        throw new Error(
          "VM 종료가 완료되지 않았습니다. 파일을 보존하기 위해 강제 종료하지 않았습니다.",
          { cause: shutdownError },
        );
      }
      await runDocker(["stop", computer.containerId]);
    },
    async remove(computer: AssistantComputer): Promise<void> {
      await assertOwner(computer);
      await runDocker([
        "rm",
        ...(computer.kind === "vm" ? ["--force"] : []),
        "--volumes",
        computer.containerId,
      ]);
    },
  };
}
