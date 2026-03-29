import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

export type BackgroundRunStatus = "starting" | "building" | "zipping" | "success" | "failed";

export interface BackgroundRunState {
  errorMessage?: string;
  finishedAt?: string;
  logPath: string;
  projectName: string;
  projectPath: string;
  runId: string;
  startedAt: string;
  status: BackgroundRunStatus;
  statusText: string;
  updatedAt: string;
  zipPath: string;
}

export interface BackgroundRunIndex {
  activeRunIds: string[];
  recentRunIds: string[];
}

interface CreateBackgroundRunOptions {
  logDir?: string;
  projectName: string;
  projectPath: string;
  runId: string;
  zipPath: string;
}

interface BackgroundRunUpdate {
  errorMessage?: string;
  finishedAt?: string;
  status: BackgroundRunStatus;
  statusText: string;
  updatedAt?: string;
}

const INDEX_FILE_NAME = "index.json";
const RUN_STATUS_FILE_EXTENSION = ".json";

export function getBackgroundRunLogDir(): string {
  return path.join(os.homedir(), ".sxuhutils", "build-and-zip-logs");
}

export function getBackgroundRunIndexPath(logDir: string): string {
  return path.join(logDir, INDEX_FILE_NAME);
}

export function getBackgroundRunLogPath(logDir: string, runId: string): string {
  return path.join(logDir, `${runId}.log`);
}

export function getBackgroundRunScriptPath(logDir: string, runId: string): string {
  return path.join(logDir, `${runId}.sh`);
}

export function getBackgroundRunStatePath(logDir: string, runId: string): string {
  return path.join(logDir, `${runId}${RUN_STATUS_FILE_EXTENSION}`);
}

export async function createBackgroundRun({
  logDir = getBackgroundRunLogDir(),
  projectName,
  projectPath,
  runId,
  zipPath,
}: CreateBackgroundRunOptions): Promise<BackgroundRunState> {
  await fs.mkdir(logDir, { recursive: true });

  const now = new Date().toISOString();
  const runState: BackgroundRunState = {
    logPath: getBackgroundRunLogPath(logDir, runId),
    projectName,
    projectPath,
    runId,
    startedAt: now,
    status: "starting",
    statusText: "准备启动后台任务",
    updatedAt: now,
    zipPath,
  };

  await writeJsonAtomic(getBackgroundRunStatePath(logDir, runId), runState);
  await updateBackgroundRunIndex(logDir, (index) => ({
    activeRunIds: uniqueRunIds([runId, ...index.activeRunIds]),
    recentRunIds: uniqueRunIds([runId, ...index.recentRunIds]),
  }));

  return runState;
}

export async function updateBackgroundRun(logDir: string, runId: string, patch: BackgroundRunUpdate): Promise<BackgroundRunState> {
  const statePath = getBackgroundRunStatePath(logDir, runId);
  const previous = await readBackgroundRunState(statePath);
  if (!previous) {
    throw new Error(`后台任务状态不存在: ${runId}`);
  }

  const next: BackgroundRunState = {
    ...previous,
    ...("errorMessage" in patch ? { errorMessage: patch.errorMessage || undefined } : {}),
    ...("finishedAt" in patch ? { finishedAt: patch.finishedAt || undefined } : {}),
    status: patch.status,
    statusText: patch.statusText,
    updatedAt: patch.updatedAt || new Date().toISOString(),
  };

  if (next.status !== "failed" && !("errorMessage" in patch)) {
    delete next.errorMessage;
  }

  await writeJsonAtomic(statePath, next);
  await updateBackgroundRunIndex(logDir, (index) => ({
    activeRunIds:
      next.status === "success" || next.status === "failed"
        ? index.activeRunIds.filter((item) => item !== runId)
        : uniqueRunIds([runId, ...index.activeRunIds]),
    recentRunIds: uniqueRunIds([runId, ...index.recentRunIds]),
  }));

  return next;
}

export async function readBackgroundRunIndex(logDir: string): Promise<BackgroundRunIndex> {
  const parsed = await readJsonFile<Partial<BackgroundRunIndex>>(getBackgroundRunIndexPath(logDir));
  return {
    activeRunIds: sanitizeRunIdList(parsed?.activeRunIds),
    recentRunIds: sanitizeRunIdList(parsed?.recentRunIds),
  };
}

