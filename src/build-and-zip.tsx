import {
  Action,
  ActionPanel,
  Clipboard,
  closeMainWindow,
  Detail,
  Form,
  getPreferenceValues,
  Icon,
  LaunchType,
  List,
  Toast,
  launchCommand,
  showHUD,
  showToast,
  useNavigation,
} from "@raycast/api";
import { spawn } from "child_process";
import { Dirent, promises as fs } from "fs";
import os from "os";
import path from "path";
import { useCallback, useEffect, useMemo, useState } from "react";
import { runBackgroundLaunchWithFeedback } from "./background-launch-feedback";
import {
  createBackgroundRun,
  getBackgroundRunIndexPath,
  getBackgroundRunLogDir,
  getBackgroundRunScriptPath,
  getBackgroundRunStatePath,
  pruneBackgroundRuns,
  updateBackgroundRun,
} from "./background-run-state";

type ProjectType = "maven" | "ant" | "node" | "unknown";

interface ProjectCandidate {
  name: string;
  path: string;
  type: ProjectType;
}

interface BuildZipPreferences {
  workspaceRoots?: string;
  maxScanDepth?: string;
  defaultZipName?: string;
  nodeBuildScript?: string;
  javaHome?: string;
  antBuildFile?: string;
  mavenExecutable?: string;
  mavenSettings?: string;
  mavenRepoLocal?: string;
  mavenProfile?: string;
  mavenGoals?: string;
}

interface RunOverrides {
  buildCommand?: string;
  sourceDir?: string;
  includePaths?: string;
  zipName?: string;
}

interface ZipPlan {
  sourceDir: string;
  entries: string[];
}

interface ExecutionPlan {
  project: ProjectCandidate;
  buildCommand: string;
  zipCommand: string;
  zipName: string;
  zipSourceDir: string;
  zipEntries: string[];
  zipPath: string;
}

const IGNORED_DIRS = new Set([
  ".git",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  ".next",
  ".nuxt",
]);

const NODE_OUTPUT_CANDIDATES = ["dist", "build", "api"];
const JAVA_ENTRY_CANDIDATES = ["com", "mapper"];
const DEFAULT_MAVEN_EXECUTABLE = "/opt/homebrew/Cellar/maven@3.6.1/3.6.1/bin/mvn";
const DEFAULT_MAVEN_SETTINGS = "/opt/homebrew/Cellar/maven@3.6.1/settings.xml";
const DEFAULT_MAVEN_REPO_LOCAL = "/Users/husky/maven_repo";
const DEFAULT_MAVEN_PROFILE = "pre";
const DEFAULT_MAVEN_GOALS = "--update-snapshots clean install -Dmaven.test.skip=true";
const DEFAULT_JAVA_HOME = "/Library/Java/JavaVirtualMachines/zulu-8.jdk/Contents/Home";
const SCAN_ROOT_ALLOWLIST = ["/Users/husky/workSpace/7-lk", "/Users/husky/workSpace/10-lknodejs"];
const MAX_BACKGROUND_RUN_LOGS = 10;

