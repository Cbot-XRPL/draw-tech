import fs from "node:fs/promises";
import path from "node:path";
import { cleanText, createId } from "./utils.js";

export function createStudioMemoryService({ memoryDir }) {
  return {
    ensureDirectories,
    getMemory,
    writeMemory,
    updateMemory,
    appendChangelog,
    addLockedDecision
  };

  async function ensureDirectories() {
    await fs.mkdir(memoryDir, { recursive: true });
  }

  async function getMemory(project) {
    await ensureDirectories();
    const filePath = getFilePath(project.id);

    try {
      const raw = await fs.readFile(filePath, "utf8");
      return normalizeMemory(project, JSON.parse(raw));
    } catch {
      const memory = createDefaultMemory(project);
      await writeMemory(project.id, memory);
      return memory;
    }
  }

  async function writeMemory(projectId, memory) {
    const filePath = getFilePath(projectId);
    await fs.writeFile(filePath, `${JSON.stringify(memory, null, 2)}\n`);
  }

  async function updateMemory(project, updates) {
    const existing = await getMemory(project);
    const merged = normalizeMemory(project, {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString()
    });
    await writeMemory(project.id, merged);
    return merged;
  }

  async function appendChangelog(project, entry) {
    const memory = await getMemory(project);
    const changelogEntry = {
      id: createId("log"),
      type: cleanText(entry.type) || "note",
      title: cleanText(entry.title) || "Studio note",
      detail: cleanText(entry.detail),
      createdAt: new Date().toISOString()
    };

    memory.changelog.unshift(changelogEntry);
    memory.changelog = memory.changelog.slice(0, 30);
    memory.updatedAt = new Date().toISOString();
    await writeMemory(project.id, memory);
    return memory;
  }

  async function addLockedDecision(project, decision) {
    const memory = await getMemory(project);
    const entry = {
      id: createId("decision"),
      title: cleanText(decision.title) || "Locked decision",
      detail: cleanText(decision.detail),
      createdAt: new Date().toISOString()
    };

    memory.lockedDecisions.unshift(entry);
    memory.lockedDecisions = memory.lockedDecisions.slice(0, 20);
    memory.changelog.unshift({
      id: createId("log"),
      type: "approval",
      title: entry.title,
      detail: entry.detail,
      createdAt: entry.createdAt
    });
    memory.changelog = memory.changelog.slice(0, 30);
    memory.updatedAt = new Date().toISOString();
    await writeMemory(project.id, memory);
    return memory;
  }

  function getFilePath(projectId) {
    return path.join(memoryDir, `${projectId}.json`);
  }
}

function createDefaultMemory(project) {
  const now = new Date().toISOString();
  return normalizeMemory(project, {
    projectId: project.id,
    projectTitle: project.title,
    systemPrompt:
      "Keep the collection visually consistent, stack-friendly, and production-minded. Respect approved style decisions and avoid drifting from the established world.",
    userGuidance: "",
    contextSummary: "",
    styleRules: [],
    lockedDecisions: [],
    changelog: [],
    createdAt: now,
    updatedAt: now
  });
}

function normalizeMemory(project, memory) {
  return {
    projectId: project.id,
    projectTitle: cleanText(memory.projectTitle) || project.title,
    systemPrompt: cleanText(memory.systemPrompt),
    userGuidance: cleanText(memory.userGuidance),
    contextSummary: cleanText(memory.contextSummary),
    styleRules: Array.isArray(memory.styleRules)
      ? memory.styleRules.map((item) => cleanText(item)).filter(Boolean).slice(0, 12)
      : [],
    lockedDecisions: Array.isArray(memory.lockedDecisions)
      ? memory.lockedDecisions
          .map((item) => ({
            id: cleanText(item?.id) || createId("decision"),
            title: cleanText(item?.title),
            detail: cleanText(item?.detail),
            createdAt: cleanText(item?.createdAt) || new Date().toISOString()
          }))
          .filter((item) => item.title || item.detail)
          .slice(0, 20)
      : [],
    changelog: Array.isArray(memory.changelog)
      ? memory.changelog
          .map((item) => ({
            id: cleanText(item?.id) || createId("log"),
            type: cleanText(item?.type) || "note",
            title: cleanText(item?.title) || "Studio note",
            detail: cleanText(item?.detail),
            createdAt: cleanText(item?.createdAt) || new Date().toISOString()
          }))
          .slice(0, 30)
      : [],
    createdAt: cleanText(memory.createdAt) || new Date().toISOString(),
    updatedAt: cleanText(memory.updatedAt) || new Date().toISOString()
  };
}
