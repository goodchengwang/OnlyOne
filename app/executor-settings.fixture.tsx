import { mount, signal, View } from "nsh";
import { Button } from "./ui";
import { ExecutorSettings, type ExecutorControl } from "./executor-settings";
import type { DesktopStatus } from "../src/desktop-status";

const state = signal<DesktopStatus | null>({ running: true, stopping: false, mode: "development" });
const busy = signal<"start" | "stop" | null>(null);
const error = signal("");
let finish: (() => void) | undefined;
const service: ExecutorControl = {
  state, busy, error, refresh: () => {},
  run: async (action) => {
    busy.set(action);
    error.set("");
    await new Promise<void>((resolve) => { finish = resolve; });
    state.set({ running: action === "start", stopping: false, mode: action === "start" ? "release" : null });
    busy.set(null);
    return true;
  },
};
mount(() => <View style={{ padding: 24, gap: 12 }}>
  <ExecutorSettings service={service} />
  <Button testID="finish-task" label="Finish task" onPress={() => finish?.()} />
  <Button testID="fail-service" label="Fail service" onPress={() => error.set("Please retry")} />
</View>);
