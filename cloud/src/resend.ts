/** Resend errors must never carry the provider response (or credentials) into logs. */
export async function sendResend(key: string, from: string, to: string, subject: string, text: string, request: typeof fetch = fetch) {
  const response = await request("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `OnlyOne <${from}>`, to: [to], subject, text }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => { throw new Error("Resend request failed or timed out"); });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Resend HTTP ${response.status}`);
}
