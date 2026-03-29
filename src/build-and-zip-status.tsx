import { Clipboard, Color, Icon, MenuBarExtra, open, showInFinder } from "@raycast/api";
import { useEffect, useState } from "react";
import { BackgroundRunState, getBackgroundRunLogDir, loadBackgroundRuns } from "./background-run-state";
import { revealPathInFinder } from "./finder-utils";

const RECENT_RUN_LIMIT = 5;
const REFRESH_INTERVAL_MS = 5000;

export default function BuildAndZipStatusCommand() {
  const [activeRuns, setActiveRuns] = useState<BackgroundRunState[]>([]);
  const [recentRuns, setRecentRuns] = useState<BackgroundRunState[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let disposed = false;

    const refresh = async () => {
      try {
        const loaded = await loadBackgroundRuns(getBackgroundRunLogDir());
        if (disposed) {
          return;
        }
        setActiveRuns(loaded.activeRuns);
        setRecentRuns(loaded.recentRuns.slice(0, RECENT_RUN_LIMIT));
        setErrorMessage(undefined);
      } catch (error) {
        if (disposed) {
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed) {
          setIsLoading(false);
        }
      }
    };

    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <MenuBarExtra
      icon={activeRuns.length > 0 ? { source: Icon.CircleProgress100, tintColor: Color.Blue } : Icon.Hammer}
      isLoading={isLoading}
      title={activeRuns.length > 0 ? `构建 ${activeRuns.length}` : "构建"}
      tooltip={buildTooltip(activeRuns.length, recentRuns.length)}
    >
      {errorMessage ? <MenuBarExtra.Item title="状态读取失败" subtitle={errorMessage} /> : null}

      {activeRuns.length > 0 ? (
        <MenuBarExtra.Section title="进行中的任务">
          {activeRuns.map((run) => (
            <RunMenuItem key={run.runId} run={run} />
          ))}
        </MenuBarExtra.Section>
      ) : (
        <MenuBarExtra.Section title="进行中的任务">
          <MenuBarExtra.Item title="当前没有后台任务" />
        </MenuBarExtra.Section>
      )}

      <MenuBarExtra.Section title="最近任务">
        {recentRuns.length > 0 ? (
          recentRuns.map((run) => <RunMenuItem key={run.runId} run={run} />)
        ) : (
          <MenuBarExtra.Item title="最近还没有任务记录" />
        )}
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}

function RunMenuItem({ run }: { run: BackgroundRunState }) {
  return (
    <MenuBarExtra.Submenu
      icon={getStatusIcon(run.status)}
      title={run.projectName}
    >
      <MenuBarExtra.Item title={run.statusText || run.status} subtitle={formatTimestamp(run.updatedAt)} />
      <MenuBarExtra.Item title="打开日志" onAction={() => void open(run.logPath)} />
      <MenuBarExtra.Item title="复制日志路径" onAction={() => void Clipboard.copy(run.logPath)} />
      {run.zipPath ? <MenuBarExtra.Item title="打开压缩包" onAction={() => void revealPathInFinder(run.zipPath, showInFinder)} /> : null}
      {run.zipPath ? <MenuBarExtra.Item title="复制压缩包路径" onAction={() => void Clipboard.copy(run.zipPath)} /> : null}
      {run.errorMessage ? <MenuBarExtra.Item title="错误信息" subtitle={run.errorMessage} /> : null}
    </MenuBarExtra.Submenu>
  );
}

function buildTooltip(activeCount: number, recentCount: number): string {
  if (activeCount > 0) {
    return `进行中 ${activeCount} · 最近任务 ${recentCount}`;
  }
  return `当前无进行中任务 · 最近任务 ${recentCount}`;
}

function formatTimestamp(value?: string): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function getStatusIcon(status: BackgroundRunState["status"]) {
  if (status === "success") {
    return { source: Icon.CheckCircle, tintColor: Color.Green };
  }
  if (status === "failed") {
    return { source: Icon.XMarkCircle, tintColor: Color.Red };
  }
  if (status === "zipping") {
    return { source: Icon.Box, tintColor: Color.Orange };
  }
  return { source: Icon.CircleProgress100, tintColor: Color.Blue };
}
