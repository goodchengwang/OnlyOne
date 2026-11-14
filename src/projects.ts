import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { P } from "./core";
import { createProjectFiles, getProject, listProjects, projectMemoryFile, memoryContext } from "../cloud/src/projects";
export { getProject, listProjects, projectMemoryFile };

export const projectStore = () => ({
  read: (path: string) => existsSync(P(path)) ? { path, text: readFileSync(P(path), "utf8"), updated: statSync(P(path)).mtime.toISOString() } : null,
  list: (_: string) => existsSync(P("projects")) ? readdirSync(P("projects"), { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => {
    const path = `projects/${e.name}/project.md`;
    return existsSync(P(path)) ? [{ path, text: readFileSync(P(path), "utf8"), updated: statSync(P(path)).mtime.toISOString() }] : [];
  }) : [],
});
export function createProject(a: unknown) {
  const r = createProjectFiles(projectStore(), a);
  if (typeof r === "string") return r;
  for (const [path, text] of Object.entries(r.changes)) { mkdirSync(dirname(P(path)), { recursive: true }); writeFileSync(P(path), text); }
  return r.project;
}
export function projectPrompt(id?: string): string {
  if (!id) return "";
  const project = getProject(projectStore(), id);
  if (!project) throw new Error(`Project ${id} is not registered`);
  const file = projectMemoryFile(id), memory = projectStore().read(file)?.text ?? "";
  return `# Current project\n${project.name} (${id})\nComputer: ${project.host}\nFolder: ${project.repo}\nOnly this project's memory applies. Keep project-specific facts and lessons in ${P(file)}, never in global or agent memory. Never register projects or edit project.md / memory/projects.md; only the owner's project dialog may do that.\n\n# Project memory\n${memoryContext(memory)}`;
}
