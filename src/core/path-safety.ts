import path from "node:path";
import type { Stats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { OperationError, type ScanResult } from "./types.js";

export type PathSafetyErrorCode = "UNSAFE_PATH" | "STALE_PLAN";
export type PathKind = "file" | "directory" | "other";

export class PathSafetyError extends OperationError {
  declare readonly code: PathSafetyErrorCode;
  readonly path: string;
  readonly reason: string;

  constructor(code: PathSafetyErrorCode, targetPath: string, reason: string) {
    super(code, `${reason} (${targetPath})`, {
      operationStatus: "not_started",
      verificationStatus: "not_run",
    });
    this.name = "PathSafetyError";
    this.path = targetPath;
    this.reason = reason;
  }
}

export interface PathIdentity {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  kind: PathKind;
}

export interface TrustedRootContext {
  /** The absolute path supplied by the caller, before following the root itself. */
  lexicalPath: string;
  /** The canonical root used to rebuild every managed path. */
  realPath: string;
  identity: PathIdentity;
}

export interface RegisteredTrustedRoots {
  root: TrustedRootContext;
  sqliteHome: TrustedRootContext | null;
}

const registeredTrustedRoots = new WeakMap<object, RegisteredTrustedRoots>();

export function registerTrustedRoots(
  owner: object,
  root: TrustedRootContext,
  sqliteHome: TrustedRootContext | null,
): void {
  registeredTrustedRoots.set(owner, { root, sqliteHome });
}

export function getRegisteredTrustedRoots(owner: object): RegisteredTrustedRoots | null {
  return registeredTrustedRoots.get(owner) ?? null;
}

/**
 * A destructive operation may only use the exact trusted-root contexts that
 * were captured for the scan object. Reconstructing trust from a shallow clone
 * would turn an untrusted current pathname into new authority.
 */
export function requireMutationTrustedRoots(scan: ScanResult): RegisteredTrustedRoots {
  const registered = getRegisteredTrustedRoots(scan.root);
  if (!registered) {
    throw new PathSafetyError(
      "UNSAFE_PATH",
      scan.root.rootPath,
      "destructive operation requires the trusted-root context captured by scanCodexRoot",
    );
  }

  const issues = scan.safety?.unsafeSurfaces ?? scan.root.unsafeSurfaces;
  if (!scan.safety || !Array.isArray(issues)) {
    throw new PathSafetyError(
      "UNSAFE_PATH",
      scan.root.rootPath,
      "destructive operation requires typed scan safety state",
    );
  }
  if (issues.length > 0 || !scan.safety.complete) {
    const first = issues[0];
    throw new PathSafetyError(
      "UNSAFE_PATH",
      first?.path ?? scan.root.rootPath,
      first
        ? `scan is incomplete because ${first.surface} is unsafe: ${first.reason}`
        : "scan safety state is incomplete",
    );
  }

  return registered;
}

export interface ManagedPathComponentIdentity {
  relativePath: string;
  absolutePath: string;
  identity: PathIdentity;
}

export interface CaptureManagedPathOptions {
  expectedKind?: "any" | "file" | "directory";
  allowMissing?: boolean;
  rejectHardlinks?: boolean;
}

interface ResolvedCaptureManagedPathOptions {
  expectedKind: "any" | "file" | "directory";
  allowMissing: boolean;
  rejectHardlinks: boolean;
}

export interface ManagedPathSnapshot {
  rootRealPath: string;
  rootIdentity: PathIdentity;
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  identity: PathIdentity | null;
  deepestExistingPath: string;
  deepestExistingRelativePath: string;
  components: ManagedPathComponentIdentity[];
  options: ResolvedCaptureManagedPathOptions;
}

function unsafe(targetPath: string, reason: string): never {
  throw new PathSafetyError("UNSAFE_PATH", targetPath, reason);
}

function stale(targetPath: string, reason: string): never {
  throw new PathSafetyError("STALE_PLAN", targetPath, reason);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function isPathSafetyError(error: unknown): error is PathSafetyError {
  return error instanceof PathSafetyError;
}

function pathKind(fileStat: Stats): PathKind {
  if (fileStat.isFile()) return "file";
  if (fileStat.isDirectory()) return "directory";
  return "other";
}

function identityFromStat(fileStat: Stats): PathIdentity {
  return {
    dev: fileStat.dev,
    ino: fileStat.ino,
    mode: fileStat.mode,
    nlink: fileStat.nlink,
    kind: pathKind(fileStat),
  };
}

function identitiesMatch(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.kind === right.kind
    && (left.kind === "directory" || left.nlink === right.nlink);
}

function relativeIfContained(basePath: string, candidatePath: string): string | null {
  const relativePath = path.relative(basePath, candidatePath);
  if (relativePath === "") return "";
  if (
    relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath;
}

function normalizeManagedRelativePath(relativePath: string): string {
  if (relativePath.includes("\0")) {
    unsafe(relativePath, "managed path contains a NUL byte");
  }

  if (
    path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || /^[A-Za-z]:/.test(relativePath)
  ) {
    unsafe(relativePath, "managed path must be relative to the trusted root");
  }

  const parts = relativePath
    .split(/[\\/]+/u)
    .filter((part) => part !== "" && part !== ".");

  if (parts.length === 0) {
    unsafe(relativePath, "the trusted root itself is not a managed target");
  }
  if (parts.some((part) => part === "..")) {
    unsafe(relativePath, "managed path cannot traverse above the trusted root");
  }

  return path.join(...parts);
}

function normalizeOptions(options: CaptureManagedPathOptions): ResolvedCaptureManagedPathOptions {
  return {
    expectedKind: options.expectedKind ?? "any",
    allowMissing: options.allowMissing ?? true,
    rejectHardlinks: options.rejectHardlinks ?? true,
  };
}

async function lstatOrUnsafe(targetPath: string, reasonPrefix: string): Promise<Stats> {
  try {
    return await lstat(targetPath);
  } catch (error) {
    unsafe(targetPath, `${reasonPrefix}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertRootIdentity(context: TrustedRootContext): Promise<void> {
  let rootStat: Stats;
  try {
    rootStat = await lstat(context.realPath);
  } catch (error) {
    stale(
      context.realPath,
      `trusted root is no longer available: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const currentIdentity = identityFromStat(rootStat);
  if (rootStat.isSymbolicLink() || currentIdentity.kind !== "directory") {
    stale(context.realPath, "trusted root is no longer the captured directory");
  }
  if (!identitiesMatch(context.identity, currentIdentity)) {
    stale(context.realPath, "trusted root identity changed after capture");
  }
}

export async function assertTrustedRootCurrent(context: TrustedRootContext): Promise<void> {
  await assertRootIdentity(context);
}

function assertSafeExistingComponent(
  targetPath: string,
  fileStat: Stats,
  isFinal: boolean,
  options: ResolvedCaptureManagedPathOptions,
): PathIdentity {
  if (fileStat.isSymbolicLink()) {
    unsafe(targetPath, "managed path contains a symbolic link or junction");
  }

  const identity = identityFromStat(fileStat);
  if (identity.kind === "other") {
    unsafe(targetPath, "managed path contains an unsupported special file");
  }
  if (!isFinal && identity.kind !== "directory") {
    unsafe(targetPath, "a managed parent component is not a directory");
  }
  if (identity.kind === "file" && options.rejectHardlinks && identity.nlink > 1) {
    unsafe(targetPath, "managed regular file has multiple hard links");
  }
  if (isFinal && options.expectedKind !== "any" && identity.kind !== options.expectedKind) {
    unsafe(targetPath, `managed target must be a ${options.expectedKind}`);
  }

  return identity;
}

/**
 * Canonicalizes the caller-supplied root once. The root path itself may be a
 * symlink; managed descendants may not contain symlinks or junctions.
 */
export async function createTrustedRootContext(rootPath: string): Promise<TrustedRootContext> {
  if (rootPath.includes("\0")) {
    unsafe(rootPath, "trusted root contains a NUL byte");
  }

  const lexicalPath = path.resolve(rootPath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch (error) {
    unsafe(
      lexicalPath,
      `trusted root cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rootStat = await lstatOrUnsafe(canonicalPath, "trusted root cannot be inspected");
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    unsafe(canonicalPath, "trusted root must resolve to a directory");
  }

  const confirmedCanonicalPath = await realpath(lexicalPath).catch((error: unknown) => {
    unsafe(
      lexicalPath,
      `trusted root changed while it was being captured: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (confirmedCanonicalPath !== canonicalPath) {
    unsafe(lexicalPath, "trusted root changed while it was being captured");
  }

  return {
    lexicalPath,
    realPath: canonicalPath,
    identity: identityFromStat(rootStat),
  };
}

/** Rebuilds a managed target from a trusted canonical root and safe relative path. */
export function reconstructManagedPath(
  context: TrustedRootContext,
  relativePath: string,
): { relativePath: string; absolutePath: string } {
  const normalizedRelativePath = normalizeManagedRelativePath(relativePath);
  const absolutePath = path.resolve(context.realPath, normalizedRelativePath);
  const containmentRelativePath = relativeIfContained(context.realPath, absolutePath);
  if (containmentRelativePath === null || containmentRelativePath === "") {
    unsafe(absolutePath, "managed path escapes or resolves to the trusted root");
  }

  return {
    relativePath: containmentRelativePath,
    absolutePath,
  };
}

/** Converts a lexical absolute path under the root (or its accepted alias) to a managed relative path. */
export function toManagedRelativePath(context: TrustedRootContext, candidatePath: string): string {
  if (candidatePath.includes("\0")) {
    unsafe(candidatePath, "candidate path contains a NUL byte");
  }
  if (!path.isAbsolute(candidatePath)) {
    unsafe(candidatePath, "candidate path must be absolute");
  }

  const absoluteCandidatePath = path.resolve(candidatePath);
  for (const basePath of new Set([context.realPath, context.lexicalPath])) {
    const relativePath = relativeIfContained(basePath, absoluteCandidatePath);
    if (relativePath !== null && relativePath !== "") {
      return reconstructManagedPath(context, relativePath).relativePath;
    }
  }

  unsafe(candidatePath, "candidate path is outside the trusted root");
}

/**
 * Walks a managed path with lstat one component at a time. Missing targets are
 * represented by the deepest existing safe parent instead of being followed.
 */
export async function captureManagedPath(
  context: TrustedRootContext,
  relativePath: string,
  requestedOptions: CaptureManagedPathOptions = {},
): Promise<ManagedPathSnapshot> {
  await assertRootIdentity(context);

  const options = normalizeOptions(requestedOptions);
  const reconstructed = reconstructManagedPath(context, relativePath);
  const pathParts = reconstructed.relativePath.split(path.sep);
  const components: ManagedPathComponentIdentity[] = [
    {
      relativePath: ".",
      absolutePath: context.realPath,
      identity: context.identity,
    },
  ];

  let deepestExistingPath = context.realPath;
  let deepestExistingRelativePath = ".";
  let finalIdentity: PathIdentity | null = null;
  let exists = true;

  for (let index = 0; index < pathParts.length; index += 1) {
    const componentRelativePath = path.join(...pathParts.slice(0, index + 1));
    const componentPath = path.join(context.realPath, componentRelativePath);
    let componentStat: Stats;
    try {
      componentStat = await lstat(componentPath);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        exists = false;
        break;
      }
      unsafe(
        componentPath,
        `managed path component cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const isFinal = index === pathParts.length - 1;
    const identity = assertSafeExistingComponent(componentPath, componentStat, isFinal, options);
    components.push({
      relativePath: componentRelativePath,
      absolutePath: componentPath,
      identity,
    });
    deepestExistingPath = componentPath;
    deepestExistingRelativePath = componentRelativePath;
    if (isFinal) finalIdentity = identity;
  }

  if (!exists && !options.allowMissing) {
    unsafe(reconstructed.absolutePath, "managed target does not exist");
  }

  return {
    rootRealPath: context.realPath,
    rootIdentity: context.identity,
    ...reconstructed,
    exists,
    identity: exists ? finalIdentity : null,
    deepestExistingPath,
    deepestExistingRelativePath,
    components,
    options,
  };
}

/**
 * Repeats the component walk and rejects any identity or existence change.
 * This narrows, but does not eliminate, same-user filesystem races; callers
 * still need a final check immediately before their mutation.
 */
export async function revalidateManagedPath(
  context: TrustedRootContext,
  snapshot: ManagedPathSnapshot,
): Promise<void> {
  if (
    snapshot.rootRealPath !== context.realPath
    || !identitiesMatch(snapshot.rootIdentity, context.identity)
  ) {
    stale(snapshot.absolutePath, "managed path snapshot belongs to a different trusted root");
  }

  let current: ManagedPathSnapshot;
  try {
    current = await captureManagedPath(context, snapshot.relativePath, snapshot.options);
  } catch (error) {
    if (isPathSafetyError(error)) {
      if (error.code === "STALE_PLAN") throw error;
      stale(error.path, `managed path became unsafe after capture: ${error.reason}`);
    }
    throw error;
  }

  if (snapshot.exists !== current.exists) {
    stale(snapshot.absolutePath, "managed target existence changed after capture");
  }
  if (snapshot.deepestExistingRelativePath !== current.deepestExistingRelativePath) {
    stale(
      current.deepestExistingPath,
      "the deepest existing managed parent changed after capture",
    );
  }
  if (snapshot.components.length !== current.components.length) {
    stale(current.deepestExistingPath, "managed path component count changed after capture");
  }

  for (let index = 0; index < snapshot.components.length; index += 1) {
    const previousComponent = snapshot.components[index];
    const currentComponent = current.components[index];
    if (
      previousComponent.relativePath !== currentComponent.relativePath
      || !identitiesMatch(previousComponent.identity, currentComponent.identity)
    ) {
      stale(currentComponent.absolutePath, "managed path identity changed after capture");
    }
  }
}

export async function readManagedFile(
  context: TrustedRootContext,
  relativePath: string,
): Promise<Buffer> {
  return (await readManagedFileWithMetadata(context, relativePath)).bytes;
}

export async function readManagedFileWithMetadata(
  context: TrustedRootContext,
  relativePath: string,
): Promise<{ bytes: Buffer; size: number; mtimeMs: number }> {
  const snapshot = await captureManagedPath(context, relativePath, {
    expectedKind: "file",
    allowMissing: false,
  });
  const before = await lstat(snapshot.absolutePath);
  const bytes = await readFile(snapshot.absolutePath);
  const after = await lstat(snapshot.absolutePath);
  await revalidateManagedPath(context, snapshot);
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.mode !== after.mode
    || before.nlink !== after.nlink
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
  ) {
    stale(snapshot.absolutePath, "managed file changed while it was being read");
  }
  return { bytes, size: before.size, mtimeMs: before.mtimeMs };
}

export async function readManagedText(
  context: TrustedRootContext,
  relativePath: string,
): Promise<string> {
  return (await readManagedFile(context, relativePath)).toString("utf8");
}
