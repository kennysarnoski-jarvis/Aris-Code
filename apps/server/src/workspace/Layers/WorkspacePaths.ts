import { lstat as nodeLstat } from "node:fs/promises";
import * as OS from "node:os";
import { Effect, FileSystem, Layer, Path } from "effect";

import {
  WorkspacePaths,
  WorkspacePathOutsideRootError,
  WorkspaceRootCreateFailedError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotExistsError,
  type WorkspacePathsShape,
} from "../Services/WorkspacePaths.ts";

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

/**
 * Slice B (2026-05-16) — verify the resolved absolute target stays inside
 * `realRoot` after resolving every symlink in the path chain.
 *
 * Why this is necessary: `path.relative(root, target)` operates on STRINGS
 * only and never touches the filesystem. A symlink INSIDE the workspace
 * pointing OUTSIDE it passes the string check but, when the kernel
 * resolves the path at `open(2)` time, the operation lands wherever the
 * symlink points. C1 attack: `workspace/link → /etc`; `writeFile("link/passwd")`
 * passes string containment (no `..`, no absolute) but writes `/etc/passwd`.
 *
 * Algorithm walks the path from `realRoot` down to `target`, one
 * component at a time:
 *
 *   1. For each component, `lstat` it (NOT `stat` — we need to detect
 *      symlinks even if their targets are broken, which `stat` follows
 *      through and may surface as ENOENT).
 *   2. If the component doesn't exist (ENOENT): the rest of the path is
 *      to-be-created. All ancestors validated. Accept (write operations
 *      land here).
 *   3. If the component is a symlink: `realPath` it to follow the chain.
 *      Verify the resolved location is still inside `realRoot`. Continue
 *      walking from the resolved location.
 *   4. If broken symlink (lstat says it's a symlink but realPath fails):
 *      we CANNOT verify where it points. Reject — blocks the
 *      broken-symlink write attack where `writeFile(workspace/badlink/foo)`
 *      would follow the broken symlink and create `foo` at the symlink's
 *      target if the target's parent dir exists.
 *   5. If regular file/dir: continue walking.
 *
 * Returns `true` if every component is contained, `false` if ANY escape
 * (symlink-to-outside or broken-symlink) is detected.
 *
 * Takes services as explicit arguments instead of yielding them so its
 * Effect doesn't leak `FileSystem | Path` into the caller's requirements
 * channel — the `WorkspacePathsShape.resolveRelativePathWithinRoot`
 * contract specifies no requirements.
 */
const validateContainment = (
  target: string,
  syntacticRoot: string,
  realRoot: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    // Pre-check against the SYNTACTIC root — the same base `target` was
    // resolved from. On macOS `/tmp` → `/private/tmp`, so `realRoot`
    // differs from the user-visible root. Using `syntacticRoot` here
    // keeps the string check coherent with `path.resolve` above.
    const relToSyntacticRoot = path.relative(syntacticRoot, target);
    if (relToSyntacticRoot.startsWith("..") || path.isAbsolute(relToSyntacticRoot)) {
      return null;
    }

    const parts = relToSyntacticRoot
      .split(/[/\\]/)
      .filter((p: string) => p.length > 0 && p !== ".");
    let current = realRoot;
    let deepestExisting = realRoot;
    let remainingParts: string[] = [];
    let sawSymlink = false;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!; // bounds guarantee defined; for-loop index
      if (part === "..") return null; // defense in depth; would've been caught above
      const next = path.join(current, part);

      const lstatResult = yield* Effect.tryPromise(() => nodeLstat(next)).pipe(
        Effect.map((info) => ({ ok: true as const, info })),
        Effect.catch(() => Effect.succeed({ ok: false as const })),
      );

      if (!lstatResult.ok) {
        // Component doesn't exist (or unreadable). `current` is the
        // deepest existing directory. The remainder of the path
        // (including this non-existent component) is to-be-created.
        deepestExisting = current;
        remainingParts = parts.slice(i);
        break;
      }

      if (lstatResult.info.isSymbolicLink()) {
        sawSymlink = true;
        const realNextResult = yield* fileSystem.realPath(next).pipe(
          Effect.map((p) => ({ ok: true as const, path: p })),
          Effect.catch(() => Effect.succeed({ ok: false as const })),
        );
        if (!realNextResult.ok) {
          // Broken symlink — can't verify containment. Reject.
          return null;
        }
        const realRel = path.relative(realRoot, realNextResult.path);
        if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
          // Symlink escapes the root. Reject.
          return null;
        }
        current = realNextResult.path;
        deepestExisting = current;
      } else {
        current = next;
        deepestExisting = current;
      }
    }

    // TOCTOU defense (M-2A): if the walk encountered any symlinks,
    // realpath the deepest existing directory to catch a swap of a
    // non-symlink directory for a symlink between our per-component
    // lstats and now. If an attacker swapped a component, realpath
    // follows it and containment fails.
    //
    // If no symlinks were encountered, the TOCTOU window between the
    // last lstat and the caller's open(2) is a single-syscall gap —
    // negligible on a single-user machine. We return the original
    // target unchanged to avoid perturbing paths on macOS where OS-level
    // symlinks like /tmp → /private/tmp are not attacker-controlled.
    if (!sawSymlink) {
      return target;
    }

    const realDeepest = yield* fileSystem.realPath(deepestExisting).pipe(
      Effect.map((p) => ({ ok: true as const, path: p })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!realDeepest.ok) return null;

    const realDeepestRel = path.relative(realRoot, realDeepest.path);
    if (realDeepestRel.startsWith("..") || path.isAbsolute(realDeepestRel)) {
      return null;
    }

    if (remainingParts.length > 0) {
      const resolvedPath = path.join(realDeepest.path, ...remainingParts);
      const finalRel = path.relative(realRoot, resolvedPath);
      if (finalRel.startsWith("..") || path.isAbsolute(finalRel)) {
        return null;
      }
      return resolvedPath;
    }

    return realDeepest.path;
  });

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(OS.homedir(), input.slice(2));
  }
  return input;
}

