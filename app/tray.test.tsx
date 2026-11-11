import { describe, expect, test } from "nsh/test";
import { lang } from "./i18n";
import { trayMenu } from "./tray";

const labels = (m: ReturnType<typeof trayMenu>["menu"]) => m.map((i) => ("type" in i ? "---" : i.label ?? i.role));

describe("tray menu", () => {
  test("signed out: open and quit", () => {
    lang.set("en");
    const t = trayMenu(null, () => {});
    expect(t.tooltip).toBe("OnlyOne");
    expect(labels(t.menu)).toEqual(["Open OnlyOne", "---", "Quit OnlyOne"]);
  });

  test("signed in: the decisions waiting open the current one", () => {
    lang.set("zh");
    const calls: string[] = [];
    const chat = { pending: 2, review: () => calls.push("review"), settings: () => calls.push("settings") };
    const t = trayMenu(chat, () => calls.push("show"));
    expect(t.tooltip).toBe("OnlyOne · 2 件事等你拍板");
    expect(labels(t.menu)).toEqual(["打开 OnlyOne", "2 件事等你拍板", "---", "团队设置…", "---", "退出 OnlyOne"]);
    (t.menu[1] as { onSelect: () => void }).onSelect();
    (t.menu[3] as { onSelect: () => void }).onSelect();
    expect(calls).toEqual(["show", "review", "show", "settings"]);
    lang.set("en");
  });

  test("nothing waiting: no decisions item", () => {
    lang.set("en");
    const t = trayMenu({ pending: 0, review: () => {}, settings: () => {} }, () => {});
    expect(labels(t.menu)).toEqual(["Open OnlyOne", "---", "Team Settings…", "---", "Quit OnlyOne"]);
  });
});
