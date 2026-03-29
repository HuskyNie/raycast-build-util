export async function revealPathInFinder(path: string, showInFinder: (path: string) => Promise<void>): Promise<void> {
  await showInFinder(path);
}