export default function BuildAndZipCommand() {
  const preferences = getPreferenceValues<BuildZipPreferences>();
  const [projects, setProjects] = useState<ProjectCandidate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string>();

  const scanDepth = useMemo(() => {
    const parsed = Number.parseInt(preferences.maxScanDepth ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
  }, [preferences.maxScanDepth]);

  const workspaceRoots = useMemo(() => parseWorkspaceRoots(preferences.workspaceRoots), [preferences.workspaceRoots]);

  const loadProjects = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(undefined);
    try {
      const scanned = await scanProjects(workspaceRoots, scanDepth);
      setProjects(scanned);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
      setProjects([]);
    } finally {
      setIsLoading(false);
    }
  }, [scanDepth, workspaceRoots]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const handleRunInBackground = useCallback(
    async (project: ProjectCandidate, overrides?: RunOverrides) => {
      await runBackgroundLaunchWithFeedback({
        closeMainWindow,
        showHUD,
        startTask: () => startDetachedBuildAndZip(project, preferences, overrides),
        successHUDMessage: `${project.name} 后台任务已启动`,
        onSuccess: async () => {
          await launchCommand({ name: "build-and-zip-status", type: LaunchType.Background }).catch(() => undefined);
        },
        onFailure: async (error) => {
          await launchCommand({ name: "build-and-zip-status", type: LaunchType.Background }).catch(() => undefined);
          await showToast({
            style: Toast.Style.Failure,
            title: `启动失败: ${project.name}`,
            message: getErrorMessage(error),
          });
        },
      });
    },
    [preferences],
  );

  return (
    <List isLoading={isLoading} searchBarPlaceholder="搜索项目并执行打包压缩">
      {errorMessage ? (
        <List.EmptyView
          title="扫描失败"
          description={errorMessage}
          actions={
            <ActionPanel>
              <Action title="重新扫描" icon={Icon.ArrowClockwise} onAction={loadProjects} />
            </ActionPanel>
          }
        />
      ) : null}

      {!errorMessage && projects.length === 0 && !isLoading ? (
        <List.EmptyView
          title="没有找到项目"
          description="请确认白名单目录下存在可识别项目，再重新扫描。"
          actions={
            <ActionPanel>
              <Action title="重新扫描" icon={Icon.ArrowClockwise} onAction={loadProjects} />
            </ActionPanel>
          }
        />
      ) : null}

      {projects.map((project) => (
        <List.Item
          key={project.path}
          title={project.name}
          subtitle={project.path}
          accessories={[{ tag: projectTypeLabel(project.type) }]}
          actions={
            <ActionPanel>
              <Action title="后台执行（可关闭窗口）" icon={Icon.Hammer} onAction={() => void handleRunInBackground(project)} />
              <Action.Push
                title="前台执行（实时日志）"
                icon={Icon.Hammer}
                target={<LiveBuildAndZipView project={project} preferences={preferences} />}
              />
              <Action.Push
                title="自定义参数执行"
                icon={Icon.Gear}
                target={
                  <RunWithOptionsForm
                    project={project}
                    defaultZipName={normalizeZipName(preferences.defaultZipName)}
                    preferences={preferences}
                    onRunInBackground={(overrides) => handleRunInBackground(project, overrides)}
                  />
                }
              />
              <Action.CopyToClipboard title="复制项目路径" content={project.path} />
              <Action.ShowInFinder path={project.path} />
              <Action title="重新扫描" icon={Icon.ArrowClockwise} onAction={loadProjects} shortcut={{ modifiers: ["cmd"], key: "r" }} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

interface RunWithOptionsFormProps {
  project: ProjectCandidate;
  defaultZipName: string;
  preferences: BuildZipPreferences;
  onRunInBackground: (overrides: RunOverrides) => Promise<void>;
}

function RunWithOptionsForm({ project, defaultZipName, preferences, onRunInBackground }: RunWithOptionsFormProps) {
  const { push } = useNavigation();

  return (
    <Form
      navigationTitle={`自定义执行: ${project.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="后台执行（可关闭窗口）"
            onSubmit={async (values: FormValues) => {
              const overrides = toRunOverrides(values);
              await onRunInBackground(overrides);
            }}
          />
          <Action.SubmitForm
            title="前台执行（实时日志）"
            onSubmit={(values: FormValues) => {
              const overrides = toRunOverrides(values);
              push(<LiveBuildAndZipView project={project} preferences={preferences} overrides={overrides} />);
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description text="仅在当前项目生效。留空即使用自动识别结果。" />
      <Form.TextField id="buildCommand" title="构建命令" placeholder="例如 mvn -DskipTests clean package / yarn build / ant" />
      <Form.TextField id="sourceDir" title="压缩根目录" placeholder="绝对路径或相对项目路径，例如 target/app/WEB-INF/classes" />
      <Form.TextField id="includePaths" title="压缩内容" placeholder="相对压缩根目录，逗号分隔，例如 com,mapper 或 dist" />
      <Form.TextField id="zipName" title="ZIP 文件名" defaultValue={defaultZipName} placeholder="例如 a.zip" />
    </Form>
  );
}

interface FormValues {
  buildCommand: string;
  sourceDir: string;
  includePaths: string;
  zipName: string;
}

function toRunOverrides(values: FormValues): RunOverrides {
  return {
    buildCommand: values.buildCommand.trim() || undefined,
    sourceDir: values.sourceDir.trim() || undefined,
    includePaths: values.includePaths.trim() || undefined,
    zipName: values.zipName.trim() || undefined,
  };
}

interface LiveBuildAndZipViewProps {
  project: ProjectCandidate;
  preferences: BuildZipPreferences;
  overrides?: RunOverrides;
}

function LiveBuildAndZipView({ project, preferences, overrides }: LiveBuildAndZipViewProps) {
  const [status, setStatus] = useState<"preparing" | "running" | "success" | "failed">("preparing");
  const [logs, setLogs] = useState("正在准备执行计划...\n");
  const [plannedZipPath, setPlannedZipPath] = useState("");

  useEffect(() => {
    let disposed = false;
    let child: ReturnType<typeof spawn> | null = null;

    const appendLog = (chunk: string) => {
      if (disposed) {
        return;
      }
      setLogs((prev) => trimLogs(`${prev}${chunk}`));
    };

    const run = async () => {
      try {
        const plan = await buildExecutionPlan(project, preferences, overrides);
        if (disposed) {
          return;
        }

        setStatus("running");
        setPlannedZipPath(plan.zipPath);
        appendLog(renderPlanSummary(plan));

        const script = buildForegroundScript(plan);
        child = spawn("zsh", ["-lc", script], { cwd: plan.project.path });

        child.stdout?.on("data", (chunk: unknown) => appendLog(String(chunk)));
        child.stderr?.on("data", (chunk: unknown) => appendLog(String(chunk)));

        child.on("error", (error: unknown) => {
          if (disposed) {
            return;
          }
          appendLog(`\n[ERROR] ${getErrorMessage(error)}\n`);
          setStatus("failed");
        });

        child.on("close", async (code: number | null) => {
          if (disposed) {
            return;
          }

          if (code === 0) {
            await Clipboard.copy(plan.zipPath);
            setStatus("success");
            appendLog(`\n[DONE] 完成，ZIP 路径已复制: ${plan.zipPath}\n`);
            await showToast({
              style: Toast.Style.Success,
              title: "打包并压缩完成",
              message: `${plan.project.name} 完成`,
            });
            return;
          }

          setStatus("failed");
          appendLog(`\n[FAILED] 退出码: ${String(code)}\n`);
          await showToast({
            style: Toast.Style.Failure,
            title: "打包并压缩失败",
            message: `${plan.project.name} 执行失败`,
          });
        });
      } catch (error) {
        if (disposed) {
          return;
        }
        setStatus("failed");
        appendLog(`\n[ERROR] ${getErrorMessage(error)}\n`);
      }
    };

    void run();

    return () => {
      disposed = true;
      if (child && !child.killed) {
        child.kill("SIGTERM");
      }
    };
  }, [overrides, preferences, project]);

  const title = getLiveViewTitle(status);

  return (
    <Detail
      markdown={`# ${title}\n\n${
        plannedZipPath ? `${status === "success" ? "ZIP" : "计划 ZIP"}: \`${plannedZipPath}\`\n\n` : ""
      }\`\`\`\n${logs || "暂无日志"}\n\`\`\``}
      actions={
        <ActionPanel>
          {status === "success" && plannedZipPath ? <Action.CopyToClipboard title="复制 ZIP 路径" content={plannedZipPath} /> : null}
          <Action.CopyToClipboard title="复制日志" content={logs} />
          <Action.ShowInFinder path={project.path} />
        </ActionPanel>
      }
    />
  );
}

function getLiveViewTitle(status: "preparing" | "running" | "success" | "failed"): string {
  if (status === "preparing") {
    return "准备执行中";
  }
  if (status === "running") {
    return "执行中（实时日志）";
  }
  if (status === "success") {
    return "执行完成";
  }
  return "执行失败";
}

async function buildExecutionPlan(
  project: ProjectCandidate,
  preferences: BuildZipPreferences,
  overrides?: RunOverrides,
): Promise<ExecutionPlan> {
  const projectPath = project.path;
  const projectType = project.type;
  const zipPlan = await resolveZipPlan(projectPath, projectType, overrides);
  const zipName = normalizeZipName(overrides?.zipName || preferences.defaultZipName);
  const zipCommand = buildZipCommand(zipName, zipPlan.entries);
  const zipPath = path.join(zipPlan.sourceDir, zipName);
  const buildCommand = overrides?.buildCommand?.trim() || (await detectBuildCommand(projectType, projectPath, preferences));
  if (!buildCommand) {
    throw new Error(`未识别到构建命令（项目类型: ${projectType}）。请在“自定义参数执行”中填写构建命令`);
  }

  return {
    project,
    buildCommand,
    zipCommand,
    zipName,
    zipSourceDir: zipPlan.sourceDir,
    zipEntries: zipPlan.entries,
    zipPath,
  };
}

function buildForegroundScript(plan: ExecutionPlan): string {
  const lines: string[] = [
    "set -e",
    'export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"',
    'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi',
    `echo "[START] ${escapeForDoubleQuotes(plan.project.name)}"`,
  ];

  lines.push(`cd ${shellEscape(plan.project.path)}`);
  lines.push('echo "[BUILD] 开始构建"');
  lines.push(plan.buildCommand);
  appendAntIdeaOutputSyncScript(lines, plan, "");

  lines.push(`mkdir -p ${shellEscape(plan.zipSourceDir)}`);
  lines.push(`cd ${shellEscape(plan.zipSourceDir)}`);
  lines.push(`rm -f ${shellEscape(plan.zipName)}`);
  lines.push('echo "[ZIP] 开始压缩"');
  lines.push(plan.zipCommand);
  lines.push(`echo "[DONE] ${escapeForDoubleQuotes(plan.zipPath)}"`);

  return lines.join("\n");
}

function renderPlanSummary(plan: ExecutionPlan): string {
  return [
    `[PLAN] 项目: ${plan.project.path}`,
    `[PLAN] 构建: ${plan.buildCommand}`,
    `[PLAN] 压缩目录: ${plan.zipSourceDir}`,
    `[PLAN] 压缩内容: ${plan.zipEntries.join(", ")}`,
    `[PLAN] ZIP: ${plan.zipPath}`,
    "",
  ].join("\n");
}

function trimLogs(content: string): string {
  const maxChars = 120000;
  if (content.length <= maxChars) {
    return content;
  }
  return content.slice(content.length - maxChars);
}

async function startDetachedBuildAndZip(
  project: ProjectCandidate,
  preferences: BuildZipPreferences,
  overrides?: RunOverrides,
): Promise<{ logPath: string; runId: string; zipPath: string }> {
  const plan = await buildExecutionPlan(project, preferences, overrides);
  const logDir = getBackgroundRunLogDir();
  await fs.mkdir(logDir, { recursive: true });

  const stamp = formatStamp();
  const safeName = sanitizeFileName(project.name);
  const runId = `${safeName}-${stamp}`;
  const runState = await createBackgroundRun({
    logDir,
    projectName: project.name,
    projectPath: project.path,
    runId,
    zipPath: plan.zipPath,
  });
  const scriptPath = getBackgroundRunScriptPath(logDir, runId);
  const scriptContent = buildDetachedScript(plan, {
    indexPath: getBackgroundRunIndexPath(logDir),
    logPath: runState.logPath,
    runId,
    statePath: getBackgroundRunStatePath(logDir, runId),
  });

  try {
    await fs.writeFile(scriptPath, scriptContent, { encoding: "utf8", mode: 0o700 });
    await fs.chmod(scriptPath, 0o700);

    const child = spawn("/bin/zsh", [scriptPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    await pruneBackgroundRuns(logDir, MAX_BACKGROUND_RUN_LOGS);

    return {
      logPath: runState.logPath,
      runId,
      zipPath: plan.zipPath,
    };
  } catch (error) {
    await updateBackgroundRun(logDir, runId, {
      errorMessage: getErrorMessage(error),
      finishedAt: new Date().toISOString(),
      status: "failed",
      statusText: "启动失败",
    });
    throw error;
  }
}

function buildDetachedScript(
  plan: ExecutionPlan,
  runArtifacts: { indexPath: string; logPath: string; runId: string; statePath: string },
): string {
  const lines: string[] = [
    "#!/bin/zsh",
    "task_status=0",
    "set -e",
    'export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"',
    'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi',
    'NODE_BIN="$(command -v node || command -v nodejs || true)"',
    `RUN_ID=${shellEscape(runArtifacts.runId)}`,
    `STATE_FILE=${shellEscape(runArtifacts.statePath)}`,
    `INDEX_FILE=${shellEscape(runArtifacts.indexPath)}`,
    `LOG_FILE=${shellEscape(runArtifacts.logPath)}`,
    `ZIP_PATH=${shellEscape(plan.zipPath)}`,
    `PROJECT_NAME=${shellEscape(plan.project.name)}`,
    `LOG_FILE_PATH=${shellEscape(runArtifacts.logPath)}`,
    "notify() {",
    '  local title="$1"',
    '  local subtitle="$2"',
    '  local message="$3"',
    '  local target_path="$4"',
    "  if command -v terminal-notifier >/dev/null 2>&1; then",
    '    if [ -n "$target_path" ]; then',
    '      terminal-notifier -title "$title" -subtitle "$subtitle" -message "$message" -execute "open -R \\"$target_path\\"" >/dev/null 2>&1 || true',
    "    else",
    '      terminal-notifier -title "$title" -subtitle "$subtitle" -message "$message" >/dev/null 2>&1 || true',
    "    fi",
    "  fi",
    "}",
    "update_run_state() {",
    '  local next_status="$1"',
    '  local next_status_text="$2"',
    '  local next_finished_at="$3"',
    '  local next_error_message="$4"',
    '  if [ -z "$NODE_BIN" ]; then',
    "    return 0",
    "  fi",
    '  STATE_FILE="$STATE_FILE" INDEX_FILE="$INDEX_FILE" RUN_ID="$RUN_ID" RUN_STATUS="$next_status" RUN_STATUS_TEXT="$next_status_text" RUN_FINISHED_AT="$next_finished_at" RUN_ERROR_MESSAGE="$next_error_message" "$NODE_BIN" <<\'NODE\' >/dev/null 2>&1 || true',
    'const fs = require("fs");',
    "",
    "function readJson(filePath, fallback) {",
    "  try {",
    '    return JSON.parse(fs.readFileSync(filePath, "utf8"));',
    "  } catch {",
    "    return fallback;",
    "  }",
    "}",
    "",
    "function writeJsonAtomic(filePath, value) {",
    '  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;',
    '  fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\\n`, "utf8");',
    "  fs.renameSync(tempFile, filePath);",
    "}",
    "",
    "function normalizeRunIds(values) {",
    "  if (!Array.isArray(values)) {",
    "    return [];",
    "  }",
    '  return Array.from(new Set(values.filter((item) => typeof item === "string" && item.length > 0)));',
    "}",
    "",
    "const stateFile = process.env.STATE_FILE;",
    "const indexFile = process.env.INDEX_FILE;",
    "const runId = process.env.RUN_ID;",
    "const status = process.env.RUN_STATUS;",
    'const statusText = process.env.RUN_STATUS_TEXT || "";',
    'const finishedAt = process.env.RUN_FINISHED_AT || "";',
    'const errorMessage = process.env.RUN_ERROR_MESSAGE || "";',
    'const now = new Date().toISOString();',
    "const state = readJson(stateFile, null);",
    "if (state && typeof state === 'object') {",
    "  state.status = status;",
    "  state.statusText = statusText;",
    "  state.updatedAt = now;",
    "  if (finishedAt) {",
    "    state.finishedAt = finishedAt;",
    "  }",
    "  if (errorMessage) {",
    "    state.errorMessage = errorMessage;",
    "  } else if (Object.prototype.hasOwnProperty.call(state, 'errorMessage')) {",
    "    delete state.errorMessage;",
    "  }",
    "  writeJsonAtomic(stateFile, state);",
    "}",
    "const index = readJson(indexFile, { activeRunIds: [], recentRunIds: [] });",
    "const activeRunIds = normalizeRunIds(index.activeRunIds).filter((item) => item !== runId);",
    "const recentRunIds = normalizeRunIds(index.recentRunIds).filter((item) => item !== runId);",
    "if (status !== 'success' && status !== 'failed') {",
    "  activeRunIds.unshift(runId);",
    "}",
    "recentRunIds.unshift(runId);",
    "writeJsonAtomic(indexFile, {",
    "  activeRunIds: normalizeRunIds(activeRunIds),",
    "  recentRunIds: normalizeRunIds(recentRunIds),",
    "});",
    "NODE",
    "}",
    "{",
    `  echo "[$(date '+%Y-%m-%d %H:%M:%S')] START ${escapeForDoubleQuotes(plan.project.name)}"`,
    `  cd ${shellEscape(plan.project.path)}`,
  ];

  lines.push('  update_run_state "building" "构建中" "" ""');
  lines.push('  echo "[$(date \'+%Y-%m-%d %H:%M:%S\')] BUILD START"');
  lines.push(`  ${plan.buildCommand}`);
  appendAntIdeaOutputSyncScript(lines, plan, "  ");

  lines.push(`  mkdir -p ${shellEscape(plan.zipSourceDir)}`);
  lines.push(`  cd ${shellEscape(plan.zipSourceDir)}`);
  lines.push(`  rm -f ${shellEscape(plan.zipName)}`);
  lines.push('  update_run_state "zipping" "压缩中" "" ""');
  lines.push('  echo "[$(date \'+%Y-%m-%d %H:%M:%S\')] ZIP START"');
  lines.push(`  ${plan.zipCommand}`);
  lines.push('  echo "[$(date \'+%Y-%m-%d %H:%M:%S\')] DONE"');
  lines.push('} >> "$LOG_FILE" 2>&1 || task_status=$?');
  lines.push('if [ "$task_status" -eq 0 ]; then');
  lines.push('  echo "ZIP_PATH=$ZIP_PATH" >> "$LOG_FILE"');
  lines.push('  if command -v pbcopy >/dev/null 2>&1; then');
  lines.push('    printf "%s" "$ZIP_PATH" | pbcopy || true');
  lines.push('  fi');
  lines.push('  update_run_state "success" "已完成" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ""');
  lines.push('  notify "工程构建成功" "$PROJECT_NAME" "$ZIP_PATH" "$ZIP_PATH"');
  lines.push("else");
  lines.push('  echo "FAILED, exit code: $task_status" >> "$LOG_FILE"');
  lines.push(
    '  fail_reason="$(tail -n 120 "$LOG_FILE" | sed -E \'s/\\x1B\\[[0-9;]*[[:alpha:]]//g\' | awk \'NF { line=$0 } END { print line }\')"',
  );
  lines.push('  if [ -z "$fail_reason" ]; then');
  lines.push('    fail_reason="退出码: $task_status"');
  lines.push("  fi");
  lines.push('  if [ ${#fail_reason} -gt 200 ]; then');
  lines.push('    fail_reason="${fail_reason:0:200}..."');
  lines.push("  fi");
  lines.push('  update_run_state "failed" "执行失败" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$fail_reason"');
  lines.push('  notify "工程构建失败" "$PROJECT_NAME" "$fail_reason" "$LOG_FILE_PATH"');
  lines.push("fi");
  lines.push("exit $task_status");

  return lines.join("\n");
}

function formatStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(
    now.getSeconds(),
  )}`;
}

function sanitizeFileName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return sanitized || "project";
}

function escapeForDoubleQuotes(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

function withJavaHome(command: string, javaHome?: string): string {
  const trimmed = (javaHome ?? "").trim();
  if (!trimmed) {
    return command;
  }

  const expanded = expandHomeDir(trimmed);
  const javaBin = path.join(expanded, "bin");
  return `JAVA_HOME=${shellEscape(expanded)} PATH=${shellEscape(javaBin)}:$PATH ${command}`;
}

function appendAntIdeaOutputSyncScript(lines: string[], plan: ExecutionPlan, indent: string): void {
  if (plan.project.type !== "ant" || !isIdeaOutputDirectory(plan.zipSourceDir)) {
    return;
  }

  const zipSourceDir = shellEscape(plan.zipSourceDir);
  const sourceCandidates = [
    path.join(plan.project.path, "WebContent", "WEB-INF", "classes", "com"),
    path.join(plan.project.path, "build", "classes", "com"),
    path.join(plan.project.path, "target", "classes", "com"),
  ]
    .map((item) => shellEscape(item))
    .join(" ");

  lines.push(`${indent}echo "[SYNC] 同步 Ant 输出到 IDEA 目录"`);
  lines.push(`${indent}local_sync_source=""`);
  lines.push(`${indent}for candidate in ${sourceCandidates}; do`);
  lines.push(`${indent}  if [ -d "$candidate" ]; then`);
  lines.push(`${indent}    local_sync_source="$candidate"`);
  lines.push(`${indent}    break`);
  lines.push(`${indent}  fi`);
  lines.push(`${indent}done`);
  lines.push(`${indent}mkdir -p ${zipSourceDir}`);
  lines.push(`${indent}if [ -n "$local_sync_source" ]; then`);
  lines.push(`${indent}  rm -rf ${zipSourceDir}/com`);
  lines.push(`${indent}  cp -R "$local_sync_source" ${zipSourceDir}/com`);
  lines.push(`${indent}  echo "[SYNC] $local_sync_source -> ${escapeForDoubleQuotes(plan.zipSourceDir)}/com"`);
  lines.push(`${indent}else`);
  lines.push(
    `${indent}  echo "[SYNC] 未找到可同步的编译产物(com)，已保持目录: ${escapeForDoubleQuotes(plan.zipSourceDir)} (project: ${escapeForDoubleQuotes(
      plan.project.path,
    )})"`,
  );
  lines.push(`${indent}fi`);
}

function isIdeaOutputDirectory(dirPath: string): boolean {
  const normalized = path.normalize(dirPath);
  const marker = `${path.sep}out${path.sep}production${path.sep}`;
  return normalized.includes(marker) || normalized.endsWith(`${path.sep}out${path.sep}production`);
}

function parseWorkspaceRoots(rawRoots?: string): string[] {
  const allowlist = SCAN_ROOT_ALLOWLIST.map((item) => path.resolve(expandHomeDir(item)));
  const configuredRoots = (rawRoots ?? "")
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(expandHomeDir(item)));

  const requestedRoots = configuredRoots.length > 0 ? configuredRoots : allowlist;
  const roots = requestedRoots.filter((item) => allowlist.includes(item));
  return Array.from(new Set(roots.length > 0 ? roots : allowlist));
}