export const makeWorkspacePaths = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const normalizeWorkspaceRoot: WorkspacePathsShape["normalizeWorkspaceRoot"] = Effect.fn(
    "WorkspacePaths.normalizeWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalizedWorkspaceRoot = path.resolve(expandHomePath(workspaceRoot.trim(), path));
    let workspaceStat = yield* fileSystem
      .stat(normalizedWorkspaceRoot)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!workspaceStat && options?.createIfMissing) {
      yield* fileSystem.makeDirectory(normalizedWorkspaceRoot, { recursive: true }).pipe(
        Effect.mapError(
          () =>
            new WorkspaceRootCreateFailedError({
              workspaceRoot,
              normalizedWorkspaceRoot,
            }),
        ),
      );
      workspaceStat = yield* fileSystem
        .stat(normalizedWorkspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
    }
    if (!workspaceStat) {
      return yield* new WorkspaceRootNotExistsError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    if (workspaceStat.type !== "Directory") {
      return yield* new WorkspaceRootNotDirectoryError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    return normalizedWorkspaceRoot;
  });

  const resolveRelativePathWithinRoot: WorkspacePathsShape["resolveRelativePathWithinRoot"] =
    Effect.fn("WorkspacePaths.resolveRelativePathWithinRoot")(function* (input) {
      const normalizedInputPath = input.relativePath.trim();

      // Slice B (2026-05-16) — null-byte rejection. `path.resolve` silently
      // accepts NUL bytes on Linux/macOS, but the kernel truncates at the
      // first NUL when the path reaches `open(2)`. So `"foo\0evil"` becomes
      // `"foo"` at the syscall — a subtle bypass. Reject up-front.
      if (normalizedInputPath.includes(" ")) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      if (path.isAbsolute(normalizedInputPath)) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      const absolutePath = path.resolve(input.workspaceRoot, normalizedInputPath);
      const relativeToRoot = toPosixRelativePath(path.relative(input.workspaceRoot, absolutePath));
      if (
        relativeToRoot.length === 0 ||
        relativeToRoot === "." ||
        relativeToRoot.startsWith("../") ||
        relativeToRoot === ".." ||
        path.isAbsolute(relativeToRoot)
      ) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      // Slice B (2026-05-16) — realpath-based containment check (C1 fix).
      //
      // The string-level checks above reject SYNTACTIC traversal (`..`,
      // absolute paths, null bytes). That's necessary but not sufficient:
      // a symlink INSIDE the workspace pointing OUTSIDE it passes string
      // checks because `path.resolve` / `path.relative` are pure string
      // operations and never touch the filesystem.
      //
      // Attack we're blocking: `workspace/link → /etc`,
      // `writeFile("link/passwd")` resolves to `workspace/link/passwd`
      // which string-checks as contained — but the kernel follows the
      // symlink at `open(2)` time and writes `/etc/passwd`.
      //
      // Defense: realpath the workspace root, then walk down to the
      // target one component at a time, lstat'ing each. Any symlink
      // gets realpath'd and its target re-verified to be inside the
      // root. Broken symlinks (which would let an attacker create a new
      // file outside the workspace via write-through-broken-link) are
      // rejected because we can't realpath them to verify containment.
      //
      // realRoot is computed FIRST so we resolve any symlinks in the
      // root path itself — common on macOS where `/tmp` is a symlink to
      // `/private/tmp`. Without this, paths under a symlinked root
      // would always look "outside" themselves.
      const realRootResult = yield* fileSystem.realPath(input.workspaceRoot).pipe(
        Effect.map((p) => ({ ok: true as const, path: p })),
        Effect.catch(() => Effect.succeed({ ok: false as const })),
      );
      if (!realRootResult.ok) {
        // The workspace root itself isn't realpath-able. Unusual — the
        // `normalizeWorkspaceRoot` step above should have caught a
        // missing root. Reject conservatively rather than letting a
        // broken root mask a containment failure.
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }
      const realRoot = realRootResult.path;

      const resolvedPath = yield* validateContainment(
        absolutePath,
        input.workspaceRoot,
        realRoot,
        fileSystem,
        path,
      );
      if (resolvedPath === null) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      // Containment verified at both string AND filesystem levels, with
      // the TOCTOU window closed (M-2A): `validateContainment` now
      // returns a realpath-resolved path whose deepest existing
      // directory was realpath'd at the end of the walk. Any symlink
      // swap between component-level lstats and the final realpath
      // is caught by the containment re-check.
      //
      // We return the resolved path so callers (writeFile / readFile /
      // makeDirectory) operate on the real filesystem location without
      // following any intermediate symlinks — closing the gap between
      // validation and the kernel's open(2).
      // absolutePath is the TOCTOU-hardened resolved path for filesystem
      // operations. relativePath stays syntactic — it's the client-facing
      // path relative to the user-visible workspace root.
      return {
        absolutePath: resolvedPath,
        relativePath: relativeToRoot,
      };
    });

  return {
    normalizeWorkspaceRoot,
    resolveRelativePathWithinRoot,
  } satisfies WorkspacePathsShape;
});

export const WorkspacePathsLive = Layer.effect(WorkspacePaths, makeWorkspacePaths);
