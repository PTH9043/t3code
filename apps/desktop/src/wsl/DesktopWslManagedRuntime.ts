// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- WSL bootstrap transfers trusted local build files over stdio.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";

import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  archive: Schema.String,
  sha256: Schema.String,
  platform: Schema.Literal("linux"),
  arch: Schema.Literal("x64"),
  libc: Schema.Literal("musl"),
  nodePty: Schema.Literal("1.1.0"),
});
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest));

const PROBE = String.raw`
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const digest=process.argv[1],override=process.argv[2];
const root=override||path.join(os.homedir(),'.t3','managed-wsl-runtime');
let cached=null;
try {
  for(const name of fs.readdirSync(root)) {
    if(name!==digest&&!name.startsWith(digest+'-'))continue;
    const dir=path.join(root,name);
    try {
      if(fs.readFileSync(path.join(dir,'.t3-ready'),'utf8')!==digest)continue;
      const pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
      const dependencies=Object.keys(pkg.dependencies||{});
      if(dependencies.length===0||dependencies.some(name=>!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)||!fs.existsSync(path.join(dir,'node_modules',name,'package.json'))))continue;
      if(!fs.existsSync(path.join(dir,'node_modules','node-pty','build','Release','pty.node')))continue;
      require(path.join(dir,'node_modules','node-pty'));
      cached=dir;break;
    } catch {}
  }
} catch {}
let glibc=null;
try { glibc=process.report.getReport().header.glibcVersionRuntime||null } catch {}
process.stdout.write(JSON.stringify({nodePath:process.execPath,nodeVersion:process.versions.node,arch:process.arch,platform:process.platform,glibc,root,cached,path:process.env.PATH||''}));
`;

const INSTALL = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {pipeline}=require('node:stream/promises');
const root=process.argv[1],digest=process.argv[2];
if(!/^[0-9a-f]{64}$/.test(digest)||!path.isAbsolute(root))throw Error('Invalid runtime target');
fs.mkdirSync(root,{recursive:true,mode:0o700});
const temp=fs.mkdtempSync(path.join(root,'.unpack-'));
const cleanup=()=>{if(path.dirname(fs.realpathSync(temp))!==fs.realpathSync(root)||!path.basename(temp).startsWith('.unpack-'))throw Error('Invalid temporary directory');fs.rmSync(temp,{recursive:true,force:true})};
(async()=>{
  const archive=path.join(temp,'payload.tar.gz'),hash=crypto.createHash('sha256');
  process.stdin.on('data',chunk=>hash.update(chunk));
  await pipeline(process.stdin,fs.createWriteStream(archive,{flags:'wx',mode:0o600}));
  if(hash.digest('hex')!==digest)throw Error('Runtime archive checksum mismatch');
  await new Promise((ok,fail)=>{const tar=cp.spawn('tar',['-xzf',archive,'-C',temp],{stdio:['ignore','ignore','pipe']});let err='';tar.stderr.on('data',chunk=>err=(err+chunk).slice(-2000));tar.once('error',fail);tar.once('exit',code=>code===0?ok():fail(Error('Runtime extraction failed: '+err)))});
  fs.unlinkSync(archive);
  const pty=require(path.join(temp,'node_modules','node-pty'));
  if(typeof pty.spawn!=='function'||!fs.existsSync(path.join(temp,'node_modules','node-pty','build','Release','pty.node')))throw Error('Runtime terminal module is unavailable');
  fs.writeFileSync(path.join(temp,'.t3-ready'),digest,{mode:0o600});
  let target=path.join(root,digest);
  if(fs.existsSync(target))target=path.join(root,digest+'-'+crypto.randomBytes(8).toString('hex'));
  fs.renameSync(temp,target);
  process.stdout.write(JSON.stringify({cached:target}));
})().catch(error=>{try{if(fs.existsSync(temp))cleanup()}catch{};console.error(error.message);process.exitCode=1});
`;

const COPY_SERVER = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.argv[1],expected=process.argv[2];
if(!path.isAbsolute(root)||!/^[0-9a-f]{64}$/.test(expected))throw Error('Invalid server target');
let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>text+=chunk);
process.stdin.on('end',()=>{
 const files=JSON.parse(text),hash=crypto.createHash('sha256'),seen=new Set();
 if(!Array.isArray(files)||files.length===0)throw Error('No server files');
 const decoded=files.map(file=>{
  if(typeof file.name!=='string'||!/^[A-Za-z0-9_.-]+\.mjs$/.test(file.name)||seen.has(file.name)||typeof file.data!=='string')throw Error('Invalid server file');
  seen.add(file.name);const bytes=Buffer.from(file.data,'base64');hash.update(file.name).update('\0').update(bytes).update('\0');return {name:file.name,bytes};
 });
 if(!seen.has('bin.mjs')||hash.digest('hex')!==expected)throw Error('Server bundle checksum mismatch');
 const parent=path.join(root,'server');fs.mkdirSync(parent,{recursive:true,mode:0o700});
 for(const name of fs.readdirSync(parent)){
  if(name!==expected&&!name.startsWith(expected+'-'))continue;
  const candidate=path.join(parent,name);
  try {
   if(fs.readFileSync(path.join(candidate,'.t3-ready'),'utf8')!==expected)continue;
   const existing=crypto.createHash('sha256');
   for(const file of decoded)existing.update(file.name).update('\0').update(fs.readFileSync(path.join(candidate,file.name))).update('\0');
   if(existing.digest('hex')===expected){process.stdout.write(JSON.stringify({entry:path.join(candidate,'bin.mjs')}));return}
  } catch {}
 }
 let target=path.join(parent,expected);
 const temp=fs.mkdtempSync(path.join(parent,'.copy-'));
 try {
  for(const file of decoded)fs.writeFileSync(path.join(temp,file.name),file.bytes,{flag:'wx',mode:0o600});
  fs.writeFileSync(path.join(temp,'.t3-ready'),expected,{mode:0o600});
  if(fs.existsSync(target))target=path.join(parent,expected+'-'+crypto.randomBytes(8).toString('hex'));
  fs.renameSync(temp,target);
  process.stdout.write(JSON.stringify({entry:path.join(target,'bin.mjs')}));
 } finally {
  if(fs.existsSync(temp)) {
   if(path.dirname(fs.realpathSync(temp))!==fs.realpathSync(parent)||!path.basename(temp).startsWith('.copy-'))throw Error('Invalid temporary directory');
   fs.rmSync(temp,{recursive:true,force:true});
  }
 }
});
`;

