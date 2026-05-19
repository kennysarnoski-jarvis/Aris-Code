import * as FS from "node:fs";
import * as Path from "node:path";

import type { ClientSettings, PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import { Predicate } from "effect";

interface ClientSettingsDocument {
  readonly settings: ClientSettings;
}

interface PersistedSavedEnvironmentStorageRecord extends PersistedSavedEnvironmentRecord {
  readonly encryptedBearerToken?: string;
}

interface SavedEnvironmentRegistryDocument {
  readonly records: readonly PersistedSavedEnvironmentStorageRecord[];
}

export interface DesktopSecretStorage {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (value: string) => Buffer;
  readonly decryptString: (value: Buffer) => string;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!FS.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(FS.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  const directory = Path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  FS.mkdirSync(directory, { recursive: true });
  FS.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  FS.renameSync(tempPath, filePath);
}

function isPersistedSavedEnvironmentStorageRecord(
  value: unknown,
): value is PersistedSavedEnvironmentStorageRecord {
  return (
    Predicate.isObject(value) &&
    typeof value.environmentId === "string" &&
    typeof value.label === "string" &&
    typeof value.httpBaseUrl === "string" &&
    typeof value.wsBaseUrl === "string" &&
    typeof value.createdAt === "string" &&
    (value.lastConnectedAt === null || typeof value.lastConnectedAt === "string") &&
    (value.encryptedBearerToken === undefined || typeof value.encryptedBearerToken === "string")
  );
}

/**
 * Slice V / H11 — per-entry validator for the wire shape used by the
 * `SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL` IPC handler. Pre-Slice-V
 * the handler accepted any array and cast it straight to
 * `PersistedSavedEnvironmentRecord[]` before writing to disk — a
 * malformed payload (missing fields, wrong types) corrupted the
 * on-disk registry, which then bricked the renderer on next launch
 * when `readJsonFile` returned shapes the rest of the app didn't
 * expect.
 *
 * The wire shape is a strict subset of the storage shape (no
 * `encryptedBearerToken`), so the field-level checks are the same
 * minus that one optional field.
 */
export function isPersistedSavedEnvironmentRecord(
  value: unknown,
): value is PersistedSavedEnvironmentRecord {
  return (
    Predicate.isObject(value) &&
    typeof value.environmentId === "string" &&
    typeof value.label === "string" &&
    typeof value.httpBaseUrl === "string" &&
    typeof value.wsBaseUrl === "string" &&
    typeof value.createdAt === "string" &&
    (value.lastConnectedAt === null || typeof value.lastConnectedAt === "string")
  );
}

function readSavedEnvironmentRegistryDocument(filePath: string): SavedEnvironmentRegistryDocument {
  const parsed = readJsonFile<SavedEnvironmentRegistryDocument>(filePath);
  if (!Predicate.isObject(parsed)) {
    return { records: [] };
  }

  return {
    records: Array.isArray(parsed.records)
      ? parsed.records.filter(isPersistedSavedEnvironmentStorageRecord)
      : [],
  };
}

function toPersistedSavedEnvironmentRecord(
  record: PersistedSavedEnvironmentStorageRecord,
): PersistedSavedEnvironmentRecord {
  return {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
  };
}

export function readClientSettings(settingsPath: string): ClientSettings | null {
  return readJsonFile<ClientSettingsDocument>(settingsPath)?.settings ?? null;
}

export function writeClientSettings(settingsPath: string, settings: ClientSettings): void {
  writeJsonFile(settingsPath, { settings } satisfies ClientSettingsDocument);
}

export function readSavedEnvironmentRegistry(
  registryPath: string,
): readonly PersistedSavedEnvironmentRecord[] {
  return readSavedEnvironmentRegistryDocument(registryPath).records.map((record) =>
    toPersistedSavedEnvironmentRecord(record),
  );
}

export function writeSavedEnvironmentRegistry(
  registryPath: string,
  records: readonly PersistedSavedEnvironmentRecord[],
): void {
  const currentDocument = readSavedEnvironmentRegistryDocument(registryPath);
  const encryptedBearerTokenById = new Map(
    currentDocument.records.flatMap((record) =>
      record.encryptedBearerToken
        ? [[record.environmentId, record.encryptedBearerToken] as const]
        : [],
    ),
  );
  writeJsonFile(registryPath, {
    // Slice W / H11-L2 — explicit field-by-field construction in both
    // branches. The pre-Slice-W shape returned the raw `record`
    // verbatim when no encryptedBearerToken existed, which would
    // smuggle any extra fields a hostile/malformed payload smuggled
    // past `isPersistedSavedEnvironmentRecord` (the type guard only
    // checks the required fields are present and well-typed — it
    // doesn't reject extras). Explicit picking here gives us the
    // same defense-in-depth that `toPersistedSavedEnvironmentRecord`
    // provides on the read side: only fields we know about ever
    // land on disk.
    records: records.map((record) => {
      const encryptedBearerToken = encryptedBearerTokenById.get(record.environmentId);
      const base: PersistedSavedEnvironmentStorageRecord = {
        environmentId: record.environmentId,
        label: record.label,
        httpBaseUrl: record.httpBaseUrl,
        wsBaseUrl: record.wsBaseUrl,
        createdAt: record.createdAt,
        lastConnectedAt: record.lastConnectedAt,
      };
      return encryptedBearerToken ? { ...base, encryptedBearerToken } : base;
    }),
  } satisfies SavedEnvironmentRegistryDocument);
}

export function readSavedEnvironmentSecret(input: {
  readonly registryPath: string;
  readonly environmentId: string;
  readonly secretStorage: DesktopSecretStorage;
}): string | null {
  const document = readSavedEnvironmentRegistryDocument(input.registryPath);
  const encoded = document.records.find(
    (record) => record.environmentId === input.environmentId,
  )?.encryptedBearerToken;
  if (!encoded) {
    return null;
  }

  if (!input.secretStorage.isEncryptionAvailable()) {
    return null;
  }

  try {
    return input.secretStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch {
    return null;
  }
}

export function writeSavedEnvironmentSecret(input: {
  readonly registryPath: string;
  readonly environmentId: string;
  readonly secret: string;
  readonly secretStorage: DesktopSecretStorage;
}): boolean {
  const document = readSavedEnvironmentRegistryDocument(input.registryPath);

  if (!input.secretStorage.isEncryptionAvailable()) {
    return false;
  }

  let found = false;

  writeJsonFile(input.registryPath, {
    records: document.records.map((record) => {
      if (record.environmentId !== input.environmentId) {
        return record;
      }

      found = true;
      const encryptedBearerToken = input.secretStorage
        .encryptString(input.secret)
        .toString("base64");
      return {
        environmentId: record.environmentId,
        label: record.label,
        httpBaseUrl: record.httpBaseUrl,
        wsBaseUrl: record.wsBaseUrl,
        createdAt: record.createdAt,
        lastConnectedAt: record.lastConnectedAt,
        encryptedBearerToken,
      } satisfies PersistedSavedEnvironmentStorageRecord;
    }),
  } satisfies SavedEnvironmentRegistryDocument);
  return found;
}

export function removeSavedEnvironmentSecret(input: {
  readonly registryPath: string;
  readonly environmentId: string;
}): void {
  const document = readSavedEnvironmentRegistryDocument(input.registryPath);
  if (
    !document.records.some(
      (record) =>
        record.environmentId === input.environmentId && record.encryptedBearerToken !== undefined,
    )
  ) {
    return;
  }

  writeJsonFile(input.registryPath, {
    records: document.records.map((record) => {
      if (record.environmentId !== input.environmentId) {
        return record;
      }

      return toPersistedSavedEnvironmentRecord(record);
    }),
  } satisfies SavedEnvironmentRegistryDocument);
}
