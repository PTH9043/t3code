import * as NodeChildProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import { VoiceRecordingGuard } from "../src/assistant/VoiceRecordingGuard.ts";
import { inspectAutomaticRestart } from "./dev-restart-guard.mjs";

let root;
let stateDir;
let guard;

class Sender extends EventEmitter {
  isDestroyed() {
    return false;
  }
}

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recording-guard-"));
  stateDir = NodePath.join(root, "userdata");
  NodeFS.mkdirSync(stateDir);
  const db = new DatabaseSync(NodePath.join(stateDir, "state.sqlite"));
  db.exec(`CREATE TABLE projection_thread_sessions (thread_id TEXT, status TEXT, active_turn_id TEXT);
    CREATE TABLE projection_turns (thread_id TEXT, turn_id TEXT, state TEXT);
    CREATE TABLE projection_threads (thread_id TEXT, deleted_at TEXT);`);
  db.close();
  guard = new VoiceRecordingGuard();
});

afterEach(() => {
  guard.dispose();
  if (NodePath.dirname(NodePath.resolve(root)) !== NodePath.resolve(NodeOS.tmpdir()))
    throw new Error("Unexpected test root");
  NodeFS.rmSync(root, { recursive: true, force: true });
});

const inspect = () => inspectAutomaticRestart(process.pid, { T3CODE_HOME: root });

it("blocks restart for each recording, respects its sender, and releases on renderer loss", () => {
  const first = new Sender();
  const second = new Sender();
  const token = guard.begin(stateDir, first);
  guard.begin(stateDir, second);
  expect(inspect()).toMatchObject({ safe: false, reason: "assistant-recording" });
  guard.end(token, second);
  second.emit("render-process-gone");
  expect(inspect()).toMatchObject({ safe: false, reason: "assistant-recording" });
  first.emit("destroyed");
  const idle = inspect();
  expect(idle).toMatchObject({ safe: true, reason: "idle" });
  idle.release();
});

it("reserves the lock through the restart decision so a microphone cannot start in the gap", () => {
  const idle = inspect();
  expect(idle).toMatchObject({ safe: true, reason: "idle" });
  const sender = new Sender();
  expect(() => guard.begin(stateDir, sender)).toThrow();
  idle.release();
  const token = guard.begin(stateDir, sender);
  expect(inspect()).toMatchObject({ safe: false, reason: "assistant-recording" });
  guard.end(token, sender);
  const after = inspect();
  expect(after.safe).toBe(true);
  after.release();
});

it("does not retain a lock when the recording process exits without cleanup", async () => {
  const lockFile = NodePath.join(stateDir, ".assistant-voice-restart-guard.sqlite");
  const script =
    "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.stdout.write('locked');setInterval(()=>{},1000)";
  const child = NodeChildProcess.spawn(process.execPath, ["-e", script, lockFile], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await once(child.stdout, "data");
    expect(inspect()).toMatchObject({ safe: false, reason: "assistant-recording" });
  } finally {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  const idle = inspect();
  expect(idle.safe).toBe(true);
  idle.release();
});
