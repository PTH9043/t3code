// @effect-diagnostics nodeBuiltinImport:off - SQLite locking must be acquired before microphone IPC returns.
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import type * as Electron from "electron";

type Sender = Pick<Electron.WebContents, "isDestroyed" | "once" | "removeListener">;
type Recording = { sender: Sender; stateDir: string; cleanup: () => void };
type RecordingLock = { db: DatabaseSync; tokens: Set<string> };

/** Protects in-memory microphone recordings from the development restart watcher. */
export class VoiceRecordingGuard {
  private readonly recordings = new Map<string, Recording>();
  private readonly locks = new Map<string, RecordingLock>();

  begin(stateDir: string, sender: Sender): string {
    if (sender.isDestroyed()) throw new Error("Recording window is closed");
    stateDir = NodePath.resolve(stateDir);
    NodeFs.mkdirSync(stateDir, { recursive: true });
    let lock = this.locks.get(stateDir);
    if (!lock) {
      const db = new DatabaseSync(
        NodePath.join(stateDir, ".assistant-voice-restart-guard.sqlite"),
        { timeout: 100 },
      );
      try {
        // Held until the last in-memory recording is resolved or its renderer exits.
        db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        db.close();
        throw error;
      }
      lock = { db, tokens: new Set() };
      this.locks.set(stateDir, lock);
    }
    const token = NodeCrypto.randomUUID();
    const cleanup = () => this.end(token, sender);
    lock.tokens.add(token);
    this.recordings.set(token, { sender, stateDir, cleanup });
    try {
      sender.once("destroyed", cleanup);
      sender.once("render-process-gone", cleanup);
      sender.once("did-navigate", cleanup);
      if (sender.isDestroyed()) throw new Error("Recording window is closed");
      return token;
    } catch (error) {
      this.end(token, sender);
      throw error;
    }
  }

  end(token: string, sender: Sender): void {
    const recording = this.recordings.get(token);
    if (!recording || recording.sender !== sender) return;
    this.recordings.delete(token);
    sender.removeListener("destroyed", recording.cleanup);
    sender.removeListener("render-process-gone", recording.cleanup);
    sender.removeListener("did-navigate", recording.cleanup);
    const lock = this.locks.get(recording.stateDir);
    if (lock) {
      lock.tokens.delete(token);
      if (lock.tokens.size === 0) {
        this.locks.delete(recording.stateDir);
        lock.db.close();
      }
    }
  }

  dispose(): void {
    for (const [token, { sender }] of this.recordings) this.end(token, sender);
  }
}

export const voiceRecordingGuard = new VoiceRecordingGuard();
