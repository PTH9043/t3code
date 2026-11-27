import type { DesktopDirectRpcBridge, DesktopDirectRpcOutput } from "@t3tools/contracts";

// The shared RPC socket expects a pong within five seconds. Local backend work
// can briefly block the event loop, so allow the same 15-second window used by
// the foreground probe while still closing a genuinely unresponsive connection.
const LOCAL_HEALTH_TIMEOUT_MS = 15_000;
const RPC_PING = '{"_tag":"Ping"}';
const RPC_PONG = '{"_tag":"Pong"}';

/** Adapts desktop IPC to Effect RPC's framed connection interface without opening a socket. */
export class DirectRpcConnection extends EventTarget {
  readonly url = "desktop-direct://primary";
  readonly protocol = "";
  readonly extensions = "";
  readonly binaryType = "arraybuffer";
  readyState = 0;
  private clientId: number | undefined;
  private readonly pending: DesktopDirectRpcOutput[] = [];
  private readonly unsubscribe: () => void;
  private readonly bridge: DesktopDirectRpcBridge;
  private sendChain: Promise<void> = Promise.resolve();
  private healthTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(bridge: DesktopDirectRpcBridge, backendId?: string) {
    super();
    this.bridge = bridge;
    this.unsubscribe = bridge.onFrame((frame) => {
      if (this.clientId === undefined) {
        this.pending.push(frame);
      } else {
        this.receive(frame);
      }
    });
    void bridge.open(backendId).then(
      (clientId) => {
        this.clientId = clientId;
        if (this.readyState >= 2) {
          void bridge.close(clientId).catch(() => undefined);
          return;
        }
        for (const frame of this.pending.splice(0)) this.receive(frame);
      },
      () => this.fail(),
    );
  }

  private receive(frame: DesktopDirectRpcOutput) {
    if (frame.clientId !== this.clientId || this.readyState === 3) return;
    switch (frame.type) {
      case "opened":
        if (this.readyState === 0) {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
        }
        break;
      case "data":
        if (this.readyState === 1) {
          this.clearHealthTimeout();
          this.dispatchEvent(new MessageEvent("message", { data: frame.data }));
        }
        break;
      case "closed":
        this.finish(1001, "Direct connection closed.");
        break;
    }
  }

  private clearHealthTimeout() {
    if (this.healthTimeout !== undefined) {
      clearTimeout(this.healthTimeout);
      this.healthTimeout = undefined;
    }
  }

  private finish(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.clearHealthTimeout();
    this.unsubscribe();
    const event = new Event("close");
    Object.defineProperties(event, { code: { value: code }, reason: { value: reason } });
    this.dispatchEvent(event);
  }

  private fail() {
    if (this.readyState === 3) return;
    this.dispatchEvent(new Event("error"));
    const clientId = this.clientId;
    this.finish(1011, "Direct connection failed.");
    if (clientId !== undefined) void this.bridge.close(clientId).catch(() => undefined);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== 1 || this.clientId === undefined) {
      throw new Error("Direct connection is not open.");
    }
    if (typeof data !== "string") throw new TypeError("Direct RPC expects a framed text message.");
    const clientId = this.clientId;
    if (data.trim() === RPC_PING) {
      if (this.healthTimeout === undefined) {
        // @effect-diagnostics-next-line globalTimers:off -- This EventTarget follows the browser socket lifecycle.
        this.healthTimeout = setTimeout(() => this.fail(), LOCAL_HEALTH_TIMEOUT_MS);
      }
      // Keep the shared five-second socket heartbeat alive only while this
      // direct transport waits for actual backend activity within the deadline.
      queueMicrotask(() => {
        if (this.readyState === 1) {
          this.dispatchEvent(new MessageEvent("message", { data: RPC_PONG }));
        }
      });
    }
    this.sendChain = this.sendChain
      .then(() => {
        if (this.readyState !== 1) return;
        return this.bridge.send(clientId, data);
      })
      .catch(() => this.fail());
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const clientId = this.clientId;
    this.finish(code, reason);
    if (clientId !== undefined) void this.bridge.close(clientId).catch(() => undefined);
  }
}
