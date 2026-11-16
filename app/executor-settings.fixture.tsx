import { mount, signal, View } from "nsh";
import { Button } from "./ui";
import { ExecutorSettings, type ExecutorControl } from "./executor-settings";
import type { DesktopStatus, ExecutorAction } from "../src/desktop-status";
import { needsExecutorTools, type ExecutorTools } from "./executor-setup";

const state = signal<DesktopStatus | null>({ running: true, stopping: false, mode: "development" });
const busy = signal<ExecutorAction | "install" | null>(null);
const tools = signal<ExecutorTools | null>({ node: "v22.0.0", npm: "10.0.0", cli: "0.1.3" });
const error = signal("");
let finish: (() => void) | undefined;
const service: ExecutorControl = {
  state, busy, error, tools, refresh: () => {},
  retry: () => service.run("start"), requiresInstall: () => !!tools() && needsExecutorTools(tools()!),
  install: async () => {
    busy.set("install"); error.set("");
    await new Promise<void>((resolve) => { finish = resolve; });
    if (failInstall) { error.set("Installation failed. Please retry"); busy.set(null); return; }
    tools.set({ node: "v22.0.0", npm: "10.0.0", cli: "0.1.3" });
    busy.set(null);
    await service.run("start");
  },
  run: async (action) => {
    busy.set(action);
    error.set("");
    await new Promise<void>((resolve) => { finish = resolve; });
    if (action === "check-update") state.set({ running: true, stopping: false, mode: "release", cli: { version: "0.1.3", latest: "0.1.4", available: true } });
    else if (action === "update") state.set({ running: true, stopping: false, mode: "release", cli: { version: "0.1.4", latest: "0.1.4", available: false } });
    else state.set({ running: action === "start", stopping: false, mode: action === "start" ? "release" : null });
    busy.set(null);
    return true;
  },
};
let failInstall = false;
mount(() => <View style={{ padding: 24, gap: 12 }}>
  <ExecutorSettings service={service} />
  <Button testID="finish-task" label="Finish task" onPress={() => finish?.()} />
  <Button testID="fail-service" label="Fail service" onPress={() => error.set("Please retry")} />
  <Button testID="missing-tools" label="Missing tools" onPress={() => { state.set(null); tools.set({ node: null, npm: null, cli: null }); }} />
  <Button testID="fail-install" label="Fail install" onPress={() => { failInstall = !failInstall; }} />
</View>);
