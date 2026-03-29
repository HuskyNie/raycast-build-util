export interface BackgroundLaunchWithFeedbackOptions<TResult> {
  closeMainWindow: () => Promise<void>;
  onFailure: (error: unknown) => Promise<void> | void;
  onSuccess: (result: TResult) => Promise<void> | void;
  showHUD: (message: string) => Promise<void>;
  startTask: () => Promise<TResult>;
  successHUDMessage: string;
}

export async function runBackgroundLaunchWithFeedback<TResult>({
  closeMainWindow,
  onFailure,
  onSuccess,
  showHUD,
  startTask,
  successHUDMessage,
}: BackgroundLaunchWithFeedbackOptions<TResult>): Promise<void> {
  try {
    const result = await startTask();
    await onSuccess(result);
    await closeMainWindow();
    await showHUD(successHUDMessage);
  } catch (error) {
    await onFailure(error);
  }
}
