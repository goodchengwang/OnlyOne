import { Text, View } from "nsh";
import { L } from "./i18n";
import { Button, colors, SettingsGroup as Group } from "./ui";
import type { DesktopStatus, ExecutorAction } from "../src/desktop-status";
import { needsExecutorTools, type ExecutorTools } from "./executor-setup";

export type ExecutorControl = { state: () => DesktopStatus | null; busy: () => ExecutorAction | "install" | null; error: () => string; run: (action: ExecutorAction) => Promise<boolean>; retry: () => Promise<boolean>; requiresInstall: () => boolean; refresh: () => void; tools: () => ExecutorTools | null; install: () => Promise<void> };
export function ExecutorSettings(props: { service: ExecutorControl }) {
  const s = props.service;
  s.refresh();
  const label = () => s.busy() === "stop" || s.state()?.stopping
    ? L("Waiting for running tasks to finish before stopping…", "正在等待任务结束后关闭…")
    : s.busy() === "install" ? L("Downloading and installing missing components…", "正在下载并安装缺少的组件…")
    : s.busy() === "check-update" ? L("Checking CLI updates…", "正在检查 CLI 更新…")
    : s.busy() === "update" ? L("Downloading and verifying CLI; running tasks finish before switching…", "正在下载并校验 CLI，任务结束后切换版本…")
    : s.busy() === "start" ? L("Starting or switching; running tasks will finish first…", "正在启动或切换，等待当前任务结束…")
    : s.state()?.running ? (s.state()?.mode === "development" ? L("Development executor running", "开发版执行器运行中") : L("Release executor running", "正式版执行器运行中"))
    : !s.state() ? L("Background service unavailable", "后台服务尚不可用") : L("Background service stopped", "后台服务已关闭");
  return <Group title={L("Background service on this computer", "本机后台服务")} hint={L("Release apps use onlyonecli on this computer. Closing the window keeps it running; stopping waits for tasks to finish.", "正式桌面端使用本机 onlyonecli。关闭窗口后服务继续运行，关闭服务会等待当前任务结束。")}>
    <View style={{ gap: 10, padding: 16 }}>
      <If when={s.tools()}>
        <Text testID="executor-tools" style={{ fontSize: 14, color: colors.muted }}>{() => {
          const tools = s.tools()!;
          return `Node.js ${tools.node ?? L("not detected", "未检测到")}${tools.node && Number(tools.node.replace(/^v/, "").split(".")[0]) < 22 ? L(" (22+ required)", "（需要 22+）") : ""} · npm ${tools.npm ?? L("not detected", "未检测到")}\nonlyonecli ${tools.cli ?? L("not detected", "未检测到")}`;
        }}</Text>
        <If when={s.tools() && needsExecutorTools(s.tools()!)}>
          <Button testID="executor-install" label={s.busy() === "install" ? L("Installing…", "正在安装…") : L("Install missing components", "安装缺少的组件")} disabled={!!s.busy()} onPress={() => void s.install()} />
        </If>
      </If>
      <Text testID="executor-status" style={{ fontSize: 14, color: colors.muted }}>{label()}</Text>
      <If when={s.state()?.cli}><Text testID="cli-version" style={{ fontSize: 14, color: colors.muted }}>{() => {
        const cli = s.state()!.cli!;
        return `CLI ${cli.version}` + (cli.pending ? L(" · awaiting startup confirmation", " · 等待启动确认") : cli.latest ? cli.available ? L(` · ${cli.latest} available`, ` · 可更新至 ${cli.latest}`) : L(" · up to date", " · 已是最新版本") : "");
      }}</Text></If>
      <Button testID="cli-check-update" label={L("Check CLI updates", "检查 CLI 更新")} disabled={!!s.busy() || !s.state() || s.state()?.mode === "development"} onPress={() => void s.run("check-update")} />
      <Button testID="executor-check" label={L("Detect components again", "重新检测组件")} disabled={!!s.busy()} onPress={s.refresh} />
      <If when={s.state()?.cli?.available}><Button testID="cli-update" label={L("Download and update CLI", "下载并更新 CLI")} disabled={!!s.busy() || !!s.state()?.cli?.pending} onPress={() => void s.run("update")} /></If>
      <If when={s.error()}><Text testID="executor-error" style={{ color: colors.danger }}>{s.error()}</Text></If>
      <Button testID="executor-toggle" label={s.state()?.running ? L("Stop background service", "关闭后台服务") : L("Start background service", "开启后台服务")} disabled={!!s.busy() || !s.state()} onPress={() => void s.run(s.state()?.running ? "stop" : "start")} />
    </View>
  </Group>;
}

