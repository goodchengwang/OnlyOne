import { expect, test } from "bun:test";
import { attachmentName, isDoc } from "../app/files";

test("markdown attachments are documents, images are not", () => {
  expect(isDoc("/media/1731-report.md")).toBe(true);
  expect(isDoc("/media/1731-notes.markdown?token=x")).toBe(true);
  expect(isDoc("/media/1731-shot.png")).toBe(false);
});

test("attachment names drop the storage timestamps", () => {
  expect(attachmentName("/media/1762650000000-1762650000123-push-notifications.md")).toBe("push-notifications.md");
  expect(attachmentName("https://onlyone.example/media/1762650000000-report.md?token=x")).toBe("report.md");
  expect(attachmentName("/media/plain.md")).toBe("plain.md");
});

test("attachments are any file: the card opens what is not a picture, and images stay pictures", async () => {
  const { isImageFile, fileExt } = await import("../app/files");
  expect(isImageFile("/media/1731-shot.png?token=x")).toBe(true);
  expect(isImageFile("/media/1731-photo.JPEG")).toBe(true);
  expect(isImageFile("/media/1731-bundle.zip")).toBe(false);
  expect(isImageFile("/media/1731-build.log")).toBe(false);
  // a HEIC is a file card: the app cannot draw it, the system can open it
  expect(isImageFile("/media/1731-photo.heic")).toBe(false);
  expect(fileExt("bundle.zip")).toBe("ZIP");
  expect(fileExt("no-extension")).toBe("");
});

test("a file's type and the limits the composer applies", async () => {
  const { fileType, fileSize, showsAsImage, attachIssue, ATTACH_MAX_BYTES, ATTACH_MAX_COUNT } = await import("../app/files");
  // an image's type comes from its name when the device gave none (a phone photo), anything else keeps what it said
  expect(fileType("", "IMG_0001.HEIC")).toBe("image/heic");
  expect(fileType("image/jpg", "x")).toBe("image/jpg");
  expect(fileType("application/zip", "bundle")).toBe("application/zip");
  expect(fileType("", "notes.md")).toBe("text/markdown");
  expect(fileType("", "mystery")).toBe("");
  expect(showsAsImage("image/png")).toBe(true);
  expect(showsAsImage("image/heic")).toBe(false);
  expect(showsAsImage("image/svg+xml")).toBe(false);
  expect(attachIssue(1000, 0)).toBe("");
  expect(attachIssue(ATTACH_MAX_BYTES + 1, 0)).toBe("big");
  expect(attachIssue(1000, ATTACH_MAX_COUNT)).toBe("many");
  expect(fileSize(812)).toBe("812 B");
  expect(fileSize(24 * 1024)).toBe("24 KB");
  expect(fileSize(2.4 * 1024 * 1024)).toBe("2.4 MB");
});

test("an upload request carries several files at once, and none when it carries none", async () => {
  const { uploadFiles } = await import("../cloud/src/uploads");
  const form = new FormData();
  form.append("file", new File([new Uint8Array([1, 2, 3])], "bundle.zip", { type: "application/zip" }));
  form.append("file", new File([new Uint8Array([4])], "build.log"));
  expect(uploadFiles(form).map((f) => f.name)).toEqual(["bundle.zip", "build.log"]);
  expect(uploadFiles(null)).toEqual([]);
  expect(uploadFiles(new FormData())).toEqual([]);
});
