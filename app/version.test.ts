import { expect, test } from "nsh/test";
import { machineVersion } from "./onlyone";
import { lang } from "./i18n";

test("machine versions distinguish npm releases, source builds and missing reports", () => {
  const previous = lang();
  try {
    lang.set("en");
    expect(machineVersion("10.20.300")).toBe("CLI · v10.20.300");
    expect(machineVersion("0.2.0-beta.1")).toBe("CLI · v0.2.0-beta.1");
    expect(machineVersion("726affc123456")).toBe("Development · 726affc");
    expect(machineVersion("dev")).toBe("Development");
    expect(machineVersion()).toBe("Unknown");
    lang.set("zh");
    expect(machineVersion("0.1.1")).toBe("CLI · v0.1.1");
    expect(machineVersion("726affc123456")).toBe("开发版 · 726affc");
    expect(machineVersion("dev")).toBe("开发版");
    expect(machineVersion()).toBe("未知");
  } finally {
    lang.set(previous);
  }
});
