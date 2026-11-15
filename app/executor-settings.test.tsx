import { expect, open, test } from "nsh/test";

test("background service control waits for tasks, then shows stopped and starts the release executor", async () => {
  const app = await open("./executor-settings.fixture.tsx", { platform: "macos", width: 800, height: 600 });
  await app.waitFor("Development executor running");
  await app.press("id:executor-toggle");
  await app.waitFor("Waiting for running tasks to finish before stopping…");
  await expect(app.press("id:executor-toggle")).rejects.toThrow();
  await app.press("id:finish-task");
  await app.waitFor("Background service stopped");
  await app.press("id:executor-toggle");
  await app.waitFor("Starting or switching; running tasks will finish first…");
  await app.press("id:finish-task");
  await app.waitFor("Release executor running");
  await app.press("id:fail-service");
  await app.waitFor("id:executor-error");
  expect(app.shows("Please retry")).toBe(true);
});

test("checks CLI updates and downloads a new version from settings", async () => {
  const app = await open("./executor-settings.fixture.tsx", { platform: "macos", width: 800, height: 700 });
  await app.press("id:executor-toggle"); await app.press("id:finish-task");
  await app.press("id:executor-toggle"); await app.press("id:finish-task");
  await app.press("id:cli-check-update");
  await app.waitFor("Checking CLI updates…");
  await app.press("id:finish-task");
  await app.waitFor("CLI 0.1.3 · 0.1.4 available");
  await app.press("id:cli-update");
  await app.waitFor("Downloading and verifying CLI; running tasks finish before switching…");
  await app.press("id:finish-task");
  await app.waitFor("CLI 0.1.4 · up to date");
});
