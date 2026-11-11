// Read mail captured by the local Resend test provider.
export async function capturedCode(base: string, token: string) {
  const response = await fetch(`${base}/api/test`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error("Run this test against cloud/test/standalone.toml");
  const { mail } = await response.json() as any;
  for (const message of mail.toReversed()) {
    const code = message.subject.match(/(?:验证码：|login code: )([A-HJKMNP-Z2-9]{8})$/)?.[1];
    if (code) return code;
  }
  throw new Error("No captured login email");
}
