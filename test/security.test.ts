// Worker hardening: IP allow-list, login code format, OAuth redirect hosts, media served from the app origin.
import { expect, test } from "bun:test";
import { ipAllowed, parseAllowList } from "../cloud/src/ipallow";
import { CODE_ALPHABET, CODE_LEN, CODE_RE, newCode, normCode } from "../cloud/src/authcode";
import { okRedirect } from "../cloud/src/mcp";
import { mediaHeaders } from "../cloud/src/uploads";

test("IP allow-list: v4 / v6 addresses and CIDRs", () => {
  const { nets, bad } = parseAllowList("203.0.113.7, 198.51.100.0/24 2001:db8:abcd::/48\n::1 nonsense 10.0.0.0/33");
  expect(bad).toEqual(["nonsense", "10.0.0.0/33"]);
  expect(ipAllowed("203.0.113.7", nets)).toBe(true);
  expect(ipAllowed("203.0.113.8", nets)).toBe(false);
  expect(ipAllowed("198.51.100.254", nets)).toBe(true);
  expect(ipAllowed("198.51.101.1", nets)).toBe(false);
  expect(ipAllowed("2001:db8:abcd:12::5", nets)).toBe(true);
  expect(ipAllowed("2001:DB8:ABCE::5", nets)).toBe(false);
  expect(ipAllowed("::1", nets)).toBe(true);
  expect(ipAllowed("::ffff:203.0.113.7", nets)).toBe(true); // IPv4-mapped
  expect(ipAllowed("", nets)).toBe(false);
  expect(ipAllowed(null, nets)).toBe(false);
  expect(ipAllowed("1.2.3.4", parseAllowList("garbage").nets)).toBe(false); // fails closed
  expect(ipAllowed("1.2.3.4", parseAllowList("0.0.0.0/0").nets)).toBe(true);
});

test("login codes: 8 unambiguous letters/digits, typed loosely", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const c = newCode();
    expect(c).toHaveLength(CODE_LEN);
    expect(CODE_RE.test(c)).toBe(true);
    seen.add(c);
  }
  expect(seen.size).toBe(2000);
  expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
  expect(normCode("abcd-efgh")).toBe("ABCDEFGH");
  expect(normCode(" k7qm 4xpr ")).toBe("K7QM4XPR");
  expect(CODE_RE.test(normCode("123456"))).toBe(false); // old 6-digit codes
  expect(CODE_RE.test(normCode("ABCDEFG0"))).toBe(false);
});

test("OAuth redirects: only Claude, ChatGPT and loopback", () => {
  expect(okRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
  expect(okRedirect("https://claude.com/api/mcp/auth_callback")).toBe(true);
  expect(okRedirect("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
  expect(okRedirect("http://localhost:6274/oauth/callback")).toBe(true);
  expect(okRedirect("http://127.0.0.1:33418/callback")).toBe(true);
  expect(okRedirect("https://evil.example.com/cb")).toBe(false);
  expect(okRedirect("https://claude.ai.evil.com/cb")).toBe(false);
  expect(okRedirect("https://evilclaude.ai/cb")).toBe(false);
  expect(okRedirect("https://claude.ai@evil.com/cb")).toBe(false);
  expect(okRedirect("http://claude.ai/cb")).toBe(false);
  expect(okRedirect("https://claude.ai:8443/cb")).toBe(false);
});

test("media: active content is a sandboxed download, images stay inline", () => {
  for (const t of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/javascript", ""]) {
    const h = mediaHeaders(t, "x");
    expect(h["content-type"]).toBe("application/octet-stream");
    expect(h["content-disposition"]).toStartWith("attachment");
  }
  const png = mediaHeaders("image/png", "a b.png");
  expect(png["content-type"]).toBe("image/png");
  expect(png["content-disposition"]).toBe('inline; filename="a_b.png"');
  expect(png["x-content-type-options"]).toBe("nosniff");
  expect(png["content-security-policy"]).toStartWith("sandbox");
});
