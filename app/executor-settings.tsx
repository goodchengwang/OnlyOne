import { Text, View } from "nsh";
import { L } from "./i18n";
import { Button, colors, SettingsGroup as Group } from "./ui";
import type { DesktopStatus } from "../src/desktop-status";

export type ExecutorControl = { state: () => DesktopStatus | null; busy: () => "start" | "stop" | null; error: () => string; run: (action: "start" | "stop") => Promise<boolean>; refresh: () => void };
export function ExecutorSettings(props: { service: ExecutorControl }) {
  const s = props.service;
  s.refresh();
  const label = () => s.busy() === "stop" || s.state()?.stopping
    ? L("Waiting for running tasks to finish before stopping…", "正在等待任务结束后关闭…")
    : s.busy() === "start" ? L("Starting or switching; running tasks will finish first…", "正在启动或切换，等待当前任务结束…")
    : s.state()?.running ? (s.state()?.mode === "development" ? L("Development executor running", "开发版执行器运行中") : L("Release executor running", "正式版执行器运行中"))
    : L("Background service stopped", "后台服务已关闭");
  return <Group title={L("Background service on this Mac", "本机后台服务")} hint={L("Opening a version switches to its executor after running tasks finish. Closing the window keeps the service running.", "打开哪个版本就切到对应执行器，切换和关闭服务都会等待当前任务结束。关闭窗口后服务继续运行。")}>
    <View style={{ gap: 10, padding: 16 }}>
      <Text testID="executor-status" style={{ fontSize: 14, color: colors.muted }}>{label()}</Text>
      <If when={s.error()}><Text testID="executor-error" style={{ color: colors.danger }}>{s.error()}</Text></If>
      <Button testID="executor-toggle" label={s.state()?.running ? L("Stop background service", "关闭后台服务") : L("Start background service", "开启后台服务")} disabled={!!s.busy() || !s.state()} onPress={() => void s.run(s.state()?.running ? "stop" : "start")} />
    </View>
  </Group>;
}

