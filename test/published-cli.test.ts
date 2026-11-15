import { expect, test } from "bun:test";
import { checkPublishedCli } from "../scripts/check-published-cli";

test("App publication requires a compatible public CLI and every desktop platform package", async () => {
  const packages = ["onlyone-darwin-arm64", "onlyone-darwin-x64", "onlyone-linux-x64", "onlyone-windows-x64"];
  let protocol: number | undefined = 1, missing = "", mismatch = false;
  const calls: string[] = [];
  const request = async (url: string) => {
    calls.push(url);
    const name = new URL(url).pathname.split("/")[1]!;
    if (name === "onlyonecli") return Response.json({ version: "0.1.3", onlyoneAppProtocol: protocol,
      optionalDependencies: Object.fromEntries(packages.map(name => [name, "0.1.3"])) });
    const platform = name.replace('onlyone-', '').split('-');
    return name === missing ? Response.json({}, { status: 404 }) : Response.json({ name, version: mismatch ? "0.1.2" : "0.1.3",
      os: [platform[0] === "windows" ? "win32" : platform[0]], cpu: [platform[1]] });
  };
  expect(await checkPublishedCli(request)).toBe("0.1.3");
  expect(calls).toHaveLength(5);
  protocol = undefined; calls.length = 0;
  await expect(checkPublishedCli(request)).rejects.toThrow("app protocol 1");
  expect(calls).toHaveLength(1);
  protocol = 1; missing = "onlyone-windows-x64";
  await expect(checkPublishedCli(request)).rejects.toThrow("onlyone-windows-x64@0.1.3 is not published");
  missing = ""; mismatch = true;
  await expect(checkPublishedCli(request)).rejects.toThrow("Registry metadata mismatch");
});
