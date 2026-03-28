import fs from "node:fs/promises";
import path from "node:path";
import {
  clampInteger,
  cleanSlug,
  cleanText,
  createId,
  getAspectRatioLabel,
  slugify,
  supportedGenerationSizeForCanvas
} from "./utils.js";

export function createProjectService({ projectsDir }) {
  return {
    ensureDirectories,
    normalizeProjectInput,
    mergeProject,
    summarizeProject,
    readProject,
    writeProject,
    getLatestProjectId,
    syncLayersFromPlan
  };

  async function ensureDirectories() {
    await fs.mkdir(projectsDir, { recursive: true });
  }

  function normalizeProjectInput(input) {
    const now = new Date().toISOString();
    const rawLayers = Array.isArray(input.layers) ? input.layers : parseLayerText(input.layerText || "");
    const layers = rawLayers.map((layer, index) => normalizeLayer(layer, index)).filter(Boolean);

    return {
      id: createId("project"),
      title: cleanText(input.title) || "Untitled NFT Collection",
      artDirection: cleanText(input.artDirection),
      collectionGoal: cleanText(input.collectionGoal),
      canvas: normalizeCanvas(input.canvas),
      layers,
      chatHistory: [],
      draftHistory: [],
      previewHistory: [],
      selectedPreviewId: null,
      previewPrompt: "",
      planSummary: "",
      styleGuide: "",
      createdAt: now,
      updatedAt: now
    };
  }

  function mergeProject(existing, input) {
    const merged = {
      ...existing,
      title: cleanText(input.title) || existing.title,
      artDirection: input.artDirection === undefined ? existing.artDirection : cleanText(input.artDirection),
      collectionGoal:
        input.collectionGoal === undefined ? existing.collectionGoal : cleanText(input.collectionGoal),
      canvas: input.canvas ? normalizeCanvas(input.canvas) : existing.canvas,
      chatHistory: Array.isArray(existing.chatHistory) ? existing.chatHistory : [],
      draftHistory: Array.isArray(existing.draftHistory) ? existing.draftHistory : [],
      updatedAt: new Date().toISOString()
    };

    if (Array.isArray(input.layers)) {
      merged.layers = input.layers.map((layer, index) => normalizeExistingLayer(layer, index)).filter(Boolean);
    } else if (typeof input.layerText === "string") {
      merged.layers = parseLayerText(input.layerText)
        .map((layer, index) => normalizeLayer(layer, index))
        .filter(Boolean);
    } else {
      merged.layers = (existing.layers || []).map((layer, index) => normalizeExistingLayer(layer, index));
    }

    if (input.selectedPreviewId !== undefined) {
      merged.selectedPreviewId = cleanText(input.selectedPreviewId) || null;
    }

    return merged;
  }

  function normalizeExistingLayer(layer, index) {
    const normalized = normalizeLayer(layer, index);
    if (!normalized) {
      return null;
    }

    return {
      ...normalized,
      description: cleanText(layer.description),
      placementNotes: cleanText(layer.placementNotes),
      variantIdeas: Array.isArray(layer.variantIdeas) ? layer.variantIdeas.map(cleanText).filter(Boolean) : [],
      variants: Array.isArray(layer.variants) ? layer.variants : [],
      selectedVariantId: cleanText(layer.selectedVariantId) || null
    };
  }

  function normalizeLayer(layer, index) {
    const name = cleanText(typeof layer === "string" ? layer : layer?.name);
    if (!name) {
      return null;
    }

    return {
      id: cleanSlug(typeof layer === "object" ? layer?.id : "") || `layer-${index + 1}-${slugify(name)}`,
      name,
      description: cleanText(typeof layer === "object" ? layer?.description : ""),
      placementNotes: cleanText(typeof layer === "object" ? layer?.placementNotes : ""),
      variantIdeas: Array.isArray(layer?.variantIdeas) ? layer.variantIdeas.map(cleanText).filter(Boolean) : [],
      variants: Array.isArray(layer?.variants) ? layer.variants : [],
      selectedVariantId: cleanText(typeof layer === "object" ? layer?.selectedVariantId : "") || null
    };
  }

  function normalizeCanvas(canvas) {
    const preset = cleanText(canvas?.preset) || cleanText(canvas?.size);
    const defaultWidth = preset === "1024x1536" ? 1024 : preset === "1536x1024" ? 1536 : 1024;
    const defaultHeight = preset === "1024x1536" ? 1536 : preset === "1536x1024" ? 1024 : 1024;
    const width = clampInteger(canvas?.width, defaultWidth, 256, 4096);
    const height = clampInteger(canvas?.height, defaultHeight, 256, 4096);

    return {
      width,
      height,
      aspect: getAspectRatioLabel(width, height),
      generationSize: supportedGenerationSizeForCanvas(width, height)
    };
  }

  function parseLayerText(layerText) {
    return String(layerText || "")
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function summarizeProject(project) {
    return {
      id: project.id,
      title: project.title,
      layerCount: project.layers.length,
      updatedAt: project.updatedAt,
      createdAt: project.createdAt
    };
  }

  async function readProject(projectId) {
    const filePath = path.join(projectsDir, `${projectId}.json`);
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  }

  async function writeProject(project) {
    const filePath = path.join(projectsDir, `${project.id}.json`);
    await fs.writeFile(filePath, `${JSON.stringify(project, null, 2)}\n`);
  }

  async function getLatestProjectId() {
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));

      if (!files.length) {
        return null;
      }

      const projects = await Promise.all(
        files.map(async (entry) => {
          const project = await readProject(path.basename(entry.name, ".json"));
          return summarizeProject(project);
        })
      );

      projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      return projects[0]?.id || null;
    } catch {
      return null;
    }
  }

  function syncLayersFromPlan(existingLayers, plannedLayers) {
    const existingMap = new Map(existingLayers.map((layer) => [layer.id, layer]));

    return plannedLayers.map((plannedLayer, index) => {
      const fallbackByName = existingLayers.find(
        (layer) => slugify(layer.name) === slugify(plannedLayer.name)
      );
      const current = existingMap.get(plannedLayer.id) || fallbackByName || existingLayers[index];

      return {
        id: current?.id || plannedLayer.id,
        name: current?.name || plannedLayer.name,
        description: plannedLayer.description || current?.description || "",
        placementNotes: plannedLayer.placementNotes || current?.placementNotes || "",
        variantIdeas: plannedLayer.variantIdeas || [],
        variants: current?.variants || [],
        selectedVariantId: current?.selectedVariantId || null
      };
    });
  }
}
