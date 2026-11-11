import { expect, test } from "bun:test";
import { agentDisplayName, avatarOf } from "../app/avatars";
test("agent names follow the client language", () => {
  expect(agentDisplayName("Tripitaka@host", true)).toBe("唐僧");
  expect(agentDisplayName("Tripitaka@host", false)).toBe("Tripitaka");
  expect(agentDisplayName("Argus@h", false)).toBe("Monkey");
  expect(agentDisplayName("reviewer", true)).toBe("悟空");
  expect(agentDisplayName("onlyone@h", true)).toBe("顺风耳");
  expect(agentDisplayName("onlyone@h", false)).toBe("Shunfeng");
  expect(agentDisplayName("unknown@h", true)).toBe("unknown");
  expect(agentDisplayName("Tripitaka@h", true, [{ id: "lead", avatar: "custom.png" }])).toBe("唐僧");
  expect(avatarOf("Tripitaka@h", [{ id: "lead", avatar: "custom.png" }])).toBe("custom.png");
  expect(avatarOf("unknown@h", [{ id: "lead", avatar: "custom.png" }])).toBeNull();
  const custom = [{ id: "content", name: "content-editor", avatar: "wrong.png" }, { id: "content-editor", name: "小白", avatar: "right.png" }];
  expect(avatarOf("content-editor@h", custom)).toBe("right.png");
  custom[1].name = "选题助手";
  expect(agentDisplayName("content-editor@h", true, custom)).toBe("选题助手");
  expect(avatarOf("content-editor@h", custom)).toBe("right.png");
});
