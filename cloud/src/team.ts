import { mediaHeaders, sniffImage, uploadProblem } from "./uploads";

export type MemberView = { id: string; name?: string; avatar?: string; revision?: string };
export const MEMBER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const ROUTINE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,79}$/u;
export const MAX_AVATAR = 1_500_000;

/** The scheduler's accepted forms; reject typos instead of saving a task that never fires. */
export function validSchedule(every: string): boolean {
  return /^(hourly|[1-9]\d*m)$/.test(every) ||
    /^(daily|weekdays|weekly (SUN|MON|TUE|WED|THU|FRI|SAT)) ([01]\d|2[0-3]):[0-5]\d$/.test(every);
}

export function avatarResponse(data: Uint8Array | null): Response {
  if (!data) return Response.json({ error: "avatar not found" }, { status: 404 });
  const type = sniffImage(data);
  const bad = uploadProblem(type, data.length);
  if (bad || data.length > MAX_AVATAR) return Response.json({ error: "invalid avatar" }, { status: 415 });
  return new Response(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, { headers: mediaHeaders(type, "avatar") });
}
