export interface ConfirmKillContext {
  paneId: string;
  killPane: (paneId: string) => Promise<boolean>;
  refreshSessions: () => Promise<unknown>;
  isCurrent: () => boolean;
  onSuccess: () => void;
  showActionError: (message: string) => void;
}

export async function executeConfirmKill(ctx: ConfirmKillContext) {
  const killed = await ctx.killPane(ctx.paneId);
  if (!ctx.isCurrent()) return;

  if (!killed) {
    ctx.showActionError("Failed to kill pane");
    return;
  }

  ctx.onSuccess();
  await ctx.refreshSessions();
}
