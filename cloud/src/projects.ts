// Projects are owner-created records. Discovering a repository or a channel never registers one.
import { L } from "./i18n";
import { parseDoc, type ToolStore } from "./tools";

export type Project = { id: string; name: string; host: string; repo: string; created: string };
export const PROJECT_ID = /^prj-[a-f0-9-]{36}$/;
export const projectFile = (id: string) => `projects/${id}/project.md`;
export const projectMemoryFile = (id: string) => `projects/${id}/memory.md`;
type Store = Pick<ToolStore, "read" | "list">;

export function projectInput(a: any): { name: string; host: string; repo: string } | string {
  if (!a || typeof a !== "object") return L("Project details required", "请填写项目资料");
  const name: string = typeof a.name === "string" ? a.name.trim() : "";
  const host: string = typeof a.host === "string" ? a.host.trim() : "";
  let repo: string = typeof a.repo === "string" ? a.repo.trim() : "";
  if (!name || name.length > 60 || /[\x00-\x1f]/.test(name)) return L("Project name must be 1–60 characters", "项目名称须为 1–60 个字符");
  if (!/^[\w.-]{1,128}$/.test(host)) return L("Choose an execution computer", "请选择执行电脑");
  if (!/^(\/|[A-Za-z]:[\\/])/.test(repo) || repo.length > 1024 || /[\x00-\x1f]/.test(repo) || repo.split(/[\\/]/).some((s) => s === "." || s === "..")) return L("Choose an absolute folder path without . or ..", "请填写不含 . 或 .. 的文件夹绝对路径");
  repo = repo.replace(/([\\/])\1+/g, "$1").replace(/[\\/]+$/, "") || "/";
  if (/^[A-Za-z]:$/.test(repo)) repo += "\\";
  return { name, host, repo };
}

export function getProject(st: Store, id: string): Project | null {
  if (!PROJECT_ID.test(id)) return null;
  const f = st.read(projectFile(id));
  if (!f) return null;
  const { meta } = parseDoc(f.text), input = projectInput(meta);
  return typeof input === "string" || meta.id !== id ? null : { id, ...input, created: meta.created ?? f.updated };
}
export function listProjects(st: Store): Project[] {
  return st.list("projects/").filter((f) => /^projects\/prj-[a-f0-9-]{36}\/project\.md$/.test(f.path))
    .map((f) => getProject({ ...st, read: () => f }, f.path.split("/")[1])).filter((p): p is Project => !!p)
    .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}
export const projectDoc = (p: Project) => `---\n${Object.entries(p).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n`;
export function projectIndex(projects: Project[]): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return `# Projects\n\nOnly projects explicitly created by the owner are registered. This index is generated; never add projects by scanning folders or sessions.\n\n| name | computer | folder | memory |\n|---|---|---|---|\n${projects.map((p) => `| ${cell(p.name)} | ${cell(p.host)} | ${cell(p.repo)} | ${projectMemoryFile(p.id)} |`).join("\n")}\n`;
}

/** Changes are committed together; the client supplies a stable id so retries cannot duplicate a project. */
export function createProjectFiles(st: Store, a: any): { project: Project; changes: Record<string, string> } | string {
  const input = projectInput(a);
  if (typeof input === "string") return input;
  if (!PROJECT_ID.test(a.id ?? "")) return L("Invalid project id", "项目标识无效");
  const projects = listProjects(st), existing = projects.find((p) => p.id === a.id);
  if (existing) return existing.name === input.name && existing.host === input.host && existing.repo === input.repo ? { project: existing, changes: {} } : L("Project id already exists", "项目标识已存在");
  if (projects.some((p) => p.host === input.host && p.repo === input.repo)) return L("This folder has already been added on this computer", "这台电脑上的该文件夹已经添加过了");
  if (projects.length >= 100) return L("At most 100 projects can be registered", "最多可添加 100 个项目");
  const project = { id: a.id as string, ...input, created: new Date().toISOString() };
  return { project, changes: {
    [projectFile(project.id)]: projectDoc(project),
    [projectMemoryFile(project.id)]: `# ${project.name} memory\n\n`,
    "memory/projects.md": projectIndex([...projects, project]),
  } };
}

export function memoryContext(text: string, max = 16000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[Memory truncated: ${text.length} characters total. Read the remaining project memory file in sections before relying on older rules.]`;
}
