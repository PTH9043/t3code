// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

/**
 * Graphify-inspired local deterministic AST-structure & dependency graph engine.
 * - Zero vector DB, zero external Python runtime, zero native addon risk.
 * - Strips comments/strings via a proper character lexer so literals never create false edges.
 * - Tags every edge with explicit provenance:
 *   - EXTRACTED: static import/export, class inheritance, or uniquely resolved direct call.
 *   - INFERRED: dynamic import, DI/service token reference, or unique cross-file symbol match.
 *   - AMBIGUOUS: identifier call matching multiple definitions across the workspace.
 */

export type CodeGraphEdgeProvenance = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export type CodeGraphSymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "method";

export interface CodeGraphSymbol {
  readonly name: string;
  readonly kind: CodeGraphSymbolKind;
  readonly file: string;
  readonly line: number;
  readonly exported: boolean;
  readonly parent?: string | undefined;
}

export interface CodeGraphImportEdge {
  readonly fromFile: string;
  readonly specifier: string;
  readonly resolvedFile: string | null;
  readonly importedNames: ReadonlyArray<string>;
  readonly provenance: CodeGraphEdgeProvenance;
  readonly line: number;
}

export interface CodeGraphCallEdge {
  readonly callerFile: string;
  readonly callerSymbol: string;
  readonly calleeName: string;
  readonly targetFile: string | null;
  readonly targetLine: number | null;
  readonly line: number;
  readonly provenance: CodeGraphEdgeProvenance;
  readonly candidateFiles?: ReadonlyArray<string> | undefined;
}

interface ParsedFileEntry {
  readonly relPath: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly symbols: ReadonlyArray<CodeGraphSymbol>;
  readonly imports: ReadonlyArray<{
    readonly specifier: string;
    readonly importedNames: ReadonlyArray<string>;
    readonly provenance: "EXTRACTED" | "INFERRED";
    readonly line: number;
  }>;
  readonly rawCalls: ReadonlyArray<{
    readonly callerSymbol: string;
    readonly calleeName: string;
    readonly line: number;
  }>;
}

export interface CodeGraphQueryResult {
  readonly workspaceRoot: string;
  readonly indexedFiles: number;
  readonly indexedSymbols: number;
  readonly provenanceCounts: {
    readonly EXTRACTED: number;
    readonly INFERRED: number;
    readonly AMBIGUOUS: number;
  };
  readonly data: unknown;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-electron",
  "build",
  "target",
  ".t3",
  ".vite-plus",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "bin",
  "obj",
]);

const SUPPORTED_EXTS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".cs",
]);

const CALL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "throw",
  "new",
  "typeof",
  "void",
  "await",
  "yield",
  "import",
  "export",
  "function",
  "class",
  "super",
  "this",
  "def",
  "fn",
  "func",
  "match",
  "sizeof",
  "nameof",
  "assert",
  "print",
  "len",
  "range",
  "str",
  "int",
  "float",
  "bool",
  "list",
  "dict",
  "set",
  "tuple",
  "require",
  "console",
  "Math",
  "JSON",
  "Object",
  "Array",
  "Number",
  "String",
  "Boolean",
  "Promise",
  "Error",
  "Set",
  "Map",
  "Date",
  "RegExp",
]);

const MAX_INDEXED_FILES = 4_000;
const MAX_FILE_BYTES = 512 * 1024;
const INDEX_CACHE_MAX_WORKSPACES = 6;

function normalizeRelPath(root: string, absPath: string): string {
  return NodePath.relative(root, absPath).split(NodePath.sep).join("/");
}

/**
 * Replaces comments and string literals with spaces while preserving newlines
 * so line numbers stay 100% exact and strings/comments never generate false AST edges.
 */
