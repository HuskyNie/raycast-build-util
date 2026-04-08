interface BuildAndZipStatusRuntimeOptions {
  activeRunCount: number;
  isInitialLoading: boolean;
}

export function shouldKeepBuildAndZipStatusLoaded({
  activeRunCount,
  isInitialLoading,
}: BuildAndZipStatusRuntimeOptions): boolean {
  return isInitialLoading || activeRunCount > 0;
}