export async function loadBackgroundRuns(logDir: string): Promise<{ activeRuns: BackgroundRunState[]; recentRuns: BackgroundRunState[] }> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(logDir);
  } catch {
    return { activeRuns: [], recentRuns: [] };
  }

  const states = (
    await Promise.all(
      entries
        .filter((entry) => isRunStateFile(entry))
        .map((entry) => readBackgroundRunState(path.join(logDir, entry))),
    )
  ).filter((item): item is BackgroundRunState => Boolean(item));

  const activeRuns = states
    .filter((run) => run.status !== "success" && run.status !== "failed")
    .sort((left, right) => sortByIsoDesc(left.updatedAt, right.updatedAt));

  const recentRuns = states
    .filter((run) => run.status === "success" || run.status === "failed")
    .sort((left, right) => sortByIsoDesc(left.finishedAt || left.updatedAt, right.finishedAt || right.updatedAt));

  return { activeRuns, recentRuns };
}

export async function pruneBackgroundRuns(logDir: string, maxCompletedRuns: number): Promise<void> {
  if (maxCompletedRuns < 0) {
    return;
  }

  const { activeRuns, recentRuns } = await loadBackgroundRuns(logDir);
  const keptRecentRuns = recentRuns.slice(0, maxCompletedRuns);
  const keptRunIds = new Set([...activeRuns.map((run) => run.runId), ...keptRecentRuns.map((run) => run.runId)]);

  let entries: string[] = [];
  try {
    entries = await fs.readdir(logDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry === INDEX_FILE_NAME) {
      continue;
    }

    const runId = toRunIdFromArtifact(entry);
    if (!runId || keptRunIds.has(runId)) {
      continue;
    }

    try {
      await fs.unlink(path.join(logDir, entry));
    } catch {
      // Ignore cleanup failures to avoid affecting the main workflow.
    }
  }

  await writeJsonAtomic(getBackgroundRunIndexPath(logDir), {
    activeRunIds: activeRuns.map((run) => run.runId),
    recentRunIds: uniqueRunIds([...activeRuns.map((run) => run.runId), ...keptRecentRuns.map((run) => run.runId)]),
  } satisfies BackgroundRunIndex);
}

async function updateBackgroundRunIndex(
  logDir: string,
  update: (index: BackgroundRunIndex) => BackgroundRunIndex,
): Promise<BackgroundRunIndex> {
  const current = await readBackgroundRunIndex(logDir);
  const next = update(current);
  const normalized: BackgroundRunIndex = {
    activeRunIds: sanitizeRunIdList(next.activeRunIds),
    recentRunIds: sanitizeRunIdList(next.recentRunIds),
  };

  await writeJsonAtomic(getBackgroundRunIndexPath(logDir), normalized);
  return normalized;
}

async function readBackgroundRunState(statePath: string): Promise<BackgroundRunState | null> {
  const parsed = await readJsonFile<Partial<BackgroundRunState>>(statePath);
  if (!parsed || typeof parsed.runId !== "string" || typeof parsed.projectName !== "string" || typeof parsed.logPath !== "string") {
    return null;
  }

  if (
    parsed.status !== "starting" &&
    parsed.status !== "building" &&
    parsed.status !== "zipping" &&
    parsed.status !== "success" &&
    parsed.status !== "failed"
  ) {
    return null;
  }

  return {
    logPath: parsed.logPath,
    projectName: parsed.projectName,
    projectPath: typeof parsed.projectPath === "string" ? parsed.projectPath : "",
    runId: parsed.runId,
    startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    status: parsed.status,
    statusText: typeof parsed.statusText === "string" ? parsed.statusText : "",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    zipPath: typeof parsed.zipPath === "string" ? parsed.zipPath : "",
    ...(typeof parsed.finishedAt === "string" ? { finishedAt: parsed.finishedAt } : {}),
    ...(typeof parsed.errorMessage === "string" ? { errorMessage: parsed.errorMessage } : {}),
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempFile, filePath);
}

function sanitizeRunIdList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return uniqueRunIds(values.filter((item): item is string => typeof item === "string" && item.length > 0));
}

function uniqueRunIds(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRunStateFile(fileName: string): boolean {
  return fileName.endsWith(RUN_STATUS_FILE_EXTENSION) && fileName !== INDEX_FILE_NAME;
}

function toRunIdFromArtifact(fileName: string): string | null {
  const match = fileName.match(/^(.*)\.(json|log|sh)$/);
  if (!match || match[1] === "index") {
    return null;
  }
  return match[1];
}

function sortByIsoDesc(left: string, right: string): number {
  return Date.parse(right) - Date.parse(left);
}