type Input = Uint8Array | NodeStream.Readable | undefined;
type RunWsl = (args: readonly string[], input: Input, signal?: AbortSignal) => Promise<string>;

function makeWslRunner(distro: string): RunWsl {
  return async (args, input, signal) =>
    await new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        WSLENV: undefined,
        T3CODE_HOME: undefined,
        NODE_OPTIONS: undefined,
      };
      const child = NodeChildProcess.spawn("wsl.exe", ["-d", distro, "--exec", "node", ...args], {
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        ...(signal ? { signal } : {}),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-16_384);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4_096);
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve(stdout)
          : reject(new Error(`WSL runtime preparation failed (${code}): ${stderr.trim()}`)),
      );
      child.stdin.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error);
      });
      if (input instanceof Uint8Array) child.stdin.end(input);
      else if (input) input.once("error", reject).pipe(child.stdin);
      else child.stdin.end();
    });
}

async function fileHash(path: string) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}

export interface ManagedWslRuntimeInput {
  readonly distro: string;
  readonly manifestPath: string;
  readonly serverDirectory: string;
  readonly nodeEngineRange: string;
  /** Isolated tests may supply a temporary Linux cache directory. */
  readonly testCacheRoot?: string;
}

/** Prepare app-owned Linux files over stdin without mounting the Windows drive. */
export async function prepareWslManagedRuntime(
  input: ManagedWslRuntimeInput,
  signal?: AbortSignal,
) {
  const manifest = decodeManifest(await NodeFSP.readFile(input.manifestPath, "utf8"));
  if (
    !/^[0-9a-f]{64}$/u.test(manifest.sha256) ||
    NodePath.basename(manifest.archive) !== manifest.archive
  ) {
    throw new Error("Invalid managed WSL runtime manifest.");
  }
  const archive = NodePath.join(NodePath.dirname(input.manifestPath), manifest.archive);
  if ((await fileHash(archive)) !== manifest.sha256)
    throw new Error("Managed WSL runtime checksum mismatch.");
  const run = makeWslRunner(input.distro);
  const probe = JSON.parse(
    await run(["-e", PROBE, manifest.sha256, input.testCacheRoot ?? ""], undefined, signal),
  ) as {
    nodePath: string;
    nodeVersion: string;
    arch: string;
    platform: string;
    glibc: string | null;
    root: string;
    cached: string | null;
    path: string;
  };
  if (
    probe.platform !== manifest.platform ||
    probe.arch !== manifest.arch ||
    probe.glibc !== null
  ) {
    throw new Error("The managed WSL runtime does not match this Linux architecture or C library.");
  }
  if (!satisfiesSemverRange(probe.nodeVersion, input.nodeEngineRange)) {
    throw new Error(`WSL Node.js ${probe.nodeVersion} does not satisfy ${input.nodeEngineRange}.`);
  }
  const cached =
    probe.cached ??
    (
      JSON.parse(
        await run(
          ["-e", INSTALL, probe.root, manifest.sha256],
          NodeFS.createReadStream(archive),
          signal,
        ),
      ) as { cached: string }
    ).cached;
  const names = (await NodeFSP.readdir(input.serverDirectory))
    .filter((name) => /^[A-Za-z0-9_.-]+\.mjs$/u.test(name))
    .sort();
  if (!names.includes("bin.mjs")) throw new Error("The T3 server bundle is missing.");
  const hash = NodeCrypto.createHash("sha256");
  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      bytes: await NodeFSP.readFile(NodePath.join(input.serverDirectory, name)),
    })),
  );
  for (const file of files) hash.update(file.name).update("\0").update(file.bytes).update("\0");
  const digest = hash.digest("hex");
  const payload = Buffer.from(
    JSON.stringify(files.map((file) => ({ name: file.name, data: file.bytes.toString("base64") }))),
  );
  const copied = JSON.parse(await run(["-e", COPY_SERVER, cached, digest], payload, signal)) as {
    entry: string;
  };
  return { linuxEntryPath: copied.entry, nodePath: probe.nodePath, resolvedPath: probe.path };
}
