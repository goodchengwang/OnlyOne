export type ExecutorAction = "start" | "stop" | "check-update" | "update";
export type DesktopStatus = { running: boolean; stopping: boolean; mode: "development" | "release" | null;
  cli?: { version: string; latest?: string; pending?: boolean; available?: boolean } };