async function scanProjects(roots: string[], maxDepth: number): Promise<ProjectCandidate[]> {
  const queue: Array<{ dir: string; depth: number }> = roots.map((dir) => ({ dir, depth: 0 }));
  const visited = new Set<string>();
  const results = new Map<string, ProjectCandidate>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    const resolvedDir = path.resolve(current.dir);
    const canonicalDir = await toCanonicalPath(resolvedDir);
    if (visited.has(canonicalDir)) {
      continue;
    }
    visited.add(canonicalDir);

    if (!(await isDirectory(canonicalDir))) {
      continue;
    }

    const projectType = await detectProjectType(canonicalDir);
    if (projectType !== "unknown") {
      results.set(canonicalDir, {
        name: path.basename(canonicalDir),
        path: canonicalDir,
        type: projectType,
      });
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    let entries: Array<Dirent> = [];
    try {
      entries = await fs.readdir(canonicalDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) {
        continue;
      }

      queue.push({ dir: path.join(canonicalDir, entry.name), depth: current.depth + 1 });
    }
  }

  return Array.from(results.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function detectProjectType(projectPath: string): Promise<ProjectType> {
  const [hasPom, hasAntBuildFile, hasPackageJson] = await Promise.all([
    pathExists(path.join(projectPath, "pom.xml")),
    hasAntBuildFileInProject(projectPath),
    pathExists(path.join(projectPath, "package.json")),
  ]);

  if (hasPom) {
    return "maven";
  }
  if (hasAntBuildFile) {
    return "ant";
  }
  if (hasPackageJson) {
    return "node";
  }
  return "unknown";
}

async function detectBuildCommand(type: ProjectType, projectPath: string, preferences: BuildZipPreferences): Promise<string> {
  if (type === "maven") {
    return detectMavenBuildCommand(projectPath, preferences);
  }

  if (type === "ant") {
    return detectAntBuildCommand(projectPath, preferences);
  }

  if (type === "node") {
    return detectNodeBuildCommand(projectPath, preferences.nodeBuildScript?.trim() || "build");
  }

  return "";
}

async function detectAntBuildCommand(projectPath: string, preferences: BuildZipPreferences): Promise<string> {
  const preferredBuildFile = (preferences.antBuildFile ?? "").trim() || "build_pre.xml";
  const configuredJavaHome = (preferences.javaHome ?? "").trim() || DEFAULT_JAVA_HOME;
  const explicitCandidate = path.join(projectPath, preferredBuildFile);
  if (await pathExists(explicitCandidate)) {
    return withJavaHome(`ant -f ${shellEscape(preferredBuildFile)}`, configuredJavaHome);
  }

  if (await pathExists(path.join(projectPath, "build.xml"))) {
    return withJavaHome("ant -f build.xml", configuredJavaHome);
  }

  const detected = await findFirstAntBuildFile(projectPath);
  if (detected) {
    return withJavaHome(`ant -f ${shellEscape(detected)}`, configuredJavaHome);
  }

  return withJavaHome("ant", configuredJavaHome);
}

async function hasAntBuildFileInProject(projectPath: string): Promise<boolean> {
  if (await pathExists(path.join(projectPath, "build.xml"))) {
    return true;
  }
  return Boolean(await findFirstAntBuildFile(projectPath));
}

async function findFirstAntBuildFile(projectPath: string): Promise<string | null> {
  let entries: Array<Dirent> = [];
  try {
    entries = await fs.readdir(projectPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const matched = entries
    .filter((entry) => entry.isFile() && /^build.*\.xml$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return matched[0] ?? null;
}

async function detectMavenBuildCommand(projectPath: string, preferences: BuildZipPreferences): Promise<string> {
  const configuredExecutable = (preferences.mavenExecutable ?? "").trim() || DEFAULT_MAVEN_EXECUTABLE;
  const configuredSettings = (preferences.mavenSettings ?? "").trim() || DEFAULT_MAVEN_SETTINGS;
  const configuredRepoLocal = (preferences.mavenRepoLocal ?? "").trim() || DEFAULT_MAVEN_REPO_LOCAL;
  const configuredProfile = (preferences.mavenProfile ?? "").trim() || DEFAULT_MAVEN_PROFILE;
  const configuredGoals = (preferences.mavenGoals ?? "").trim() || DEFAULT_MAVEN_GOALS;
  const configuredJavaHome = (preferences.javaHome ?? "").trim() || DEFAULT_JAVA_HOME;

  const executable = await resolveMavenExecutable(projectPath, configuredExecutable);
  const parts = [shellEscape(executable)];

  if (configuredSettings) {
    parts.push(`-s ${shellEscape(expandHomeDir(configuredSettings))}`);
  }
  if (configuredRepoLocal) {
    parts.push(`-Dmaven.repo.local=${shellEscape(expandHomeDir(configuredRepoLocal))}`);
  }

  parts.push(configuredGoals);

  if (configuredProfile) {
    parts.push(`-P${shellEscape(configuredProfile)}`);
  }

  const baseCommand = parts.join(" ");
  return withJavaHome(baseCommand, configuredJavaHome);
}

async function resolveMavenExecutable(projectPath: string, configuredExecutable: string): Promise<string> {
  const expandedConfigured = expandHomeDir(configuredExecutable);
  if (path.isAbsolute(expandedConfigured)) {
    if (await pathExists(expandedConfigured)) {
      return expandedConfigured;
    }

    if (await pathExists(path.join(projectPath, "mvnw"))) {
      return "./mvnw";
    }
    return "mvn";
  }

  return expandedConfigured || "mvn";
}

async function detectNodeBuildCommand(projectPath: string, preferredScript: string): Promise<string> {
  let scripts: Record<string, string> = {};
  try {
    const packageJsonPath = path.join(projectPath, "package.json");
    const packageJson = await readJsonFile<{ scripts?: Record<string, string> }>(packageJsonPath);
    scripts = packageJson.scripts ?? {};
  } catch {
    return "";
  }

  const exactCandidates = [preferredScript, "build", "build:prod", "build:production"];
  const allScriptNames = Object.keys(scripts);
  const buildPrefixCandidates = allScriptNames.filter((scriptName) => /^build([:-]|$)/i.test(scriptName));
  const fuzzyBuildCandidates = allScriptNames.filter((scriptName) => /build/i.test(scriptName));
  const candidates = Array.from(new Set([...exactCandidates, ...buildPrefixCandidates, ...fuzzyBuildCandidates]));
  const selectedScript = candidates.find((scriptName) => Boolean(scripts[scriptName]));
  if (!selectedScript) {
    return "";
  }

  const manager = await detectPackageManager(projectPath);
  if (manager === "yarn" && selectedScript === "build") {
    return "yarn build";
  }

  if (manager === "yarn") {
    return `yarn run ${selectedScript}`;
  }

  if (manager === "pnpm") {
    return `pnpm run ${selectedScript}`;
  }

  return `npm run ${selectedScript}`;
}

async function detectPackageManager(projectPath: string): Promise<"pnpm" | "yarn" | "npm"> {
  if (await pathExists(path.join(projectPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(path.join(projectPath, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

async function resolveZipPlan(projectPath: string, type: ProjectType, overrides?: RunOverrides): Promise<ZipPlan> {
  const autoPlan = await detectAutoZipPlan(projectPath, type);

  const sourceDir = overrides?.sourceDir ? resolveUserPath(projectPath, overrides.sourceDir) : autoPlan.sourceDir;
  if (!(await isDirectory(sourceDir))) {
    if (type === "ant" && isIdeaOutputDirectory(sourceDir)) {
      await fs.mkdir(sourceDir, { recursive: true });
    } else {
      throw new Error(`压缩根目录不存在: ${sourceDir}`);
    }
  }

  let entries = parseIncludeEntries(overrides?.includePaths);
  if (entries.length === 0) {
    if (overrides?.sourceDir) {
      entries = await detectDefaultEntries(type, projectPath, sourceDir);
    } else {
      entries = autoPlan.entries;
    }
  }

  const filteredEntries = await filterExistingEntries(sourceDir, entries);
  const allowMissingEntries = type === "ant" && isIdeaOutputDirectory(sourceDir);
  return {
    sourceDir,
    entries: filteredEntries.length > 0 ? filteredEntries : allowMissingEntries ? entries : ["."],
  };
}

async function detectAutoZipPlan(projectPath: string, type: ProjectType): Promise<ZipPlan> {
  if (type === "ant") {
    const ideaOutput = await detectAntIdeaOutputDir(projectPath);
    if (ideaOutput) {
      const entries = await detectDefaultEntries(type, projectPath, ideaOutput);
      return {
        sourceDir: ideaOutput,
        entries,
      };
    }
  }

  if (type === "maven" || type === "ant") {
    const classesDir = await detectJavaClassesDir(projectPath);
    if (classesDir) {
      const entries = await detectDefaultEntries(type, projectPath, classesDir);
      return {
        sourceDir: classesDir,
        entries,
      };
    }
  }

  if (type === "node") {
    for (const folderName of NODE_OUTPUT_CANDIDATES) {
      if (await pathExists(path.join(projectPath, folderName))) {
        return {
          sourceDir: projectPath,
          entries: [folderName],
        };
      }
    }
  }

  return {
    sourceDir: projectPath,
    entries: ["."],
  };
}

async function detectJavaClassesDir(projectPath: string): Promise<string | null> {
  const targetDir = path.join(projectPath, "target");
  if (await isDirectory(targetDir)) {
    let entries: Array<Dirent> = [];
    try {
      entries = await fs.readdir(targetDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const webInfClassesCandidates: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(targetDir, entry.name, "WEB-INF", "classes");
      if (await isDirectory(candidate)) {
        webInfClassesCandidates.push(candidate);
      }
    }

    if (webInfClassesCandidates.length > 0) {
      return pickNewestDirectory(webInfClassesCandidates);
    }

    const targetClasses = path.join(targetDir, "classes");
    if (await isDirectory(targetClasses)) {
      return targetClasses;
    }
  }

  const projectLocalOut = await detectIdeaOutProduction(projectPath, projectPath);
  if (projectLocalOut) {
    return projectLocalOut;
  }

  const workspaceParent = path.dirname(projectPath);
  const workspaceOut = await detectIdeaOutProduction(projectPath, workspaceParent);
  if (workspaceOut) {
    return workspaceOut;
  }

  return null;
}

async function detectIdeaOutProduction(projectPath: string, basePath: string): Promise<string | null> {
  const outProduction = path.join(basePath, "out", "production");
  if (!(await isDirectory(outProduction))) {
    return null;
  }

  const projectName = path.basename(projectPath);
  const exactProjectOutput = path.join(outProduction, projectName);
  if (await isDirectory(exactProjectOutput)) {
    return exactProjectOutput;
  }

  const children = await fs.readdir(outProduction, { withFileTypes: true });
  const projectFolders = children
    .filter((entry: Dirent) => entry.isDirectory())
    .map((entry: Dirent) => path.join(outProduction, entry.name));

  if (projectFolders.length === 1) {
    return projectFolders[0];
  }

  return null;
}

async function detectAntIdeaOutputDir(projectPath: string): Promise<string | null> {
  const projectLocalOut = await detectIdeaOutProduction(projectPath, projectPath);
  if (projectLocalOut) {
    return projectLocalOut;
  }

  const workspaceParent = path.dirname(projectPath);
  const workspaceOut = await detectIdeaOutProduction(projectPath, workspaceParent);
  if (workspaceOut) {
    return workspaceOut;
  }

  return path.join(workspaceParent, "out", "production", path.basename(projectPath));
}

async function pickNewestDirectory(paths: string[]): Promise<string> {
  let newestPath = paths[0];
  let newestMtime = -1;

  for (const item of paths) {
    const stats = await fs.stat(item);
    if (stats.mtimeMs > newestMtime) {
      newestPath = item;
      newestMtime = stats.mtimeMs;
    }
  }

  return newestPath;
}

async function detectDefaultEntries(type: ProjectType, projectPath: string, sourceDir: string): Promise<string[]> {
  if (type === "maven" || type === "ant") {
    if (type === "ant" && isIdeaOutputDirectory(sourceDir)) {
      return ["com"];
    }

    const javaEntries = await filterExistingEntries(sourceDir, JAVA_ENTRY_CANDIDATES);
    if (javaEntries.length > 0) {
      return javaEntries;
    }
  }

  if (type === "node" && path.resolve(sourceDir) === path.resolve(projectPath)) {
    for (const folderName of NODE_OUTPUT_CANDIDATES) {
      if (await pathExists(path.join(sourceDir, folderName))) {
        return [folderName];
      }
    }
  }

  return ["."];
}

function buildZipCommand(zipName: string, entries: string[]): string {
  if (entries.includes(".")) {
    return `zip -rq ${shellEscape(zipName)} . -x ${shellEscape(zipName)}`;
  }
  return `zip -rq ${shellEscape(zipName)} ${entries.map(shellEscape).join(" ")}`;
}

function normalizeZipName(input?: string): string {
  const raw = (input ?? "").trim();
  const baseName = path.basename(raw || "a.zip");
  if (baseName.toLowerCase().endsWith(".zip")) {
    return baseName;
  }
  return `${baseName}.zip`;
}

function parseIncludeEntries(raw?: string): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function filterExistingEntries(sourceDir: string, entries: string[]): Promise<string[]> {
  const filtered: string[] = [];
  for (const entry of entries) {
    if (entry === ".") {
      filtered.push(entry);
      continue;
    }

    const fullPath = path.resolve(sourceDir, entry);
    if (await pathExists(fullPath)) {
      filtered.push(entry);
    }
  }
  return filtered;
}

function resolveUserPath(projectPath: string, inputPath: string): string {
  const expanded = expandHomeDir(inputPath.trim());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(projectPath, expanded);
}

function expandHomeDir(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function toCanonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content) as T;
}

function projectTypeLabel(type: ProjectType): string {
  if (type === "maven") {
    return "Maven";
  }
  if (type === "ant") {
    return "Ant";
  }
  if (type === "node") {
    return "Node";
  }
  return "Unknown";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
