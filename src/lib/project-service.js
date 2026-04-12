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
      proposedLayers: [],
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
      selectedVariantId: cleanText(layer.selectedVariantId) || null,
      transform: typeof layer === "object" && layer?.transform ? layer.transform : null,
      fitContract: normalizeLayerFitContract(layer?.fitContract),
      structuralOpening: normalizeStructuralOpening(layer?.structuralOpening)
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
      selectedVariantId: cleanText(typeof layer === "object" ? layer?.selectedVariantId : "") || null,
      transform: typeof layer === "object" && layer?.transform ? layer.transform : null,
      fitContract: normalizeLayerFitContract(typeof layer === "object" ? layer?.fitContract : null),
      structuralOpening: normalizeStructuralOpening(typeof layer === "object" ? layer?.structuralOpening : null)
    };
  }

  function normalizeLayerFitContract(contract) {
    if (!contract || typeof contract !== "object") {
      return null;
    }

    const normalized = {
      profileId: cleanText(contract.profileId),
      profileLabel: cleanText(contract.profileLabel),
      scope: cleanText(contract.scope) || "anchor",
      anchorLayerId: cleanText(contract.anchorLayerId),
      anchorLayerName: cleanText(contract.anchorLayerName),
      anchorVariantId: cleanText(contract.anchorVariantId),
      anchorVariantName: cleanText(contract.anchorVariantName),
      referenceVariantId: cleanText(contract.referenceVariantId),
      referenceVariantName: cleanText(contract.referenceVariantName),
      targetWidthRatio: coerceNumber(contract.targetWidthRatio),
      targetHeightRatio: coerceNumber(contract.targetHeightRatio),
      targetCenterXOffsetRatio: coerceNumber(contract.targetCenterXOffsetRatio),
      targetCenterYRatio: coerceNumber(contract.targetCenterYRatio),
      targetTopRatio: coerceNumber(contract.targetTopRatio),
      targetBottomRatio: coerceNumber(contract.targetBottomRatio),
      canvasWidthRatio: coerceNumber(contract.canvasWidthRatio),
      canvasHeightRatio: coerceNumber(contract.canvasHeightRatio),
      canvasCenterXRatio: coerceNumber(contract.canvasCenterXRatio),
      canvasCenterYRatio: coerceNumber(contract.canvasCenterYRatio),
      canvasTopRatio: coerceNumber(contract.canvasTopRatio),
      canvasBottomRatio: coerceNumber(contract.canvasBottomRatio),
      depthMode: cleanText(contract.depthMode),
      clipStrategy: cleanText(contract.clipStrategy),
      backCutoff: coerceNumber(contract.backCutoff),
      frontStart: coerceNumber(contract.frontStart),
      summary: cleanText(contract.summary),
      updatedAt: cleanText(contract.updatedAt)
    };

    return Object.values(normalized).some((value) => value !== "" && value !== null) ? normalized : null;
  }

  function normalizeStructuralOpening(opening) {
    if (!opening || typeof opening !== "object") {
      return null;
    }

    const normalized = {
      shape: cleanText(opening.shape),
      widthRatio: coerceNumber(opening.widthRatio),
      heightRatio: coerceNumber(opening.heightRatio),
      centerXRatio: coerceNumber(opening.centerXRatio),
      centerYRatio: coerceNumber(opening.centerYRatio),
      placement: cleanText(opening.placement),
      description: cleanText(opening.description),
      interconnects: Array.isArray(opening.interconnects)
        ? opening.interconnects.map(cleanText).filter(Boolean)
        : []
    };

    return Object.values(normalized).some((value) =>
      value !== "" && value !== null && !(Array.isArray(value) && value.length === 0)
    ) ? normalized : null;
  }

  function coerceNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
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
        selectedVariantId: current?.selectedVariantId || null,
        transform: current?.transform || { x: 0, y: 0, scale: 1 },
        fitContract: current?.fitContract || null,
        region: plannedLayer.region || current?.region || null,
        stackOrder: plannedLayer.stackOrder != null ? plannedLayer.stackOrder : (current?.stackOrder != null ? current.stackOrder : index),
        previewGenerationPrompt: plannedLayer.previewGenerationPrompt || current?.previewGenerationPrompt || "",
        parentLayer: plannedLayer.parentLayer || current?.parentLayer || null,
        attachmentType: plannedLayer.attachmentType || current?.attachmentType || null,
        edgeRules: plannedLayer.edgeRules || current?.edgeRules || null,
        zOrderNote: plannedLayer.zOrderNote || current?.zOrderNote || null,
        interactionDescription: plannedLayer.interactionDescription || current?.interactionDescription || null
      };
    });
  }
}
