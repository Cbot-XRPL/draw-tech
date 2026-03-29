import fs from "node:fs/promises";
import path from "node:path";
import { cleanText, createId, safeJsonParse, slugify } from "./utils.js";

export function createStudioBrainService({ brainDir, toolManifestPath }) {
  return {
    ensureDirectories,
    getBrain,
    writeBrain,
    getToolManifest,
    recordSessionEvent,
    mergeAiReflection,
    reinforceBrain
  };

  async function ensureDirectories() {
    await fs.mkdir(brainDir, { recursive: true });
  }

  async function getBrain() {
    await ensureDirectories();

    try {
      const raw = await fs.readFile(getBrainPath(), "utf8");
      return normalizeBrain(safeJsonParse(raw));
    } catch {
      const brain = createDefaultBrain();
      await writeBrain(brain);
      return brain;
    }
  }

  async function writeBrain(brain) {
    await fs.writeFile(getBrainPath(), `${JSON.stringify(normalizeBrain(brain), null, 2)}\n`);
  }

  async function getToolManifest() {
    const raw = await fs.readFile(toolManifestPath, "utf8");
    return normalizeToolManifest(safeJsonParse(raw));
  }

  async function recordSessionEvent(project, event) {
    const brain = await getBrain();
    const note = {
      id: createId("session"),
      projectId: cleanText(project?.id),
      projectTitle: cleanText(project?.title),
      type: cleanText(event?.type) || "session",
      prompt: cleanText(event?.prompt),
      layerName: cleanText(event?.layerName),
      summary: cleanText(event?.summary),
      analysis: normalizeAnalysis(event?.analysis),
      createdAt: new Date().toISOString()
    };

    brain.sessionNotes.unshift(note);
    brain.sessionNotes = brain.sessionNotes.slice(0, 60);
    brain.recentProjects = [
      {
        projectId: cleanText(project?.id),
        projectTitle: cleanText(project?.title),
        updatedAt: note.createdAt
      },
      ...brain.recentProjects.filter((item) => item.projectId !== project?.id)
    ].slice(0, 16);
    brain.updatedAt = note.createdAt;
    await writeBrain(brain);
    return brain;
  }

  async function mergeAiReflection(reflection) {
    const brain = await getBrain();
    const merged = normalizeBrain({
      ...brain,
      crossProjectSummary: cleanText(reflection?.crossProjectSummary) || brain.crossProjectSummary,
      qualityRules: mergeStringLists(brain.qualityRules, reflection?.qualityRules, 18),
      drawingLessons: mergeLessons(brain.drawingLessons, reflection?.drawingLessons),
      updatedAt: new Date().toISOString()
    });

    await writeBrain(merged);
    return merged;
  }

  async function reinforceBrain(reinforcement) {
    const brain = await getBrain();
    const merged = normalizeBrain({
      ...brain,
      qualityRules: mergeStringLists(brain.qualityRules, reinforcement?.qualityRules, 18),
      drawingLessons: mergeLessons(brain.drawingLessons, reinforcement?.drawingLessons),
      updatedAt: new Date().toISOString()
    });

    await writeBrain(merged);
    return merged;
  }

  function getBrainPath() {
    return path.join(brainDir, "studio-brain.json");
  }
}

function createDefaultBrain() {
  const now = new Date().toISOString();
  return normalizeBrain({
    systemPrompt:
      "Carry lessons forward across projects. Protect layer clarity, stack alignment, silhouette readability, and production-ready trait variety.",
    crossProjectSummary: "",
    qualityRules: [
      "Keep every layer isolated and stack-friendly.",
      "Preserve a consistent camera angle and proportion system.",
      "Prefer readable silhouettes over noisy detail.",
      "When making new variants, create a meaningful change instead of a near-duplicate."
    ],
    drawingLessons: [],
    sessionNotes: [],
    recentProjects: [],
    createdAt: now,
    updatedAt: now
  });
}

