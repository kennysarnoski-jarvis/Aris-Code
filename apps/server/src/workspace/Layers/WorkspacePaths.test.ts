import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn("makeTempDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-paths-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("WorkspacePathsLive", (it) => {
  describe("normalizeWorkspaceRoot", () => {
    it.effect("resolves an existing directory", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(cwd);

        expect(resolved).toBe(cwd);
      }),
    );

    it.effect("rejects missing directories", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;

        const error = yield* workspacePaths
          .normalizeWorkspaceRoot(path.join(cwd, "missing"))
          .pipe(Effect.flip);

        expect(error.message).toContain("Workspace root does not exist:");
      }),
    );

    it.effect("creates missing directories when createIfMissing is enabled", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;
        const missingPath = path.join(cwd, "nested", "new-project");

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(missingPath, {
          createIfMissing: true,
        });
        const stat = yield* fileSystem.stat(resolved);

        expect(resolved).toBe(missingPath);
        expect(stat.type).toBe("Directory");
      }),
    );

    it.effect("rejects file paths", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;
        const filePath = path.join(cwd, "README.md");
        yield* writeTextFile(cwd, "README.md", "# hi\n");

        const error = yield* workspacePaths.normalizeWorkspaceRoot(filePath).pipe(Effect.flip);

        expect(error.message).toContain("Workspace root is not a directory:");
      }),
    );
  });

  describe("resolveRelativePathWithinRoot", () => {
    it.effect("resolves relative paths inside the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;

        const resolved = yield* workspacePaths.resolveRelativePathWithinRoot({
          workspaceRoot: cwd,
          relativePath: "plans/effect-rpc.md",
        });

        expect(resolved).toEqual({
          absolutePath: path.join(cwd, "plans/effect-rpc.md"),
          relativePath: "plans/effect-rpc.md",
        });
      }),
    );

    it.effect("rejects paths that escape the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();

        const error = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath: "../escape.md",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // Slice B (2026-05-16) — symlink-escape & containment hardening
  //
  // The string-level checks above reject syntactic traversal. These
  // tests cover the filesystem-level realpath containment check that
  // closes the C1 symlink-bypass attack.
  //
  // Build pattern: create one tmp dir as the workspace root, a second
  // tmp dir as "outside" (with real content), then symlink from inside
  // the root to the outside dir. Resolve through the jail and expect
  // rejection. Effect's FileSystem.symlink(target, link) is used so
  // tests stay in the Effect runtime.
  // ─────────────────────────────────────────────────────────────────────

  describe("resolveRelativePathWithinRoot — symlink containment (Slice B)", () => {
    it.effect("rejects a symlink pointing to a file outside the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir();
        const outsideDir = yield* makeTempDir();

        // outside-secret.txt exists outside the workspace; link points to it.
        const outsideFile = path.join(outsideDir, "outside-secret.txt");
        yield* fileSystem.writeFileString(outsideFile, "SECRET").pipe(Effect.orDie);
        yield* fileSystem.symlink(outsideFile, path.join(cwd, "leak")).pipe(Effect.orDie);

        const error = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath: "leak",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: leak",
        );
      }),
    );

    it.effect("rejects a path that traverses through a symlink to an outside directory", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir();
        const outsideDir = yield* makeTempDir();

        // outside-dir/passwd exists; link inside cwd points at outside-dir,
        // so cwd/link/passwd resolves (via the kernel's symlink follow) to
        // outside-dir/passwd — the canonical C1 attack shape.
        yield* fileSystem
          .writeFileString(path.join(outsideDir, "passwd"), "ATTACKER")
          .pipe(Effect.orDie);
        yield* fileSystem.symlink(outsideDir, path.join(cwd, "link")).pipe(Effect.orDie);

        const error = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath: "link/passwd",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: link/passwd",
        );
      }),
    );

    it.effect("rejects a symlink chain that ultimately resolves outside the workspace", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir();
        const outsideDir = yield* makeTempDir();

        // hop1 → hop2 → outsideDir. realPath chases the whole chain in
        // one call, so the resolved target is outsideDir — outside the
        // workspace.
        const outsideTarget = path.join(outsideDir, "target.txt");
        yield* fileSystem.writeFileString(outsideTarget, "outside").pipe(Effect.orDie);
        const hop2 = path.join(cwd, "hop2");
        const hop1 = path.join(cwd, "hop1");
        yield* fileSystem.symlink(outsideTarget, hop2).pipe(Effect.orDie);
        yield* fileSystem.symlink(hop2, hop1).pipe(Effect.orDie);

        const error = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath: "hop1",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: hop1",
        );
      }),
    );

    it.effect("rejects a broken symlink — can't verify containment", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir();
        const outsideDir = yield* makeTempDir();

        // Symlink to a path that doesn't exist. lstat detects it (it
        // exists as a symlink) but realPath fails. We can't verify
        // where a write through this link would land — reject.
        // This blocks the broken-symlink write-creation attack:
        // `writeFile(workspace/badlink/foo)` would follow the symlink
        // and create `foo` at the symlink's target if the target's
        // parent dir exists.
        const nonExistentOutside = path.join(outsideDir, "does-not-exist-yet");
        yield* fileSystem.symlink(nonExistentOutside, path.join(cwd, "badlink")).pipe(Effect.orDie);

        const error = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath: "badlink/newfile.txt",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: badlink/newfile.txt",
        );
      }),
    );

    it.effect("accepts a project-internal symlink pointing to another file inside the root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir();

        // Internal symlink: real-file.txt inside cwd, alias.txt is a
        // symlink to it (also inside cwd). Resolving alias.txt should
        // succeed — symlinks are NOT prohibited per se, only escaping
        // ones are.
        yield* writeTextFile(cwd, "real-file.txt", "hi");
        yield* fileSystem
          .symlink(path.join(cwd, "real-file.txt"), path.join(cwd, "alias.txt"))
          .pipe(Effect.orDie);

        const resolved = yield* workspacePaths.resolveRelativePathWithinRoot({
          workspaceRoot: cwd,
          relativePath: "alias.txt",
        });

        expect(resolved.relativePath).toBe("alias.txt");
      }),
    );

    it.effect("accepts a write target whose parent directory doesn't exist yet", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();

        // Write operations legitimately target paths that don't exist
        // yet. The realpath check must walk up to the longest existing
        // prefix (the workspace root in this case) and accept the rest
        // as not-yet-created. No symlinks in the chain → accept.
        const resolved = yield* workspacePaths.resolveRelativePathWithinRoot({
          workspaceRoot: cwd,
          relativePath: "future/nested/dir/file.txt",
        });

        expect(resolved.relativePath).toBe("future/nested/dir/file.txt");
      }),
    );

    it.effect("rejects paths containing a null byte", () =>
      Effect.gen(function* () {
        // The kernel truncates paths at the first NUL byte during
        // open(2), but JS string operations don't — a subtle bypass
        // where validation reasons about one path and the syscall acts
        // on a different one. Reject up-front.
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();

        const error = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath: "foo evil.txt",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain("Workspace file path must be relative to the project root");
      }),
    );

    it.effect(
      "handles symlinks in the workspace ROOT path itself (macOS /tmp -> /private/tmp)",
      () =>
        Effect.gen(function* () {
          // On macOS, /tmp is a symlink to /private/tmp. Without
          // realPath'ing the root, a write target at /tmp/foo would be
          // computed as outside /private/tmp/foo (its own real root).
          // This test verifies symlinks in the root path are correctly
          // unwrapped before the containment check. On Linux the tmpdir
          // typically isn't symlinked, but the test still exercises the
          // realPath-root pathway and shouldn't regress there.
          const workspacePaths = yield* WorkspacePaths;
          const cwd = yield* makeTempDir();

          const resolved = yield* workspacePaths.resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath: "inside.txt",
          });

          expect(resolved.relativePath).toBe("inside.txt");
        }),
    );
  });
});