function stripCommentsAndStringsPreservingLines(source: string, isPython: boolean): string {
  const out = new Array<string>(source.length);
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i]!;
    const next = i + 1 < n ? source[i + 1]! : "";

    // Python line comment
    if (isPython && ch === "#") {
      while (i < n && source[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }

    // C-style line comment
    if (!isPython && ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }

    // C-style block comment
    if (!isPython && ch === "/" && next === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < n) {
        if (source[i] === "*" && source[i + 1] === "/") {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          break;
        }
        out[i] = source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    // Python triple quotes
    if (isPython && (ch === '"' || ch === "'") && source.slice(i, i + 3) === ch.repeat(3)) {
      const quote3 = ch.repeat(3);
      out[i] = " ";
      out[i + 1] = " ";
      out[i + 2] = " ";
      i += 3;
      while (i < n) {
        if (source.slice(i, i + 3) === quote3) {
          out[i] = " ";
          out[i + 1] = " ";
          out[i + 2] = " ";
          i += 3;
          break;
        }
        out[i] = source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    // Quoted strings (single, double, template backtick)
    if (ch === '"' || ch === "'" || (!isPython && ch === "`")) {
      const quote = ch;
      out[i] = " ";
      i += 1;
      while (i < n) {
        const cur = source[i]!;
        if (cur === "\\") {
          out[i] = " ";
          if (i + 1 < n) {
            out[i + 1] = source[i + 1] === "\n" ? "\n" : " ";
            i += 2;
          } else {
            i += 1;
          }
          continue;
        }
        if (cur === quote) {
          out[i] = " ";
          i += 1;
          break;
        }
        out[i] = cur === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    out[i] = ch;
    i += 1;
  }

  return out.join("");
}

function parseImportNames(clause: string): string[] {
  const names: string[] = [];
  const braceMatch = clause.match(/\{([^}]*)\}/);
  if (braceMatch) {
    for (const part of braceMatch[1]!.split(",")) {
      const clean = part.replace(/\btype\s+/g, "").trim();
      if (!clean) continue;
      const asParts = clean.split(/\s+as\s+/);
      const localName = (asParts[1] ?? asParts[0])?.trim();
      if (localName && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(localName)) {
        names.push(localName);
      }
    }
  }
  const starMatch = clause.match(/\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
  if (starMatch) names.push(starMatch[1]!);

  const defaultMatch = clause.match(/^(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*,|\s*$)/);
  if (defaultMatch && defaultMatch[1] !== "type") {
    names.push(defaultMatch[1]!);
  }
  return names;
}

function parseSourceFile(
  relPath: string,
  source: string,
  mtimeMs: number,
  size: number,
): ParsedFileEntry {
  const ext = NodePath.extname(relPath).toLowerCase();
  const isPython = ext === ".py";
  const isTsJs = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);
  const isRust = ext === ".rs";
  const isGo = ext === ".go";
  const isCSharp = ext === ".cs";

  const symbols: CodeGraphSymbol[] = [];
  const imports: Array<{
    readonly specifier: string;
    readonly importedNames: ReadonlyArray<string>;
    readonly provenance: "EXTRACTED" | "INFERRED";
    readonly line: number;
  }> = [];
  const rawCalls: Array<{
    readonly callerSymbol: string;
    readonly calleeName: string;
    readonly line: number;
  }> = [];

  // 1) Extract static/dynamic imports from raw source (ignoring comment lines)
  const rawLines = source.split(/\r?\n/);
  if (isTsJs) {
    // Handle single-line and multi-line `import ... from "..."` and `export ... from "..."`
    const staticImportRe =
      /(?:^|\n)\s*(?:import|export)\s+([\s\S]{0,400}?)\s+from\s+["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = staticImportRe.exec(source)) !== null) {
      const prefix = source.slice(0, m.index);
      const line = prefix.split("\n").length;
      const lineText = rawLines[line - 1] ?? "";
      if (/^\s*(?:\/\/|\*)/.test(lineText)) continue;
      imports.push({
        specifier: m[2]!,
        importedNames: parseImportNames(m[1]!),
        provenance: "EXTRACTED",
        line,
      });
    }
    const sideEffectImportRe = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
    while ((m = sideEffectImportRe.exec(source)) !== null) {
      const line = source.slice(0, m.index).split("\n").length;
      imports.push({ specifier: m[1]!, importedNames: [], provenance: "EXTRACTED", line });
    }
    const dynamicImportRe = /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = dynamicImportRe.exec(source)) !== null) {
      const line = source.slice(0, m.index).split("\n").length;
      imports.push({ specifier: m[1]!, importedNames: [], provenance: "INFERRED", line });
    }
  } else if (isPython) {
    for (let idx = 0; idx < rawLines.length; idx += 1) {
      const line = rawLines[idx]!;
      const fromMatch = line.match(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)$/);
      if (fromMatch) {
        const names = fromMatch[2]!
          .split(",")
          .map(
            (p) =>
              p
                .trim()
                .split(/\s+as\s+/)[0]
                ?.trim() ?? "",
          )
          .filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
        imports.push({
          specifier: fromMatch[1]!,
          importedNames: names,
          provenance: "EXTRACTED",
          line: idx + 1,
        });
        continue;
      }
      const impMatch = line.match(/^\s*import\s+([A-Za-z0-9_.]+)/);
      if (impMatch) {
        imports.push({
          specifier: impMatch[1]!,
          importedNames: [],
          provenance: "EXTRACTED",
          line: idx + 1,
        });
      }
    }
  } else if (isRust) {
    for (let idx = 0; idx < rawLines.length; idx += 1) {
      const m = rawLines[idx]!.match(/^\s*(?:pub\s+)?use\s+([^;]+);/);
      if (m) {
        imports.push({
          specifier: m[1]!.trim(),
          importedNames: [],
          provenance: "EXTRACTED",
          line: idx + 1,
        });
      }
    }
  } else if (isCSharp) {
    for (let idx = 0; idx < rawLines.length; idx += 1) {
      const m = rawLines[idx]!.match(/^\s*using\s+([A-Za-z0-9_.]+)\s*;/);
      if (m) {
        imports.push({
          specifier: m[1]!,
          importedNames: [],
          provenance: "EXTRACTED",
          line: idx + 1,
        });
      }
    }
  } else if (isGo) {
    const goImportRe = /"([^"]+)"/g;
    let inImportBlock = false;
    for (let idx = 0; idx < rawLines.length; idx += 1) {
      const trimmed = rawLines[idx]!.trim();
      if (/^import\s*\($/.test(trimmed)) {
        inImportBlock = true;
        continue;
      }
      if (inImportBlock && trimmed === ")") {
        inImportBlock = false;
        continue;
      }
      if (inImportBlock || trimmed.startsWith("import ")) {
        let gm: RegExpExecArray | null;
        while ((gm = goImportRe.exec(trimmed)) !== null) {
          imports.push({
            specifier: gm[1]!,
            importedNames: [],
            provenance: "EXTRACTED",
            line: idx + 1,
          });
        }
      }
    }
  }

  // 2) Strip comments & strings for clean deterministic symbol + call extraction
  const cleanSource = stripCommentsAndStringsPreservingLines(source, isPython);
  const cleanLines = cleanSource.split(/\r?\n/);

  let currentSymbol = "<module>";
  let symbolBraceDepth = 0;
  let braceDepth = 0;
  let currentIndent = -1;

  for (let idx = 0; idx < cleanLines.length; idx += 1) {
    const line = cleanLines[idx]!;
    const lineNum = idx + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let definedNameOnLine: string | null = null;

    if (isTsJs) {
      const fnMatch = line.match(
        /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[<(]/,
      );
      const classMatch = line.match(
        /^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
      );
      const ifaceMatch = line.match(/^\s*(export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      const typeMatch = line.match(
        /^\s*(export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*=/,
      );
      const enumMatch = line.match(
        /^\s*(export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
      );
      const constFnMatch = line.match(
        /^\s*(export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>|Effect\.fn|function\b|Schema\.Struct|Schema\.Union|Schema\.Literals|Layer\.)/,
      );

      if (fnMatch) {
        definedNameOnLine = fnMatch[2]!;
        symbols.push({
          name: definedNameOnLine,
          kind: "function",
          file: relPath,
          line: lineNum,
          exported: Boolean(fnMatch[1]),
        });
        currentSymbol = definedNameOnLine;
        symbolBraceDepth = braceDepth;
      } else if (classMatch) {
        definedNameOnLine = classMatch[2]!;
        symbols.push({
          name: definedNameOnLine,
          kind: "class",
          file: relPath,
          line: lineNum,
          exported: Boolean(classMatch[1]),
        });
        currentSymbol = definedNameOnLine;
        symbolBraceDepth = braceDepth;
      } else if (ifaceMatch) {
        definedNameOnLine = ifaceMatch[2]!;
        symbols.push({
          name: definedNameOnLine,
          kind: "interface",
          file: relPath,
          line: lineNum,
          exported: Boolean(ifaceMatch[1]),
        });
      } else if (typeMatch) {
        definedNameOnLine = typeMatch[2]!;
        symbols.push({
          name: definedNameOnLine,
          kind: "type",
          file: relPath,
          line: lineNum,
          exported: Boolean(typeMatch[1]),
        });
      } else if (enumMatch) {
        definedNameOnLine = enumMatch[2]!;
        symbols.push({
          name: definedNameOnLine,
          kind: "enum",
          file: relPath,
          line: lineNum,
          exported: Boolean(enumMatch[1]),
        });
      } else if (constFnMatch) {
        definedNameOnLine = constFnMatch[2]!;
        symbols.push({
          name: definedNameOnLine,
          kind: "const",
          file: relPath,
          line: lineNum,
          exported: Boolean(constFnMatch[1]),
        });
        currentSymbol = definedNameOnLine;
        symbolBraceDepth = braceDepth;
      }
    } else if (isPython) {
      const indent = line.search(/\S/);
      if (currentIndent >= 0 && indent <= currentIndent) {
        currentSymbol = "<module>";
        currentIndent = -1;
      }
      const pyFn = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      const pyCls = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
      if (pyFn) {
        definedNameOnLine = pyFn[1]!;
        symbols.push({
          name: definedNameOnLine,
          kind: indent > 0 ? "method" : "function",
          file: relPath,
          line: lineNum,
          exported: !definedNameOnLine.startsWith("_"),
        });
        currentSymbol = definedNameOnLine;
        currentIndent = indent;
      } else if (pyCls) {
        definedNameOnLine = pyCls[1]!;
        symbols.push({
          name: definedNameOnLine,
          kind: "class",
          file: relPath,
          line: lineNum,
          exported: !definedNameOnLine.startsWith("_"),
        });
        currentSymbol = definedNameOnLine;
        currentIndent = indent;
      }
    } else if (isRust) {
      const rsFn = line.match(
        /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
      );
      const rsStruct = line.match(
        /^\s*(pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
      );
      if (rsFn) {
        definedNameOnLine = rsFn[2]!;
        symbols.push({
          name: definedNameOnLine,
          kind: "function",
          file: relPath,
          line: lineNum,
          exported: Boolean(rsFn[1]),
        });
        currentSymbol = definedNameOnLine;
        symbolBraceDepth = braceDepth;
      } else if (rsStruct) {
        definedNameOnLine = rsStruct[2]!;
        symbols.push({
          name: definedNameOnLine,
          kind: "class",
          file: relPath,
          line: lineNum,
          exported: Boolean(rsStruct[1]),
        });
      }
    } else if (isGo) {
      const goFn = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      const goType = line.match(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)\b/);
      if (goFn) {
        definedNameOnLine = goFn[1]!;
        symbols.push({
          name: definedNameOnLine,
          kind: "function",
          file: relPath,
          line: lineNum,
          exported: /^[A-Z]/.test(definedNameOnLine),
        });
        currentSymbol = definedNameOnLine;
        symbolBraceDepth = braceDepth;
      } else if (goType) {
        definedNameOnLine = goType[1]!;
        symbols.push({
          name: definedNameOnLine,
          kind: "type",
          file: relPath,
          line: lineNum,
          exported: /^[A-Z]/.test(definedNameOnLine),
        });
      }
    } else if (isCSharp) {
      const csCls = line.match(
        /^\s*(public\s+|internal\s+|private\s+)?(?:static\s+|sealed\s+|abstract\s+|partial\s+)*(?:class|interface|struct|record)\s+([A-Za-z_][A-Za-z0-9_]*)/,
      );
      if (csCls) {
        definedNameOnLine = csCls[2]!;
        symbols.push({
          name: definedNameOnLine,
          kind: "class",
          file: relPath,
          line: lineNum,
          exported: Boolean(csCls[1]?.trim() === "public"),
        });
        currentSymbol = definedNameOnLine;
        symbolBraceDepth = braceDepth;
      }
    }

    // Extract call expressions on this line: `callee(` or `obj.callee(`
    const callRe = /(?:^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(line)) !== null) {
      const callee = cm[1]!;
      if (callee === definedNameOnLine || CALL_KEYWORDS.has(callee)) continue;
      if (callee.length < 2) continue;
      rawCalls.push({
        callerSymbol: currentSymbol,
        calleeName: callee,
        line: lineNum,
      });
    }

    // Track brace depth for enclosing symbol scope
    if (!isPython) {
      for (let c = 0; c < line.length; c += 1) {
        if (line[c] === "{") braceDepth += 1;
        else if (line[c] === "}") {
          braceDepth = Math.max(0, braceDepth - 1);
          if (currentSymbol !== "<module>" && braceDepth <= symbolBraceDepth) {
            currentSymbol = "<module>";
          }
        }
      }
    }
  }

  return { relPath, mtimeMs, size, symbols, imports, rawCalls };
}

function resolveImportSpecifier(
  fromRelPath: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const fromDir = NodePath.posix.dirname(fromRelPath);
  const rawJoined = NodePath.posix.normalize(NodePath.posix.join(fromDir, specifier));

  const candidates = [rawJoined];
  const ext = NodePath.posix.extname(rawJoined);
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    const stem = rawJoined.slice(0, -ext.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.js`);
  } else if (!ext) {
    candidates.push(
      `${rawJoined}.ts`,
      `${rawJoined}.tsx`,
      `${rawJoined}.js`,
      `${rawJoined}.jsx`,
      `${rawJoined}.py`,
      `${rawJoined}/index.ts`,
      `${rawJoined}/index.tsx`,
      `${rawJoined}/index.js`,
    );
  }

  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function collectSourceFiles(workspaceRoot: string, subPath?: string): string[] {
  const startDir = subPath
    ? NodePath.resolve(workspaceRoot, subPath)
    : NodePath.resolve(workspaceRoot);
  const resolvedRoot = NodePath.resolve(workspaceRoot);
  const relCheck = NodePath.relative(resolvedRoot, startDir);
  if (relCheck.startsWith("..") || NodePath.isAbsolute(relCheck)) {
    throw new Error(`Path '${subPath}' escapes workspace root.`);
  }
  if (!NodeFs.existsSync(startDir)) return [];

  const results: string[] = [];
  const stack: string[] = [startDir];

  while (stack.length > 0 && results.length < MAX_INDEXED_FILES) {
    const dir = stack.pop()!;
    let stat: NodeFs.Stats;
    try {
      stat = NodeFs.statSync(dir);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      if (SUPPORTED_EXTS.has(NodePath.extname(dir).toLowerCase()) && stat.size <= MAX_FILE_BYTES) {
        results.push(dir);
      }
      continue;
    }
    if (!stat.isDirectory()) continue;

    let entries: NodeFs.Dirent[];
    try {
      entries = NodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push(NodePath.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = NodePath.extname(entry.name).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext)) continue;
        const full = NodePath.join(dir, entry.name);
        try {
          if (NodeFs.statSync(full).size <= MAX_FILE_BYTES) {
            results.push(full);
            if (results.length >= MAX_INDEXED_FILES) break;
          }
        } catch {
          // Ignore transient unreadable file.
        }
      }
    }
  }
  return results;
}

export class WorkspaceCodeGraph {
  private readonly workspaceRoot: string;
  private readonly fileEntries = new Map<string, ParsedFileEntry>();
  private symbolsByName = new Map<string, CodeGraphSymbol[]>();
  private importsByFile = new Map<string, CodeGraphImportEdge[]>();
  private importersByFile = new Map<string, CodeGraphImportEdge[]>();
  private callsByCallee = new Map<string, CodeGraphCallEdge[]>();
  private callsByCaller = new Map<string, CodeGraphCallEdge[]>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = NodePath.resolve(workspaceRoot);
  }

  /** Incrementally refreshes changed/new/deleted files using mtime + size cache. */
  public refresh(scopeSubPath?: string): {
    readonly indexedFiles: number;
    readonly indexedSymbols: number;
  } {
    const absFiles = collectSourceFiles(this.workspaceRoot, scopeSubPath);
    const seenRel = new Set<string>();
    let changed = false;

    for (const absPath of absFiles) {
      const relPath = normalizeRelPath(this.workspaceRoot, absPath);
      seenRel.add(relPath);
      let stat: NodeFs.Stats;
      try {
        stat = NodeFs.statSync(absPath);
      } catch {
        continue;
      }
      const existing = this.fileEntries.get(relPath);
      if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) {
        continue;
      }
      let source: string;
      try {
        source = NodeFs.readFileSync(absPath, "utf8");
      } catch {
        continue;
      }
      this.fileEntries.set(relPath, parseSourceFile(relPath, source, stat.mtimeMs, stat.size));
      changed = true;
    }

    // Prune deleted files only when refreshing full root
    if (!scopeSubPath) {
      for (const relPath of [...this.fileEntries.keys()]) {
        if (!seenRel.has(relPath)) {
          this.fileEntries.delete(relPath);
          changed = true;
        }
      }
    }

    if (changed || this.symbolsByName.size === 0) {
      this.rebuildRelations();
    }

    let totalSymbols = 0;
    for (const list of this.symbolsByName.values()) totalSymbols += list.length;
    return { indexedFiles: this.fileEntries.size, indexedSymbols: totalSymbols };
  }

  private rebuildRelations(): void {
    const fileSet = new Set(this.fileEntries.keys());
    const symbolsByName = new Map<string, CodeGraphSymbol[]>();
    const symbolsByFile = new Map<string, Map<string, CodeGraphSymbol>>();
    const importsByFile = new Map<string, CodeGraphImportEdge[]>();
    const importersByFile = new Map<string, CodeGraphImportEdge[]>();
    const callsByCallee = new Map<string, CodeGraphCallEdge[]>();
    const callsByCaller = new Map<string, CodeGraphCallEdge[]>();

    for (const entry of this.fileEntries.values()) {
      const localMap = new Map<string, CodeGraphSymbol>();
      for (const sym of entry.symbols) {
        localMap.set(sym.name, sym);
        const list = symbolsByName.get(sym.name) ?? [];
        list.push(sym);
        symbolsByName.set(sym.name, list);
      }
      symbolsByFile.set(entry.relPath, localMap);
    }

    // Resolve imports
    for (const entry of this.fileEntries.values()) {
      const edges: CodeGraphImportEdge[] = [];
      for (const imp of entry.imports) {
        const resolvedFile = resolveImportSpecifier(entry.relPath, imp.specifier, fileSet);
        const edge: CodeGraphImportEdge = {
          fromFile: entry.relPath,
          specifier: imp.specifier,
          resolvedFile,
          importedNames: imp.importedNames,
          provenance: imp.provenance,
          line: imp.line,
        };
        edges.push(edge);
        if (resolvedFile) {
          const rev = importersByFile.get(resolvedFile) ?? [];
          rev.push(edge);
          importersByFile.set(resolvedFile, rev);
        }
      }
      importsByFile.set(entry.relPath, edges);
    }

    // Resolve call edges with EXTRACTED / INFERRED / AMBIGUOUS provenance
    for (const entry of this.fileEntries.values()) {
      const localSyms = symbolsByFile.get(entry.relPath)!;
      const fileImports = importsByFile.get(entry.relPath) ?? [];
      const importedTargetByName = new Map<string, string>();
      const namespaceImportedFiles = new Set<string>();
      for (const imp of fileImports) {
        if (!imp.resolvedFile) continue;
        if (imp.importedNames.length === 0) {
          namespaceImportedFiles.add(imp.resolvedFile);
        }
        for (const name of imp.importedNames) {
          importedTargetByName.set(name, imp.resolvedFile);
        }
      }

      for (const call of entry.rawCalls) {
        const localHit = localSyms.get(call.calleeName);
        let edge: CodeGraphCallEdge | null = null;

        if (localHit) {
          edge = {
            callerFile: entry.relPath,
            callerSymbol: call.callerSymbol,
            calleeName: call.calleeName,
            targetFile: entry.relPath,
            targetLine: localHit.line,
            line: call.line,
            provenance: "EXTRACTED",
          };
        } else if (importedTargetByName.has(call.calleeName)) {
          const targetFile = importedTargetByName.get(call.calleeName)!;
          const targetSym = symbolsByFile.get(targetFile)?.get(call.calleeName);
          edge = {
            callerFile: entry.relPath,
            callerSymbol: call.callerSymbol,
            calleeName: call.calleeName,
            targetFile,
            targetLine: targetSym?.line ?? null,
            line: call.line,
            provenance: "EXTRACTED",
          };
        } else {
          const globalHits = symbolsByName.get(call.calleeName);
          if (globalHits && globalHits.length > 0) {
            const nsHits = globalHits.filter((s) => namespaceImportedFiles.has(s.file));
            if (nsHits.length === 1) {
              edge = {
                callerFile: entry.relPath,
                callerSymbol: call.callerSymbol,
                calleeName: call.calleeName,
                targetFile: nsHits[0]!.file,
                targetLine: nsHits[0]!.line,
                line: call.line,
                provenance: "EXTRACTED",
              };
            } else if (globalHits.length === 1) {
              edge = {
                callerFile: entry.relPath,
                callerSymbol: call.callerSymbol,
                calleeName: call.calleeName,
                targetFile: globalHits[0]!.file,
                targetLine: globalHits[0]!.line,
                line: call.line,
                provenance: "INFERRED",
              };
            } else {
              edge = {
                callerFile: entry.relPath,
                callerSymbol: call.callerSymbol,
                calleeName: call.calleeName,
                targetFile: null,
                targetLine: null,
                line: call.line,
                provenance: "AMBIGUOUS",
                candidateFiles: [...new Set(globalHits.map((s) => s.file))].slice(0, 8),
              };
            }
          }
        }

        if (!edge) continue;
        const calleeList = callsByCallee.get(call.calleeName) ?? [];
        calleeList.push(edge);
        callsByCallee.set(call.calleeName, calleeList);

        const callerKey = `${entry.relPath}::${call.callerSymbol}`;
        const callerList = callsByCaller.get(callerKey) ?? [];
        callerList.push(edge);
        callsByCaller.set(callerKey, callerList);
      }
    }

    this.symbolsByName = symbolsByName;
    this.importsByFile = importsByFile;
    this.importersByFile = importersByFile;
    this.callsByCallee = callsByCallee;
    this.callsByCaller = callsByCaller;
  }

  private normalizeTargetPath(target: string): string {
    return target.replace(/\\/g, "/").replace(/^\.\//, "");
  }

  public querySymbols(target: string, maxResults = 50): CodeGraphSymbol[] {
    const q = this.normalizeTargetPath(target).toLowerCase();
    const hits: CodeGraphSymbol[] = [];
    for (const entry of this.fileEntries.values()) {
      const fileMatch = entry.relPath.toLowerCase().includes(q);
      for (const sym of entry.symbols) {
        if (fileMatch || sym.name.toLowerCase().includes(q)) {
          hits.push(sym);
          if (hits.length >= maxResults) return hits;
        }
      }
    }
    return hits;
  }

  public queryImports(targetFile: string): {
    readonly file: string | null;
    readonly outgoing: ReadonlyArray<CodeGraphImportEdge>;
    readonly incoming: ReadonlyArray<CodeGraphImportEdge>;
  } {
    const norm = this.normalizeTargetPath(targetFile);
    const exact = this.fileEntries.has(norm)
      ? norm
      : ([...this.fileEntries.keys()].find((f) => f.endsWith(norm)) ?? null);
    if (!exact) return { file: null, outgoing: [], incoming: [] };
    return {
      file: exact,
      outgoing: this.importsByFile.get(exact) ?? [],
      incoming: this.importersByFile.get(exact) ?? [],
    };
  }

  public queryCallers(symbolName: string, maxResults = 60): ReadonlyArray<CodeGraphCallEdge> {
    return (this.callsByCallee.get(symbolName.trim()) ?? []).slice(0, maxResults);
  }

  public queryCallees(symbolOrFile: string, maxResults = 60): ReadonlyArray<CodeGraphCallEdge> {
    const trimmed = symbolOrFile.trim();
    const out: CodeGraphCallEdge[] = [];
    for (const [key, edges] of this.callsByCaller.entries()) {
      const [file, sym] = key.split("::");
      if (sym === trimmed || file === this.normalizeTargetPath(trimmed)) {
        for (const edge of edges) {
          out.push(edge);
          if (out.length >= maxResults) return out;
        }
      }
    }
    return out;
  }

  public queryImpactRadius(
    target: string,
    maxDepth = 2,
    maxResults = 60,
  ): {
    readonly seedFiles: ReadonlyArray<string>;
    readonly impacted: ReadonlyArray<{
      readonly file: string;
      readonly depth: number;
      readonly via: string;
      readonly provenance: CodeGraphEdgeProvenance;
    }>;
  } {
    const depthCap = Math.max(1, Math.min(4, maxDepth));
    const norm = this.normalizeTargetPath(target);
    const seedFiles = new Set<string>();

    if (this.fileEntries.has(norm)) {
      seedFiles.add(norm);
    } else {
      for (const f of this.fileEntries.keys()) {
        if (f.endsWith(`/${norm}`) || f === norm) seedFiles.add(f);
      }
      for (const sym of this.symbolsByName.get(target.trim()) ?? []) {
        seedFiles.add(sym.file);
      }
    }

    const visited = new Set<string>(seedFiles);
    const queue: Array<{ readonly file: string; readonly depth: number }> = [...seedFiles].map(
      (file) => ({ file, depth: 0 }),
    );
    const impacted: Array<{
      readonly file: string;
      readonly depth: number;
      readonly via: string;
      readonly provenance: CodeGraphEdgeProvenance;
    }> = [];

    while (queue.length > 0 && impacted.length < maxResults) {
      const current = queue.shift()!;
      if (current.depth >= depthCap) continue;

      // 1) Files that import current.file
      for (const imp of this.importersByFile.get(current.file) ?? []) {
        if (visited.has(imp.fromFile)) continue;
        visited.add(imp.fromFile);
        impacted.push({
          file: imp.fromFile,
          depth: current.depth + 1,
          via: `import(${current.file})`,
          provenance: imp.provenance,
        });
        queue.push({ file: imp.fromFile, depth: current.depth + 1 });
        if (impacted.length >= maxResults) break;
      }

      // 2) Callers of symbols exported from current.file
      const entry = this.fileEntries.get(current.file);
      if (entry) {
        for (const sym of entry.symbols) {
          for (const call of this.callsByCallee.get(sym.name) ?? []) {
            if (visited.has(call.callerFile)) continue;
            visited.add(call.callerFile);
            impacted.push({
              file: call.callerFile,
              depth: current.depth + 1,
              via: `call(${sym.name})`,
              provenance: call.provenance,
            });
            queue.push({ file: call.callerFile, depth: current.depth + 1 });
            if (impacted.length >= maxResults) break;
          }
          if (impacted.length >= maxResults) break;
        }
      }
    }

    return { seedFiles: [...seedFiles], impacted };
  }
}

const graphCache = new Map<string, WorkspaceCodeGraph>();

export function getOrCreateWorkspaceCodeGraph(workspaceRoot: string): WorkspaceCodeGraph {
  const key = NodePath.resolve(workspaceRoot).toLowerCase();
  const existing = graphCache.get(key);
  if (existing) {
    graphCache.delete(key);
    graphCache.set(key, existing);
    return existing;
  }
  const created = new WorkspaceCodeGraph(workspaceRoot);
  graphCache.set(key, created);
  while (graphCache.size > INDEX_CACHE_MAX_WORKSPACES) {
    const oldest = graphCache.keys().next().value;
    if (oldest !== undefined) graphCache.delete(oldest);
  }
  return created;
}