function normalizeBrain(brain) {
  return {
    systemPrompt: cleanText(brain?.systemPrompt),
    crossProjectSummary: cleanText(brain?.crossProjectSummary),
    qualityRules: normalizeStringList(brain?.qualityRules, 18),
    drawingLessons: normalizeLessons(brain?.drawingLessons),
    sessionNotes: Array.isArray(brain?.sessionNotes)
      ? brain.sessionNotes
          .map((item) => ({
            id: cleanText(item?.id) || createId("session"),
            projectId: cleanText(item?.projectId),
            projectTitle: cleanText(item?.projectTitle),
            type: cleanText(item?.type) || "session",
            prompt: cleanText(item?.prompt),
            layerName: cleanText(item?.layerName),
            summary: cleanText(item?.summary),
            analysis: normalizeAnalysis(item?.analysis),
            createdAt: cleanText(item?.createdAt) || new Date().toISOString()
          }))
          .slice(0, 60)
      : [],
    recentProjects: Array.isArray(brain?.recentProjects)
      ? brain.recentProjects
          .map((item) => ({
            projectId: cleanText(item?.projectId),
            projectTitle: cleanText(item?.projectTitle),
            updatedAt: cleanText(item?.updatedAt) || new Date().toISOString()
          }))
          .filter((item) => item.projectId)
          .slice(0, 16)
      : [],
    createdAt: cleanText(brain?.createdAt) || new Date().toISOString(),
    updatedAt: cleanText(brain?.updatedAt) || new Date().toISOString()
  };
}

function normalizeToolManifest(manifest) {
  return {
    version: Number(manifest?.version || 1),
    name: cleanText(manifest?.name) || "draw-tech-studio-tools",
    systemGuidance: cleanText(manifest?.systemGuidance),
    packages: Array.isArray(manifest?.packages)
      ? manifest.packages
          .map((item) => ({
            id: cleanText(item?.id),
            label: cleanText(item?.label),
            purpose: cleanText(item?.purpose)
          }))
          .filter((item) => item.id)
      : [],
    capabilities: Array.isArray(manifest?.capabilities)
      ? manifest.capabilities
          .map((item) => ({
            id: cleanText(item?.id),
            name: cleanText(item?.name),
            packages: normalizeStringList(item?.packages, 8),
            useWhen: normalizeStringList(item?.useWhen, 8)
          }))
          .filter((item) => item.id)
      : [],
    fitProfiles: Array.isArray(manifest?.fitProfiles)
      ? manifest.fitProfiles
          .map((item) => ({
            id: cleanText(item?.id),
            label: cleanText(item?.label),
            layerKeywords: normalizeStringList(item?.layerKeywords, 16),
            anchorRegion: cleanText(item?.anchorRegion),
            clipStrategy: cleanText(item?.clipStrategy),
            guidance: cleanText(item?.guidance),
            defaultTransform: item?.defaultTransform || null
          }))
          .filter((item) => item.id)
      : []
  };
}

function normalizeLessons(lessons) {
  return Array.isArray(lessons)
    ? lessons
        .map((item) => ({
          id: cleanText(item?.id) || createId("lesson"),
          title: cleanText(item?.title),
          detail: cleanText(item?.detail),
          tags: normalizeStringList(item?.tags, 8),
          sourceProjectId: cleanText(item?.sourceProjectId),
          sourceProjectTitle: cleanText(item?.sourceProjectTitle),
          createdAt: cleanText(item?.createdAt) || new Date().toISOString()
        }))
        .filter((item) => item.title || item.detail)
        .slice(0, 40)
    : [];
}

function normalizeStringList(values, limit) {
  return Array.isArray(values)
    ? [...new Set(values.map((item) => cleanText(item)).filter(Boolean))].slice(0, limit)
    : [];
}

function mergeStringLists(existing, incoming, limit) {
  return [
    ...normalizeStringList(incoming, limit),
    ...normalizeStringList(existing, limit)
  ].filter((item, index, list) => list.indexOf(item) === index).slice(0, limit);
}

function mergeLessons(existing, incoming) {
  const normalizedIncoming = normalizeLessons(incoming);
  const normalizedExisting = normalizeLessons(existing);
  const seen = new Set();
  const merged = [];

  for (const lesson of [...normalizedIncoming, ...normalizedExisting]) {
    const key = slugify(`${lesson.title}-${lesson.detail}`) || lesson.id;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(lesson);
  }

  return merged.slice(0, 40);
}

function normalizeAnalysis(analysis) {
  if (!analysis || typeof analysis !== "object") {
    return null;
  }

  return {
    width: Number(analysis.width || 0),
    height: Number(analysis.height || 0),
    alphaCoverage: Number(analysis.alphaCoverage || 0),
    touchesEdge: Boolean(analysis.touchesEdge),
    possibleDuplicate: Boolean(analysis.possibleDuplicate),
    strongestMatchName: cleanText(analysis.strongestMatchName),
    strongestSimilarity: Number(analysis.strongestSimilarity || 0)
  };
}
