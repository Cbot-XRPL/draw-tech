import express from "express";
import archiver from "archiver";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import sharp from "sharp";
import { createOpenAIService } from "./lib/openai-service.js";
import { createProjectService } from "./lib/project-service.js";
import { createAssetToolService } from "./lib/asset-tool-service.js";
import { createStudioBrainService } from "./lib/studio-brain-service.js";
import { createStudioMemoryService } from "./lib/studio-memory-service.js";
import { clampVariantCount, cleanText, createId, loadEnvFile, safeJsonParse, sanitizeFileName, slugify } from "./lib/utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const projectsDir = path.join(dataDir, "projects");
const generatedDir = path.join(dataDir, "generated");
const memoryDir = path.join(dataDir, "memory");
const brainDir = path.join(dataDir, "brain");
const uploadsDir = path.join(dataDir, "uploads");
const toolManifestPath = path.join(rootDir, "src", "config", "creative-tool-manifest.json");

loadEnvFile(path.join(rootDir, ".env"), readFileSync);

const projectService = createProjectService({ projectsDir });
const studioMemoryService = createStudioMemoryService({ memoryDir });
const studioBrainService = createStudioBrainService({ brainDir, toolManifestPath });
const openaiService = createOpenAIService();
const assetToolService = createAssetToolService();
const layerFitProfiles = loadLayerFitProfiles();

const app = express();
const runtimeState = {
  sessionApiKey: ""
};

const DURABLE_STUDIO_QUALITY_RULES = [
  "When the preview is shown in the app, prefer one backend-composited preview image over multiple competing client-side render paths.",
  "A layer should only appear on preview when its checkbox-style toggle is actively selected.",
  "When simplifying the preview UI, keep frontend DOM ids and frontend render code in sync so stale references do not break painting.",
  "When editing an existing layer image, preserve the source drawing and change only the requested feature unless the user explicitly asks for a redraw.",
  "Every synced layer folder should keep one approved family fit contract so swapping variants preserves the same seat, overlap, clipping, and stack quality."
];

const DURABLE_STUDIO_LESSONS = [
  {
    title: "Keep preview rendering single-path",
    detail:
      "When the app preview fails or shows only a stray pixel, collapse to one preview image fed by the server composite instead of mixing canvas, stacked img tags, and stale DOM hooks.",
    tags: ["preview", "rendering", "frontend", "composite"]
  },
  {
    title: "Treat layer visibility as a real toggle",
    detail:
      "Checked means the layer is on preview, unchecked means it is off. The preview should follow that state exactly so users can test stack combinations freely.",
    tags: ["preview", "layers", "selection", "ux"]
  },
  {
    title: "Match chat-selected assets to the intended subject",
    detail:
      "When committing from chat history into a folder, prefer the actual subject named by the user instead of matching accessory notes that merely mention that subject.",
    tags: ["chat", "routing", "asset-selection", "layers"]
  },
  {
    title: "Edits should preserve the base drawing",
    detail:
      "When the user asks to remove or tweak one feature on an existing layer image, use the current selected asset as the source and preserve the pose, style, proportions, and composition instead of redrawing the whole character.",
    tags: ["editing", "layers", "consistency", "source-preservation"]
  },
  {
    title: "Folder variants need one shared fit contract",
    detail:
      "When one crown, glasses, or other synced trait sits correctly, capture that seat, overlap, and clipping pattern as the family contract for the whole folder so future variants stay interchangeable.",
    tags: ["layers", "fit", "consistency", "variants", "stacking"]
  }
];

process.on("unhandledRejection", (error) => {
  console.error("[draw-tech] Unhandled rejection");
  console.error(error);
});

process.on("uncaughtException", (error) => {
  console.error("[draw-tech] Uncaught exception");
  console.error(error);
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadsDir),
    filename: (_req, file, callback) => {
      const id = createId("upload");
      const ext = path.extname(file.originalname || "") || ".png";
      callback(null, `${id}${ext}`);
    }
  }),
  limits: {
    files: 6,
    fileSize: 12 * 1024 * 1024
  }
});

app.use(express.json({ limit: "2mb" }));
app.use("/generated", express.static(generatedDir));
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(publicDir));

app.get("/api/config", async (_req, res) => {
  await ensureDirectories();
  res.json({
    hasEnvKey: Boolean(process.env.OPENAI_API_KEY),
    hasSessionKey: Boolean(runtimeState.sessionApiKey),
    defaultProjectId: await projectService.getLatestProjectId()
  });
});

app.post("/api/session", (req, res) => {
  runtimeState.sessionApiKey = String(req.body?.apiKey || "").trim();
  res.json({
    ok: true,
    hasSessionKey: Boolean(runtimeState.sessionApiKey)
  });
});

app.post("/api/uploads", upload.array("images", 6), async (req, res, next) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    const attachments = [];

    for (const file of files) {
      const id = path.basename(file.filename, path.extname(file.filename));
      const buffer = await fs.readFile(file.path);
      const analysis = await assetToolService.inspectAttachmentBuffer(buffer);
      const meta = {
        id,
        name: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        width: analysis.width,
        height: analysis.height,
        imageUrl: `/uploads/${file.filename}`,
        fileName: file.filename
      };
      await fs.writeFile(path.join(uploadsDir, `${id}.json`), `${JSON.stringify(meta, null, 2)}\n`);
      attachments.push(meta);
    }

    res.json({ attachments });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects", async (_req, res, next) => {
  try {
    await ensureDirectories();
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const project = await projectService.readProject(path.basename(entry.name, ".json"));
      projects.push(projectService.summarizeProject(project));
    }

    projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json({ projects });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects", async (req, res, next) => {
  try {
    await ensureDirectories();
    const project = projectService.normalizeProjectInput(req.body || {});
    await projectService.writeProject(project);
    const memory = await studioMemoryService.getMemory(project);
    res.status(201).json({ project, memory });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const memory = await studioMemoryService.getMemory(project);
    res.json({ project, memory });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/fit-debug", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    res.json(buildFitDebugData(project));
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:projectId", async (req, res, next) => {
  try {
    const existing = await projectService.readProject(req.params.projectId);
    const project = projectService.mergeProject(existing, req.body || {});
    await projectService.writeProject(project);
    const memory = await studioMemoryService.getMemory(project);
    res.json({ project, memory });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:projectId", async (req, res, next) => {
  try {
    const projectId = req.params.projectId;
    const filePath = path.join(projectsDir, `${projectId}.json`);
    await fs.unlink(filePath).catch(() => {});
    const memoryPath = path.join(memoryDir, `${projectId}.json`);
    await fs.unlink(memoryPath).catch(() => {});
    res.json({ ok: true, deletedId: projectId });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/reset-positions", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    hydrateProjectLayerFitContracts(project);
    const canvas = project.canvas || { width: 1024, height: 1024 };

    for (const layer of project.layers) {
      const transform = await computeLayerTransformFromContent(layer, canvas);
      layer.transform = transform;
      for (const variant of layer.variants || []) {
        if (variant.customTransform) delete variant.customTransform;
      }
    }

    const sortedLayers = sortLayersByType(project.layers);
    project.layers = sortedLayers;
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    res.json({ project });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/layers/:layerId/reset-position", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    hydrateProjectLayerFitContracts(project);
    const layer = project.layers.find((item) => item.id === req.params.layerId);
    if (!layer) { res.status(404).json({ error: "Layer not found." }); return; }
    const canvas = project.canvas || { width: 1024, height: 1024 };
    layer.transform = await computeLayerTransformFromContent(layer, canvas);
    for (const variant of layer.variants || []) {
      if (variant.customTransform) delete variant.customTransform;
    }
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    res.json({ project, layer });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/layers/:layerId/upload-variant", upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) { res.status(400).json({ error: "No image file provided." }); return; }
    const project = await projectService.readProject(req.params.projectId);
    const layer = project.layers.find((item) => item.id === req.params.layerId);
    if (!layer) { res.status(404).json({ error: "Layer not found." }); return; }

    const variantId = createId("variant");
    const variantFolder = path.join(generatedDir, project.id, "layers", layer.id);
    await fs.mkdir(variantFolder, { recursive: true });
    const filename = `${variantId}.png`;
    const buffer = await sharp(req.file.buffer).png().toBuffer();
    const resized = await resizePng(buffer, project.canvas);
    await fs.writeFile(path.join(variantFolder, filename), resized);

    const variantName = cleanText(req.body?.name) || req.file.originalname?.replace(/\.[^.]+$/, "") || "Uploaded Variant";
    const variant = {
      id: variantId,
      name: variantName,
      notes: "Manually uploaded",
      prompt: "",
      imageUrl: `/generated/${project.id}/layers/${layer.id}/${filename}`,
      rarityWeight: 50,
      createdAt: new Date().toISOString()
    };
    layer.variants.push(variant);
    if (!layer.selectedVariantId) layer.selectedVariantId = variantId;
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    res.json({ project, layer, variant });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/rebuild-layers-from-preview", async (req, res, next) => {
  try {
    const apiKey = getApiKey();
    const project = await projectService.readProject(req.params.projectId);
    const previewId = cleanText(req.body?.previewId) || project.selectedPreviewId;
    const preview = (project.previewHistory || []).find((p) => p.id === previewId);

    if (!preview) {
      res.status(404).json({ error: "Preview not found." });
      return;
    }

    project.selectedPreviewId = previewId;
    project.previewPrompt = preview.prompt || project.previewPrompt;

    let memory = await studioMemoryService.getMemory(project);
    const brain = await studioBrainService.getBrain();
    const toolManifest = await studioBrainService.getToolManifest();
    const plan = await openaiService.createPreviewPlan(apiKey, project, memory, brain, toolManifest, []);

    project.planSummary = plan.collectionSummary;
    project.styleGuide = plan.styleGuide;

    // Prefer existing project layers as the starting point so we don't lose
    // layers the user already has (e.g. Background Accent) or invent spurious
    // ones (e.g. Ground Shadow). Only fall back to the AI plan when the project
    // has no layers yet.
    const existingLayers = Array.isArray(project.layers) ? project.layers.filter((l) => l.name) : [];
    const proposedLayers = existingLayers.length > 0
      ? existingLayers.map((layer) => ({
          id: layer.id,
          name: layer.name,
          description: layer.description || "",
          placementNotes: layer.placementNotes || "",
          variantIdeas: Array.isArray(layer.variantIdeas) ? layer.variantIdeas : [],
          transform: layer.transform,
          fitContract: layer.fitContract,
          previewGenerationPrompt: layer.previewGenerationPrompt || "",
          region: layer.region || null,
          stackOrder: layer.stackOrder,
          attachmentType: layer.attachmentType || null,
          edgeRules: layer.edgeRules || null,
          parentLayer: layer.parentLayer || null,
          zOrderNote: layer.zOrderNote || null,
          interactionDescription: layer.interactionDescription || null
        }))
      : plan.layers.map((layer, index) => ({
          id: layer.id || `layer-${index + 1}`,
          name: cleanText(layer.name) || `Layer ${index + 1}`,
          description: cleanText(layer.description),
          placementNotes: cleanText(layer.placementNotes),
          variantIdeas: Array.isArray(layer.variantIdeas) ? layer.variantIdeas : []
        }));

    // Run layer map + detailed prompt analysis on the preview
    try {
      const previewAbsPath = publicAssetUrlToAbsolutePath(preview.imageUrl);
      const previewBuffer = await fs.readFile(previewAbsPath);
      const previewDataUrl = `data:image/png;base64,${previewBuffer.toString("base64")}`;

      // Fuzzy layer name matching — GPT sometimes returns slightly different names
      // (e.g. "Door" vs "Vault Door"). Try exact match first, then slug match,
      // then substring containment, then positional fallback.
      const findLayerMatch = (name, index) => {
        const target = cleanText(name).toLowerCase();
        const targetSlug = slugify(name);
        return proposedLayers.find((l) => cleanText(l.name).toLowerCase() === target)
          || proposedLayers.find((l) => slugify(l.name) === targetSlug)
          || proposedLayers.find((l) => target.includes(cleanText(l.name).toLowerCase()) || cleanText(l.name).toLowerCase().includes(target))
          || (Number.isFinite(index) ? proposedLayers[index] : null);
      };

      const layerMap = await openaiService.createLayerMap(apiKey, previewDataUrl, proposedLayers, project.canvas);
      for (let mi = 0; mi < layerMap.length; mi++) {
        const mapped = layerMap[mi];
        const match = findLayerMatch(mapped.name, mi);
        if (match) {
          match.region = mapped.region;
          match.stackOrder = mapped.stackOrder;
        } else if (mapped.isNew && mapped.name && !existingLayers.length) {
          // Only add new layers when building from scratch (no existing layers).
          // When rebuilding with existing layers, the user's layer list is the
          // source of truth — don't add AI-hallucinated extras.
          proposedLayers.push({
            id: `layer-${proposedLayers.length + 1}-${slugify(mapped.name)}`,
            name: mapped.name,
            description: mapped.description || "",
            placementNotes: "",
            variantIdeas: [],
            region: mapped.region,
            stackOrder: mapped.stackOrder
          });
        }
      }
      proposedLayers.sort((a, b) => (a.stackOrder || 0) - (b.stackOrder || 0));

      const relationships = await openaiService.createLayerRelationships(apiKey, previewDataUrl, proposedLayers, project.canvas);
      for (let ri = 0; ri < relationships.length; ri++) {
        const rel = relationships[ri];
        const match = findLayerMatch(rel.name, ri);
        if (match) {
          match.parentLayer = rel.parentLayer;
          match.attachmentType = rel.attachmentType;
          match.edgeRules = rel.edgeRules;
          match.zOrderNote = rel.zOrderNote;
          match.interactionDescription = rel.interactionDescription;
        }
      }

      const detailedPrompts = await openaiService.analyzePreviewForLayerPrompts(apiKey, previewDataUrl, proposedLayers, project.canvas);
      for (let di = 0; di < detailedPrompts.length; di++) {
        const dp = detailedPrompts[di];
        const match = findLayerMatch(dp.name, di);
        if (match && dp.generationPrompt) {
          const relContext = match.interactionDescription
            ? ` SPATIAL RELATIONSHIP: ${match.interactionDescription}${match.parentLayer ? ` This element attaches to ${match.parentLayer} via ${match.attachmentType}.` : ""}${match.zOrderNote ? ` Z-order: ${match.zOrderNote}.` : ""}`
            : "";
          match.previewGenerationPrompt = dp.generationPrompt + relContext;
        }
      }
    } catch (analysisError) {
      console.warn("[rebuild] Could not analyze preview:", analysisError.message);
    }

    const proposeOnly = Boolean(req.body?.proposeOnly);
    if (proposeOnly) {
      project.proposedLayers = proposedLayers;
    } else {
      project.layers = projectService.syncLayersFromPlan(project.layers, proposedLayers);
      project.proposedLayers = [];
    }
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);

    memory = await studioMemoryService.appendChangelog(project, {
      type: proposeOnly ? "propose-layers" : "rebuild-layers",
      title: proposeOnly ? "Proposed layers from preview" : "Rebuilt layers from preview",
      detail: `${proposeOnly ? "Proposed" : "Synced"} ${proposedLayers.length} layers from ${preview.name || previewId}.`
    });

    res.json({ project, memory, layerCount: proposedLayers.length });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/approve-plan", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const proposed = Array.isArray(project.proposedLayers) ? project.proposedLayers : [];

    if (!proposed.length) {
      res.status(400).json({ error: "No proposed layers to approve." });
      return;
    }

    project.layers = projectService.syncLayersFromPlan(project.layers, proposed);
    project.proposedLayers = [];
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    const memory = await studioMemoryService.appendChangelog(project, {
      type: "approve-plan",
      title: "Approved layer plan",
      detail: `Created ${project.layers.length} layer folders from proposed plan.`
    });
    res.json({ project, memory });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/lock-style", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const styleGuide = cleanText(req.body?.styleGuide) || project.styleGuide;
    if (!styleGuide) { res.status(400).json({ error: "No style guide to lock." }); return; }
    project.lockedStyleGuide = styleGuide;
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    const memory = await studioMemoryService.appendChangelog(project, {
      type: "style-lock",
      title: "Locked style guide",
      detail: styleGuide
    });
    res.json({ project, memory });
  } catch (error) {
    next(error);
  }
});

app.post("/api/chat", async (req, res, next) => {
  try {
    const apiKey = getApiKey();
    const promptText = cleanText(req.body?.prompt);
    const attachments = await resolveAttachments(req.body?.attachmentIds);
    if (!promptText) {
      res.status(400).json({ error: "Write a prompt first." });
      return;
    }

    let project;
    if (cleanText(req.body?.projectId)) {
      const existing = await projectService.readProject(req.body.projectId);
      project = projectService.mergeProject(existing, {
        canvas: req.body?.canvas || existing.canvas
      });
    } else {
      project = projectService.normalizeProjectInput({
        title: "Draw Tech Session",
        artDirection: promptText,
        collectionGoal: "Layered NFT build session",
        canvas: req.body?.canvas,
        layers: []
      });
    }

    project.chatHistory = Array.isArray(project.chatHistory) ? project.chatHistory : [];
    project.draftHistory = Array.isArray(project.draftHistory) ? project.draftHistory : [];
    hydrateProjectLayerFitContracts(project);
    const contextualAttachments = await extendAttachmentsWithChatContext(project, promptText, attachments);
    let memory = await studioMemoryService.getMemory(project);
    const brain = await studioBrainService.getBrain();
    const toolManifest = await studioBrainService.getToolManifest();
    const route = await openaiService.routeUserPrompt(
      apiKey,
      project,
      memory,
      brain,
      toolManifest,
      promptText,
      contextualAttachments
    );

    let assistantReply = route.assistantReply || "Working on that now.";
    let action = route.actionType;
    let assistantGenerated = null;

    const hasProposedOnly = Array.isArray(project.proposedLayers) && project.proposedLayers.length > 0;
    if (hasProposedOnly && ["edit_layer_variant", "transform_layer_variant", "draft_variant", "add_variant", "commit_draft"].includes(action)) {
      action = "preview";
      assistantReply = "The layers are still proposed — approve the plan first to create the folders and draw the layers. I'll regenerate the preview with your feedback.";
    }

    const forcedFreshDraft = shouldForceFreshTraitDraft(project, promptText, route);
    const freshDraftTargetLayerName = forcedFreshDraft ? resolveDraftTargetLayerName(project, promptText, route) : "";
    const forcedLayerEdit = forcedFreshDraft ? null : resolveLayerEditTarget(project, promptText, route);
    const forcedLayerTransform = forcedFreshDraft ? null : resolveLayerTransformTarget(project, promptText, route);
    if (forcedFreshDraft) {
      action = "draft_variant";
      const freshDraftLabel =
        cleanText(route.variantNameHint) ||
        extractFreshTraitName(promptText) ||
        guessLayerNameFromPrompt(promptText) ||
        "that trait";
      assistantReply =
        `I'll draft ${cleanText(freshDraftLabel)} for review without touching the existing layer.`;
    } else if (forcedLayerTransform) {
      action = "transform_layer_variant";
      if (cleanText(route.actionType).toLowerCase() !== "transform_layer_variant") {
        assistantReply =
          `I'll refit the existing ${forcedLayerTransform.layer.name} layer on the stack without redrawing the asset.`;
      }
    } else if (forcedLayerEdit) {
      action = "edit_layer_variant";
    }
    const forcedPureTraitRestoreTarget =
      forcedLayerEdit?.layer || forcedLayerTransform?.layer || findLikelyLayerForEdit(project, promptText) || null;
    const forcedFrontOnlyHeadwearTarget =
      forcedPureTraitRestoreTarget && shouldUseFrontOnlyHeadwearTrait(forcedPureTraitRestoreTarget, promptText)
        ? forcedPureTraitRestoreTarget
        : null;
    const forcedPureTraitRebuildTarget =
      forcedPureTraitRestoreTarget &&
      shouldRebuildPureTraitAsset(
        forcedPureTraitRestoreTarget,
        promptText,
        route.removalTarget || forcedLayerEdit?.removalTarget
      )
        ? forcedPureTraitRestoreTarget
        : null;

    if (action === "remove_layer") {
      const layer = findLayer(project, route.targetLayerName || route.removalTarget);
      if (!layer) {
        assistantReply = "I could not find that layer to remove.";
      } else {
        project.layers = project.layers.filter((item) => item.id !== layer.id);
        project.updatedAt = new Date().toISOString();
        await projectService.writeProject(project);
        memory = await studioMemoryService.appendChangelog(project, {
          type: "remove-layer",
          title: `Removed ${layer.name}`,
          detail: promptText
        });
      }
    } else if (action === "remove_variant") {
      const layer = findLayer(project, route.targetLayerName || route.removalTarget);
      const removed = layer ? removeVariantFromLayer(layer, route.variantNameHint || route.removalTarget) : null;
      if (!layer || !removed) {
        assistantReply = "I could not find that layer image to remove.";
      } else {
        if (layer.selectedVariantId === removed.id) {
          layer.selectedVariantId = layer.variants[0]?.id || null;
        }
        project.updatedAt = new Date().toISOString();
        await projectService.writeProject(project);
        memory = await studioMemoryService.appendChangelog(project, {
          type: "remove-variant",
          title: `Removed ${removed.name}`,
          detail: `Layer: ${layer.name}`
        });
      }
    } else if (action === "draft_variant" || action === "add_variant") {
      const draftResult = await generateDraftForProject(project, apiKey, {
        promptText,
        targetLayerName: freshDraftTargetLayerName || resolveDraftTargetLayerName(project, promptText, route),
        extraDirection: route.variantDirection,
        attachments: contextualAttachments
      });
      project = draftResult.project;
      memory = draftResult.memory;
      assistantGenerated = toAssistantGeneratedImage(draftResult.draft);
    } else if (forcedFrontOnlyHeadwearTarget) {
      const frontOnlyResult = await rebuildHeadwearAsFrontTrait(project, forcedFrontOnlyHeadwearTarget, {
        promptText
      });
      project = frontOnlyResult.project;
      memory = frontOnlyResult.memory;
      assistantGenerated = toAssistantGeneratedImage(frontOnlyResult.variant);
      assistantReply =
        route.assistantReply ||
        `I rebuilt ${frontOnlyResult.layer.name} as a front-only trait so it sits on the anchor cleanly without the rear hoop showing.`;
    } else if (forcedPureTraitRebuildTarget) {
      const rebuildResult = await regenerateAccessoryLayerAsPureTrait(project, apiKey, forcedPureTraitRebuildTarget, {
        promptText,
        extraDirection: route.variantDirection
      });
      project = rebuildResult.project;
      memory = rebuildResult.memory;
      assistantGenerated = toAssistantGeneratedImage(rebuildResult.variant);
      if (isLayerTransformPrompt(promptText)) {
        const transformResult = await updateLayerVariantTransform(project, rebuildResult.layer, {
          promptText,
          extraDirection: route.variantDirection
        });
        project = transformResult.project;
        memory = transformResult.memory;
      }
      assistantReply =
        route.assistantReply ||
        `I rebuilt ${rebuildResult.layer.name} as a clean isolated trait asset and refit it on the stack.`;
    } else if (
      forcedPureTraitRestoreTarget &&
      shouldForcePureTraitRestore(forcedPureTraitRestoreTarget, promptText, route.removalTarget || forcedLayerEdit?.removalTarget)
    ) {
      const sanitizeResult = await sanitizeAccessoryLayerToPureTrait(project, forcedPureTraitRestoreTarget, {
        promptText
      });
      project = sanitizeResult.project;
      memory = sanitizeResult.memory;
      if (isLayerTransformPrompt(promptText)) {
        const transformResult = await updateLayerVariantTransform(project, sanitizeResult.layer, {
          promptText,
          extraDirection: route.variantDirection
        });
        project = transformResult.project;
        memory = transformResult.memory;
      }
      assistantReply =
        route.assistantReply ||
        `I restored ${sanitizeResult.layer.name} to the last clean trait-only asset from history and removed the contaminated variant from the live layer.`;
    } else if (action === "transform_layer_variant") {
      const transformTarget =
        forcedLayerTransform || resolveLayerTransformTarget(project, promptText, route);
      if (!transformTarget) {
        assistantReply = "I could not figure out which layer transform to update.";
      } else if (
        (!Array.isArray(transformTarget.layer?.variants) || transformTarget.layer.variants.length === 0) &&
        shouldForceFreshTraitDraft(project, promptText, {
          ...route,
          targetLayerName: transformTarget.layer.name,
          actionType: "draft_variant"
        })
      ) {
        const draftResult = await generateDraftForProject(project, apiKey, {
          promptText,
          targetLayerName: transformTarget.layer.name,
          extraDirection: route.variantDirection,
          attachments: contextualAttachments
        });
        project = draftResult.project;
        memory = draftResult.memory;
        assistantGenerated = toAssistantGeneratedImage(draftResult.draft);
        assistantReply =
          route.assistantReply ||
          `I'll draft a new ${transformTarget.layer.name} asset for review instead of trying to reposition an empty layer.`;
      } else {
        const cleanRestoreRequest = shouldRestoreAccessoryLayerFromCleanSource(
          transformTarget.layer,
          promptText,
          route.removalTarget
        );
        if (cleanRestoreRequest) {
          const restoreResult = await restoreLayerVariantFromHistory(project, transformTarget.layer, `${promptText} restore original clean`);
          if (restoreResult?.variant) {
            project = restoreResult.project;
            memory = restoreResult.memory;
            transformTarget.layer = restoreResult.layer;
            pruneContaminatedSelectedVariants(transformTarget.layer, restoreResult.variant.id);
            project.updatedAt = new Date().toISOString();
            await projectService.writeProject(project);
          }
        }
        if (shouldRestoreLayerBeforeTransform(promptText)) {
          const restoreResult = await restoreLayerVariantFromHistory(project, transformTarget.layer, promptText);
          if (restoreResult?.variant) {
            project = restoreResult.project;
            memory = restoreResult.memory;
            transformTarget.layer = restoreResult.layer;
          }
        }
        const deterministicLayerFit = shouldUseDeterministicLayerFitEdit(transformTarget.layer, promptText);
        if (deterministicLayerFit) {
          const wrapResult = await applyDeterministicLayerVisualAdjustments(project, transformTarget.layer, {
            promptText
          });
          project = wrapResult.project;
          memory = wrapResult.memory;
          transformTarget.layer = wrapResult.layer;
        } else if (!cleanRestoreRequest && shouldAlsoVisuallyEditLayer(promptText)) {
          const editResult = await reviseLayerVariantForProject(project, apiKey, {
            layer: transformTarget.layer,
            promptText,
            extraDirection: route.variantDirection,
            attachments: contextualAttachments
          });
          project = editResult.project;
          memory = editResult.memory;
          transformTarget.layer = editResult.layer;
          assistantGenerated = toAssistantGeneratedImage(editResult.variant);
        }
        const transformResult = await updateLayerVariantTransform(project, transformTarget.layer, {
          promptText,
          extraDirection: route.variantDirection
        });
        project = transformResult.project;
        memory = transformResult.memory;
        assistantReply =
          route.assistantReply ||
          `I updated ${transformResult.layer.name} placement on the stack without redrawing the asset.`;
      }
    } else if (action === "edit_layer_variant") {
      const editTarget =
        forcedLayerEdit || resolveLayerEditTarget(project, promptText, route);
      if (!editTarget) {
        assistantReply = "I could not figure out which layer image to revise.";
      } else if (
        (!Array.isArray(editTarget.layer?.variants) || editTarget.layer.variants.length === 0) &&
        shouldForceFreshTraitDraft(project, promptText, {
          ...route,
          targetLayerName: editTarget.layer.name,
          actionType: "draft_variant"
        })
      ) {
        const draftResult = await generateDraftForProject(project, apiKey, {
          promptText,
          targetLayerName: editTarget.layer.name,
          extraDirection: route.variantDirection,
          attachments: contextualAttachments
        });
        project = draftResult.project;
        memory = draftResult.memory;
        assistantGenerated = toAssistantGeneratedImage(draftResult.draft);
        assistantReply =
          route.assistantReply ||
          `I'll draft a new ${editTarget.layer.name} asset for review instead of trying to revise an empty layer.`;
      } else {
        const cleanRestoreRequest = shouldRestoreAccessoryLayerFromCleanSource(
          editTarget.layer,
          promptText,
          editTarget.removalTarget
        );
        if (cleanRestoreRequest) {
          const restoreResult = await restoreLayerVariantFromHistory(project, editTarget.layer, `${promptText} restore original clean`);
          if (restoreResult?.variant) {
            project = restoreResult.project;
            memory = restoreResult.memory;
            editTarget.layer = restoreResult.layer;
            pruneContaminatedSelectedVariants(editTarget.layer, restoreResult.variant.id);
            project.updatedAt = new Date().toISOString();
            await projectService.writeProject(project);
          }
          const transformResult = await updateLayerVariantTransform(project, editTarget.layer, {
            promptText,
            extraDirection: route.variantDirection
          });
          project = transformResult.project;
          memory = transformResult.memory;
          assistantReply =
            route.assistantReply ||
            `I restored a clean ${transformResult.layer.name} source and refit it on the stack instead of trying to salvage the contaminated trait image.`;
        } else if (shouldUseDeterministicLayerFitEdit(editTarget.layer, promptText)) {
          const fitResult = await applyDeterministicLayerVisualAdjustments(project, editTarget.layer, {
            promptText
          });
          project = fitResult.project;
          memory = fitResult.memory;
          const transformResult = await updateLayerVariantTransform(project, fitResult.layer, {
            promptText,
            extraDirection: route.variantDirection
          });
          project = transformResult.project;
          memory = transformResult.memory;
          assistantReply =
            route.assistantReply ||
            `I kept ${transformResult.layer.name} isolated and updated its fit on the stack without redrawing other layers into it.`;
        } else {
          const editResult = await reviseLayerVariantForProject(project, apiKey, {
            layer: editTarget.layer,
            promptText,
            removalTarget: editTarget.removalTarget,
            extraDirection: route.variantDirection,
            attachments: contextualAttachments
          });
          project = editResult.project;
          memory = editResult.memory;
          assistantGenerated = toAssistantGeneratedImage(editResult.variant);
          assistantReply =
            route.assistantReply ||
            `I revised ${editResult.layer.name} so ${editTarget.removalTarget || "that feature"} is no longer baked into the base layer.`;
        }
      }
    } else if (action === "restyle") {
      const styleDir = cleanText(route.styleDirection) || cleanText(route.variantDirection) || "restyled";
      const targetLayer = route.targetLayerName ? findLayer(project, route.targetLayerName) : null;

      if (targetLayer) {
        const variant = (targetLayer.variants || []).find((v) => v.id === targetLayer.selectedVariantId) || (targetLayer.variants || [])[0];
        if (variant?.imageUrl) {
          const sourceUrl = publicAssetUrlToAbsolutePath(variant.imageUrl);
          const sourceBuffer = await fs.readFile(sourceUrl);
          const sourceDataUrl = `data:image/png;base64,${sourceBuffer.toString("base64")}`;
          const restylePrompt = `Redraw this exact image in ${styleDir} style. Keep the exact same subject, composition, pose, and content. Only change the rendering style to ${styleDir}. Preserve all details and proportions.`;
          const isBackground = isFullCanvasBackgroundLayerName(targetLayer.name);
          const imageAsset = await openaiService.editImageAsset({
            apiKey,
            prompt: restylePrompt,
            images: [sourceDataUrl],
            background: isBackground ? "opaque" : "transparent",
            inputFidelity: "high"
          });
          const variantId = createId("variant");
          const variantFolder = path.join(generatedDir, project.id, "layers", targetLayer.id);
          await fs.mkdir(variantFolder, { recursive: true });
          const filename = `${variantId}.png`;
          const resized = await resizePng(imageAsset.buffer, project.canvas);
          await fs.writeFile(path.join(variantFolder, filename), resized);
          const newVariant = {
            id: variantId,
            name: `${variant.name} (${styleDir})`,
            notes: `Restyled to ${styleDir}`,
            prompt: restylePrompt,
            imageUrl: `/generated/${project.id}/layers/${targetLayer.id}/${filename}`,
            rarityWeight: 50,
            createdAt: new Date().toISOString()
          };
          targetLayer.variants.push(newVariant);
          targetLayer.selectedVariantId = variantId;
          project.updatedAt = new Date().toISOString();
          await projectService.writeProject(project);
          memory = await studioMemoryService.appendChangelog(project, {
            type: "restyle",
            title: `Restyled ${targetLayer.name} to ${styleDir}`,
            detail: promptText
          });
          assistantGenerated = toAssistantGeneratedImage(newVariant);
          assistantReply = route.assistantReply || `I restyled ${targetLayer.name} in ${styleDir} style. The original variant is still there if you want to switch back.`;
        } else {
          assistantReply = `${targetLayer.name} has no image to restyle yet. Build the layer first.`;
        }
      } else {
        const restylePrompt = `${project.previewPrompt || promptText} Render the entire scene in ${styleDir} style. Keep the exact same subjects, composition, and layout. Only change the rendering style.`;
        const previewAsset = await openaiService.generateImageAsset({
          apiKey,
          prompt: restylePrompt,
          size: project.canvas.generationSize,
          background: "opaque"
        });
        const previewId = createId("preview");
        const previewFolder = path.join(generatedDir, project.id, "preview");
        await fs.mkdir(previewFolder, { recursive: true });
        const previewFilename = `${previewId}.png`;
        await fs.writeFile(path.join(previewFolder, previewFilename), await resizePng(previewAsset.buffer, project.canvas));
        const previewNumber = (project.previewHistory || []).length + 1;
        const previewEntry = {
          id: previewId,
          name: `Preview ${previewNumber} (${styleDir})`,
          imageUrl: `/generated/${project.id}/preview/${previewFilename}`,
          prompt: restylePrompt,
          notes: `Restyled to ${styleDir}`,
          createdAt: new Date().toISOString()
        };
        project.previewHistory.unshift(previewEntry);
        project.selectedPreviewId = previewId;
        project.updatedAt = new Date().toISOString();
        await projectService.writeProject(project);
        assistantGenerated = toAssistantGeneratedImage(previewEntry);
        assistantReply = route.assistantReply || `Here's the collection restyled in ${styleDir}. The previous previews are still in history.`;
      }
    } else if (action === "feedback") {
      const feedbackMode = detectFeedbackMode(promptText);
      if (!route.assistantReply) {
        assistantReply =
          feedbackMode === "feedback-correction"
            ? "I logged that correction and will steer future generations around it."
            : "I logged that preference and will carry it into future generations.";
      }
      memory = await studioMemoryService.appendChangelog(project, {
        type: feedbackMode,
        title: buildFeedbackTitle(promptText, feedbackMode),
        detail: promptText
      });

      if (shouldLockFeedback(promptText, feedbackMode)) {
        memory = await studioMemoryService.addLockedDecision(project, {
          title: buildLockedDecisionTitle(promptText),
          detail: promptText
        });
      }

      memory = await refreshMemoryIfPossible(project, memory, apiKey);
      await refreshBrainIfPossible(project, memory, apiKey, {
        type: "feedback",
        prompt: promptText,
        layerName: route.targetLayerName || guessLayerNameFromPrompt(promptText),
        summary: promptText
      });
    } else if (action === "commit_draft") {
      const latestSource = getLatestCommitSource(project, promptText);
      if (!latestSource) {
        assistantReply = "There is no recent generated image in chat to add yet.";
      } else {
        const targetLayerName =
          route.targetLayerName || guessLayerNameFromPrompt(promptText) || latestSource.targetLayerName || "Accessory";
        const commitResult = await commitGeneratedSourceToLayer(project, latestSource, targetLayerName);
        project = commitResult.project;
        memory = commitResult.memory;
        assistantGenerated = toAssistantGeneratedImage(commitResult.source);
        assistantReply = assistantReply || `Added that image into ${commitResult.layer.name} and put it on the preview.`;
      }
    } else {
      if (route.canvasWidth && route.canvasHeight) {
        project.canvas = projectService.mergeProject(project, {
          canvas: {
            width: route.canvasWidth,
            height: route.canvasHeight,
            preset: project.canvas.generationSize
          }
        }).canvas;
      }

      project.artDirection = [project.artDirection, promptText].filter(Boolean).join("\n").trim();
      if (route.title && project.title.startsWith("Draw Tech Session")) {
        project.title = route.title;
      }
      await projectService.writeProject(project);
      const previewResult = await generatePreviewForProject(project, apiKey, contextualAttachments);
      project = previewResult.project;
      memory = previewResult.memory;
      assistantGenerated = toAssistantGeneratedImage(previewResult.preview);

      // Draw 1 image per empty layer immediately (build order: bg, base, then traits)
      const sortedLayers = [...project.layers].sort((a, b) => {
        const aName = cleanText(a.name).toLowerCase();
        const bName = cleanText(b.name).toLowerCase();
        const aScore = /background/.test(aName) ? 0 : /(base|body|character|avatar)/.test(aName) ? 1 : 2;
        const bScore = /background/.test(bName) ? 0 : /(base|body|character|avatar)/.test(bName) ? 1 : 2;
        return aScore - bScore;
      });
      for (const layer of sortedLayers) {
        if (layer.variants && layer.variants.length > 0) continue;
        try {
          // Use the same logic as the /variants endpoint (with regions, prompts, repositioning)
          project = await drawLayerVariantWithFullContext(project, layer.id, 1, apiKey);
        } catch (variantError) {
          console.warn(`[preview-draw] Failed to draw ${layer.name}:`, variantError.message);
        }
      }
      await projectService.writeProject(project);

      const proposed = project.proposedLayers || [];
      const drawnCount = project.layers.filter((l) => l.variants && l.variants.length > 0).length;
      if (proposed.length) {
        const layerList = proposed.map((l) => l.name).join(", ");
        assistantReply = assistantReply || `Here's a preview with ${drawnCount} layers drawn: ${layerList}. Review the layer plan below — you can rebuild or adjust.`;
      }
    }

    project.chatHistory.push({
      id: createId("user"),
      role: "user",
      text: promptText,
      attachments: attachments.map(toPublicAttachment),
      createdAt: new Date().toISOString()
    });
    project.chatHistory.push({
      id: createId("draw-tech"),
      role: "draw-tech",
      text: assistantReply,
      generatedImage: assistantGenerated,
      createdAt: new Date().toISOString()
    });
    project.chatHistory = project.chatHistory.slice(-24);
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);

    const latestDraft = (project.draftHistory || [])[0];
    const qualitySource = latestDraft?.analysis ? latestDraft : null;
    const qualityWarnings = buildQualityWarnings(qualitySource);
    res.json({ project, memory, action, assistantReply, qualityWarnings });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/memory", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const memory = await studioMemoryService.getMemory(project);
    res.json({ memory });
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:projectId/memory", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const memory = await studioMemoryService.updateMemory(project, {
      systemPrompt: req.body?.systemPrompt,
      userGuidance: req.body?.userGuidance
    });
    res.json({ memory });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/memory/changelog", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    let memory = await studioMemoryService.appendChangelog(project, {
      type: req.body?.type,
      title: req.body?.title,
      detail: req.body?.detail
    });

    memory = await refreshMemoryIfPossible(project, memory);
    res.json({ memory });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/memory/approve", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    let memory = await studioMemoryService.addLockedDecision(project, {
      title: req.body?.title,
      detail: req.body?.detail
    });

    memory = await refreshMemoryIfPossible(project, memory);
    res.json({ memory });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/memory/refresh", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const memory = await studioMemoryService.getMemory(project);
    const refreshed = await refreshMemoryWithApi(project, memory, getApiKey());
    res.json({ memory: refreshed });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/preview", async (req, res, next) => {
  try {
    const apiKey = getApiKey();
    const existing = await projectService.readProject(req.params.projectId);
    const project = projectService.mergeProject(existing, req.body || {});
    let memory = await studioMemoryService.getMemory(project);

    const brain = await studioBrainService.getBrain();
    const toolManifest = await studioBrainService.getToolManifest();
    const plan = await openaiService.createPreviewPlan(apiKey, project, memory, brain, toolManifest);
    const previewAsset = await openaiService.generateImageAsset({
      apiKey,
      prompt: plan.previewPrompt,
      size: project.canvas.generationSize,
      background: "opaque"
    });

    const previewId = createId("preview");
    const previewFolder = path.join(generatedDir, project.id, "preview");
    const previewFilename = `${previewId}.png`;
    await fs.mkdir(previewFolder, { recursive: true });
    await fs.writeFile(
      path.join(previewFolder, previewFilename),
      await resizePng(previewAsset.buffer, project.canvas)
    );

    const now = new Date().toISOString();
    project.planSummary = plan.collectionSummary;
    project.styleGuide = plan.styleGuide;
    project.previewPrompt = plan.previewPrompt;
    project.previewHistory.unshift({
      id: previewId,
      imageUrl: `/generated/${project.id}/preview/${previewFilename}`,
      prompt: plan.previewPrompt,
      notes: plan.collectionSummary,
      createdAt: now
    });
    project.selectedPreviewId = previewId;
    project.layers = projectService.syncLayersFromPlan(project.layers, plan.layers);
    project.updatedAt = now;

    await projectService.writeProject(project);
    memory = await studioMemoryService.appendChangelog(project, {
      type: "preview",
      title: "Generated collection preview",
      detail: `Created preview ${previewId} with ${project.layers.length} active layers.`
    });
    memory = await refreshMemoryIfPossible(project, memory, apiKey);
    res.json({ project, plan, memory });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/layers/:layerId/variants", async (req, res, next) => {
  try {
    const apiKey = getApiKey();
    const count = clampVariantCount(req.body?.count);
    const project = await projectService.readProject(req.params.projectId);
    hydrateProjectLayerFitContracts(project);
    const layer = project.layers.find((item) => item.id === req.params.layerId);
    let memory = await studioMemoryService.getMemory(project);

    if (!layer) {
      res.status(404).json({ error: `Layer ${req.params.layerId} was not found.` });
      return;
    }

    const brain = await studioBrainService.getBrain();
    const toolManifest = await studioBrainService.getToolManifest();
    const plan = await openaiService.createLayerVariantPlan(
      apiKey,
      project,
      layer,
      count,
      memory,
      brain,
      toolManifest
    );
    const variantFolder = path.join(generatedDir, project.id, "layers", layer.id);
    await fs.mkdir(variantFolder, { recursive: true });

    const isBackground = isFullCanvasBackgroundLayerName(layer.name);
    const isBase = isPrimaryBaseLayerName(layer.name);
    const isBgAccent = isBackgroundAccentLayerName(layer.name);
    const backgroundMode = isBackground ? "opaque" : "transparent";
    const anchorRef = (!isBackground && !isBase && !isBgAccent)
      ? await getActiveAnchorReferenceAttachment(project, layer)
      : null;
    const region = layer.region || null;
    const canvasW = project.canvas?.width || 1024;
    const canvasH = project.canvas?.height || 1024;

    const previewPromptForLayer = cleanText(layer.previewGenerationPrompt);

    // Look up parent layer's actual drawn bounds for clip-aware child placement.
    // The parent (usually the body/base) was generated in a previous sequential
    // call and its variant is already on disk.
    let parentBounds = null;
    if (layer.parentLayer && !isBackground && !isBase) {
      const parentLayer = project.layers.find((l) =>
        cleanText(l.name).toLowerCase() === cleanText(layer.parentLayer).toLowerCase()
        || slugify(l.name) === slugify(layer.parentLayer)
      );
      if (parentLayer) {
        const parentVariant = (parentLayer.variants || []).find((v) => v.id === parentLayer.selectedVariantId) || (parentLayer.variants || [])[0];
        if (parentVariant?.imageUrl) {
          try {
            const parentPath = publicAssetUrlToAbsolutePath(parentVariant.imageUrl);
            const parentBuffer = await fs.readFile(parentPath);
            const parentAnalysis = await assetToolService.inspectPngBuffer(parentBuffer);
            if (parentAnalysis.bounds) {
              const parentRegion = parentLayer.region;
              parentBounds = {
                ...parentAnalysis.bounds,
                estimatedX: parentRegion?.x || 0,
                estimatedY: parentRegion?.y || 0,
                estimatedW: parentRegion?.width || canvasW,
                estimatedH: parentRegion?.height || canvasH
              };
            }
          } catch (e) {
            console.warn(`[variants] Could not read parent layer bounds: ${e.message}`);
          }
        }
      }
    }

    const variants = [];
    const warnings = [];
    for (let variantIndex = 0; variantIndex < plan.variants.length; variantIndex++) {
      const item = plan.variants[variantIndex];
      let imageAsset;

      // First variant uses the detailed preview-analyzed prompt wrapped with isolation rules
      const isFirstVariant = variantIndex === 0;
      const basePrompt = (isFirstVariant && previewPromptForLayer)
        ? openaiService.buildLayerAssetPrompt({ project, layer, promptText: previewPromptForLayer })
        : item.prompt;

      // Build exclusion list — what NOT to draw
      const otherLayerNames = project.layers
        .filter((l) => l.id !== layer.id)
        .map((l) => l.name);
      const exclusionPrompt = otherLayerNames.length
        ? ` STRICT RULE: Output ONLY the ${layer.name} element. Do NOT draw, include, or reproduce ANY of these: ${otherLayerNames.join(", ")}. The reference image is ONLY for understanding scale, position, and perspective — do NOT copy its content. Draw ONLY ${layer.name} on a transparent background.`
        : "";

      const regionPrompt = region && !isBackground
        ? ` Target region on the ${canvasW}x${canvasH} canvas: approximately centered around (${Math.round(region.x + region.width / 2)}, ${Math.round(region.y + region.height / 2)}) at roughly ${region.width}x${region.height} pixels.`
        : "";

      // For child assets, reinforce that they MUST match the base body's 3D
      // camera angle shown in the reference image. The reference is always the
      // base/body layer, so we reference it directly regardless of the child's
      // immediate parent in the layer hierarchy.
      const anchorLayerName = anchorRef?.targetLayerName || "base body";
      const perspectivePrompt = (!isBackground && !isBase && anchorRef)
        ? ` CRITICAL 3D RULE: The reference image shows the ${anchorLayerName} at a specific 3D camera angle. This ${layer.name} sits on that same construct and MUST be drawn at the EXACT same camera angle. Study the reference — match its perspective foreshortening, vanishing point direction, and surface angles precisely. If the ${anchorLayerName} is turned, this ${layer.name} must show the same turn on the surface where it attaches. NEVER draw this element flat, front-facing, or leaning away from the reference's angle.`
        : "";

      const fullPrompt = basePrompt + exclusionPrompt + regionPrompt + perspectivePrompt;

      if (anchorRef?.dataUrl && !isBackground && !isBase) {
        imageAsset = await openaiService.editImageAsset({
          apiKey,
          prompt: fullPrompt,
          images: [anchorRef.dataUrl],
          background: "transparent",
          inputFidelity: "high"
        });
      } else {
        // Background, base, and layers without anchor: generate from prompt alone
        // The detailed preview-analyzed prompt has all the visual info needed
        imageAsset = await openaiService.generateImageAsset({
          apiKey,
          prompt: fullPrompt,
          size: project.canvas.generationSize,
          background: backgroundMode
        });
      }

      let resizedBuffer = await resizePng(imageAsset.buffer, project.canvas);

      // Fit CHILD layers to their target region. The base/body layer is the
      // anchor — it renders at whatever size DALL-E chose, unmodified. Only
      // trait/accessory layers get fitted to their region relative to the
      // parent's actual drawn bounds.
      if (region && !isBackground && !isBase) {
        resizedBuffer = await fitLayerToRegion(resizedBuffer, region, canvasW, canvasH, parentBounds, layer.name);
      }

      const analysis = await inspectVariantAgainstLayer(layer, resizedBuffer);

      if (analysis.possibleDuplicate) {
        warnings.push(`${item.name} looks very similar to ${analysis.strongestMatchName}`);
      }
      if (!isBackground && analysis.alphaCoverage === 1) {
        warnings.push(`${item.name} has no transparency — may need a transparent background`);
      }
      if (!isBackground && !isBase && analysis.touchesEdge) {
        warnings.push(`${item.name} bleeds to canvas edge — may not stack cleanly`);
      }
      if (analysis.emptyAlpha) {
        warnings.push(`${item.name} appears completely empty/transparent`);
      }

      const variantId = createId("variant");
      const filename = `${variantId}.png`;
      await fs.writeFile(path.join(variantFolder, filename), resizedBuffer);

      variants.push({
        id: variantId,
        name: item.name,
        notes: item.notes,
        prompt: item.prompt,
        imageUrl: `/generated/${project.id}/layers/${layer.id}/${filename}`,
        analysis,
        createdAt: new Date().toISOString()
      });
    }

    layer.variants.push(...variants);
    if (!layer.selectedVariantId && variants[0]) {
      layer.selectedVariantId = variants[0].id;
    }

    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    memory = await studioMemoryService.appendChangelog(project, {
      type: "variants",
      title: `Generated ${variants.length} ${layer.name} variants`,
      detail: variants.map((variant) => variant.name).join(", ")
    });
    memory = await refreshMemoryIfPossible(project, memory, apiKey);
    res.json({ project, variants, warnings, memory });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/apply-combo", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const picks = req.body?.picks;
    if (!picks || typeof picks !== "object") {
      res.status(400).json({ error: "Picks object is required." });
      return;
    }

    for (const layer of project.layers) {
      const pick = picks[layer.id];
      if (pick?.variantId) {
        const hasVariant = layer.variants.some((v) => v.id === pick.variantId);
        if (hasVariant) layer.selectedVariantId = pick.variantId;
      }
    }

    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    res.json({ project });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/preview/render", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const sources = await getPreviewCompositeSources(project);

    if (!sources.length) {
      res.status(404).json({ error: "No selected preview layers to render." });
      return;
    }

    const width = Math.max(1, Number(project.canvas?.width || 1024));
    const height = Math.max(1, Number(project.canvas?.height || 1024));
    const baseSource = sources.find((source) => source.isBaseLayer) || null;
    const compositePieces = (await Promise.all(
      sources.map((source) => buildCompositeLayers(source, width, height, baseSource))
    )).flat();
    const anchorOccluder = await buildAnchorOccluderPiece(sources, width, height);
    const baseLayers = compositePieces.filter((piece) => piece.stage === "base");
    const behindBaseLayers = compositePieces.filter((piece) => piece.stage === "behind-base");
    const headwearWrapLayers = compositePieces.filter((piece) => piece.stage === "headwear-wrap");
    const normalLayers = compositePieces.filter((piece) => piece.stage === "normal");
    const inFrontBaseLayers = compositePieces.filter((piece) => piece.stage === "in-front-base");
    const compositeLayers = [
      ...behindBaseLayers,
      ...baseLayers,
      ...headwearWrapLayers,
      ...(anchorOccluder ? [anchorOccluder] : []),
      ...normalLayers,
      ...inFrontBaseLayers
    ].map(
      ({ input, left, top }) => ({
        input,
        left,
        top
      })
    );
    const compositeBuffer = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite(compositeLayers)
      .png()
      .toBuffer();

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.end(compositeBuffer);
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/export/hashlips", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const layerFolders = buildHashLipsLayerFolders(project);

    if (!layerFolders.length) {
      res.status(400).json({
        error: "Generate at least one layer variant before exporting a HashLips package."
      });
      return;
    }

    const archiveName = `${sanitizeFileName(project.title, "draw-tech-collection")}-hashlips.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${archiveName}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (error) => {
      next(error);
    });
    archive.pipe(res);

    for (const layerFolder of layerFolders) {
      for (const variant of layerFolder.variants) {
        archive.file(variant.absolutePath, {
          name: `layers/${layerFolder.folderName}/${variant.fileName}`
        });
      }
    }

    archive.append(
      JSON.stringify(buildHashLipsExportManifest(project, layerFolders), null, 2),
      { name: "draw-tech.project.json" }
    );
    archive.append(JSON.stringify(buildHashLipsConfig(project, layerFolders), null, 2), {
      name: "hashlips.config.json"
    });
    archive.append(buildHashLipsReadme(project), { name: "README.txt" });

    await archive.finalize();
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/shuffle", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const shuffled = [];

    for (const layer of project.layers) {
      const variants = Array.isArray(layer.variants) ? layer.variants : [];
      if (variants.length > 0) {
        const pick = variants[Math.floor(Math.random() * variants.length)];
        layer.selectedVariantId = pick.id;
        shuffled.push({ layerName: layer.name, variantName: pick.name });
      }
    }

    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    res.json({ project, shuffled });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/collection-grid", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const count = Math.max(1, Math.min(16, Number(req.query?.count) || 9));
    const layersWithVariants = project.layers.filter((l) => l.variants && l.variants.length > 0);
    const conflicts = {};
    for (const layer of project.layers) {
      if (Array.isArray(layer.conflicts) && layer.conflicts.length) {
        conflicts[layer.id] = layer.conflicts;
      }
    }

    const combos = [];
    for (let i = 0; i < count; i++) {
      const picks = {};
      for (const layer of layersWithVariants) {
        const pick = layer.variants[Math.floor(Math.random() * layer.variants.length)];
        picks[layer.id] = { layerId: layer.id, layerName: layer.name, variantId: pick.id, variantName: pick.name };
      }
      combos.push(picks);
    }

    const supplyInfo = calculateSupplyInfo(project);
    res.json({ combos, supplyInfo, layerCount: layersWithVariants.length });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/layers/:layerId/select", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const layer = project.layers.find((item) => item.id === req.params.layerId);

    if (!layer) {
      res.status(404).json({ error: `Layer ${req.params.layerId} was not found.` });
      return;
    }

    const variantId = String(req.body?.variantId || "");
    const hasVariant = layer.variants.some((variant) => variant.id === variantId);
    layer.selectedVariantId = hasVariant
      ? layer.selectedVariantId === variantId
        ? null
        : variantId
      : null;
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    const memory = await studioMemoryService.appendChangelog(project, {
      type: "selection",
      title: layer.selectedVariantId ? `Selected ${layer.name} variant` : `Cleared ${layer.name} variant`,
      detail: layer.selectedVariantId || "Cleared active variant selection."
    });
    res.json({ project, memory });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/layers/:layerId/transform", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const layer = project.layers.find((item) => item.id === req.params.layerId);

    if (!layer) {
      res.status(404).json({ error: `Layer ${req.params.layerId} was not found.` });
      return;
    }

    const variantId = cleanText(req.body?.variantId) || cleanText(layer.selectedVariantId);
    const variant =
      layer.variants.find((item) => item.id === variantId) ||
      layer.variants.find((item) => item.id === layer.selectedVariantId) ||
      layer.variants[0] ||
      null;

    if (!variant) {
      res.status(404).json({ error: "No selected layer image was available to reposition." });
      return;
    }

    const patch = req.body?.transform;
    if (!patch || typeof patch !== "object") {
      res.status(400).json({ error: "A transform payload is required." });
      return;
    }

    const requestedScope = cleanText(req.body?.scope).toLowerCase();
    const useVariantTransform = requestedScope === "variant" || (requestedScope !== "layer" && isVariantUsingCustomTransform(variant));
    const currentTransform = useVariantTransform
      ? getVariantPlacementTransform(layer, variant)
      : getLayerPlacementTransform(layer, variant);
    const nextTransform = mergeLayerTransform(currentTransform, patch);
    applyPlacementTransformForVariant(layer, variant, nextTransform, useVariantTransform ? "custom" : "sync");
    layer.selectedVariantId = variant.id;
    if (!useVariantTransform) {
      refreshLayerFitContract(project, layer, variant, { force: true });
    }

    // Update the layer region to match the new transform so future variant
    // generations position content at the user's adjusted location
    if (!useVariantTransform) {
      layer.region = computeRegionFromTransform(nextTransform, variant, project.canvas);
    }

    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    const memory = await studioMemoryService.appendChangelog(project, {
      type: useVariantTransform ? "manual-transform-variant" : "manual-transform-layer",
      title: useVariantTransform ? `Dragged ${variant.name}` : `Dragged ${layer.name}`,
      detail: useVariantTransform
        ? `Set custom placement for ${variant.name} to x ${nextTransform.x}, y ${nextTransform.y}, scale ${nextTransform.scale}.`
        : `Set ${variant.name} to x ${nextTransform.x}, y ${nextTransform.y}, scale ${nextTransform.scale}.`
    });
    res.json({
      project,
      memory,
      layer,
      variant,
      transformScope: useVariantTransform ? "variant" : "layer"
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/layers/:layerId/move", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const currentIndex = project.layers.findIndex((item) => item.id === req.params.layerId);

    if (currentIndex === -1) {
      res.status(404).json({ error: "Layer not found." });
      return;
    }

    const direction = String(req.body?.direction || "").toLowerCase();
    const delta = direction === "forward" ? 1 : direction === "backward" ? -1 : 0;
    if (!delta) {
      res.status(400).json({ error: "Layer move direction must be 'forward' or 'backward'." });
      return;
    }

    const targetIndex = currentIndex + delta;
    if (targetIndex < 0 || targetIndex >= project.layers.length) {
      res.json({ project, moved: false });
      return;
    }

    const reorderedLayers = [...project.layers];
    const [movedLayer] = reorderedLayers.splice(currentIndex, 1);
    reorderedLayers.splice(targetIndex, 0, movedLayer);
    project.layers = reorderedLayers;
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    const memory = await studioMemoryService.appendChangelog(project, {
      type: "move-layer",
      title: `${direction === "forward" ? "Brought forward" : "Sent backward"} ${movedLayer.name}`,
      detail: `Layer stack position changed to ${targetIndex + 1} of ${project.layers.length}.`
    });
    res.json({ project, memory, moved: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/layers", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const nextName = cleanText(req.body?.name);

    if (!nextName) {
      res.status(400).json({ error: "Layer name is required." });
      return;
    }

    const duplicate = project.layers.find((item) => slugify(item.name) === slugify(nextName));
    if (duplicate) {
      res.status(409).json({ error: `A layer named ${duplicate.name} already exists.` });
      return;
    }

    const layer = createEmptyLayer(project, nextName);
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    const memory = await studioMemoryService.appendChangelog(project, {
      type: "create-layer",
      title: `Created ${layer.name}`,
      detail: "Added a new empty layer folder from the app."
    });
    res.status(201).json({ project, memory, layer });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/layers/:layerId/rename", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const layer = project.layers.find((item) => item.id === req.params.layerId);

    if (!layer) {
      res.status(404).json({ error: "Layer not found." });
      return;
    }

    const nextName = cleanText(req.body?.name);
    if (!nextName) {
      res.status(400).json({ error: "Layer name is required." });
      return;
    }

    const duplicate = project.layers.find(
      (item) => item.id !== layer.id && slugify(item.name) === slugify(nextName)
    );
    if (duplicate) {
      res.status(409).json({ error: `A layer named ${duplicate.name} already exists.` });
      return;
    }

    const previousName = layer.name;
    layer.name = nextName;
    syncRenamedLayerReferences(project, layer.id, previousName, nextName);
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    const memory = await studioMemoryService.appendChangelog(project, {
      type: "rename-layer",
      title: `Renamed ${previousName} to ${nextName}`,
      detail: "Updated layer folder name from the app."
    });
    res.json({ project, memory });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/drafts/:draftId/commit", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const result = await commitDraftToLayer(project, req.params.draftId, req.body?.layerName);
    res.json({
      project: result.project,
      memory: result.memory,
      draft: result.source,
      layer: result.layer,
      variant: result.variant
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/layers/:layerId/variants/:variantId/placement-mode", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const layer = project.layers.find((item) => item.id === req.params.layerId);
    if (!layer) {
      res.status(404).json({ error: "Layer not found." });
      return;
    }

    const variant = (Array.isArray(layer.variants) ? layer.variants : []).find(
      (item) => item.id === req.params.variantId
    );
    if (!variant) {
      res.status(404).json({ error: "Layer image not found." });
      return;
    }

    const requestedMode = cleanText(req.body?.mode).toLowerCase();
    const nextMode =
      requestedMode === "custom" || requestedMode === "sync"
        ? requestedMode
        : isVariantUsingCustomTransform(variant)
          ? "sync"
          : "custom";

    let detail = "";
    if (nextMode === "custom") {
      const frozenTransform = getVariantPlacementTransform(layer, variant);
      applyVariantPlacementTransform(layer, variant, frozenTransform);
      detail = `Broke ${variant.name} out of ${layer.name} sync so it can keep its own placement.`;
    } else {
      const syncedTransform = resyncVariantPlacementTransform(layer, variant);
      detail = `Resynced ${variant.name} back to ${layer.name} at x ${syncedTransform.x}, y ${syncedTransform.y}, scale ${syncedTransform.scale}.`;
    }

    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    const memory = await studioMemoryService.appendChangelog(project, {
      type: nextMode === "custom" ? "break-layer-sync" : "resync-layer-sync",
      title: nextMode === "custom" ? `Customised ${variant.name}` : `Resynced ${variant.name}`,
      detail
    });
    res.json({
      project,
      memory,
      layer,
      variant,
      mode: nextMode
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/layers/:layerId/variants/:variantId/weight", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const layer = project.layers.find((item) => item.id === req.params.layerId);
    if (!layer) { res.status(404).json({ error: "Layer not found." }); return; }
    const variant = (layer.variants || []).find((item) => item.id === req.params.variantId);
    if (!variant) { res.status(404).json({ error: "Variant not found." }); return; }

    const weight = Math.max(1, Math.min(1000, Math.round(Number(req.body?.weight) || 50)));
    variant.rarityWeight = weight;
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    res.json({ project, layer, variant });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/layers/:layerId/conflicts", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const layer = project.layers.find((item) => item.id === req.params.layerId);
    if (!layer) { res.status(404).json({ error: "Layer not found." }); return; }

    layer.conflicts = Array.isArray(req.body?.conflicts)
      ? req.body.conflicts.map((c) => cleanText(c)).filter(Boolean).slice(0, 20)
      : [];
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    res.json({ project, layer });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/clone", async (req, res, next) => {
  try {
    const source = await projectService.readProject(req.params.projectId);
    const cloned = projectService.normalizeProjectInput({
      title: `${source.title} (Copy)`,
      artDirection: source.artDirection,
      collectionGoal: source.collectionGoal,
      canvas: source.canvas,
      layers: source.layers.map((layer) => ({
        name: layer.name,
        description: layer.description,
        placementNotes: layer.placementNotes,
        variantIdeas: layer.variantIdeas,
        conflicts: layer.conflicts
      }))
    });
    cloned.styleGuide = source.styleGuide;
    cloned.planSummary = source.planSummary;
    await projectService.writeProject(cloned);
    res.json({ project: cloned });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/layers/:layerId/variants/:variantId/move", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const sourceLayer = project.layers.find((item) => item.id === req.params.layerId);
    if (!sourceLayer) {
      res.status(404).json({ error: "Source layer not found." });
      return;
    }

    const targetLayer =
      project.layers.find((item) => item.id === cleanText(req.body?.targetLayerId)) ||
      findLayer(project, req.body?.targetLayerName);
    if (!targetLayer) {
      res.status(404).json({ error: "Target layer not found." });
      return;
    }

    const variant = sourceLayer.variants.find((item) => item.id === req.params.variantId);
    if (!variant) {
      res.status(404).json({ error: "Layer image not found." });
      return;
    }

    if (sourceLayer.id === targetLayer.id) {
      res.json({
        project,
        moved: false,
        sourceLayer,
        targetLayer,
        variant
      });
      return;
    }

    const existingVariant =
      targetLayer.variants.find((item) => item.imageUrl === variant.imageUrl) ||
      targetLayer.variants.find(
        (item) =>
          cleanText(item.prompt) &&
          cleanText(item.prompt) === cleanText(variant.prompt) &&
          cleanText(item.name) === cleanText(variant.name)
      ) ||
      null;

    sourceLayer.variants = sourceLayer.variants.filter((item) => item.id !== variant.id);
    if (sourceLayer.selectedVariantId === variant.id) {
      sourceLayer.selectedVariantId = sourceLayer.variants[0]?.id || null;
    }

    let movedVariant = existingVariant;
    if (!movedVariant) {
      variant.transformMode = "sync";
      variant.transform = getLayerPlacementTransform(targetLayer, variant);
      targetLayer.variants.push(variant);
      movedVariant = variant;
    }

    applyLayerPlacementTransform(targetLayer, getLayerPlacementTransform(targetLayer, movedVariant));
    targetLayer.selectedVariantId = movedVariant.id;
    syncMovedVariantReferences(project, {
      fromLayer: sourceLayer,
      toLayer: targetLayer,
      fromVariantId: variant.id,
      toVariantId: movedVariant.id,
      imageUrl: movedVariant.imageUrl
    });

    if (isPrimaryBaseLayerName(targetLayer.name)) {
      project.selectedPreviewId = null;
    }

    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    const memory = await studioMemoryService.appendChangelog(project, {
      type: "move-variant",
      title: `Moved ${movedVariant.name}`,
      detail: `${movedVariant.name} moved from ${sourceLayer.name} to ${targetLayer.name}.`
    });
    res.json({
      project,
      memory,
      moved: true,
      sourceLayer,
      targetLayer,
      variant: movedVariant
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:projectId/layers/:layerId", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const layer = project.layers.find((item) => item.id === req.params.layerId);
    if (!layer) {
      res.status(404).json({ error: "Layer not found." });
      return;
    }

    project.layers = project.layers.filter((item) => item.id !== layer.id);
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    const memory = await studioMemoryService.appendChangelog(project, {
      type: "remove-layer",
      title: `Removed ${layer.name}`,
      detail: "Removed from layer breakout."
    });
    res.json({ project, memory });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:projectId/layers/:layerId/variants/:variantId", async (req, res, next) => {
  try {
    const project = await projectService.readProject(req.params.projectId);
    const layer = project.layers.find((item) => item.id === req.params.layerId);
    if (!layer) {
      res.status(404).json({ error: "Layer not found." });
      return;
    }

    const variant = layer.variants.find((item) => item.id === req.params.variantId);
    if (!variant) {
      res.status(404).json({ error: "Layer image not found." });
      return;
    }

    layer.variants = layer.variants.filter((item) => item.id !== variant.id);
    if (layer.selectedVariantId === variant.id) {
      layer.selectedVariantId = layer.variants[0]?.id || null;
    }

    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    const memory = await studioMemoryService.appendChangelog(project, {
      type: "remove-variant",
      title: `Removed ${variant.name}`,
      detail: `Layer: ${layer.name}`
    });
    res.json({ project, memory });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = Number(error.status || 500);
  console.error("[draw-tech] Request failed", {
    status,
    message: error.message
  });
  if (error.stack) {
    console.error(error.stack);
  }
  res.status(status).json({
    error: error.message || "Unexpected server error."
  });
});

const port = Number(process.env.PORT || 3000);
await ensureDirectories();
app.listen(port, () => {
  const urls = getAccessibleUrls(port);
  console.log("draw-tech running");
  for (const url of urls) {
    console.log(`  ${url}`);
  }
});

async function ensureDirectories() {
  await projectService.ensureDirectories();
  await fs.mkdir(generatedDir, { recursive: true });
  await studioMemoryService.ensureDirectories();
  await studioBrainService.ensureDirectories();
  await studioBrainService.reinforceBrain({
    qualityRules: DURABLE_STUDIO_QUALITY_RULES,
    drawingLessons: DURABLE_STUDIO_LESSONS
  });
  await fs.mkdir(uploadsDir, { recursive: true });
}

function loadLayerFitProfiles() {
  const manifest = safeJsonParse(readFileSync(toolManifestPath, "utf8")) || {};
  return Array.isArray(manifest.fitProfiles)
    ? manifest.fitProfiles
        .map((profile) => ({
          id: cleanText(profile?.id),
          label: cleanText(profile?.label),
          layerKeywords: Array.isArray(profile?.layerKeywords)
            ? profile.layerKeywords.map((item) => cleanText(item).toLowerCase()).filter(Boolean)
            : [],
          anchorRegion: cleanText(profile?.anchorRegion),
          clipStrategy: cleanText(profile?.clipStrategy),
          guidance: cleanText(profile?.guidance),
          defaultTransform: profile?.defaultTransform || null,
          anchorWidthRatio: coerceProfileNumber(profile?.anchorWidthRatio, null),
          anchorHeightRatio: coerceProfileNumber(profile?.anchorHeightRatio, null),
          anchorCenterXOffsetRatio: coerceProfileNumber(profile?.anchorCenterXOffsetRatio, null),
          anchorCenterYRatio: coerceProfileNumber(profile?.anchorCenterYRatio, null),
          anchorTopRatio: coerceProfileNumber(profile?.anchorTopRatio, null),
          anchorBottomRatio: coerceProfileNumber(profile?.anchorBottomRatio, null),
          frontStart: coerceProfileNumber(profile?.frontStart, null),
          backCutoff: coerceProfileNumber(profile?.backCutoff, null)
        }))
        .filter((profile) => profile.id)
    : [];
}

function coerceProfileNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
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
    targetWidthRatio: coerceProfileNumber(contract.targetWidthRatio, null),
    targetHeightRatio: coerceProfileNumber(contract.targetHeightRatio, null),
    targetCenterXOffsetRatio: coerceProfileNumber(contract.targetCenterXOffsetRatio, null),
    targetCenterYRatio: coerceProfileNumber(contract.targetCenterYRatio, null),
    targetTopRatio: coerceProfileNumber(contract.targetTopRatio, null),
    targetBottomRatio: coerceProfileNumber(contract.targetBottomRatio, null),
    canvasWidthRatio: coerceProfileNumber(contract.canvasWidthRatio, null),
    canvasHeightRatio: coerceProfileNumber(contract.canvasHeightRatio, null),
    canvasCenterXRatio: coerceProfileNumber(contract.canvasCenterXRatio, null),
    canvasCenterYRatio: coerceProfileNumber(contract.canvasCenterYRatio, null),
    canvasTopRatio: coerceProfileNumber(contract.canvasTopRatio, null),
    canvasBottomRatio: coerceProfileNumber(contract.canvasBottomRatio, null),
    depthMode: cleanText(contract.depthMode),
    clipStrategy: cleanText(contract.clipStrategy),
    backCutoff: coerceProfileNumber(contract.backCutoff, null),
    frontStart: coerceProfileNumber(contract.frontStart, null),
    summary: cleanText(contract.summary),
    updatedAt: cleanText(contract.updatedAt)
  };

  return Object.values(normalized).some((value) => value !== "" && value !== null) ? normalized : null;
}

function getLayerFitContract(layer) {
  return normalizeLayerFitContract(layer?.fitContract);
}

function getLayerFitProfile(layerName) {
  const lowered = cleanText(layerName).toLowerCase();
  if (!lowered) {
    return null;
  }

  return (
    layerFitProfiles.find((profile) => profile.layerKeywords.some((keyword) => lowered.includes(keyword))) || null
  );
}

function buildFitDebugData(project) {
  const canvas = project?.canvas || { width: 1024, height: 1024 };
  const activeAnchor = getActiveAnchorLayer(project, null);
  const layers = (project?.layers || []).map((layer) => {
    const variants = Array.isArray(layer.variants) ? layer.variants : [];
    const selectedVariant = variants.find((item) => item.id === layer.selectedVariantId) || null;
    const fitProfile = getLayerFitProfile(layer.name);
    const transform = getVariantPlacementTransform(layer, selectedVariant);
    const fitContract = getLayerFitContract(layer) || buildLayerFitContract(project, layer, selectedVariant);

    return {
      id: layer.id,
      name: layer.name,
      isBaseLayer: isPrimaryBaseLayerName(layer.name),
      selected: Boolean(selectedVariant),
      selectedVariantId: selectedVariant?.id || null,
      selectedVariantTransformMode: normalizeVariantTransformMode(selectedVariant?.transformMode),
      selectedVariant: selectedVariant
        ? {
            id: selectedVariant.id,
            name: selectedVariant.name,
            imageUrl: selectedVariant.imageUrl,
            createdAt: selectedVariant.createdAt
          }
        : null,
      variantCount: variants.length,
      transform,
      fitProfile: fitProfile
        ? {
            id: fitProfile.id,
            label: fitProfile.label,
            anchorRegion: fitProfile.anchorRegion,
            clipStrategy: fitProfile.clipStrategy,
            guidance: fitProfile.guidance,
            defaultTransform: normalizeLayerTransform(fitProfile.defaultTransform || getDefaultTransformForLayer(layer.name))
          }
        : null,
      fitContract
    };
  });

  return {
    projectId: project.id,
    projectTitle: project.title,
    updatedAt: project.updatedAt,
    canvas: {
      width: Number(canvas.width || 1024),
      height: Number(canvas.height || 1024)
    },
    selectedLayerCount: layers.filter((layer) => layer.selected).length,
    activeAnchor: activeAnchor
      ? {
          layerId: activeAnchor.layer.id,
          layerName: activeAnchor.layer.name,
          variantId: activeAnchor.variant?.id || null,
          variantName: activeAnchor.variant?.name || null,
          imageUrl: activeAnchor.variant?.imageUrl || null
        }
      : null,
    layers
  };
}

function getApiKey() {
  const apiKey = runtimeState.sessionApiKey || process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    const error = new Error("Add an OpenAI API key in the app or in your .env file first.");
    error.status = 400;
    throw error;
  }
  return apiKey;
}

async function resizePng(buffer, canvas) {
  return sharp(buffer)
    .resize({
      width: canvas.width,
      height: canvas.height,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();
}

async function generatePreviewForProject(project, apiKey, attachments = []) {
  let memory = await studioMemoryService.getMemory(project);
  const brain = await studioBrainService.getBrain();
  const toolManifest = await studioBrainService.getToolManifest();
  const plan = await openaiService.createPreviewPlan(apiKey, project, memory, brain, toolManifest, attachments);
  const previewAsset = await openaiService.generateImageAsset({
    apiKey,
    prompt: plan.previewPrompt,
    size: project.canvas.generationSize,
    background: "opaque"
  });

  const previewId = createId("preview");
  const previewFolder = path.join(generatedDir, project.id, "preview");
  const previewFilename = `${previewId}.png`;
  await fs.mkdir(previewFolder, { recursive: true });
  await fs.writeFile(
    path.join(previewFolder, previewFilename),
    await resizePng(previewAsset.buffer, project.canvas)
  );
  const previewBuffer = await fs.readFile(path.join(previewFolder, previewFilename));
  const previewAnalysis = await assetToolService.inspectPngBuffer(previewBuffer);

  const now = new Date().toISOString();
  project.planSummary = plan.collectionSummary;
  project.styleGuide = plan.styleGuide;
  project.previewPrompt = plan.previewPrompt;
  const previewNumber = (project.previewHistory || []).length + 1;
  const previewEntry = {
    id: previewId,
    name: `Preview ${previewNumber}`,
    imageUrl: `/generated/${project.id}/preview/${previewFilename}`,
    prompt: plan.previewPrompt,
    notes: plan.collectionSummary,
    createdAt: now
  };
  project.previewHistory.unshift(previewEntry);
  project.selectedPreviewId = previewId;
  const proposedLayers = plan.layers.map((layer, index) => ({
    id: layer.id || `layer-${index + 1}`,
    name: cleanText(layer.name) || `Layer ${index + 1}`,
    description: cleanText(layer.description),
    placementNotes: cleanText(layer.placementNotes),
    variantIdeas: Array.isArray(layer.variantIdeas) ? layer.variantIdeas : []
  }));

  // Analyze preview image: get bounding boxes AND detailed generation prompts for each layer
  try {
    const previewDataUrl = `data:image/png;base64,${previewBuffer.toString("base64")}`;

    // Fuzzy layer name matching for GPT analysis results
    const findProposedMatch = (name, index) => {
      const target = cleanText(name).toLowerCase();
      const targetSlug = slugify(name);
      return proposedLayers.find((l) => cleanText(l.name).toLowerCase() === target)
        || proposedLayers.find((l) => slugify(l.name) === targetSlug)
        || proposedLayers.find((l) => target.includes(cleanText(l.name).toLowerCase()) || cleanText(l.name).toLowerCase().includes(target))
        || (Number.isFinite(index) ? proposedLayers[index] : null);
    };

    // Step 1: Get pixel-precise bounding boxes + detect missing layers
    const layerMap = await openaiService.createLayerMap(apiKey, previewDataUrl, proposedLayers, project.canvas);
    for (let mi = 0; mi < layerMap.length; mi++) {
      const mapped = layerMap[mi];
      const match = findProposedMatch(mapped.name, mi);
      if (match && !mapped.isNew) {
        match.region = mapped.region;
        match.stackOrder = mapped.stackOrder;
      } else if (mapped.isNew && mapped.name) {
        proposedLayers.push({
          id: `layer-${proposedLayers.length + 1}-${slugify(mapped.name)}`,
          name: mapped.name,
          description: mapped.description || "",
          placementNotes: "",
          variantIdeas: [],
          region: mapped.region,
          stackOrder: mapped.stackOrder
        });
      }
    }
    proposedLayers.sort((a, b) => (a.stackOrder || 0) - (b.stackOrder || 0));

    // Step 2: Get layer relationships (what clips to what, edge rules, z-order)
    const relationships = await openaiService.createLayerRelationships(apiKey, previewDataUrl, proposedLayers, project.canvas);
    for (let ri = 0; ri < relationships.length; ri++) {
      const rel = relationships[ri];
      const match = findProposedMatch(rel.name, ri);
      if (match) {
        match.parentLayer = rel.parentLayer;
        match.attachmentType = rel.attachmentType;
        match.edgeRules = rel.edgeRules;
        match.zOrderNote = rel.zOrderNote;
        match.interactionDescription = rel.interactionDescription;
      }
    }

    // Step 3: Get hyper-detailed generation prompts by studying the preview
    const detailedPrompts = await openaiService.analyzePreviewForLayerPrompts(apiKey, previewDataUrl, proposedLayers, project.canvas);
    for (let di = 0; di < detailedPrompts.length; di++) {
      const dp = detailedPrompts[di];
      const match = findProposedMatch(dp.name, di);
      if (match && dp.generationPrompt) {
        // Inject relationship context into the generation prompt
        const relContext = match.interactionDescription
          ? ` SPATIAL RELATIONSHIP: ${match.interactionDescription}${match.parentLayer ? ` This element attaches to ${match.parentLayer} via ${match.attachmentType}.` : ""}${match.zOrderNote ? ` Z-order: ${match.zOrderNote}.` : ""}`
          : "";
        match.previewGenerationPrompt = dp.generationPrompt + relContext;
      }
    }
  } catch (mapError) {
    console.warn("[layer-analysis] Could not fully analyze preview:", mapError.message);
  }

  // Create layer folders immediately AND keep proposedLayers for UI review
  project.layers = projectService.syncLayersFromPlan(project.layers, proposedLayers);
  project.proposedLayers = proposedLayers;
  project.updatedAt = now;

  await projectService.writeProject(project);
  memory = await studioMemoryService.appendChangelog(project, {
    type: "preview",
    title: "Generated collection preview",
    detail: `Created preview ${previewId} with ${project.layers.length} active layers.`
  });
  memory = await refreshMemoryIfPossible(project, memory, apiKey);
  await refreshBrainIfPossible(project, memory, apiKey, {
    type: "preview",
    prompt: plan.previewPrompt,
    summary: plan.collectionSummary,
    analysis: previewAnalysis
  });

  return { project, memory, plan, preview: previewEntry };
}

async function generateLayerVariantsForProject(project, layerId, count, apiKey, options = {}) {
  const layer = project.layers.find((item) => item.id === layerId);
  if (!layer) {
    const error = new Error(`Layer ${layerId} was not found.`);
    error.status = 404;
    throw error;
  }

  let memory = await studioMemoryService.getMemory(project);
  const brain = await studioBrainService.getBrain();
  const toolManifest = await studioBrainService.getToolManifest();
  const plan = await openaiService.createLayerVariantPlan(
    apiKey,
    project,
    layer,
    count,
    memory,
    brain,
    toolManifest,
    options.attachments || []
  );
  const variantFolder = path.join(generatedDir, project.id, "layers", layer.id);
  await fs.mkdir(variantFolder, { recursive: true });

  const variants = [];
  const existingFitContract = getLayerFitContract(layer);
  const layerHadCommittedVariants = Array.isArray(layer.variants) && layer.variants.length > 0;
  let layerTransform = getLayerPlacementTransform(layer);
  const backgroundMode = isFullCanvasBackgroundLayerName(layer.name) ? "opaque" : "transparent";
  for (const item of plan.variants) {
    const imageAsset = await openaiService.generateImageAsset({
      apiKey,
      prompt: [item.prompt, cleanText(options.extraDirection)].filter(Boolean).join(" "),
      size: project.canvas.generationSize,
      background: backgroundMode
    });

    const variantId = createId("variant");
    const filename = `${variantId}.png`;
    const absolutePath = path.join(variantFolder, filename);
    const normalizedBuffer = await resizePng(imageAsset.buffer, project.canvas);
    const finalBuffer = isFullCanvasBackgroundLayerName(layer.name)
      ? await ensureOpaqueFullCanvasBackground(normalizedBuffer, item.prompt, project.canvas)
      : normalizedBuffer;
    await fs.writeFile(absolutePath, finalBuffer);
    const variantBuffer = await fs.readFile(absolutePath);
    const analysis = await inspectVariantAgainstLayer(layer, variantBuffer);
    if ((!layerHadCommittedVariants || !existingFitContract) && !variants.length) {
      const seededTransform =
        (await buildAnchorAwareLayerTransform(
          project,
          layer,
          {
            analysis,
            transform: layerTransform
          },
          [item.prompt, item.notes, cleanText(options.extraDirection)].filter(Boolean).join(" ")
        )) || layerTransform;
      layerTransform = seededTransform;
    }

    variants.push({
      id: variantId,
      name: item.name,
      notes: item.notes,
      prompt: item.prompt,
      imageUrl: `/generated/${project.id}/layers/${layer.id}/${filename}`,
      analysis,
      transformMode: "sync",
      transform: layerTransform,
      createdAt: new Date().toISOString()
    });
  }

  layer.variants.push(...variants);
  applyLayerPlacementTransform(layer, layerTransform);
  if (variants[0]) {
    refreshLayerFitContract(project, layer, variants[0], { force: !layerHadCommittedVariants || !existingFitContract });
  }
  if (!layer.selectedVariantId && variants[0]) {
    layer.selectedVariantId = variants[0].id;
  }

  project.updatedAt = new Date().toISOString();
  await projectService.writeProject(project);
  memory = await studioMemoryService.appendChangelog(project, {
    type: "variants",
    title: `Generated ${variants.length} ${layer.name} variants`,
    detail: variants.map((variant) => variant.name).join(", ")
  });
  memory = await refreshMemoryIfPossible(project, memory, apiKey);
  await refreshBrainIfPossible(project, memory, apiKey, {
    type: "variants",
    prompt: plan.variants.map((item) => item.prompt).join(" "),
    layerName: layer.name,
    summary: variants.map((variant) => variant.name).join(", "),
    analysis: summarizeVariantAnalysis(variants)
  });
  return { project, variants, memory };
}

async function generateDraftForProject(project, apiKey, options = {}) {
  project.draftHistory = Array.isArray(project.draftHistory) ? project.draftHistory : [];
  let targetLayerName = cleanText(options.targetLayerName) || "Unsorted";
  if (isTrueBackgroundPrompt(options.promptText)) {
    targetLayerName = "Background";
  } else if (isBackgroundAccentPrompt(options.promptText) && !cleanText(options.targetLayerName)) {
    targetLayerName = "Background Accent";
  }
  const fullCanvasBackground = isFullCanvasBackgroundLayerName(targetLayerName);
  const backgroundAccent = isBackgroundAccentLayerName(targetLayerName);
  const existingLayer = findLayer(project, targetLayerName);
  const ignoreStoredStructuralOverlayContract =
    cleanText(getLayerFitProfile(targetLayerName)?.id) === "surface-overlay" &&
    /\b(fit|fits|fitted|attach|attached|align|aligned|seat|seated|sit|sits|overlay|mapped|match|inside|recessed|middle|center(?:ed)?|flush|hinge|safe|vault|door|panel|plate)\b/.test(
      cleanText(options.promptText).toLowerCase()
    );
  const draftLayer = {
    id: cleanText(existingLayer?.id) || `draft-${slugify(targetLayerName) || "layer"}`,
    name: targetLayerName,
    description: cleanText(existingLayer?.description) || cleanText(options.extraDirection) || cleanText(options.promptText),
    placementNotes:
      cleanText(existingLayer?.placementNotes) ||
      (fullCanvasBackground
        ? "Full painted background plate that fills the entire canvas behind all other layers."
        : backgroundAccent
          ? "Transparent background accent for review before folder commit."
          : "Single isolated asset for draft review before folder commit."),
    variantIdeas: Array.isArray(existingLayer?.variantIdeas) ? existingLayer.variantIdeas : [],
    variants: [
      ...(Array.isArray(existingLayer?.variants)
        ? existingLayer.variants.map((item) => ({
            id: item.id,
            name: item.name,
            imageUrl: item.imageUrl,
            notes: item.notes,
            prompt: item.prompt
          }))
        : []),
      ...project.draftHistory
        .filter((item) => cleanText(item.targetLayerName) === targetLayerName)
        .map((item) => ({ id: item.id, name: item.name, imageUrl: item.imageUrl }))
    ],
    selectedVariantId: cleanText(existingLayer?.selectedVariantId) || null,
    transform: existingLayer?.transform || getDefaultTransformForLayer(targetLayerName),
    fitContract: ignoreStoredStructuralOverlayContract ? null : existingLayer?.fitContract || null
  };
  const draftAttachments = await extendDraftAttachmentsWithAnchorReference(
    project,
    draftLayer,
    options.promptText,
    options.attachments || []
  );

  let memory = await studioMemoryService.getMemory(project);
  const brain = await studioBrainService.getBrain();
  const toolManifest = await studioBrainService.getToolManifest();
  const plan = await openaiService.createLayerVariantPlan(
    apiKey,
    project,
    draftLayer,
    1,
    memory,
    brain,
    toolManifest,
    draftAttachments
  );
  const item = plan.variants[0];
  const draftPrompt = [item?.prompt, cleanText(options.extraDirection)].filter(Boolean).join(" ");
  const referenceImages = Array.isArray(draftAttachments)
    ? draftAttachments
        .map((attachment) => cleanText(attachment?.dataUrl))
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const imageAsset = shouldUseReferenceGuidedDraftRender(options.promptText, targetLayerName, draftAttachments)
    ? await openaiService.editImageAsset({
        apiKey,
        prompt: draftPrompt,
        images: referenceImages,
        background: fullCanvasBackground ? "opaque" : "transparent",
        inputFidelity: "high"
      })
    : await openaiService.generateImageAsset({
        apiKey,
        prompt: draftPrompt,
        size: project.canvas.generationSize,
        background: fullCanvasBackground ? "opaque" : "transparent"
      });

  const draftId = createId("draft");
  const draftFolder = path.join(generatedDir, project.id, "drafts");
  const filename = `${draftId}.png`;
  const absolutePath = path.join(draftFolder, filename);
  await fs.mkdir(draftFolder, { recursive: true });
  const normalizedDraftBuffer = await resizePng(imageAsset.buffer, project.canvas);
  const finalDraftBuffer = fullCanvasBackground
    ? await ensureOpaqueFullCanvasBackground(normalizedDraftBuffer, item?.prompt || options.promptText, project.canvas)
    : normalizedDraftBuffer;
  await fs.writeFile(absolutePath, finalDraftBuffer);
  const draftBuffer = await fs.readFile(absolutePath);
  const analysis = await inspectDraftAgainstHistory(project, draftBuffer);
  const draft = {
    id: draftId,
    type: "draft",
    name: item?.name || `${targetLayerName} Draft`,
    notes: item?.notes || "",
    prompt: item?.prompt || cleanText(options.promptText),
    imageUrl: `/generated/${project.id}/drafts/${filename}`,
    targetLayerName,
    analysis,
    status: "draft",
    createdAt: new Date().toISOString()
  };

  project.draftHistory.unshift(draft);
  project.draftHistory = project.draftHistory.slice(0, 30);
  project.updatedAt = new Date().toISOString();
  await projectService.writeProject(project);
  memory = await studioMemoryService.appendChangelog(project, {
    type: "draft",
    title: `Drafted ${draft.name}`,
    detail: `Pending review for ${targetLayerName}.`
  });
  memory = await refreshMemoryIfPossible(project, memory, apiKey);
  await refreshBrainIfPossible(project, memory, apiKey, {
    type: "draft",
    prompt: draft.prompt,
    layerName: targetLayerName,
    summary: draft.notes || draft.name,
    analysis
  });

  return { project, memory, draft };
}

function shouldUseReferenceGuidedDraftRender(promptText, targetLayerName, attachments = []) {
  const lowered = cleanText(promptText).toLowerCase();
  const items = Array.isArray(attachments) ? attachments : [];
  const hasReferenceImages = items.some((attachment) => cleanText(attachment?.dataUrl));
  if (!hasReferenceImages) {
    return false;
  }

  const hasSavedProjectReference = items.some((attachment) => cleanText(attachment?.referenceType) === "saved-project");
  const hasUploadReference = items.some((attachment) => cleanText(attachment?.imageUrl).startsWith("/uploads/"));
  const hasActiveAnchorReference = items.some((attachment) => cleanText(attachment?.referenceType) === "active-anchor");
  const explicitReferenceIntent =
    /\b(?:like|same as|similar to|match(?:ing)?|based on|using|use this|use that|inspired by|looks like)\b/.test(lowered) ||
    /\bfrom\s+(?:my\s+|the\s+)?[a-z0-9][a-z0-9\s-]{0,40}\s+project\b/.test(lowered);
  const fullCanvasBackground = isFullCanvasBackgroundLayerName(targetLayerName) || isTrueBackgroundPrompt(lowered);
  const fitProfileId = cleanText(getLayerFitProfile(targetLayerName)?.id).toLowerCase();
  const structuralOverlayTarget = fitProfileId === "surface-overlay";
  const structuralFitIntent =
    /\b(fit|fits|fitted|attach|attached|align|aligned|seat|seated|sit|sits|overlay|mapped|match|inside|recessed|middle|center(?:ed)?|flush|hinge)\b/.test(
      lowered
    ) && mentionsAnchorPlacementArea(lowered);

  return (
    hasSavedProjectReference ||
    (fullCanvasBackground && (hasUploadReference || explicitReferenceIntent)) ||
    ((hasActiveAnchorReference || hasUploadReference || explicitReferenceIntent) &&
      (structuralOverlayTarget || structuralFitIntent))
  );
}

async function extendDraftAttachmentsWithAnchorReference(project, layer, promptText, attachments = []) {
  const values = dedupeReferenceAttachments(Array.isArray(attachments) ? [...attachments] : []);
  if (!shouldAttachActiveAnchorToDraft(project, layer, promptText, values)) {
    return values.slice(0, 6);
  }

  const excludeUrls = values.map((attachment) => cleanText(attachment?.imageUrl)).filter(Boolean);
  const anchorReference = await getActiveAnchorReferenceAttachment(project, layer, excludeUrls);
  if (!anchorReference?.dataUrl) {
    return values.slice(0, 6);
  }

  values.push({
    ...anchorReference,
    mimeType: "image/png",
    width: Number(project?.canvas?.width || 0),
    height: Number(project?.canvas?.height || 0),
    referenceType: cleanText(anchorReference.referenceType) || "active-anchor",
    sourceType: cleanText(anchorReference.sourceType) || "active-anchor"
  });

  return dedupeReferenceAttachments(values).slice(0, 6);
}

function shouldAttachActiveAnchorToDraft(project, layer, promptText, attachments = []) {
  const fitProfileId = cleanText(getLayerFitProfile(layer?.name)?.id).toLowerCase();
  if (!project || !layer || !fitProfileId || fitProfileId === "background" || fitProfileId === "background-accent") {
    return false;
  }

  if (!getActiveAnchorLayer(project, layer)) {
    return false;
  }

  if ((Array.isArray(attachments) ? attachments : []).some((attachment) => cleanText(attachment?.referenceType) === "active-anchor")) {
    return false;
  }

  if (fitProfileId === "surface-overlay") {
    return true;
  }

  const lowered = cleanText(promptText).toLowerCase();
  return (
    /\b(fit|fits|fitted|attach|attached|align|aligned|seat|seated|sit|sits|overlay|mapped|match|inside|recessed|middle|center(?:ed)?|flush)\b/.test(
      lowered
    ) &&
    mentionsAnchorPlacementArea(lowered)
  );
}

async function reviseLayerVariantForProject(project, apiKey, options = {}) {
  const layer = options.layer;
  if (!layer) {
    const error = new Error("Layer not found for revision.");
    error.status = 404;
    throw error;
  }

  const removalTarget = cleanText(options.removalTarget);
  const selectedVariant = getSelectedLayerVariant(layer);
  let sourceVariant = findSourceVariantForLayerEdit(layer, options.promptText);
  if (!sourceVariant?.imageUrl) {
    const error = new Error("No layer image was available to revise.");
    error.status = 404;
    throw error;
  }

  let sourceAbsolutePath = publicAssetUrlToAbsolutePath(sourceVariant.imageUrl);
  let sourceBuffer = await fs.readFile(sourceAbsolutePath);
  let sourceAnalysis = await assetToolService.inspectPngBuffer(sourceBuffer);
  let sourceDataUrl = `data:image/png;base64,${sourceBuffer.toString("base64")}`;
  const shouldReplaceSelectedVariant =
    selectedVariant &&
    selectedVariant.id !== sourceVariant.id &&
    shouldPreferCleanHistoricalSource(layer, options.promptText, removalTarget, sourceAnalysis);

  if (shouldPreferCleanHistoricalSource(layer, options.promptText, removalTarget, sourceAnalysis)) {
    const cleanHistoricalSource = findRestorableLayerSource(project, layer, `${options.promptText} restore original clean`);
    if (cleanHistoricalSource?.imageUrl && cleanHistoricalSource.imageUrl !== sourceVariant.imageUrl) {
      sourceVariant = cleanHistoricalSource;
      sourceAbsolutePath = publicAssetUrlToAbsolutePath(sourceVariant.imageUrl);
      sourceBuffer = await fs.readFile(sourceAbsolutePath);
      sourceAnalysis = await assetToolService.inspectPngBuffer(sourceBuffer);
      sourceDataUrl = `data:image/png;base64,${sourceBuffer.toString("base64")}`;
    }
  }

  const anchorReference = await getActiveAnchorReferenceAttachment(project, layer, [sourceVariant.imageUrl]);
  const chatExampleReferences = await getChatExampleReferenceAttachments(project, layer, options.promptText, [
    sourceVariant.imageUrl,
    anchorReference?.imageUrl
  ]);
  const referenceImages = [
    sourceDataUrl,
    cleanText(anchorReference?.dataUrl),
    ...chatExampleReferences.map((attachment) => cleanText(attachment?.dataUrl)),
    ...(Array.isArray(options.attachments)
      ? options.attachments
          .map((attachment) => cleanText(attachment?.dataUrl))
          .filter(Boolean)
          .slice(0, 3)
      : [])
  ]
    .filter(Boolean)
    .slice(0, 8);
  const editPrompt = buildLayerRevisionPrompt(project, layer, sourceVariant, {
    promptText: options.promptText,
    removalTarget,
    extraDirection: options.extraDirection
  });

  const imageAsset = await openaiService.editImageAsset({
    apiKey,
    prompt: editPrompt,
    images: referenceImages,
    background: "transparent",
    inputFidelity: "high"
  });

  const variantFolder = path.join(generatedDir, project.id, "layers", layer.id);
  await fs.mkdir(variantFolder, { recursive: true });

  const variantId = createId("variant");
  const filename = `${variantId}.png`;
  const absolutePath = path.join(variantFolder, filename);
  await fs.writeFile(absolutePath, await resizePng(imageAsset.buffer, project.canvas));
  const variantBuffer = await fs.readFile(absolutePath);
  const analysis = await inspectVariantAgainstLayer(layer, variantBuffer);
  if (shouldRejectContaminatedLayerEdit(layer, sourceAnalysis, analysis)) {
    await fs.unlink(absolutePath).catch(() => {});
    const error = new Error(
      `The ${layer.name} edit pulled other layer content into the asset, so it was rejected to keep the layer isolated.`
    );
    error.status = 422;
    throw error;
  }

  const revisedTransformMode = normalizeVariantTransformMode(sourceVariant?.transformMode);
  const revisedTransform =
    revisedTransformMode === "custom"
      ? getVariantPlacementTransform(layer, sourceVariant)
      : getLayerPlacementTransform(layer, sourceVariant);
  const revisedVariant = {
    id: variantId,
    type: "variant",
    name: buildRevisedVariantName(layer, sourceVariant, removalTarget),
    notes: buildRevisedVariantNotes(sourceVariant, removalTarget),
    prompt: editPrompt,
    imageUrl: `/generated/${project.id}/layers/${layer.id}/${filename}`,
    targetLayerName: layer.name,
    status: "committed",
    analysis,
    transformMode: revisedTransformMode,
    transform: revisedTransform,
    createdAt: new Date().toISOString()
  };

  layer.variants = Array.isArray(layer.variants) ? layer.variants : [];
  const sourceIndex = shouldReplaceSelectedVariant
    ? layer.variants.findIndex((item) => item.id === selectedVariant.id)
    : layer.variants.findIndex((item) => item.id === sourceVariant.id);
  if (sourceIndex >= 0) {
    layer.variants[sourceIndex] = revisedVariant;
  } else {
    layer.variants.push(revisedVariant);
  }
  layer.selectedVariantId = revisedVariant.id;
  applyPlacementTransformForVariant(layer, revisedVariant, revisedTransform, revisedTransformMode);
  refreshLayerFitContract(project, layer, revisedVariant);
  if (isPrimaryBaseLayerName(layer.name)) {
    project.selectedPreviewId = null;
  }

  project.updatedAt = new Date().toISOString();
  await projectService.writeProject(project);

  let memory = await studioMemoryService.appendChangelog(project, {
    type: "edit-layer-variant",
    title: `Revised ${layer.name}`,
    detail: removalTarget
      ? `Removed ${removalTarget} from ${layer.name} and replaced the previous selected asset.`
      : `Revised ${layer.name} based on the latest edit request.`
  });
  memory = await refreshMemoryIfPossible(project, memory, apiKey);
  await refreshBrainIfPossible(project, memory, apiKey, {
    type: "edit-layer-variant",
    prompt: options.promptText,
    layerName: layer.name,
    summary: revisedVariant.notes,
    analysis
  });

  return {
    project,
    memory,
    layer,
    sourceVariant,
    variant: revisedVariant
  };
}

async function updateLayerVariantTransform(project, layer, options = {}) {
  const variant = findSourceVariantForLayerEdit(layer, options.promptText);
  if (!variant) {
    const error = new Error("No selected layer image was available to reposition.");
    error.status = 404;
    throw error;
  }

  const useVariantTransform = isVariantUsingCustomTransform(variant);
  const currentTransform = useVariantTransform
    ? getVariantPlacementTransform(layer, variant)
    : getLayerPlacementTransform(layer, variant);
  const nextTransform = mergeLayerTransform(
    currentTransform,
    inferTransformPatchFromPrompt(layer, options.promptText, currentTransform)
  );

  applyPlacementTransformForVariant(layer, variant, nextTransform, useVariantTransform ? "custom" : "sync");
  layer.selectedVariantId = variant.id;
  if (!useVariantTransform) {
    refreshLayerFitContract(project, layer, variant, { force: true });
    layer.region = computeRegionFromTransform(nextTransform, variant, project.canvas);
  }
  project.updatedAt = new Date().toISOString();
  await projectService.writeProject(project);

  let memory = await studioMemoryService.appendChangelog(project, {
    type: useVariantTransform ? "transform-custom-variant" : "transform-layer-variant",
    title: useVariantTransform ? `Updated ${variant.name} placement` : `Updated ${layer.name} placement`,
    detail: useVariantTransform
      ? `Moved ${variant.name} independently to x ${nextTransform.x}, y ${nextTransform.y}, scale ${nextTransform.scale}.`
      : `Moved ${variant.name} to x ${nextTransform.x}, y ${nextTransform.y}, scale ${nextTransform.scale}.`
  });
  memory = await refreshMemoryIfPossible(project, memory);

  return {
    project,
    memory,
    layer,
    variant
  };
}

async function restoreLayerVariantFromHistory(project, layer, promptText = "") {
  const source = findRestorableLayerSource(project, layer, promptText);
  if (!source?.imageUrl) {
    return {
      project,
      memory: await studioMemoryService.getMemory(project),
      layer,
      variant: null
    };
  }

  layer.variants = Array.isArray(layer.variants) ? layer.variants : [];
  const existingVariant =
    layer.variants.find((item) => item.imageUrl === source.imageUrl) ||
    layer.variants.find((item) => cleanText(item.name) === cleanText(source.name)) ||
    null;

  let variant = existingVariant;
  if (!variant) {
    const variantTransformMode = normalizeVariantTransformMode(source?.transformMode);
    variant = {
      id: createId("variant"),
      name: cleanText(source.name) || `${layer.name} Restored`,
      notes: cleanText(source.notes),
      prompt: cleanText(source.prompt),
      imageUrl: source.imageUrl,
      analysis: source.analysis || null,
      transformMode: variantTransformMode,
      transform:
        variantTransformMode === "custom"
          ? getVariantPlacementTransform(layer, source)
          : getLayerPlacementTransform(layer, source),
      createdAt: new Date().toISOString()
    };
    layer.variants.unshift(variant);
  }

  const variantTransformMode = normalizeVariantTransformMode(variant?.transformMode);
  const variantTransform =
    variantTransformMode === "custom"
      ? getVariantPlacementTransform(layer, variant)
      : getLayerPlacementTransform(layer, variant);
  applyPlacementTransformForVariant(layer, variant, variantTransform, variantTransformMode);
  layer.selectedVariantId = variant.id;
  refreshLayerFitContract(project, layer, variant);
  project.updatedAt = new Date().toISOString();
  await projectService.writeProject(project);

  let memory = await studioMemoryService.appendChangelog(project, {
    type: "restore-layer-variant",
    title: `Restored ${layer.name}`,
    detail: `Re-selected ${variant.name} from project history before applying placement changes.`
  });
  memory = await refreshMemoryIfPossible(project, memory);

  return {
    project,
    memory,
    layer,
    variant
  };
}

async function commitDraftToLayer(project, draftId, targetLayerName) {
  project.draftHistory = Array.isArray(project.draftHistory) ? project.draftHistory : [];
  const draft = project.draftHistory.find((item) => item.id === draftId);
  if (!draft) {
    const error = new Error("Draft not found.");
    error.status = 404;
    throw error;
  }

  return commitGeneratedSourceToLayer(project, draft, targetLayerName);
}

function syncRenamedLayerReferences(project, layerId, previousName, nextName) {
  const oldName = cleanText(previousName);
  const newName = cleanText(nextName);
  if (!oldName || !newName || oldName === newName) {
    return;
  }

  for (const draft of project.draftHistory || []) {
    if (cleanText(draft.committedLayerId) === cleanText(layerId)) {
      draft.committedLayerName = newName;
    }
    if (cleanText(draft.targetLayerName) === oldName) {
      draft.targetLayerName = newName;
    }
  }

  for (const message of project.chatHistory || []) {
    if (!message.generatedImage) {
      continue;
    }

    if (cleanText(message.generatedImage.committedLayerId) === cleanText(layerId)) {
      message.generatedImage.committedLayerName = newName;
      message.generatedImage.targetLayerName = newName;
      continue;
    }

    if (cleanText(message.generatedImage.targetLayerName) === oldName) {
      message.generatedImage.targetLayerName = newName;
    }
  }
}

function syncMovedVariantReferences(project, move) {
  const fromLayerId = cleanText(move?.fromLayer?.id);
  const toLayerId = cleanText(move?.toLayer?.id);
  const fromLayerName = cleanText(move?.fromLayer?.name);
  const toLayerName = cleanText(move?.toLayer?.name);
  const fromVariantId = cleanText(move?.fromVariantId);
  const toVariantId = cleanText(move?.toVariantId) || fromVariantId;
  const imageUrl = cleanText(move?.imageUrl);

  for (const draft of project.draftHistory || []) {
    if (cleanText(draft.committedVariantId) === fromVariantId) {
      draft.committedLayerId = toLayerId;
      draft.committedLayerName = toLayerName;
      draft.committedVariantId = toVariantId;
      draft.targetLayerName = toLayerName;
      draft.updatedAt = new Date().toISOString();
      continue;
    }

    if (imageUrl && cleanText(draft.imageUrl) === imageUrl && cleanText(draft.committedLayerId) === fromLayerId) {
      draft.committedLayerId = toLayerId;
      draft.committedLayerName = toLayerName;
      draft.committedVariantId = toVariantId;
      draft.targetLayerName = toLayerName;
      draft.updatedAt = new Date().toISOString();
    }
  }

  for (const message of project.chatHistory || []) {
    const image = message.generatedImage;
    if (!image) {
      continue;
    }

    if (imageUrl && cleanText(image.imageUrl) === imageUrl) {
      if (cleanText(image.targetLayerName) === fromLayerName || cleanText(image.targetLayerName) === toLayerName) {
        image.targetLayerName = toLayerName;
      }
      continue;
    }

    if (cleanText(image.targetLayerName) === fromLayerName && cleanText(image.status) === "committed") {
      image.targetLayerName = toLayerName;
    }
  }
}

async function commitGeneratedSourceToLayer(project, source, targetLayerName) {
  const layer = ensureLayer(project, targetLayerName || source.targetLayerName || "Accessory");
  if (!Array.isArray(layer.variants)) {
    layer.variants = [];
  }

  const existingVariant =
    layer.variants.find((item) => item.imageUrl === source.imageUrl) ||
    layer.variants.find(
      (item) =>
        cleanText(item.prompt) &&
        cleanText(item.prompt) === cleanText(source.prompt) &&
        cleanText(item.name) === cleanText(source.name)
    ) ||
    null;

  if (existingVariant) {
    applyPlacementTransformForVariant(
      layer,
      existingVariant,
      isVariantUsingCustomTransform(existingVariant)
        ? getVariantPlacementTransform(layer, existingVariant)
        : getLayerPlacementTransform(layer, existingVariant),
      existingVariant.transformMode
    );
    layer.selectedVariantId = existingVariant.id;
    refreshLayerFitContract(project, layer, existingVariant);
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    let memory = await studioMemoryService.appendChangelog(project, {
      type: "select-existing",
      title: `Reused ${existingVariant.name}`,
      detail: `Already present in ${layer.name}, so it was selected instead of duplicated.`
    });
    memory = await refreshMemoryIfPossible(project, memory);
    return {
      project,
      memory,
      source: {
        ...source,
        status: "committed",
        committedLayerId: layer.id,
        committedLayerName: layer.name,
        committedVariantId: existingVariant.id
      },
      layer,
      variant: existingVariant
    };
  }

  const layerHadCommittedVariants = layer.variants.length > 0;
  const existingFitContract = getLayerFitContract(layer);
  const forceStructuralOverlayReseed = shouldForceStructuralOverlayFitSeed(layer, source);
  let layerTransform = getLayerPlacementTransform(layer);
  const variant = {
    id: createId("variant"),
    name: cleanText(source.name) || `${layer.name} Variant`,
    notes: cleanText(source.notes),
    prompt: cleanText(source.prompt),
    imageUrl: source.imageUrl,
    analysis: source.analysis || null,
    transformMode: "sync",
    transform: layerTransform,
    createdAt: new Date().toISOString()
  };
  if (!layerHadCommittedVariants || !existingFitContract || forceStructuralOverlayReseed) {
    const seededTransform =
      (await buildAnchorAwareLayerTransform(
        project,
        layer,
        variant,
        [cleanText(source.prompt), cleanText(source.notes), cleanText(source.name)].filter(Boolean).join(" ")
      )) || layerTransform;
    layerTransform = seededTransform;
    variant.transform = seededTransform;
  }

  layer.variants.push(variant);
  applyLayerPlacementTransform(layer, layerTransform);
  layer.selectedVariantId = variant.id;
  refreshLayerFitContract(project, layer, variant, {
    force: !layerHadCommittedVariants || !existingFitContract || forceStructuralOverlayReseed
  });
  if (isPrimaryBaseLayerName(layer.name)) {
    project.selectedPreviewId = null;
  }

  const draft = Array.isArray(project.draftHistory)
    ? project.draftHistory.find((item) => item.id === source.id)
    : null;
  if (draft) {
    draft.status = "committed";
    draft.committedLayerId = layer.id;
    draft.committedLayerName = layer.name;
    draft.committedVariantId = variant.id;
    draft.updatedAt = new Date().toISOString();
  }

  project.updatedAt = new Date().toISOString();
  await projectService.writeProject(project);

  let memory = await studioMemoryService.appendChangelog(project, {
    type: "commit-draft",
    title: `Committed ${variant.name}`,
    detail: `Added to ${layer.name}.`
  });
  memory = await refreshMemoryIfPossible(project, memory);
  return {
    project,
    memory,
    source: {
      ...source,
      status: "committed",
      committedLayerId: layer.id,
      committedLayerName: layer.name,
      committedVariantId: variant.id
    },
    layer,
    variant
  };
}

function ensureLayer(project, layerName) {
  const existing = findLayer(project, layerName);
  if (existing) {
    return existing;
  }

  return createEmptyLayer(project, layerName);
}

function createEmptyLayer(project, layerName) {
  const normalizedName = cleanText(layerName) || "Layer";
  const layer = {
    id: `${createId("layer")}-${slugify(normalizedName) || "layer"}`,
    name: normalizedName,
    description: "",
    placementNotes: "",
    variantIdeas: [],
    variants: [],
    selectedVariantId: null,
    transform: getDefaultTransformForLayer(normalizedName),
    fitContract: null
  };
  project.layers.push(layer);
  return layer;
}

function shouldForceFreshTraitDraft(project, promptText, route = {}) {
  const lowered = cleanText(promptText).toLowerCase();
  const routedAction = cleanText(route.actionType).toLowerCase();
  const explicitPromptLayer = extractLayerLookupFromPrompt(promptText);
  const explicitPromptTarget =
    (explicitPromptLayer ? findExactLayer(project, explicitPromptLayer) : null) ||
    (explicitPromptLayer ? findLayer(project, explicitPromptLayer) : null) ||
    null;
  const guessedLayerName = cleanText(route.targetLayerName) || cleanText(explicitPromptTarget?.name) || guessLayerNameFromPrompt(promptText);
  const matchingExistingLayer = guessedLayerName ? findLayer(project, guessedLayerName) || explicitPromptTarget : explicitPromptTarget;
  const keepExistingIntent = hasKeepExistingTraitIntent(lowered);
  const explicitSeparateFolderIntent = hasExplicitSeparateFolderIntent(lowered);
  const freshNamedLayerIntent = hasFreshAssetForNamedLayerIntent(lowered);
  const targetLayerIsEmpty = !Array.isArray(matchingExistingLayer?.variants) || matchingExistingLayer.variants.length === 0;
  const freshCreationIntent =
    /\b(add|draw|make|create|generate|design|craft|show|give|build|draft)\b/.test(lowered) ||
    /\b(new|another|fresh|different)\b/.test(lowered);

  if (!freshCreationIntent) {
    return false;
  }

  if (
    !keepExistingIntent &&
    !explicitSeparateFolderIntent &&
    !freshNamedLayerIntent &&
    !targetLayerIsEmpty &&
    mentionsExplicitExistingLayerMutation(lowered)
  ) {
    return false;
  }

  if (["commit_draft", "remove_variant", "remove_layer", "update_canvas"].includes(routedAction)) {
    return false;
  }

  if (keepExistingIntent || explicitSeparateFolderIntent || freshNamedLayerIntent) {
    return true;
  }

  if (!matchingExistingLayer && !["edit_layer_variant", "transform_layer_variant", "draft_variant", "add_variant"].includes(routedAction)) {
    return false;
  }

  return Boolean(matchingExistingLayer) || ["edit_layer_variant", "transform_layer_variant"].includes(routedAction);
}

function mentionsExplicitExistingLayerMutation(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  return (
    isFeatureRemovalPrompt(lowered) ||
    isLayerTransformPrompt(lowered) ||
    shouldAlsoVisuallyEditLayer(lowered) ||
    /(edit|revise|modify|update|rework|fix|replace|overwrite|restore|revert|put .* back|back into|existing layer|existing folder|current layer|current folder|same layer|same folder|selected layer|selected folder|use the current|go back into)/.test(
      lowered
    ) ||
    /\b(?:put|save|commit)\b[\s\S]*\b(layer|folder)\b/.test(
      lowered
    ) ||
    /\badd\b[\s\S]*\b(?:to|into|back into)\b[\s\S]*\b(layer|folder)\b/.test(
      lowered
    )
  );
}

function hasFreshAssetForNamedLayerIntent(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  return /\b(add|draw|make|create|generate|design|craft|build|draft)\b[\s\S]*\bfor\b[\s\S]*\b(layer|folder)\b/.test(
    lowered
  );
}

function hasKeepExistingTraitIntent(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  return (
    /(leave|keep)\s+(?:the\s+)?(?:old|existing|current|other)\s+(?:one|layer|folder|trait|version)\b/.test(lowered) ||
    /\b(?:leave|keep)\b[\s\S]*\b(?:alone|also|too|as well)\b/.test(lowered) ||
    /\b(?:don't|do not)\s+(?:replace|overwrite|touch|edit|change)\b/.test(lowered) ||
    /\bwithout\s+(?:touching|editing|changing|replacing)\b/.test(lowered)
  );
}

function hasExplicitSeparateFolderIntent(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  return (
    /\b(?:separate|different)\b[\s\S]*\b(?:layer|folder)\b/.test(lowered) ||
    /\bits own\b[\s\S]*\b(?:layer|folder)\b/.test(lowered) ||
    /\bon its own\b[\s\S]*\b(?:layer|folder)\b/.test(lowered)
  );
}

function isBackgroundAccentPrompt(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  return (
    /\bbackground accent\b/.test(lowered) ||
    /\baccent background\b/.test(lowered) ||
    /\bhalo\b/.test(lowered) ||
    /\baura\b/.test(lowered) ||
    /\bglow\b/.test(lowered) ||
    /\bring\b/.test(lowered) ||
    /\bburst\b/.test(lowered)
  );
}

function isTrueBackgroundPrompt(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  if (!/\bbackground\b|\bbg\b|\bbackdrop\b|\bscene\b/.test(lowered)) {
    return false;
  }

  if (isBackgroundAccentPrompt(lowered)) {
    return false;
  }

  return (
    /\btrue background\b/.test(lowered) ||
    /\bfull background\b/.test(lowered) ||
    /\bfull paint background\b/.test(lowered) ||
    /\bfull canvas background\b/.test(lowered) ||
    /\bfull bleed\b/.test(lowered) ||
    /\bfill(?:s|ing)? the canvas\b/.test(lowered) ||
    /\bentire canvas\b/.test(lowered) ||
    /\bwhole canvas\b/.test(lowered) ||
    /\bedge to edge\b/.test(lowered) ||
    /\bbehind everything\b/.test(lowered) ||
    /\bsolid white\b/.test(lowered) ||
    /\bsolid black\b/.test(lowered) ||
    /\bsolid color\b/.test(lowered)
  );
}

function resolveDraftTargetLayerName(project, promptText, route = {}) {
  const explicitTarget = cleanText(route.targetLayerName);
  const explicitPromptLookup = cleanText(extractLayerLookupFromPrompt(promptText));
  const explicitPromptTarget =
    (explicitPromptLookup ? findExactLayer(project, explicitPromptLookup) : null) ||
    (explicitPromptLookup ? findLayer(project, explicitPromptLookup) : null) ||
    null;
  const semanticTarget = guessLayerNameFromPrompt(promptText);
  const guessedTarget = explicitTarget || cleanText(explicitPromptTarget?.name) || semanticTarget;
  const separateFolderIntent = hasExplicitSeparateFolderIntent(promptText);
  const existingSemanticTarget = semanticTarget ? findLayer(project, semanticTarget) : null;
  const fullBackgroundIntent = isTrueBackgroundPrompt(promptText);
  const accentBackgroundIntent = isBackgroundAccentPrompt(promptText);

  if (fullBackgroundIntent) {
    const existingBackground =
      (explicitTarget && !isBackgroundAccentPrompt(explicitTarget) ? findExactLayer(project, explicitTarget) : null) ||
      findExactLayer(project, "Background") ||
      findLayerByFitProfileId(project, "background");
    if (existingBackground && !separateFolderIntent) {
      return existingBackground.name;
    }
    if (explicitTarget && !isBackgroundAccentPrompt(explicitTarget)) {
      return separateFolderIntent ? makeUniqueLayerName(project, explicitTarget) : explicitTarget;
    }
    return separateFolderIntent ? makeUniqueLayerName(project, "Background") : "Background";
  }

  if (accentBackgroundIntent) {
    const existingBackgroundAccent =
      (explicitTarget ? findExactLayer(project, explicitTarget) : null) ||
      findExactLayer(project, "Background Accent") ||
      findLayerByFitProfileId(project, "background-accent");
    if (existingBackgroundAccent && !separateFolderIntent) {
      return existingBackgroundAccent.name;
    }
    if (explicitTarget) {
      return separateFolderIntent ? makeUniqueLayerName(project, explicitTarget) : explicitTarget;
    }
    return separateFolderIntent ? makeUniqueLayerName(project, "Background Accent") : "Background Accent";
  }

  if (explicitTarget) {
    const existingExplicitTarget = findLayer(project, explicitTarget);
    if (existingExplicitTarget && !separateFolderIntent) {
      return existingExplicitTarget.name;
    }
    if (existingSemanticTarget && !separateFolderIntent) {
      return existingSemanticTarget.name;
    }
    if (!existingExplicitTarget) {
      return explicitTarget;
    }
  }

  if (explicitPromptTarget && !separateFolderIntent) {
    return explicitPromptTarget.name;
  }

  const existingSuggestedTarget = guessedTarget ? findLayer(project, guessedTarget) : null;
  if (existingSuggestedTarget && !separateFolderIntent) {
    return existingSuggestedTarget.name;
  }

  if (separateFolderIntent) {
    return resolveFreshTraitDraftLayerName(project, promptText, route);
  }

  return guessedTarget || resolveFreshTraitDraftLayerName(project, promptText, route);
}

function resolveFreshTraitDraftLayerName(project, promptText, route = {}) {
  const explicitTarget = cleanText(route.targetLayerName);
  if (explicitTarget && !findLayer(project, explicitTarget)) {
    return explicitTarget;
  }

  const hintedName = cleanText(route.variantNameHint);
  if (hintedName && !isGenericTraitLayerName(hintedName)) {
    return makeUniqueLayerName(project, titleCaseWords(hintedName));
  }

  const extractedName = extractFreshTraitName(promptText);
  if (extractedName && !isGenericTraitLayerName(extractedName)) {
    return makeUniqueLayerName(project, extractedName);
  }

  const guessedLayerName = cleanText(route.targetLayerName) || guessLayerNameFromPrompt(promptText);
  if (guessedLayerName) {
    const genericFallback = isGenericTraitLayerName(guessedLayerName)
      ? buildGenericFreshLayerName(promptText, guessedLayerName)
      : guessedLayerName;
    return makeUniqueLayerName(project, genericFallback);
  }

  return makeUniqueLayerName(project, "New Trait");
}

function resolveLayerEditTarget(project, promptText, route = {}) {
  const lowered = cleanText(promptText).toLowerCase();
  const explicitEdit = cleanText(route.actionType).toLowerCase() === "edit_layer_variant";
  const visualEdit = shouldAlsoVisuallyEditLayer(promptText);
  if (!isFeatureRemovalPrompt(lowered) && !explicitEdit && !visualEdit) {
    return null;
  }

  const layer =
    findLayer(project, route.targetLayerName) ||
    findLayer(project, extractLayerLookupFromPrompt(promptText)) ||
    findLayer(project, guessLayerNameFromPrompt(promptText)) ||
    findLikelyLayerForEdit(project, promptText);

  if (!layer) {
    return null;
  }

  if (isAccessoryLayerName(layer.name) && isLayerTransformPrompt(lowered) && !visualEdit && !isFeatureRemovalPrompt(lowered)) {
    return null;
  }

  const removalTarget = cleanText(route.removalTarget) || extractRemovalTargetFromPrompt(promptText);
  return {
    layer,
    removalTarget
  };
}

function isFeatureRemovalPrompt(loweredPrompt) {
  return /(remove|without|take off|take the|strip|erase)/.test(cleanText(loweredPrompt).toLowerCase());
}

function resolveLayerTransformTarget(project, promptText, route = {}) {
  const lowered = cleanText(promptText).toLowerCase();
  const explicitTransform = cleanText(route.actionType).toLowerCase() === "transform_layer_variant";
  if (!isLayerTransformPrompt(lowered) && !explicitTransform) {
    return null;
  }

  const layer =
    findLayer(project, route.targetLayerName) ||
    findLayer(project, extractLayerLookupFromPrompt(promptText)) ||
    findLayer(project, guessLayerNameFromPrompt(promptText)) ||
    findLikelyLayerForEdit(project, promptText);

  if (!layer) {
    return null;
  }

  return { layer };
}

function isLayerTransformPrompt(loweredPrompt) {
  return /(rework|adjust|align|move|shift|resize|position|sit|place|fit|tuck|lower|raise|nudge|center|bigger|smaller|scale|closer|higher|up on|up onto|all the way|wider|width|span|broader|narrower|tighter|slimmer)/.test(
    cleanText(loweredPrompt).toLowerCase()
  );
}

function findLayer(project, lookup) {
  const token = slugify(lookup || "");
  if (!token) {
    return null;
  }

  return (
    project.layers.find((layer) => slugify(layer.name) === token) ||
    project.layers.find((layer) => slugify(layer.name).includes(token)) ||
    null
  );
}

function isBackgroundAccentLayerName(layerName) {
  return cleanText(getLayerFitProfile(layerName)?.id).toLowerCase() === "background-accent";
}

function isFullCanvasBackgroundLayerName(layerName) {
  return cleanText(getLayerFitProfile(layerName)?.id).toLowerCase() === "background";
}

function inferSolidBackgroundColor(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  if (/\bwhite\b/.test(lowered)) {
    return { r: 255, g: 255, b: 255, alpha: 1 };
  }
  if (/\bblack\b/.test(lowered)) {
    return { r: 0, g: 0, b: 0, alpha: 1 };
  }
  if (/\bblue\b/.test(lowered)) {
    return { r: 52, g: 88, b: 255, alpha: 1 };
  }
  if (/\bred\b/.test(lowered)) {
    return { r: 210, g: 44, b: 44, alpha: 1 };
  }
  if (/\bgreen\b/.test(lowered)) {
    return { r: 44, g: 170, b: 92, alpha: 1 };
  }
  if (/\bpurple\b/.test(lowered)) {
    return { r: 118, g: 74, b: 200, alpha: 1 };
  }
  if (/\bpink\b/.test(lowered)) {
    return { r: 232, g: 118, b: 176, alpha: 1 };
  }
  if (/\bgold\b|\byellow\b/.test(lowered)) {
    return { r: 226, g: 188, b: 61, alpha: 1 };
  }
  if (/\borange\b/.test(lowered)) {
    return { r: 232, g: 133, b: 58, alpha: 1 };
  }
  if (/\bgray\b|\bgrey\b/.test(lowered)) {
    return { r: 126, g: 126, b: 126, alpha: 1 };
  }

  return { r: 18, g: 18, b: 22, alpha: 1 };
}

async function ensureOpaqueFullCanvasBackground(buffer, promptText, canvas) {
  const analysis = await assetToolService.inspectPngBuffer(buffer);
  if (Number(analysis?.alphaCoverage || 0) >= 0.92) {
    return buffer;
  }

  const background = inferSolidBackgroundColor(promptText);
  return sharp({
    create: {
      width: Math.max(1, Number(canvas?.width || 1024)),
      height: Math.max(1, Number(canvas?.height || 1024)),
      channels: 4,
      background
    }
  })
    .composite([{ input: buffer, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

function findExactLayer(project, lookup) {
  const token = slugify(lookup || "");
  if (!token) {
    return null;
  }

  return project.layers.find((layer) => slugify(layer.name) === token) || null;
}

function findLayerByFitProfileId(project, profileId) {
  const targetId = cleanText(profileId).toLowerCase();
  if (!targetId) {
    return null;
  }

  return (
    (project.layers || []).find(
      (layer) => cleanText(getLayerFitProfile(layer.name)?.id).toLowerCase() === targetId
    ) || null
  );
}

function findLikelyLayerForEdit(project, promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  const tokens = extractPromptTokens(promptText);
  const handIntent = mentionsHandPlacementArea(lowered);
  let bestLayer = null;
  let bestScore = 0;

  for (const layer of project.layers || []) {
    let score = 0;
    const layerName = cleanText(layer.name).toLowerCase();
    const layerDescription = cleanText(layer.description).toLowerCase();
    const fitProfile = getLayerFitProfile(layer.name);
    const hasSelectedVariant = Boolean(
      Array.isArray(layer.variants) && layer.variants.find((item) => item.id === layer.selectedVariantId)
    );

    if (layerName && lowered.includes(layerName)) {
      score += 20;
    }

    if (/crown|tiara|headwear|hat/.test(lowered) && /headwear|hat/.test(layerName)) {
      score += 18;
    }

    if (/base cat|cat base|base layer/.test(lowered) && /base|body|character/.test(layerName)) {
      score += 18;
    }

    if (handIntent && cleanText(fitProfile?.id) === "handheld") {
      score += 26;
    }

    if (handIntent && /(weapon|sword|staff|wand|gun|tool|prop|item|orb|flower|cane|bat|microphone)/.test(layerName)) {
      score += 18;
    }

    if (handIntent && hasSelectedVariant && !isPrimaryBaseLayerName(layer.name)) {
      score += 6;
    }

    for (const token of tokens) {
      if (layerName.includes(token)) {
        score += 6;
      }
      if (layerDescription.includes(token)) {
        score += 2;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestLayer = layer;
    }
  }

  return bestScore > 0 ? bestLayer : null;
}

function removeVariantFromLayer(layer, lookup) {
  const token = slugify(lookup || "");
  const variant =
    layer.variants.find((item) => slugify(item.name) === token) ||
    layer.variants.find((item) => slugify(item.name).includes(token)) ||
    layer.variants.find((item) => item.id === lookup) ||
    null;

  if (!variant) {
    return null;
  }

  layer.variants = layer.variants.filter((item) => item.id !== variant.id);
  return variant;
}

function findSourceVariantForLayerEdit(layer, promptText) {
  const variants = Array.isArray(layer?.variants) ? layer.variants : [];
  if (!variants.length) {
    return null;
  }

  const token = slugify(extractRemovalTargetFromPrompt(promptText));
  if (token) {
    const matched = variants.find((item) => slugify(item.name).includes(token));
    if (matched) {
      return matched;
    }
  }

  return variants.find((item) => item.id === layer.selectedVariantId) || variants[0] || null;
}

function getSelectedLayerVariant(layer) {
  const variants = Array.isArray(layer?.variants) ? layer.variants : [];
  return variants.find((item) => item.id === layer.selectedVariantId) || null;
}

function shouldForcePureTraitRestore(layer, promptText, removalTarget = "") {
  if (!isAccessoryLayerName(layer?.name)) {
    return false;
  }

  const loweredPrompt = cleanText(promptText).toLowerCase();
  const loweredTarget = cleanText(removalTarget).toLowerCase();
  return (
    shouldRestoreAccessoryLayerFromCleanSource(layer, promptText, removalTarget) ||
    /(revert|restore|just the|only the|trait only|pure trait|crown only|no cat|no head|without cat|without head)/.test(loweredPrompt) ||
    /(cat|head|body|character|avatar|subject|construct)/.test(loweredTarget)
  );
}

function shouldRebuildPureTraitAsset(layer, promptText, removalTarget = "") {
  if (!isAccessoryLayerName(layer?.name)) {
    return false;
  }

  const loweredPrompt = cleanText(promptText).toLowerCase();
  const loweredTarget = cleanText(removalTarget).toLowerCase();
  const selectedAnalysis = getSelectedLayerVariant(layer)?.analysis || null;
  const contaminatedSelected = isLikelyContaminatedAccessoryAnalysis(layer, selectedAnalysis);
  const pureTraitIntent =
    /(just the|only the|trait only|pure trait|isolated asset|single asset|single layer asset|singular asset|crown only|hat only|headwear only|no cat|no head|without cat|without head|without body|remove .* from .* layer)/.test(
      loweredPrompt
    ) ||
    /(cat|head|face|body|character|avatar|subject|construct)/.test(loweredTarget);

  return contaminatedSelected && pureTraitIntent;
}

function shouldRestoreAccessoryLayerFromCleanSource(layer, promptText, removalTarget = "") {
  return shouldPreferCleanHistoricalSource(
    layer,
    promptText,
    removalTarget,
    getSelectedLayerVariant(layer)?.analysis || null
  );
}

function normalizeLayerTransform(transform) {
  const rawRotation = Number(transform?.rotation);
  const rotation = Number.isFinite(rawRotation) ? ((rawRotation % 360) + 360) % 360 : 0;
  return {
    x: clampTransformNumber(transform?.x, 0, -0.45, 0.45),
    y: clampTransformNumber(transform?.y, 0, -0.45, 0.45),
    scale: clampTransformNumber(transform?.scale, 1, 0.15, 1.8),
    rotation,
    depthMode: cleanText(transform?.depthMode).toLowerCase() === "headwear_wrap" ? "headwear_wrap" : "flat",
    backCutoff: clampTransformNumber(transform?.backCutoff, 0.6, 0.2, 0.9),
    frontStart: clampTransformNumber(transform?.frontStart, 0.56, 0.1, 0.95)
  };
}

function normalizeVariantTransformMode(mode) {
  return cleanText(mode).toLowerCase() === "custom" ? "custom" : "sync";
}

function isVariantUsingCustomTransform(variant) {
  return normalizeVariantTransformMode(variant?.transformMode) === "custom";
}

function getLayerPlacementTransform(layer, fallbackVariant = null) {
  const selectedVariant = getSelectedLayerVariant(layer);
  const fallbackTransform =
    fallbackVariant && !isVariantUsingCustomTransform(fallbackVariant) ? fallbackVariant.transform : null;
  const selectedTransform =
    selectedVariant && !isVariantUsingCustomTransform(selectedVariant) ? selectedVariant.transform : null;
  return normalizeLayerTransform(
    layer?.transform ||
      fallbackTransform ||
      selectedTransform ||
      getDefaultTransformForLayer(layer?.name)
  );
}

function getVariantPlacementTransform(layer, variant = null) {
  if (variant && isVariantUsingCustomTransform(variant)) {
    return normalizeLayerTransform(variant.transform || getLayerPlacementTransform(layer, variant));
  }

  return getLayerPlacementTransform(layer, variant);
}

function applyLayerPlacementTransform(layer, transform) {
  const nextTransform = normalizeLayerTransform(transform || getLayerPlacementTransform(layer));
  layer.transform = nextTransform;

  if (Array.isArray(layer?.variants)) {
    for (const variant of layer.variants) {
      if (!variant) {
        continue;
      }
      if (isVariantUsingCustomTransform(variant)) {
        continue;
      }
      variant.transformMode = "sync";
      variant.transform = nextTransform;
    }
  }

  return nextTransform;
}

function applyVariantPlacementTransform(layer, variant, transform) {
  const nextTransform = normalizeLayerTransform(transform || getVariantPlacementTransform(layer, variant));
  variant.transformMode = "custom";
  variant.transform = nextTransform;
  return nextTransform;
}

function resyncVariantPlacementTransform(layer, variant) {
  const nextTransform = getLayerPlacementTransform(layer, variant);
  variant.transformMode = "sync";
  variant.transform = nextTransform;
  return nextTransform;
}

function applyPlacementTransformForVariant(layer, variant, transform, mode = variant?.transformMode) {
  if (variant && normalizeVariantTransformMode(mode) === "custom") {
    return applyVariantPlacementTransform(layer, variant, transform);
  }

  if (variant) {
    variant.transformMode = "sync";
  }

  return applyLayerPlacementTransform(layer, transform);
}

function getVariantCanvasBounds(project, layer, variant, transform = getVariantPlacementTransform(layer, variant)) {
  const analysis = variant?.analysis || null;
  if (!analysis) {
    return null;
  }

  const canvasWidth = Math.max(1, Number(project?.canvas?.width || analysis.width || 1024));
  const canvasHeight = Math.max(1, Number(project?.canvas?.height || analysis.height || 1024));
  const imageWidth = Math.max(1, Number(analysis.width || canvasWidth));
  const imageHeight = Math.max(1, Number(analysis.height || canvasHeight));
  const safeTransform = normalizeLayerTransform(transform || getVariantPlacementTransform(layer, variant));
  const scale = Math.max(0.01, Number(safeTransform.scale || 1));
  const scaledWidth = imageWidth * scale;
  const scaledHeight = imageHeight * scale;
  const drawLeft = (canvasWidth - scaledWidth) / 2 + Number(safeTransform.x || 0) * canvasWidth;
  const drawTop = (canvasHeight - scaledHeight) / 2 + Number(safeTransform.y || 0) * canvasHeight;
  const bounds = analysis?.bounds || {
    left: 0,
    top: 0,
    right: imageWidth - 1,
    bottom: imageHeight - 1
  };
  const width = Math.max(1, (Number(bounds.right) - Number(bounds.left) + 1) * scale);
  const height = Math.max(1, (Number(bounds.bottom) - Number(bounds.top) + 1) * scale);
  const left = drawLeft + Number(bounds.left) * scale;
  const top = drawTop + Number(bounds.top) * scale;

  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    centerX: left + width / 2,
    centerY: top + height / 2
  };
}

function formatContractPercent(value) {
  if (!Number.isFinite(Number(value))) {
    return "";
  }
  return `${Math.round(Number(value) * 100)}%`;
}

function formatContractSignedPercent(value) {
  if (!Number.isFinite(Number(value))) {
    return "";
  }
  const percent = Math.round(Number(value) * 100);
  return `${percent > 0 ? "+" : ""}${percent}%`;
}

function buildLayerFitContractSummary(layer, contract) {
  const safeContract = normalizeLayerFitContract(contract);
  if (!safeContract) {
    return "";
  }

  const label = cleanText(safeContract.profileLabel) || cleanText(layer?.name) || "trait";
  const reference = cleanText(safeContract.referenceVariantName) || cleanText(layer?.name) || "approved layer";

  if (safeContract.scope === "anchor" && cleanText(safeContract.anchorLayerName)) {
    if (cleanText(safeContract.profileId) === "surface-overlay") {
      const widthText = formatContractPercent(safeContract.targetWidthRatio);
      const heightText = formatContractPercent(safeContract.targetHeightRatio);
      const topText = formatContractPercent(safeContract.targetTopRatio);
      const centerYText = formatContractPercent(safeContract.targetCenterYRatio);
      const offsetText =
        Number.isFinite(Number(safeContract.targetCenterXOffsetRatio)) && Math.abs(Number(safeContract.targetCenterXOffsetRatio)) > 0.01
          ? ` with horizontal offset ${formatContractSignedPercent(safeContract.targetCenterXOffsetRatio)}`
          : " centered";
      return `Approved interchangeable ${label} family contract from ${reference}: keep every ${layer?.name || "layer"} variant about ${widthText || "similar width"} by ${heightText || "similar height"} of ${safeContract.anchorLayerName}, seated on the visible front surface with top near ${topText || centerYText || "the same front-face position"}${offsetText}.`;
    }

    const widthText = formatContractPercent(safeContract.targetWidthRatio);
    const yText =
      cleanText(safeContract.profileId) === "eyewear"
        ? `center at about ${formatContractPercent(safeContract.targetCenterYRatio)} of ${safeContract.anchorLayerName}'s height`
        : `seat at about ${formatContractPercent(safeContract.targetBottomRatio)} of ${safeContract.anchorLayerName}'s height`;
    const offsetText =
      Number.isFinite(Number(safeContract.targetCenterXOffsetRatio)) && Math.abs(Number(safeContract.targetCenterXOffsetRatio)) > 0.01
        ? ` with horizontal offset ${formatContractSignedPercent(safeContract.targetCenterXOffsetRatio)}`
        : " centered";
    const wrapBack = formatContractPercent(safeContract.backCutoff);
    const wrapFront = formatContractPercent(safeContract.frontStart);
    const clipText =
      cleanText(safeContract.depthMode) === "headwear_wrap" && wrapBack && wrapFront
        ? ` Keep the same wrap overlap (${wrapBack} back cutoff / ${wrapFront} front start).`
        : "";
    return `Approved interchangeable ${label} family contract from ${reference}: keep every ${layer?.name || "layer"} variant about ${widthText || "similar width"} of ${safeContract.anchorLayerName}, ${yText}${offsetText}.${clipText}`;
  }

  if (safeContract.scope === "canvas") {
    const widthText = formatContractPercent(safeContract.canvasWidthRatio);
    const heightText = formatContractPercent(safeContract.canvasHeightRatio);
    const centerYText = formatContractPercent(safeContract.canvasCenterYRatio);
    return `Approved interchangeable ${label} family contract from ${reference}: keep the visible footprint about ${widthText || "similar width"} by ${heightText || "similar height"} of the canvas with center height near ${centerYText || "the same vertical seat"} so swaps preserve stack quality.`;
  }

  return cleanText(safeContract.summary);
}

function buildLayerFitContract(project, layer, preferredVariant = null) {
  if (!layer) {
    return null;
  }

  const variant =
    preferredVariant ||
    getSelectedLayerVariant(layer) ||
    (Array.isArray(layer?.variants) ? layer.variants[0] : null) ||
    null;
  if (!variant) {
    return null;
  }

  const transform = getVariantPlacementTransform(layer, variant);
  const fitProfile = getLayerFitProfile(layer.name);
  const variantBounds = getVariantCanvasBounds(project, layer, variant, transform);
  const canvasWidth = Math.max(1, Number(project?.canvas?.width || variant?.analysis?.width || 1024));
  const canvasHeight = Math.max(1, Number(project?.canvas?.height || variant?.analysis?.height || 1024));
  const baseContract = {
    profileId: cleanText(fitProfile?.id),
    profileLabel: cleanText(fitProfile?.label) || cleanText(layer.name),
    referenceVariantId: cleanText(variant.id),
    referenceVariantName: cleanText(variant.name),
    depthMode: cleanText(transform.depthMode),
    clipStrategy: cleanText(fitProfile?.clipStrategy),
    backCutoff: Number(transform.backCutoff),
    frontStart: Number(transform.frontStart),
    updatedAt: new Date().toISOString()
  };

  const shouldAnchorToAnotherLayer = !isPrimaryBaseLayerName(layer.name);
  const anchor = shouldAnchorToAnotherLayer ? getActiveAnchorLayer(project, layer) : null;
  const anchorBounds =
    anchor?.layer && anchor?.variant
      ? getVariantCanvasBounds(project, anchor.layer, anchor.variant, getVariantPlacementTransform(anchor.layer, anchor.variant))
      : null;

  if (variantBounds && anchorBounds) {
    const anchorWidth = Math.max(1, Number(anchorBounds.width || 1));
    const anchorHeight = Math.max(1, Number(anchorBounds.height || 1));
    const contract = normalizeLayerFitContract({
      ...baseContract,
      scope: "anchor",
      anchorLayerId: cleanText(anchor.layer.id),
      anchorLayerName: cleanText(anchor.layer.name),
      anchorVariantId: cleanText(anchor.variant.id),
      anchorVariantName: cleanText(anchor.variant.name),
      targetWidthRatio: Number(variantBounds.width) / anchorWidth,
      targetHeightRatio: Number(variantBounds.height) / anchorHeight,
      targetCenterXOffsetRatio: (Number(variantBounds.centerX) - Number(anchorBounds.centerX)) / anchorWidth,
      targetCenterYRatio: (Number(variantBounds.centerY) - Number(anchorBounds.top)) / anchorHeight,
      targetTopRatio: (Number(variantBounds.top) - Number(anchorBounds.top)) / anchorHeight,
      targetBottomRatio: (Number(variantBounds.bottom) - Number(anchorBounds.top)) / anchorHeight
    });
    if (contract) {
      contract.summary = buildLayerFitContractSummary(layer, contract);
    }
    return contract;
  }

  if (variantBounds) {
    const contract = normalizeLayerFitContract({
      ...baseContract,
      scope: "canvas",
      canvasWidthRatio: Number(variantBounds.width) / canvasWidth,
      canvasHeightRatio: Number(variantBounds.height) / canvasHeight,
      canvasCenterXRatio: Number(variantBounds.centerX) / canvasWidth,
      canvasCenterYRatio: Number(variantBounds.centerY) / canvasHeight,
      canvasTopRatio: Number(variantBounds.top) / canvasHeight,
      canvasBottomRatio: Number(variantBounds.bottom) / canvasHeight
    });
    if (contract) {
      contract.summary = buildLayerFitContractSummary(layer, contract);
    }
    return contract;
  }

  const fallback = normalizeLayerFitContract({
    ...baseContract,
    scope: anchor ? "anchor" : "canvas"
  });
  if (fallback) {
    fallback.summary = buildLayerFitContractSummary(layer, fallback);
  }
  return fallback;
}

function refreshLayerFitContract(project, layer, preferredVariant = null, options = {}) {
  const force = options.force === true;
  const existing = getLayerFitContract(layer);
  const currentProfileId = cleanText(getLayerFitProfile(layer?.name)?.id);
  const profileMismatch =
    existing && currentProfileId && cleanText(existing.profileId) && cleanText(existing.profileId) !== currentProfileId;
  if (existing && !force && !profileMismatch && cleanText(existing.summary)) {
    layer.fitContract = existing;
    return existing;
  }

  const next = buildLayerFitContract(project, layer, preferredVariant);
  if (next) {
    layer.fitContract = next;
    return next;
  }

  return existing;
}

function hydrateProjectLayerFitContracts(project) {
  let changed = false;
  for (const layer of Array.isArray(project?.layers) ? project.layers : []) {
    const existing = getLayerFitContract(layer);
    const currentProfileId = cleanText(getLayerFitProfile(layer?.name)?.id);
    const profileMismatch =
      existing && currentProfileId && cleanText(existing.profileId) && cleanText(existing.profileId) !== currentProfileId;
    if (existing && !profileMismatch) {
      continue;
    }
    const next = buildLayerFitContract(project, layer);
    if (next) {
      layer.fitContract = next;
      changed = true;
    }
  }
  return changed;
}

function mergeLayerTransform(current, patch) {
  const next = {
    x: patch.x ?? current.x,
    y: patch.y ?? current.y,
    scale: patch.scale ?? current.scale,
    rotation: patch.rotation ?? current.rotation,
    depthMode: patch.depthMode ?? current.depthMode,
    backCutoff: patch.backCutoff ?? current.backCutoff,
    frontStart: patch.frontStart ?? current.frontStart
  };

  return normalizeLayerTransform(next);
}

function shouldRestoreLayerBeforeTransform(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  return /(put .* back|restore|how it was|that was a fail|undo|revert|clean .* layer only|original)/.test(lowered);
}

function shouldAlsoVisuallyEditLayer(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  return /(edit|hide|mask|crop|trim|cut|doesn.?t show|dont show|back part|front only|occlude|look like it.?s really on)/.test(
    lowered
  );
}

function shouldUseDeterministicLayerFitEdit(layer, promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  if (!isAccessoryLayerName(layer?.name)) {
    return false;
  }

  return (
    /(back part|back hoop|really on|sit naturally|sits naturally|see how|example|proper|fit|fits|fitting|tighten|tighter|too wide|wide|narrow|narrower|slimmer|stack|overlay|clip|sized?|wear|worn|hold|held|grip|gripping|hand|paw|arm|eye line|face better|door|panel|plate|safe|vault|hinge|recessed|opening|middle|center(?:ed)?|flush)/.test(
      lowered
    ) &&
    mentionsAnchorPlacementArea(lowered)
  );
}

function shouldUseFrontOnlyHeadwearTrait(layer, promptText) {
  if (cleanText(getLayerFitProfile(layer?.name)?.id) !== "headwear") {
    return false;
  }

  const lowered = cleanText(promptText).toLowerCase();
  return (
    /(back hoop|back loop|back part|rear hoop|rear loop|underside|hollow|hole|trim|cut away|front only|sit on .* head|sitting on .* head|worn on .* head|seat.*head|sits on .* head|crown .* head)/.test(
      lowered
    ) &&
    mentionsAnchorPlacementArea(lowered)
  );
}

function isAccessoryLayerName(layerName) {
  return Boolean(getLayerFitProfile(layerName));
}

function mentionsAnchorPlacementArea(loweredPrompt) {
  return /(head|face|eye|eyes|eye line|forehead|brow|cheek|muzzle|base|body|character|avatar|subject|construct|center piece|centerpiece|main asset|main body|main character|upper area|upper body|hand|hands|paw|paws|arm|arms|grip|holding|safe|vault|door|panel|plate|opening|recessed|hinge|frame|surface|front face|front surface|middle|center(?:ed)?)/.test(
    cleanText(loweredPrompt).toLowerCase()
  );
}

function mentionsHandPlacementArea(loweredPrompt) {
  return /(hand|hands|paw|paws|arm|arms|grip|holding|hold|held)/.test(cleanText(loweredPrompt).toLowerCase());
}

function shouldRejectContaminatedLayerEdit(layer, sourceAnalysis, revisedAnalysis) {
  if (isPrimaryBaseLayerName(layer?.name) || !isAccessoryLayerName(layer?.name)) {
    return false;
  }

  const profileId = cleanText(getLayerFitProfile(layer?.name)?.id).toLowerCase();
  const sourceBottom = Number(sourceAnalysis?.bounds?.bottom ?? 0);
  const revisedBottom = Number(revisedAnalysis?.bounds?.bottom ?? 0);
  const sourceHeight = Math.max(1, Number(sourceAnalysis?.height || revisedAnalysis?.height || 1024));
  const revisedBottomRatio = revisedBottom / sourceHeight;
  const sourceBottomRatio = sourceBottom / sourceHeight;
  const sourceCoverage = Number(sourceAnalysis?.alphaCoverage || 0);
  const revisedCoverage = Number(revisedAnalysis?.alphaCoverage || 0);

  if (profileId === "surface-overlay") {
    return revisedCoverage > Math.max(sourceCoverage * 1.45, sourceCoverage + 0.18, 0.82);
  }

  if (/headwear|hat|crown|tiara/.test(cleanText(layer?.name).toLowerCase())) {
    return (
      revisedBottomRatio > Math.max(sourceBottomRatio + 0.14, 0.62) ||
      revisedCoverage > Math.max(sourceCoverage * 1.9, sourceCoverage + 0.09, 0.22)
    );
  }

  return (
    revisedBottomRatio > Math.max(sourceBottomRatio + 0.18, 0.72) ||
    revisedCoverage > Math.max(sourceCoverage * 2.1, sourceCoverage + 0.12, 0.3)
  );
}

function isLikelyContaminatedAccessoryAnalysis(layer, analysis) {
  if (isPrimaryBaseLayerName(layer?.name) || !isAccessoryLayerName(layer?.name)) {
    return false;
  }

  const profileId = cleanText(getLayerFitProfile(layer?.name)?.id).toLowerCase();
  const height = Math.max(1, Number(analysis?.height || 1024));
  const bottomRatio = Number(analysis?.bounds?.bottom ?? 0) / height;
  const coverage = Number(analysis?.alphaCoverage || 0);
  const lowered = cleanText(layer?.name).toLowerCase();

  if (profileId === "surface-overlay") {
    return coverage > 0.82;
  }

  if (/headwear|hat|crown|tiara/.test(lowered)) {
    return bottomRatio > 0.62 || coverage > 0.22;
  }

  return bottomRatio > 0.72 || coverage > 0.3;
}

function shouldPreferCleanHistoricalSource(layer, promptText, removalTarget, sourceAnalysis) {
  if (!isAccessoryLayerName(layer?.name)) {
    return false;
  }

  const loweredPrompt = cleanText(promptText).toLowerCase();
  const loweredTarget = cleanText(removalTarget).toLowerCase();
  const removingAnchorConstruct =
    /(cat|base|body|character|avatar|subject|construct|head|face)/.test(loweredTarget) ||
    /(remove|fix|clean|strip|erase).*(cat|base|body|character|avatar|subject|construct|head|face)/.test(loweredPrompt) ||
    /(cat|base|body|character|avatar|subject|construct|head|face).*(from|out of|off).*(layer|crown|hat|headwear)/.test(loweredPrompt);

  return removingAnchorConstruct || isLikelyContaminatedAccessoryAnalysis(layer, sourceAnalysis);
}

function pruneContaminatedSelectedVariants(layer, keepVariantId = "") {
  if (!Array.isArray(layer?.variants) || !layer.variants.length) {
    return;
  }

  const keepId = cleanText(keepVariantId);
  layer.variants = layer.variants.filter((variant) => {
    if (variant.id === keepId) {
      return true;
    }
    return !isLikelyContaminatedAccessoryAnalysis(layer, variant.analysis);
  });

  if (keepId) {
    layer.selectedVariantId = keepId;
  }
}

async function sanitizeAccessoryLayerToPureTrait(project, layer, options = {}) {
  const source = findRestorableLayerSource(project, layer, `${options.promptText || ""} restore original clean pure trait`);
  if (!source?.imageUrl) {
    const error = new Error(`No clean historical ${layer.name} source was available to restore.`);
    error.status = 404;
    throw error;
  }

  layer.variants = Array.isArray(layer.variants) ? layer.variants : [];
  let variant =
    layer.variants.find((item) => item.imageUrl === source.imageUrl) ||
    layer.variants.find((item) => cleanText(item.name) === cleanText(source.name)) ||
    null;

  if (!variant) {
    const variantTransformMode = normalizeVariantTransformMode(source?.transformMode);
    variant = {
      id: cleanText(source.id) || createId("variant"),
      name: cleanText(source.name) || `${layer.name} Restored`,
      notes: cleanText(source.notes),
      prompt: cleanText(source.prompt),
      imageUrl: source.imageUrl,
      analysis: source.analysis || null,
      transformMode: variantTransformMode,
      transform:
        variantTransformMode === "custom"
          ? getVariantPlacementTransform(layer, source)
          : getLayerPlacementTransform(layer, source),
      createdAt: source.createdAt || new Date().toISOString()
    };
    layer.variants.unshift(variant);
  }

  pruneContaminatedSelectedVariants(layer, variant.id);
  const variantTransformMode = normalizeVariantTransformMode(variant?.transformMode);
  const variantTransform =
    variantTransformMode === "custom"
      ? getVariantPlacementTransform(layer, variant)
      : getLayerPlacementTransform(layer, variant);
  applyPlacementTransformForVariant(layer, variant, variantTransform, variantTransformMode);
  layer.selectedVariantId = variant.id;
  project.updatedAt = new Date().toISOString();
  await projectService.writeProject(project);

  let memory = await studioMemoryService.appendChangelog(project, {
    type: "sanitize-layer-variant",
    title: `Restored clean ${layer.name} trait`,
    detail: `Reverted ${layer.name} to ${variant.name} and pruned contaminated accessory variants from the live layer.`
  });
  memory = await refreshMemoryIfPossible(project, memory);

  return {
    project,
    memory,
    layer,
    variant
  };
}

async function regenerateAccessoryLayerAsPureTrait(project, apiKey, layer, options = {}) {
  const source = findRestorableLayerSource(project, layer, `${options.promptText || ""} restore original clean pure trait`);
  const prompt = buildPureTraitRegenerationPrompt(project, layer, source, options);
  const imageAsset = await openaiService.generateImageAsset({
    apiKey,
    prompt,
    size: project.canvas.generationSize,
    background: "transparent"
  });

  const variantFolder = path.join(generatedDir, project.id, "layers", layer.id);
  await fs.mkdir(variantFolder, { recursive: true });

  const variantId = createId("variant");
  const filename = `${variantId}.png`;
  const absolutePath = path.join(variantFolder, filename);
  await fs.writeFile(absolutePath, await resizePng(imageAsset.buffer, project.canvas));
  const variantBuffer = await fs.readFile(absolutePath);
  const analysis = await inspectVariantAgainstLayer(layer, variantBuffer);
  if (isLikelyContaminatedAccessoryAnalysis(layer, analysis)) {
    await fs.unlink(absolutePath).catch(() => {});
    const error = new Error(
      `The regenerated ${layer.name} trait still included anchor content, so it was rejected instead of saving another contaminated asset.`
    );
    error.status = 422;
    throw error;
  }

  const layerTransform = getLayerPlacementTransform(layer, source);
  const variant = {
    id: variantId,
    type: "variant",
    name: buildPureTraitVariantName(layer, source),
    notes: buildPureTraitVariantNotes(layer, source),
    prompt,
    imageUrl: `/generated/${project.id}/layers/${layer.id}/${filename}`,
    targetLayerName: layer.name,
    status: "committed",
    analysis,
    transformMode: "sync",
    transform: layerTransform,
    createdAt: new Date().toISOString()
  };

  const safeExistingVariants = (Array.isArray(layer.variants) ? layer.variants : []).filter(
    (item) => !isLikelyContaminatedAccessoryAnalysis(layer, item.analysis)
  );
  layer.variants = [variant, ...safeExistingVariants.filter((item) => item.id !== variant.id)];
  applyPlacementTransformForVariant(layer, variant, layerTransform, variant.transformMode);
  layer.selectedVariantId = variant.id;
  project.updatedAt = new Date().toISOString();
  await projectService.writeProject(project);

  let memory = await studioMemoryService.appendChangelog(project, {
    type: "rebuild-pure-trait",
    title: `Rebuilt ${layer.name} as a pure trait`,
    detail: `Generated a new isolated ${layer.name} asset and pruned contaminated accessory variants from the live layer.`
  });
  memory = await refreshMemoryIfPossible(project, memory, apiKey);
  await refreshBrainIfPossible(project, memory, apiKey, {
    type: "rebuild-pure-trait",
    prompt: options.promptText,
    layerName: layer.name,
    summary: variant.notes,
    analysis
  });

  return {
    project,
    memory,
    layer,
    variant
  };
}

async function rebuildHeadwearAsFrontTrait(project, layer, options = {}) {
  const selectedVariant = getSelectedLayerVariant(layer);
  const source =
    findRestorableLayerSource(project, layer, `${options.promptText || ""} restore original clean pure trait`) ||
    selectedVariant ||
    findSourceVariantForLayerEdit(layer, options.promptText);
  if (!source?.imageUrl) {
    const error = new Error(`No clean ${layer.name} source was available to rebuild.`);
    error.status = 404;
    throw error;
  }

  const sourceAbsolutePath = publicAssetUrlToAbsolutePath(source.imageUrl);
  const sourceBuffer = await fs.readFile(sourceAbsolutePath);
  const sourceAnalysis = source.analysis || (await assetToolService.inspectPngBuffer(sourceBuffer));
  const rebuiltBuffer = await deriveFrontOnlyHeadwearBuffer(sourceBuffer, sourceAnalysis);

  const variantFolder = path.join(generatedDir, project.id, "layers", layer.id);
  await fs.mkdir(variantFolder, { recursive: true });

  const variantId = createId("variant");
  const filename = `${variantId}.png`;
  const absolutePath = path.join(variantFolder, filename);
  await fs.writeFile(absolutePath, await resizePng(rebuiltBuffer, project.canvas));
  const variantBuffer = await fs.readFile(absolutePath);
  const analysis = await inspectVariantAgainstLayer(layer, variantBuffer);

  const nextTransformMode = normalizeVariantTransformMode(selectedVariant?.transformMode || source?.transformMode);
  let transform =
    (await buildAnchorAwareLayerTransform(project, layer, {
      ...source,
      analysis: sourceAnalysis,
      transform:
        nextTransformMode === "custom"
          ? getVariantPlacementTransform(layer, source)
          : getLayerPlacementTransform(layer, source)
    })) ||
    (nextTransformMode === "custom"
      ? getVariantPlacementTransform(layer, source)
      : getLayerPlacementTransform(layer, source));
  transform = mergeLayerTransform(transform, inferTransformPatchFromPrompt(layer, options.promptText, transform));
  transform = normalizeLayerTransform({
    ...transform,
    depthMode: "flat"
  });

  const variant = {
    id: variantId,
    type: "variant",
    name: buildFrontOnlyHeadwearVariantName(source),
    notes: buildFrontOnlyHeadwearVariantNotes(source),
    prompt: buildFrontOnlyHeadwearPrompt(project, layer, source, options),
    imageUrl: `/generated/${project.id}/layers/${layer.id}/${filename}`,
    targetLayerName: layer.name,
    status: "committed",
    analysis,
    transformMode: nextTransformMode,
    transform,
    createdAt: new Date().toISOString()
  };

  layer.variants = Array.isArray(layer.variants) ? layer.variants : [];
  const replaceId = selectedVariant?.id || cleanText(source.id);
  const replaceIndex = layer.variants.findIndex((item) => item.id === replaceId);
  if (replaceIndex >= 0) {
    layer.variants[replaceIndex] = variant;
  } else {
    layer.variants.unshift(variant);
  }
  applyPlacementTransformForVariant(layer, variant, transform, nextTransformMode);
  layer.selectedVariantId = variant.id;
  refreshLayerFitContract(project, layer, variant);
  project.updatedAt = new Date().toISOString();
  await projectService.writeProject(project);

  let memory = await studioMemoryService.appendChangelog(project, {
    type: "rebuild-front-trait",
    title: `Rebuilt ${layer.name} as a front-only trait`,
    detail: `Removed the rear hoop / hollow opening from ${cleanText(source.name) || layer.name} and kept the trait in front of the anchor construct.`
  });
  memory = await refreshMemoryIfPossible(project, memory);

  return {
    project,
    memory,
    layer,
    variant
  };
}

async function deriveFrontOnlyHeadwearBuffer(sourceBuffer, sourceAnalysis) {
  const normalized = await sharp(sourceBuffer).ensureAlpha().png().toBuffer();
  const metadata = await sharp(normalized).metadata();
  const width = Math.max(1, Number(metadata.width || sourceAnalysis?.width || 1024));
  const height = Math.max(1, Number(metadata.height || sourceAnalysis?.height || 1024));
  const bounds = sourceAnalysis?.bounds || {
    left: 0,
    top: 0,
    right: width - 1,
    bottom: height - 1
  };
  const traitWidth = Math.max(1, Number(bounds.right) - Number(bounds.left) + 1);
  const traitHeight = Math.max(1, Number(bounds.bottom) - Number(bounds.top) + 1);
  const centerX = Number(bounds.left) + traitWidth / 2;
  const mainHole = {
    cx: centerX,
    cy: Number(bounds.top) + traitHeight * 0.84,
    rx: traitWidth * 0.27,
    ry: traitHeight * 0.1
  };
  const upperHole = {
    cx: centerX,
    cy: Number(bounds.top) + traitHeight * 0.775,
    rx: traitWidth * 0.2,
    ry: traitHeight * 0.05
  };
  const maskSvg = Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="transparent"/>
      <ellipse cx="${mainHole.cx}" cy="${mainHole.cy}" rx="${mainHole.rx}" ry="${mainHole.ry}" fill="white"/>
      <ellipse cx="${upperHole.cx}" cy="${upperHole.cy}" rx="${upperHole.rx}" ry="${upperHole.ry}" fill="white"/>
    </svg>
  `);

  return sharp(normalized)
    .composite([
      {
        input: maskSvg,
        blend: "dest-out"
      }
    ])
    .png()
    .toBuffer();
}

async function applyDeterministicLayerVisualAdjustments(project, layer, options = {}) {
  const variant = findSourceVariantForLayerEdit(layer, options.promptText);
  if (!variant) {
    const error = new Error("No selected layer image was available to visually adjust.");
    error.status = 404;
    throw error;
  }

  const fitProfile = getLayerFitProfile(layer.name);
  const anchorAwareTransform = await buildAnchorAwareLayerTransform(project, layer, variant, options.promptText);
  const nextTransform =
    anchorAwareTransform ||
    mergeLayerTransform(getVariantPlacementTransform(layer, variant), {
      depthMode: cleanText(fitProfile?.clipStrategy) === "headwear_wrap" ? "headwear_wrap" : "flat",
      backCutoff: coerceProfileNumber(fitProfile?.backCutoff, 0.66),
      frontStart: coerceProfileNumber(fitProfile?.frontStart, 0.62)
    });
  applyPlacementTransformForVariant(
    layer,
    variant,
    nextTransform,
    isVariantUsingCustomTransform(variant) ? "custom" : "sync"
  );
  layer.selectedVariantId = variant.id;
  if (!isVariantUsingCustomTransform(variant)) {
    refreshLayerFitContract(project, layer, variant, { force: true });
  }
  project.updatedAt = new Date().toISOString();
  await projectService.writeProject(project);

  let memory = await studioMemoryService.appendChangelog(project, {
    type: "deterministic-layer-visual-adjustment",
    title: `Adjusted ${layer.name} fit rendering`,
    detail: `Updated ${fitProfile?.label || layer.name} fit rendering on ${variant.name} so it can sit on the anchor construct without redrawing the layer.`
  });
  memory = await refreshMemoryIfPossible(project, memory);

  return {
    project,
    memory,
    layer,
    variant
  };
}

async function buildAnchorAwareLayerTransform(project, layer, variant, promptText = "") {
  const fitProfile = getLayerFitProfile(layer?.name);
  const profileId = cleanText(fitProfile?.id).toLowerCase();
  const fitContract = getLayerFitContract(layer);
  const loweredPrompt = cleanText(promptText).toLowerCase();
  const currentTransform = getVariantPlacementTransform(layer, variant);
  if (!profileId) {
    return null;
  }

  const anchorLayer = getActiveAnchorLayer(project, layer);
  const anchorVariant = getSelectedLayerVariant(anchorLayer);
  const anchorBounds = anchorVariant?.analysis?.bounds || null;
  const variantBounds = variant?.analysis?.bounds || null;
  const canvasWidth = Math.max(1, Number(project?.canvas?.width || 1024));
  const canvasHeight = Math.max(1, Number(project?.canvas?.height || 1024));
  const imageWidth = Math.max(1, Number(variant?.analysis?.width || canvasWidth));
  const imageHeight = Math.max(1, Number(variant?.analysis?.height || canvasHeight));
  const depthMode =
    cleanText(fitContract?.depthMode) === "headwear_wrap" || cleanText(fitProfile?.clipStrategy) === "headwear_wrap"
      ? "headwear_wrap"
      : "flat";
  if (!anchorBounds || !variantBounds) {
    return mergeLayerTransform(currentTransform, {
      depthMode,
      backCutoff: coerceProfileNumber(fitContract?.backCutoff, coerceProfileNumber(fitProfile?.backCutoff, currentTransform.backCutoff)),
      frontStart: coerceProfileNumber(fitContract?.frontStart, coerceProfileNumber(fitProfile?.frontStart, currentTransform.frontStart))
    });
  }

  const defaultTransform = normalizeLayerTransform(getDefaultTransformForLayer(layer?.name));
  const anchorWidth = Math.max(1, Number(anchorBounds.right) - Number(anchorBounds.left) + 1);
  const anchorHeight = Math.max(1, Number(anchorBounds.bottom) - Number(anchorBounds.top) + 1);
  const variantWidth = Math.max(1, Number(variantBounds.right) - Number(variantBounds.left) + 1);
  const variantHeight = Math.max(1, Number(variantBounds.bottom) - Number(variantBounds.top) + 1);
  const anchorCenterX = (Number(anchorBounds.left) + Number(anchorBounds.right)) / 2;
  const variantCenterX = (Number(variantBounds.left) + Number(variantBounds.right)) / 2;
  const variantCenterY = (Number(variantBounds.top) + Number(variantBounds.bottom)) / 2;
  let baseScale = defaultTransform.scale;
  let imageLeft = 0;
  let imageTop = 0;

  if (profileId === "headwear") {
    const targetWidthRatio = coerceProfileNumber(
      fitContract?.targetWidthRatio,
      coerceProfileNumber(fitProfile?.anchorWidthRatio, 0.64)
    );
    const targetBottomRatio = coerceProfileNumber(
      fitContract?.targetBottomRatio,
      coerceProfileNumber(fitProfile?.anchorBottomRatio, 0.22)
    );
    const targetCenterXOffsetRatio = coerceProfileNumber(fitContract?.targetCenterXOffsetRatio, 0);
    const targetWidth = anchorWidth * targetWidthRatio;
    baseScale = clampTransformNumber(targetWidth / variantWidth, defaultTransform.scale, 0.15, 1.8);
    const targetBottom = Number(anchorBounds.top) + anchorHeight * targetBottomRatio;
    imageLeft = anchorCenterX + anchorWidth * targetCenterXOffsetRatio - variantCenterX * baseScale;
    imageTop = targetBottom - Number(variantBounds.bottom) * baseScale;
  } else if (profileId === "eyewear") {
    let targetWidthRatio = coerceProfileNumber(
      fitContract?.targetWidthRatio,
      coerceProfileNumber(fitProfile?.anchorWidthRatio, 0.68)
    );
    let targetCenterYRatio = coerceProfileNumber(
      fitContract?.targetCenterYRatio,
      coerceProfileNumber(fitProfile?.anchorCenterYRatio, 0.46)
    );
    const targetCenterXOffsetRatio = coerceProfileNumber(fitContract?.targetCenterXOffsetRatio, 0);
    if (/(width of .*face|face width|span .*face|full .*face width|across .*face|edge to edge|ear to ear)/.test(loweredPrompt)) {
      targetWidthRatio = 0.9;
    } else if (/(wider|bigger|larger|broader|too small)/.test(loweredPrompt)) {
      targetWidthRatio = Math.max(targetWidthRatio, 0.8);
    } else if (/(too wide|tighten|tighter|narrow|narrower|slimmer)/.test(loweredPrompt)) {
      targetWidthRatio = Math.min(targetWidthRatio, 0.62);
    }
    if (/(higher|raise|up|closer to .*eyes|closer to .*face)/.test(loweredPrompt)) {
      targetCenterYRatio = Math.max(0.4, targetCenterYRatio - 0.03);
    }
    if (/(lower|down)/.test(loweredPrompt)) {
      targetCenterYRatio = Math.min(0.55, targetCenterYRatio + 0.03);
    }
    const targetWidth = anchorWidth * targetWidthRatio;
    baseScale = clampTransformNumber(targetWidth / variantWidth, defaultTransform.scale, 0.15, 1.25);
    const targetCenterY = Number(anchorBounds.top) + anchorHeight * targetCenterYRatio;
    imageLeft = anchorCenterX + anchorWidth * targetCenterXOffsetRatio - variantCenterX * baseScale;
    imageTop = targetCenterY - variantCenterY * baseScale;
  } else {
    const targetWidthRatio = coerceStructuralOverlayFitNumber(
      profileId,
      fitContract?.targetWidthRatio,
      coerceProfileNumber(fitProfile?.anchorWidthRatio, null),
      0.2,
      0.92
    );
    const targetHeightRatio = coerceStructuralOverlayFitNumber(
      profileId,
      fitContract?.targetHeightRatio,
      coerceProfileNumber(fitProfile?.anchorHeightRatio, null),
      0.2,
      0.92
    );
    const targetCenterYRatio = coerceStructuralOverlayFitNumber(
      profileId,
      fitContract?.targetCenterYRatio,
      coerceProfileNumber(fitProfile?.anchorCenterYRatio, null),
      0.18,
      0.82
    );
    const targetTopRatio = coerceStructuralOverlayFitNumber(
      profileId,
      fitContract?.targetTopRatio,
      coerceProfileNumber(fitProfile?.anchorTopRatio, null),
      0.02,
      0.72
    );
    const targetCenterXOffsetRatio = coerceProfileNumber(
      fitContract?.targetCenterXOffsetRatio,
      coerceProfileNumber(fitProfile?.anchorCenterXOffsetRatio, 0)
    );
    if (targetWidthRatio === null && targetHeightRatio === null) {
      return null;
    }
    const scaleCandidates = [];
    if (targetWidthRatio !== null) {
      scaleCandidates.push((anchorWidth * targetWidthRatio) / variantWidth);
    }
    if (targetHeightRatio !== null) {
      scaleCandidates.push((anchorHeight * targetHeightRatio) / variantHeight);
    }
    if (!scaleCandidates.length) {
      return null;
    }
    const averageScale = scaleCandidates.reduce((sum, value) => sum + Number(value || 0), 0) / scaleCandidates.length;
    baseScale = clampTransformNumber(averageScale, defaultTransform.scale, 0.15, 1.8);
    imageLeft = anchorCenterX + anchorWidth * targetCenterXOffsetRatio - variantCenterX * baseScale;
    if (targetTopRatio !== null) {
      const targetTop = Number(anchorBounds.top) + anchorHeight * targetTopRatio;
      imageTop = targetTop - Number(variantBounds.top) * baseScale;
    } else if (targetCenterYRatio !== null) {
      const targetCenterY = Number(anchorBounds.top) + anchorHeight * targetCenterYRatio;
      imageTop = targetCenterY - variantCenterY * baseScale;
    } else {
      return null;
    }
  }

  const fittedTransform = normalizeLayerTransform({
    x: (imageLeft - (canvasWidth - imageWidth * baseScale) / 2) / canvasWidth,
    y: (imageTop - (canvasHeight - imageHeight * baseScale) / 2) / canvasHeight,
    scale: baseScale,
    depthMode,
    backCutoff: coerceProfileNumber(fitContract?.backCutoff, coerceProfileNumber(fitProfile?.backCutoff, currentTransform.backCutoff)),
    frontStart: coerceProfileNumber(fitContract?.frontStart, coerceProfileNumber(fitProfile?.frontStart, currentTransform.frontStart))
  });

  if (profileId === "eyewear" || profileId === "surface-overlay") {
    return fittedTransform;
  }

  return applyTransformResidual(fittedTransform, currentTransform, defaultTransform);
}

function shouldForceStructuralOverlayFitSeed(layer, source) {
  if (cleanText(getLayerFitProfile(layer?.name)?.id) !== "surface-overlay") {
    return false;
  }

  const lowered = [cleanText(source?.prompt), cleanText(source?.notes), cleanText(source?.name)].join(" ").toLowerCase();
  return /(fit|fits|fitted|attach|attached|align|aligned|seat|seated|sit|sits|overlay|mapped|match|inside|recessed|middle|center(?:ed)?|flush|hinge|safe|vault|door|panel|plate)/.test(
    lowered
  );
}

function coerceStructuralOverlayFitNumber(profileId, primaryValue, fallbackValue, min, max) {
  const primary = coerceProfileNumber(primaryValue, null);
  if (profileId === "surface-overlay") {
    if (primary !== null && primary >= min && primary <= max) {
      return primary;
    }
    return coerceProfileNumber(fallbackValue, null);
  }

  return coerceProfileNumber(primaryValue, coerceProfileNumber(fallbackValue, null));
}

function applyTransformResidual(baselineTransform, currentTransform, defaultTransform) {
  const safeDefaultScale = Math.max(0.001, Number(defaultTransform?.scale || 1));
  const scaleRatio = Math.max(0.5, Math.min(1.5, Number(currentTransform?.scale || 1) / safeDefaultScale));
  const currentBackCutoff = Number(currentTransform?.backCutoff || 0.66);
  const currentFrontStart = Number(currentTransform?.frontStart || 0.62);
  const defaultBackCutoff = Number(defaultTransform?.backCutoff || 0.66);
  const defaultFrontStart = Number(defaultTransform?.frontStart || 0.62);
  const baselineBackCutoff = Number(baselineTransform?.backCutoff || 0.66);
  const baselineFrontStart = Number(baselineTransform?.frontStart || 0.62);

  return normalizeLayerTransform({
    x: Number(baselineTransform?.x || 0) + (Number(currentTransform?.x || 0) - Number(defaultTransform?.x || 0)),
    y: Number(baselineTransform?.y || 0) + (Number(currentTransform?.y || 0) - Number(defaultTransform?.y || 0)),
    scale: Number(baselineTransform?.scale || 1) * scaleRatio,
    depthMode: cleanText(currentTransform?.depthMode).toLowerCase() === "headwear_wrap" ? "headwear_wrap" : baselineTransform?.depthMode,
    backCutoff: Math.max(baselineBackCutoff, baselineBackCutoff + (currentBackCutoff - defaultBackCutoff)),
    frontStart: Math.max(baselineFrontStart, baselineFrontStart + (currentFrontStart - defaultFrontStart))
  });
}

function findRestorableLayerSource(project, layer, promptText = "") {
  const lowered = cleanText(promptText).toLowerCase();
  const layerToken = slugify(layer?.name);
  const draftMatches = Array.isArray(project.draftHistory)
    ? [...project.draftHistory]
        .filter((item) => cleanText(item.committedLayerName) && slugify(item.committedLayerName) === layerToken)
        .filter((item) => item.imageUrl)
        .filter((item) => {
          const name = cleanText(item.name).toLowerCase();
          if (/(revised|without|fail)/.test(name) && /put .* back|restore|revert|original|clean/.test(lowered)) {
            return false;
          }
          if (isLikelyContaminatedAccessoryAnalysis(layer, item.analysis)) {
            return false;
          }
          return true;
        })
    : [];

  if (draftMatches[0]) {
    return {
      id: cleanText(draftMatches[0].committedVariantId) || cleanText(draftMatches[0].id) || createId("variant"),
      name: cleanText(draftMatches[0].name),
      notes: cleanText(draftMatches[0].notes),
      prompt: cleanText(draftMatches[0].prompt),
      imageUrl: cleanText(draftMatches[0].imageUrl),
      analysis: draftMatches[0].analysis || null,
      transform: getLayerPlacementTransform(layer)
    };
  }

  const currentVariants = Array.isArray(layer?.variants) ? [...layer.variants] : [];
  const safeCurrent = currentVariants.find(
    (item) =>
      !/(revised|without|fail)/.test(cleanText(item.name).toLowerCase()) &&
      !isLikelyContaminatedAccessoryAnalysis(layer, item.analysis)
  );
  if (safeCurrent) {
    return safeCurrent;
  }

  return currentVariants.find((item) => !isLikelyContaminatedAccessoryAnalysis(layer, item.analysis)) || currentVariants[0] || null;
}

function inferTransformPatchFromPrompt(layer, promptText, currentTransform = null) {
  const lowered = cleanText(promptText).toLowerCase();
  const patch = {};
  const current = normalizeLayerTransform(currentTransform || getDefaultTransformForLayer(layer.name));
  const fitProfile = getLayerFitProfile(layer.name);
  const isHandheldProfile = cleanText(fitProfile?.id) === "handheld";
  const isEyewearProfile = cleanText(fitProfile?.id) === "eyewear";
  const explicitFaceWidthFit =
    isEyewearProfile && /(width of .*face|face width|span .*face|full .*face width|across .*face|edge to edge|ear to ear)/.test(lowered);

  if (/(sit|fit|place|position|closer|up on|up onto|all the way|wear|worn)/.test(lowered) && mentionsAnchorPlacementArea(lowered)) {
    patch.x = current.x;
    patch.y = current.y;
    patch.scale = current.scale;
  }

  if (isHandheldProfile && mentionsHandPlacementArea(lowered)) {
    patch.x = current.x;
    patch.y = current.y;
    patch.scale = current.scale;
  }

  if (/(smaller|shrink|reduce|tiny|too big|too wide|tighten|tighter|narrow|narrower|slimmer)/.test(lowered)) {
    patch.scale = (patch.scale ?? current.scale) * 0.85;
  }

  if (/(bigger|larger|grow|too small|too narrow|wider)/.test(lowered)) {
    patch.scale = (patch.scale ?? current.scale) * 1.15;
  }

  if (/(higher|raise|up|top|closer|all the way)/.test(lowered)) {
    patch.y = (patch.y ?? current.y) - 0.05;
  }

  if (/(lower|down)/.test(lowered)) {
    patch.y = (patch.y ?? current.y) + 0.05;
  }

  if (/(left)/.test(lowered)) {
    patch.x = (patch.x ?? current.x) - 0.05;
  }

  if (/(right)/.test(lowered)) {
    patch.x = (patch.x ?? current.x) + 0.05;
  }

  if (/(center|centre|middle)/.test(lowered)) {
    patch.x = 0;
  }

  if (isHandheldProfile && /(left hand|left paw|left arm)/.test(lowered)) {
    patch.x = -Math.abs(current.x || 0.22);
  }

  if (isHandheldProfile && /(right hand|right paw|right arm)/.test(lowered)) {
    patch.x = Math.abs(current.x || 0.22);
  }

  if (isHandheldProfile && /(in .* hand|into .* hand|on .* hand|held|holding|grip)/.test(lowered)) {
    patch.y = patch.y ?? current.y;
    patch.scale = Math.min(patch.scale ?? current.scale, current.scale * 1.05);
  }

  if (shouldUseDeterministicLayerFitEdit(layer, promptText)) {
    patch.depthMode = cleanText(fitProfile?.clipStrategy) === "headwear_wrap" ? "headwear_wrap" : "flat";
    patch.backCutoff = coerceProfileNumber(fitProfile?.backCutoff, current.backCutoff);
    patch.frontStart = coerceProfileNumber(fitProfile?.frontStart, current.frontStart);
    patch.x = 0;
    if (cleanText(fitProfile?.id) === "headwear") {
      patch.scale = patch.scale ?? current.scale;
      patch.y = patch.y ?? current.y;
      if (/(back hoop|back part|doesn.?t show|dont show|hide)/.test(lowered)) {
        patch.frontStart = Math.min(0.9, (patch.frontStart ?? current.frontStart) + 0.03);
        patch.backCutoff = Math.min(0.9, Math.max(patch.backCutoff ?? current.backCutoff, (patch.frontStart ?? current.frontStart) + 0.03));
      }
    }
    if (isEyewearProfile) {
      patch.x = 0;
      patch.y = patch.y ?? current.y;
      patch.scale = patch.scale ?? current.scale;
      if (explicitFaceWidthFit) {
        patch.scale = current.scale;
      }
      if (/(too wide|tighten|tighter|narrow|narrower|slimmer|fit .* face better|fit .* eyes better)/.test(lowered)) {
        patch.scale = (patch.scale ?? current.scale) * 0.92;
      }
    }
    if (isHandheldProfile) {
      patch.x = /(left hand|left paw|left arm)/.test(lowered)
        ? -Math.abs(current.x || 0.22)
        : /(right hand|right paw|right arm)/.test(lowered)
          ? Math.abs(current.x || 0.22)
          : current.x;
      patch.y = current.y;
      patch.scale = Math.min(patch.scale ?? current.scale, current.scale * 1.02);
    }
  }

  if (/(all the way|proper|properly|nicely|see how|example)/.test(lowered) && mentionsAnchorPlacementArea(lowered)) {
    patch.y = Math.min(patch.y ?? current.y, current.y - 0.1);
    patch.x = 0;
  }

  return Object.keys(patch).length ? patch : current;
}

function getDefaultTransformForLayer(layerName) {
  // Generated layers are full canvas size with content already positioned.
  // Always default to identity transform — no offset, no scaling.
  return { x: 0, y: 0, scale: 1 };
}

function clampTransformNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Number(numeric.toFixed(3))));
}

function buildLayerRevisionPrompt(project, layer, sourceVariant, options = {}) {
  const removalTarget = cleanText(options.removalTarget);
  const extraDirection = cleanText(options.extraDirection);
  const sourcePrompt = cleanText(sourceVariant?.prompt);
  const sourceNotes = cleanText(sourceVariant?.notes);
  const requestedEdit = cleanText(options.promptText);
  const activeConstructSummary = buildActiveConstructSummary(project, layer);
  const fitGuidance = buildLayerFitPromptGuidance(project, layer);
  const fitProfile = getLayerFitProfile(layer.name);

  return [
    `Create a revised ${layer.name} NFT layer asset for the collection ${project.title}.`,
    "Use the provided source image as the exact base to edit rather than inventing a new drawing.",
    sourcePrompt ? `Stay visually consistent with this existing layer prompt: ${sourcePrompt}.` : "",
    sourceNotes ? `Preserve these approved notes from the current asset: ${sourceNotes}.` : "",
    requestedEdit ? `Requested revision: ${requestedEdit}.` : "",
    activeConstructSummary,
    fitGuidance,
    fitProfile?.anchorRegion ? `Fit region: ${fitProfile.anchorRegion}.` : "",
    fitProfile?.clipStrategy ? `Preferred clip strategy: ${fitProfile.clipStrategy}.` : "",
    "If an earlier successful example image from chat is attached, use it as a fit and construction reference for how this layer should sit in the stack.",
    `Keep the same pose, framing, alignment, proportions, facial expression, line quality, palette, and overall style so it still stacks cleanly with the rest of the collection.`,
    removalTarget
      ? `Remove ${removalTarget} completely from this ${layer.name} asset so that feature is not baked into the layer anymore.`
      : `Revise the current ${layer.name} asset according to the latest request without changing the core pose or style.`,
    isAccessoryLayerName(layer.name)
      ? `This must remain a pure ${layer.name} trait asset. Do not include any base character, body, head, face, hands, or other layer content in the output.`
      : "",
    "Do not redraw or restyle the whole character.",
    "Do not change any part of the source image except the requested feature adjustment.",
    "If reference images are attached, use them only to improve positioning, scale, and fit while preserving the source asset style.",
    `Anything that belongs on a separate trait layer must stay off this ${layer.name} asset.`,
    extraDirection,
    "Output one isolated layer asset only.",
    "Transparent background. No mockup, no scene, no text, no watermark.",
    "Centered composition, stack-safe proportions, crisp edges, PNG-ready."
  ]
    .filter(Boolean)
    .join(" ");
}

function buildActiveConstructSummary(project, targetLayer) {
  const anchor = getActiveAnchorLayer(project, targetLayer);
  if (!anchor?.variant) {
    return "";
  }

  return `Active construct anchor: the selected ${anchor.layer.name} layer named ${anchor.variant.name} is the central construct that this ${targetLayer?.name || "layer"} must fit around.`;
}

function buildLayerFitPromptGuidance(project, layer) {
  const lowered = cleanText(layer?.name).toLowerCase();
  const anchor = getActiveAnchorLayer(project, layer);
  const anchorLabel = anchor?.layer?.name ? anchor.layer.name : "the active base construct";
  const fitProfile = getLayerFitProfile(layer?.name);
  const fitContractGuidance = buildLayerFitContractSummary(layer, layer?.fitContract);

  if (cleanText(fitProfile?.id) === "background-accent") {
    return [
      `Treat ${anchorLabel} as the foreground subject and keep this background accent as a supportive transparent effect behind the silhouette rather than the full painted scene.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (cleanText(fitProfile?.id) === "background") {
    return [
      `Treat ${anchorLabel} as the foreground subject and build this as the true background plate: full canvas, edge to edge, behind everything, and not just a halo or accent feature.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (cleanText(fitProfile?.id) === "surface-overlay") {
    return [
      `Fit this structural overlay to ${anchorLabel}: study the visible front face, opening, recess, or seat on the anchor construct and draw only the removable overlay piece shaped to sit on that surface.`,
      `Match the anchor's contour, scale, curvature, edge spacing, and hinge alignment as closely as possible, but do not redraw the anchor body, casing, or any other base content into the trait.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (fitProfile?.guidance) {
    return [`Fit profile ${fitProfile.label || fitProfile.id} for ${anchorLabel}: ${fitProfile.guidance}`, fitContractGuidance]
      .filter(Boolean)
      .join(" ");
  }

  if (/headwear|hat|crown|tiara/.test(lowered)) {
    return [
      `Keep this headwear sized and aligned for ${anchorLabel}: centered in the upper anchor region, stack-safe, and shaped to feel built for that character instead of a random standalone canvas.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/eyes|eyewear|glasses|shades/.test(lowered)) {
    return [
      `Keep this eyewear aligned to ${anchorLabel}: centered over the eye line, narrowed to the visible face width, stack-safe over the eyes, and never redrawing any head or face content into the trait.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/neckwear|necklace|chain|scarf|bow/.test(lowered)) {
    return [`Keep this neckwear aligned to ${anchorLabel}: centered around the neck/chest area with clean spacing and no body redraw.`, fitContractGuidance]
      .filter(Boolean)
      .join(" ");
  }

  if (/handheld|weapon|sword|staff|wand|gun|tool|prop|item|orb|flower|cane|bat|microphone/.test(lowered)) {
    return [
      `Keep this handheld trait aligned to ${anchorLabel}: size it to the character and place it so it reads as being held by the visible hand or grip area instead of floating beside the body.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/background/.test(lowered)) {
    return [
      `Treat ${anchorLabel} as the foreground subject and keep this background supportive instead of overlapping the character silhouette.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  return anchor
    ? [`Fit this ${layer.name} asset so it stacks cleanly around ${anchorLabel} without redrawing the anchor layer.`, fitContractGuidance]
        .filter(Boolean)
        .join(" ")
    : fitContractGuidance;
}

function getActiveAnchorLayer(project, targetLayer = null) {
  const layers = Array.isArray(project?.layers) ? project.layers : [];
  const targetId = cleanText(targetLayer?.id);
  const candidates = [
    ...layers.filter((layer) => layer.id !== targetId && isPrimaryBaseLayerName(layer.name)),
    ...layers.filter((layer) => layer.id !== targetId && !isPrimaryBaseLayerName(layer.name))
  ];

  for (const layer of candidates) {
    const variants = Array.isArray(layer.variants) ? layer.variants : [];
    const variant = variants.find((item) => item.id === layer.selectedVariantId) || variants[0] || null;
    if (variant?.imageUrl || variant?.prompt || variant?.name) {
      return { layer, variant };
    }
  }

  return null;
}

async function getSelectedPreviewReference(project) {
  const selectedPreview = (project.previewHistory || []).find(
    (p) => p.id === project.selectedPreviewId
  );
  const imageUrl = cleanText(selectedPreview?.imageUrl);
  if (!imageUrl) return null;

  try {
    const absolutePath = publicAssetUrlToAbsolutePath(imageUrl);
    const buffer = await fs.readFile(absolutePath);
    return `data:image/png;base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

async function getActiveAnchorReferenceAttachment(project, targetLayer, excludeUrls = []) {
  const anchor = getActiveAnchorLayer(project, targetLayer);
  const imageUrl = cleanText(anchor?.variant?.imageUrl);
  if (!imageUrl || excludeUrls.includes(imageUrl)) {
    return null;
  }

  try {
    const absolutePath = publicAssetUrlToAbsolutePath(imageUrl);
    const fileBuffer = await fs.readFile(absolutePath);
    return {
      id: cleanText(anchor.variant.id) || createId("anchor"),
      name: cleanText(anchor.variant.name) || `${anchor.layer.name} anchor`,
      imageUrl,
      dataUrl: `data:image/png;base64,${fileBuffer.toString("base64")}`,
      targetLayerName: cleanText(anchor.layer.name),
      referenceType: "active-anchor",
      sourceType: "active-anchor",
      notes: cleanText(anchor.variant.notes),
      prompt: cleanText(anchor.variant.prompt)
    };
  } catch {
    return null;
  }
}

async function getChatExampleReferenceAttachments(project, layer, promptText, excludeUrls = []) {
  const matches = findChatImageReferencesForLayer(project, layer, promptText, excludeUrls);
  const attachments = [];

  for (const match of matches) {
    const imageUrl = cleanText(match?.imageUrl);
    if (!imageUrl) {
      continue;
    }

    try {
      const absolutePath = publicAssetUrlToAbsolutePath(imageUrl);
      const fileBuffer = await fs.readFile(absolutePath);
      attachments.push({
        id: cleanText(match.id) || createId("chat-ref"),
        name: cleanText(match.name) || "Chat example",
        imageUrl,
        dataUrl: `data:image/png;base64,${fileBuffer.toString("base64")}`
      });
    } catch {
      // Ignore broken old chat assets.
    }
  }

  return attachments;
}

function findChatImageReferencesForLayer(project, layer, promptText, excludeUrls = []) {
  const layerName = cleanText(layer?.name).toLowerCase();
  const promptLowered = cleanText(promptText).toLowerCase();
  const blocked = new Set(excludeUrls.map((value) => cleanText(value)).filter(Boolean));
  const candidates = [...(project.chatHistory || [])]
    .reverse()
    .filter((message) => message.role !== "user" && message.generatedImage?.imageUrl)
    .map((message) => {
      const image = normalizeGeneratedChatImage(message.generatedImage);
      if (!image.imageUrl || blocked.has(image.imageUrl)) {
        return null;
      }

      const targetLayer = cleanText(image.targetLayerName).toLowerCase();
      const name = cleanText(image.name).toLowerCase();
      const notes = cleanText(image.notes).toLowerCase();
      const prompt = cleanText(image.prompt).toLowerCase();
      const text = cleanText(message.text).toLowerCase();
      let score = scoreGeneratedImageMatch(image, message, promptText);

      if (layerName && targetLayer === layerName) {
        score += 30;
      } else if (layerName && targetLayer.includes(layerName)) {
        score += 18;
      }

      if (/headwear|hat|crown|tiara/.test(layerName) && /(crown|headwear|hat|tiara)/.test(`${name} ${notes} ${prompt} ${text}`)) {
        score += 18;
      }

      if (image.type === "preview" && /(fit|head|wear|crown|cat)/.test(promptLowered)) {
        score += 10;
      }

      return score > 0 ? { ...image, score } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);

  return candidates.slice(0, 2);
}

function buildRevisedVariantName(layer, sourceVariant, removalTarget) {
  if (removalTarget) {
    return `${layer.name} Without ${titleCaseWords(removalTarget)}`;
  }

  return cleanText(sourceVariant?.name) ? `${sourceVariant.name} Revised` : `${layer.name} Revised`;
}

function buildRevisedVariantNotes(sourceVariant, removalTarget) {
  const base = cleanText(sourceVariant?.notes);
  if (removalTarget) {
    return [base, `Revised to remove ${removalTarget} from the layer asset.`].filter(Boolean).join(" ");
  }

  return [base, "Revised version of the current layer asset."].filter(Boolean).join(" ");
}

function buildPureTraitVariantName(layer, sourceVariant) {
  if (cleanText(sourceVariant?.name)) {
    return `${sourceVariant.name} Clean`;
  }

  return `${layer.name} Clean`;
}

function buildPureTraitVariantNotes(layer, sourceVariant) {
  const base = cleanText(sourceVariant?.notes);
  return [base, `Fresh isolated ${layer.name} trait asset regenerated without any base character content.`]
    .filter(Boolean)
    .join(" ");
}

function buildFrontOnlyHeadwearVariantName(sourceVariant) {
  if (cleanText(sourceVariant?.name)) {
    return `${sourceVariant.name} Front Fit`;
  }

  return "Headwear Front Fit";
}

function buildFrontOnlyHeadwearVariantNotes(sourceVariant) {
  const base = cleanText(sourceVariant?.notes);
  return [base, "Rebuilt as a front-only worn headwear trait with the rear hoop / hollow area removed for stack fit."]
    .filter(Boolean)
    .join(" ");
}

function buildFrontOnlyHeadwearPrompt(project, layer, sourceVariant, options = {}) {
  const sourcePrompt = cleanText(sourceVariant?.prompt);
  const sourceNotes = cleanText(sourceVariant?.notes);
  const requestedEdit = cleanText(options.promptText);
  const activeConstructSummary = buildActiveConstructSummary(project, layer);
  const fitGuidance = buildLayerFitPromptGuidance(project, layer);

  return [
    `Rebuilt ${layer.name} as a front-only worn trait for ${project.title}.`,
    sourcePrompt ? `Source trait direction: ${sourcePrompt}.` : "",
    sourceNotes ? `Source notes: ${sourceNotes}.` : "",
    requestedEdit ? `Requested fit edit: ${requestedEdit}.` : "",
    activeConstructSummary,
    fitGuidance,
    "Remove the rear hoop / underside opening so the trait reads as worn on the anchor head from the front view.",
    "Keep only the single isolated trait asset with no base character pixels.",
    "Transparent background, PNG-ready."
  ]
    .filter(Boolean)
    .join(" ");
}

function buildPureTraitRegenerationPrompt(project, layer, sourceVariant, options = {}) {
  const sourcePrompt = cleanText(sourceVariant?.prompt);
  const sourceNotes = cleanText(sourceVariant?.notes);
  const requestedEdit = cleanText(options.promptText);
  const activeConstructSummary = buildActiveConstructSummary(project, layer);
  const fitGuidance = buildLayerFitPromptGuidance(project, layer);
  const fitProfile = getLayerFitProfile(layer.name);

  return [
    `Create one fresh isolated ${layer.name} NFT trait asset for the collection ${project.title}.`,
    "This is a pure single-trait rebuild, not an edit of a contaminated image.",
    sourcePrompt ? `Use this approved clean trait direction as the design source: ${sourcePrompt}.` : "",
    sourceNotes ? `Preserve these approved trait notes: ${sourceNotes}.` : "",
    requestedEdit ? `Current request: ${requestedEdit}.` : "",
    activeConstructSummary,
    fitGuidance,
    fitProfile?.anchorRegion ? `Fit region: ${fitProfile.anchorRegion}.` : "",
    fitProfile?.clipStrategy ? `Preferred clip strategy: ${fitProfile.clipStrategy}.` : "",
    "Use the anchor/base construct only as sizing and later placement context for how this trait should stack.",
    "Do not include any cat head, ears, face, body, hands, paws, arms, or other character pixels in the output.",
    "Do not include any other layer content in the output.",
    "Draw only the single requested trait asset itself.",
    "Transparent background. No mockup, no scene, no text, no watermark.",
    "Centered composition, stack-safe proportions, crisp edges, PNG-ready."
  ]
    .filter(Boolean)
    .join(" ");
}

function extractLayerLookupFromPrompt(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  const patterns = [
    /for\s+the\s+(.+?)\s+(?:layer|folder)/,
    /from\s+the\s+(.+?)\s+(?:layer|folder)/,
    /(?:from|on|into|to)\s+(.+?)\s+(?:layer|folder)/
  ];

  for (const pattern of patterns) {
    const match = lowered.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return "";
}

function extractRemovalTargetFromPrompt(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  const patterns = [
    /remove\s+(?:the\s+)?(.+?)\s+from\s+(?:the\s+)?(?:.+?)\s+layer/,
    /take\s+(?:the\s+)?(.+?)\s+off\s+(?:the\s+)?(?:.+?)\s+layer/,
    /without\s+(?:the\s+)?(.+?)(?:\s|$)/
  ];

  for (const pattern of patterns) {
    const match = lowered.match(pattern);
    if (match?.[1]) {
      return cleanText(match[1]).replace(/^(the|a|an)\s+/i, "");
    }
  }

  return "";
}

function titleCaseWords(value) {
  return cleanText(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isGenericTraitLayerName(layerName) {
  const token = slugify(layerName || "");
  if (!token) {
    return false;
  }

  return [
    "headwear",
    "hat",
    "crown",
    "tiara",
    "base-cat",
    "body",
    "background",
    "fur",
    "eyes",
    "mouth",
    "clothing",
    "accessory",
    "handheld"
  ].includes(token);
}

function extractFreshTraitName(promptText) {
  const cleaned = cleanText(promptText).replace(/[.!?]+$/g, "");
  const match = cleaned.match(
    /(?:add|draw|make|create|generate|design|craft|show|give|build|draft)\s+(?:me\s+)?(?:a\s+|an\s+|another\s+|new\s+)?(.+)/i
  );
  if (!match?.[1]) {
    return "";
  }

  const rawCandidate = cleanText(match[1])
    .replace(/\b(?:asset|trait|folder|layer)\b/gi, "")
    .replace(/\((?:[^)]*(?:leave|keep|old|existing|current|alone|also)[^)]*)\)/gi, "")
    .replace(/\b(?:leave|keep)\b[\s\S]*?\b(?:alone|also|too|as well)\b/gi, "")
    .replace(/\b(?:don't|do not)\s+(?:replace|overwrite|touch|edit|change)\b/gi, "")
    .replace(/\b(?:for|with|that|to|using|based on|like)\b[\s\S]*$/i, "")
    .replace(/^\b(?:new|another|fresh|different)\b\s*/i, "")
    .trim();

  return titleCaseWords(rawCandidate);
}

function buildGenericFreshLayerName(promptText, guessedLayerName) {
  const lowered = cleanText(promptText).toLowerCase();
  if (isBackgroundAccentPrompt(lowered)) {
    return "New Background Accent";
  }

  if (isTrueBackgroundPrompt(lowered)) {
    return "New Background";
  }

  if (/(crown|tiara)/.test(lowered)) {
    return "New Crown";
  }

  if (/(hat|headwear)/.test(lowered)) {
    return "New Headwear";
  }

  if (/(glasses|shades|eyewear)/.test(lowered)) {
    return "New Eyewear";
  }

  if (/(background)/.test(lowered)) {
    return "New Background";
  }

  if (/(sword|wand|staff|gun|weapon|prop|tool|item|handheld)/.test(lowered)) {
    return "New Handheld";
  }

  return `New ${titleCaseWords(guessedLayerName)}`;
}

function makeUniqueLayerName(project, preferredName) {
  const baseName = titleCaseWords(preferredName) || "New Trait";
  let attempt = baseName;
  let index = 2;

  while (findLayer(project, attempt)) {
    attempt = `${baseName} ${index}`;
    index += 1;
  }

  return attempt;
}

async function resolveAttachments(ids) {
  const values = Array.isArray(ids) ? ids : [];
  const attachments = [];

  for (const id of values) {
    const token = cleanText(id);
    if (!token) {
      continue;
    }

    try {
      const meta = JSON.parse(await fs.readFile(path.join(uploadsDir, `${token}.json`), "utf8"));
      const fileBuffer = await fs.readFile(path.join(uploadsDir, meta.fileName));
      attachments.push({
        ...meta,
        dataUrl: `data:${meta.mimeType};base64,${fileBuffer.toString("base64")}`
      });
    } catch {
      // Ignore missing attachments so one bad upload id does not block the prompt.
    }
  }

  return attachments;
}

async function extendAttachmentsWithChatContext(project, promptText, attachments) {
  const values = Array.isArray(attachments) ? [...attachments] : [];
  const crossProjectReferences = await getCrossProjectReferenceAttachments(project, promptText, values);
  if (crossProjectReferences.length) {
    const baseValues = dedupeReferenceAttachments(values);
    const roomForBase = Math.max(0, 6 - crossProjectReferences.length);
    return dedupeReferenceAttachments([...baseValues.slice(0, roomForBase), ...crossProjectReferences]).slice(0, 6);
  }

  const source = getLatestCommitSource(project, promptText);
  if (!source || !shouldUseLatestDraftAsReference(promptText)) {
    return dedupeReferenceAttachments(values).slice(0, 6);
  }

  try {
    const absolutePath = publicAssetUrlToAbsolutePath(source.imageUrl);
    const fileBuffer = await fs.readFile(absolutePath);
    values.push({
      id: source.id,
      name: source.name || "Latest generated image",
      mimeType: "image/png",
      width: Number(project.canvas?.width || 0),
      height: Number(project.canvas?.height || 0),
      imageUrl: source.imageUrl,
      targetLayerName: cleanText(source.targetLayerName),
      referenceType: "chat-history",
      sourceType: cleanText(source.type) || "generated",
      notes: cleanText(source.notes),
      prompt: cleanText(source.prompt),
      dataUrl: `data:image/png;base64,${fileBuffer.toString("base64")}`
    });
  } catch {
    return dedupeReferenceAttachments(values).slice(0, 6);
  }

  return dedupeReferenceAttachments(values).slice(0, 6);
}

async function getCrossProjectReferenceAttachments(currentProject, promptText, existingAttachments = []) {
  const matches = await findCrossProjectReferenceMatches(currentProject, promptText, 2);
  if (!matches.length) {
    return [];
  }

  const blocked = new Set(
    (Array.isArray(existingAttachments) ? existingAttachments : [])
      .map((item) => cleanText(item?.imageUrl) || cleanText(item))
      .filter(Boolean)
  );
  const attachments = [];

  for (const match of matches) {
    const imageUrl = cleanText(match?.imageUrl);
    if (!imageUrl || blocked.has(imageUrl)) {
      continue;
    }

    try {
      const absolutePath = publicAssetUrlToAbsolutePath(imageUrl);
      const fileBuffer = await fs.readFile(absolutePath);
      const meta = await assetToolService.inspectAttachmentBuffer(fileBuffer);
      attachments.push({
        id: cleanText(match.id) || createId("project-ref"),
        name:
          cleanText(match.name) ||
          [cleanText(match.layerName), cleanText(match.sourceProjectTitle)].filter(Boolean).join(" ") ||
          "Saved project reference",
        mimeType: "image/png",
        width: Number(meta.width || 0),
        height: Number(meta.height || 0),
        imageUrl,
        dataUrl: `data:image/png;base64,${fileBuffer.toString("base64")}`,
        targetLayerName: cleanText(match.layerName),
        referenceType: "saved-project",
        sourceType: cleanText(match.sourceType),
        sourceProjectId: cleanText(match.sourceProjectId),
        sourceProjectTitle: cleanText(match.sourceProjectTitle),
        notes: cleanText(match.notes),
        prompt: cleanText(match.prompt)
      });
      blocked.add(imageUrl);
    } catch {
      // Ignore missing or broken old generated assets from saved projects.
    }
  }

  return attachments;
}

async function findCrossProjectReferenceMatches(currentProject, promptText, limit = 2) {
  const referencedProjectName = extractProjectReferenceName(promptText);
  if (!referencedProjectName) {
    return [];
  }

  const projectMatches = await loadCrossProjectReferenceProjects(currentProject, referencedProjectName);
  if (!projectMatches.length) {
    return [];
  }

  const assetPromptText = stripProjectReferenceClause(promptText);
  const assetTokens = extractProjectReferenceAssetTokens(assetPromptText);
  const scoredMatches = [];

  for (const projectMatch of projectMatches.slice(0, 3)) {
    const imageCandidates = buildProjectReferenceImageCandidates(projectMatch.project);
    for (const candidate of imageCandidates) {
      const assetScore = scoreProjectReferenceImageCandidate(candidate, assetPromptText, assetTokens);
      if (!assetScore && assetTokens.length) {
        continue;
      }

      scoredMatches.push({
        ...candidate,
        score: projectMatch.score + assetScore,
        projectUpdatedAt: cleanText(projectMatch.project.updatedAt)
      });
    }
  }

  if (!scoredMatches.length) {
    const fallbackProject = projectMatches[0]?.project;
    if (!fallbackProject) {
      return [];
    }
    const fallbackCandidates = buildProjectReferenceImageCandidates(fallbackProject).sort((left, right) => {
      return scoreFallbackProjectReferenceCandidate(right) - scoreFallbackProjectReferenceCandidate(left);
    });
    return fallbackCandidates.slice(0, limit);
  }

  return scoredMatches
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return new Date(right.projectUpdatedAt || 0) - new Date(left.projectUpdatedAt || 0);
    })
    .slice(0, limit);
}

async function loadCrossProjectReferenceProjects(currentProject, projectName) {
  const query = cleanText(projectName);
  if (!query) {
    return [];
  }

  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    const matches = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const projectId = path.basename(entry.name, ".json");
      if (cleanText(currentProject?.id) && projectId === cleanText(currentProject.id)) {
        continue;
      }

      const candidate = await projectService.readProject(projectId);
      const score = scoreReferencedProject(candidate, query);
      if (score > 0) {
        matches.push({ project: candidate, score });
      }
    }

    return matches.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return new Date(right.project.updatedAt || 0) - new Date(left.project.updatedAt || 0);
    });
  } catch {
    return [];
  }
}

function buildProjectReferenceImageCandidates(project) {
  const candidates = [];

  for (const layer of Array.isArray(project?.layers) ? project.layers : []) {
    for (const variant of Array.isArray(layer?.variants) ? layer.variants : []) {
      if (!cleanText(variant?.imageUrl)) {
        continue;
      }

      candidates.push({
        id: cleanText(variant.id) || createId("project-ref"),
        name: cleanText(variant.name) || `${layer.name} reference`,
        layerName: cleanText(layer.name),
        notes: cleanText(variant.notes) || cleanText(layer.description),
        prompt: cleanText(variant.prompt),
        imageUrl: cleanText(variant.imageUrl),
        sourceType: "layer-variant",
        sourceProjectId: cleanText(project.id),
        sourceProjectTitle: cleanText(project.title),
        isSelected: cleanText(layer.selectedVariantId) === cleanText(variant.id),
        createdAt: cleanText(variant.createdAt)
      });
    }
  }

  for (const draft of Array.isArray(project?.draftHistory) ? project.draftHistory : []) {
    if (!cleanText(draft?.imageUrl)) {
      continue;
    }

    candidates.push({
      id: cleanText(draft.id) || createId("project-ref"),
      name: cleanText(draft.name) || "Saved draft",
      layerName: cleanText(draft.committedLayerName || draft.targetLayerName),
      notes: cleanText(draft.notes),
      prompt: cleanText(draft.prompt),
      imageUrl: cleanText(draft.imageUrl),
      sourceType: "draft",
      sourceProjectId: cleanText(project.id),
      sourceProjectTitle: cleanText(project.title),
      isSelected: cleanText(draft.status) === "committed",
      createdAt: cleanText(draft.updatedAt || draft.createdAt)
    });
  }

  for (const preview of Array.isArray(project?.previewHistory) ? project.previewHistory : []) {
    if (!cleanText(preview?.imageUrl)) {
      continue;
    }

    candidates.push({
      id: cleanText(preview.id) || createId("project-ref"),
      name: cleanText(preview.name) || `${cleanText(project.title) || "Project"} Preview`,
      layerName: "Preview",
      notes: cleanText(preview.notes),
      prompt: cleanText(preview.prompt),
      imageUrl: cleanText(preview.imageUrl),
      sourceType: "preview",
      sourceProjectId: cleanText(project.id),
      sourceProjectTitle: cleanText(project.title),
      isSelected: cleanText(project.selectedPreviewId) === cleanText(preview.id),
      createdAt: cleanText(preview.createdAt)
    });
  }

  return candidates;
}

function scoreReferencedProject(project, query) {
  const projectTitle = cleanText(project?.title).toLowerCase();
  const projectSlug = slugify(project?.title);
  const queryLower = cleanText(query).toLowerCase();
  const querySlug = slugify(queryLower);
  const tokens = extractProjectReferenceAssetTokens(queryLower);
  let score = 0;

  if (!queryLower) {
    return 0;
  }

  if (projectTitle === queryLower || projectSlug === querySlug) {
    score += 90;
  }

  if ((querySlug && projectSlug.includes(querySlug)) || projectTitle.includes(queryLower)) {
    score += 60;
  }

  for (const token of tokens) {
    if (projectTitle === token) {
      score += 24;
    } else if (projectTitle.includes(token)) {
      score += 12;
    }
  }

  return score;
}

function scoreProjectReferenceImageCandidate(candidate, assetPromptText, assetTokens = []) {
  const lowered = cleanText(assetPromptText).toLowerCase();
  const tokens = Array.isArray(assetTokens) ? assetTokens : extractProjectReferenceAssetTokens(assetPromptText);
  const haystack = [
    cleanText(candidate?.name).toLowerCase(),
    cleanText(candidate?.layerName).toLowerCase(),
    cleanText(candidate?.notes).toLowerCase(),
    cleanText(candidate?.prompt).toLowerCase()
  ].join(" ");
  let score = 0;

  if (!tokens.length) {
    return scoreFallbackProjectReferenceCandidate(candidate);
  }

  for (const token of tokens) {
    if (!token) {
      continue;
    }

    if (cleanText(candidate?.name).toLowerCase() === token) {
      score += 18;
    } else if (cleanText(candidate?.name).toLowerCase().includes(token)) {
      score += 12;
    }

    if (cleanText(candidate?.layerName).toLowerCase() === token) {
      score += 16;
    } else if (cleanText(candidate?.layerName).toLowerCase().includes(token)) {
      score += 10;
    }

    if (haystack.includes(token)) {
      score += 5;
    }
  }

  if (/(background|backdrop|scene|canvas|full bleed)/.test(lowered) && /(background|backdrop|scene|canvas|full bleed)/.test(haystack)) {
    score += 20;
  }

  if (/(accent|halo|aura|glow|ring|nebula)/.test(lowered) && /(accent|halo|aura|glow|ring|nebula)/.test(haystack)) {
    score += 14;
  }

  if (/(crown|headwear|hat|tiara)/.test(lowered) && /(crown|headwear|hat|tiara)/.test(haystack)) {
    score += 18;
  }

  if (/(glasses|eyewear|sunglasses|shades)/.test(lowered) && /(glasses|eyewear|sunglasses|shades)/.test(haystack)) {
    score += 18;
  }

  if (/(cosmic|space|nebula|galaxy|star)/.test(lowered) && /(cosmic|space|nebula|galaxy|star)/.test(haystack)) {
    score += 18;
  }

  if (candidate?.sourceType === "layer-variant") {
    score += 4;
  }

  if (candidate?.isSelected) {
    score += 4;
  }

  return score;
}

function scoreFallbackProjectReferenceCandidate(candidate) {
  let score = 0;
  if (candidate?.isSelected) {
    score += 12;
  }
  if (cleanText(candidate?.sourceType) === "layer-variant") {
    score += 8;
  }
  if (cleanText(candidate?.sourceType) === "preview") {
    score += 6;
  }
  return score;
}

function extractProjectReferenceName(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  const explicitPatterns = [
    /\b(?:from|using|use|same as|similar to|based on|match(?:ing)?|like)\s+(?:my\s+|the\s+)?([a-z0-9][a-z0-9\s-]{0,40}?)\s+project\b/i,
    /\bin\s+(?:my\s+|the\s+)?([a-z0-9][a-z0-9\s-]{0,40}?)\s+project\b/i
  ];

  for (const pattern of explicitPatterns) {
    const match = lowered.match(pattern);
    if (match?.[1]) {
      const cleaned = cleanProjectReferenceName(match[1]);
      if (cleaned) {
        return cleaned;
      }
    }
  }

  const tokens = lowered.split(/\s+/).map((token) => token.replace(/[^a-z0-9-]/g, ""));
  const projectIndex = tokens.lastIndexOf("project");
  if (projectIndex <= 0) {
    return "";
  }

  const nameTokens = [];
  for (let index = projectIndex - 1; index >= 0 && nameTokens.length < 4; index -= 1) {
    const token = tokens[index];
    if (!token || ["the", "my", "a", "an", "from", "in", "on", "like", "using", "use", "same", "as", "similar", "to", "based", "project"].includes(token)) {
      break;
    }
    nameTokens.unshift(token);
  }

  return cleanProjectReferenceName(nameTokens.join(" "));
}

function cleanProjectReferenceName(value) {
  return cleanText(value)
    .replace(/\b(?:my|the|this|that)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripProjectReferenceClause(promptText) {
  return cleanText(promptText)
    .replace(/\b(?:from|using|use|same as|similar to|based on|match(?:ing)?|like|in)\s+(?:my\s+|the\s+)?[a-z0-9][a-z0-9\s-]{0,40}?\s+project\b/gi, " ")
    .replace(/\b[a-z0-9][a-z0-9\s-]{0,40}?\s+project\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractProjectReferenceAssetTokens(promptText) {
  return [...new Set(
    stripProjectReferenceClause(promptText)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(
        (token) =>
          token.length >= 3 &&
          ![
            "make",
            "draw",
            "create",
            "generate",
            "design",
            "craft",
            "show",
            "give",
            "looks",
            "look",
            "like",
            "from",
            "with",
            "that",
            "this",
            "other",
            "project",
            "layer",
            "folder",
            "asset",
            "trait",
            "reference",
            "matching",
            "match",
            "same",
            "based",
            "using",
            "used"
          ].includes(token)
      )
  )];
}

function dedupeReferenceAttachments(attachments) {
  const seen = new Set();
  const items = Array.isArray(attachments) ? attachments : [];
  return items.filter((attachment) => {
    const key =
      cleanText(attachment?.imageUrl) ||
      cleanText(attachment?.id) ||
      (cleanText(attachment?.dataUrl) ? cleanText(attachment.dataUrl).slice(0, 120) : "");
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function shouldUseLatestDraftAsReference(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  return [
    "make it",
    "change it",
    "edit it",
    "mod it",
    "modify it",
    "tweak it",
    "same but",
    "version of that",
    "like that",
    "more like"
  ].some((phrase) => lowered.includes(phrase));
}

function toPublicAttachment(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    imageUrl: attachment.imageUrl,
    width: Number(attachment.width || 0),
    height: Number(attachment.height || 0)
  };
}

function buildQualityWarnings(generatedImage) {
  if (!generatedImage) return [];
  const warnings = [];
  const analysis = generatedImage.analysis || null;
  const name = cleanText(generatedImage.name) || "Generated image";
  const layerName = cleanText(generatedImage.targetLayerName);
  const isBg = isFullCanvasBackgroundLayerName(layerName);
  const isBase = isPrimaryBaseLayerName(layerName);

  if (!analysis) return warnings;

  if (analysis.possibleDuplicate && analysis.strongestMatchName) {
    warnings.push(`${name} looks very similar to "${analysis.strongestMatchName}" — may be a near-duplicate.`);
  }
  if (!isBg && analysis.alphaCoverage === 1) {
    warnings.push(`${name} has no transparency. Trait layers should have a transparent background.`);
  }
  if (!isBg && !isBase && analysis.touchesEdge) {
    warnings.push(`${name} bleeds to the canvas edge — it may not stack cleanly with other layers.`);
  }
  if (analysis.emptyAlpha) {
    warnings.push(`${name} appears completely empty or transparent.`);
  }

  return warnings;
}

function toAssistantGeneratedImage(item) {
  if (!item?.imageUrl) {
    return null;
  }

  return {
    id: cleanText(item.id),
    type: cleanText(item.type) || (item.targetLayerName ? "draft" : "preview"),
    name: cleanText(item.name),
    notes: cleanText(item.notes),
    prompt: cleanText(item.prompt),
    imageUrl: item.imageUrl,
    targetLayerName: cleanText(item.targetLayerName || item.committedLayerName),
    status: cleanText(item.status) || "ready"
  };
}

function getLatestOpenDraft(project) {
  return (project.draftHistory || []).find((draft) => cleanText(draft.status) !== "committed") || null;
}

function getLatestCommitSource(project, promptText = "") {
  const referencedChatImage = findChatReferencedImage(project, promptText);
  if (referencedChatImage) {
    return referencedChatImage;
  }

  const latestDraft = getLatestOpenDraft(project);
  if (latestDraft) {
    return latestDraft;
  }

  for (const message of [...(project.chatHistory || [])].reverse()) {
    if (message.role === "user") {
      continue;
    }

    if (message.generatedImage?.imageUrl) {
      return {
        id: cleanText(message.generatedImage.id) || createId("generated"),
        type: cleanText(message.generatedImage.type) || "preview",
        name: cleanText(message.generatedImage.name) || "Generated image",
        notes: cleanText(message.generatedImage.notes),
        prompt: cleanText(message.generatedImage.prompt),
        imageUrl: message.generatedImage.imageUrl,
        targetLayerName: cleanText(message.generatedImage.targetLayerName),
        status: cleanText(message.generatedImage.status) || "ready"
      };
    }
  }

  const preview = Array.isArray(project.previewHistory) ? project.previewHistory[0] : null;
  if (!preview?.imageUrl) {
    return null;
  }

  return {
    id: cleanText(preview.id) || createId("preview"),
    type: "preview",
    name: "Preview",
    notes: cleanText(preview.notes),
    prompt: cleanText(preview.prompt),
    imageUrl: preview.imageUrl,
    targetLayerName: "",
    status: "ready"
  };
}

function findChatReferencedImage(project, promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  const generatedMessages = [...(project.chatHistory || [])]
    .reverse()
    .filter((message) => message.role !== "user" && message.generatedImage?.imageUrl);

  if (!generatedMessages.length) {
    return null;
  }

  const scoredMatches = generatedMessages
    .map((message) => {
      const image = message.generatedImage || {};
      return {
        message,
        score: scoreGeneratedImageMatch(image, message, promptText)
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scoredMatches[0]?.message?.generatedImage) {
    return normalizeGeneratedChatImage(scoredMatches[0].message.generatedImage);
  }

  const referencePhrases = ["it", "that", "from chat", "from earlier", "last preview", "last one", "the one"];
  if (referencePhrases.some((phrase) => lowered.includes(phrase))) {
    return normalizeGeneratedChatImage(generatedMessages[0].generatedImage);
  }

  return null;
}

function normalizeGeneratedChatImage(image) {
  return {
    id: cleanText(image.id) || createId("generated"),
    type: cleanText(image.type) || "preview",
    name: cleanText(image.name) || "Generated image",
    notes: cleanText(image.notes),
    prompt: cleanText(image.prompt),
    imageUrl: image.imageUrl,
    targetLayerName: cleanText(image.targetLayerName),
    status: cleanText(image.status) || "ready"
  };
}

function scoreGeneratedImageMatch(image, message, promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  const tokens = extractPromptTokens(promptText);
  const name = cleanText(image.name).toLowerCase();
  const targetLayer = cleanText(image.targetLayerName).toLowerCase();
  const notes = cleanText(image.notes).toLowerCase();
  const prompt = cleanText(image.prompt).toLowerCase();
  const text = cleanText(message.text).toLowerCase();
  let score = 0;

  if (name && lowered.includes(name)) {
    score += 14;
  }

  if (targetLayer && lowered.includes(targetLayer)) {
    score += 12;
  }

  for (const token of tokens) {
    if (name === token) {
      score += 12;
    } else if (name.includes(token)) {
      score += 8;
    }

    if (targetLayer === token) {
      score += 10;
    } else if (targetLayer.includes(token)) {
      score += 7;
    }

    if (text.includes(token)) {
      score += 4;
    }

    if (prompt.includes(token)) {
      score += 3;
    }

    if (notes.includes(token)) {
      score += 1;
    }
  }

  if (image.type === "preview" && /(preview|base|main|character|cat)/.test(lowered)) {
    score += 3;
  }

  return score;
}

function extractPromptTokens(promptText) {
  return [...new Set(
    cleanText(promptText)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !["add", "put", "onto", "into", "then", "with", "from", "that", "this", "chat", "preview", "folder", "layer"].includes(token))
  )];
}

function guessLayerNameFromPrompt(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  const folderMatch = lowered.match(/([a-z0-9-]+)\s+folder/);
  if (folderMatch?.[1]) {
    const name = folderMatch[1];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  if (isBackgroundAccentPrompt(lowered)) {
    return "Background Accent";
  }

  if (isTrueBackgroundPrompt(lowered)) {
    return "Background";
  }

  const known = [
    "background",
    "body",
    "base safe",
    "safe base",
    "safe door",
    "door panel",
    "door face detail",
    "face plate",
    "faceplate",
    "door",
    "panel",
    "plate",
    "hatch",
    "lid",
    "base cat",
    "cat base",
    "face",
    "eyes",
    "mouth",
    "hat",
    "headwear",
    "crown",
    "tiara",
    "clothes",
    "clothing",
    "fur",
    "weapon",
    "sword",
    "staff",
    "wand",
    "gun",
    "tool",
    "prop",
    "handheld",
    "accessory"
  ];
  const match = known.find((item) => lowered.includes(item));
  if (!match) {
    return "";
  }

  if (match === "clothes") {
    return "Clothing";
  }

  if (["headwear", "hat", "crown", "tiara"].includes(match)) {
    return "Headwear";
  }

  if (["base safe", "safe base"].includes(match)) {
    return "Base Safe";
  }

  if (["safe door", "door panel", "door face detail", "face plate", "faceplate", "door", "panel", "plate", "hatch", "lid"].includes(match)) {
    return "Safe Door";
  }

  if (["weapon", "sword", "staff", "wand", "gun", "tool", "prop", "handheld"].includes(match)) {
    return "Handheld";
  }

  if (["base cat", "cat base", "body"].includes(match)) {
    return "Base Cat";
  }

  return match.charAt(0).toUpperCase() + match.slice(1);
}

function detectFeedbackMode(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  if (/(don't|do not|stop|avoid|too much|too many|hate|dislike|wrong|bad|off)/.test(lowered)) {
    return "feedback-correction";
  }

  if (/(love|like|great|perfect|amazing|nice|good|keep|remember|prestack|pre-stack)/.test(lowered)) {
    return "feedback-approval";
  }

  return "feedback-note";
}

function shouldLockFeedback(promptText, feedbackMode) {
  const lowered = cleanText(promptText).toLowerCase();
  if (feedbackMode !== "feedback-approval") {
    return false;
  }

  return /(love|perfect|keep|remember|always|really like|prestack|pre-stack)/.test(lowered);
}

function buildFeedbackTitle(promptText, feedbackMode) {
  const layerName = guessLayerNameFromPrompt(promptText);
  if (feedbackMode === "feedback-correction") {
    return layerName ? `Correction for ${layerName}` : "Creative correction";
  }

  if (feedbackMode === "feedback-approval") {
    return layerName ? `Approved direction for ${layerName}` : "Approved creative direction";
  }

  return "Creative feedback note";
}

function buildLockedDecisionTitle(promptText) {
  const layerName = guessLayerNameFromPrompt(promptText);
  if (layerName) {
    return `Keep this behavior for ${layerName}`;
  }

  if (/prestack|pre-stack/i.test(promptText)) {
    return "Keep the pre-stacked layer behavior";
  }

  return "Remember this approved creative behavior";
}

async function drawLayerVariantWithFullContext(project, layerId, count, apiKey) {
  hydrateProjectLayerFitContracts(project);
  const layer = project.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error(`Layer ${layerId} not found.`);

  const brain = await studioBrainService.getBrain();
  const toolManifest = await studioBrainService.getToolManifest();
  const memory = await studioMemoryService.getMemory(project);
  const plan = await openaiService.createLayerVariantPlan(apiKey, project, layer, count, memory, brain, toolManifest);

  const variantFolder = path.join(generatedDir, project.id, "layers", layer.id);
  await fs.mkdir(variantFolder, { recursive: true });

  const isBackground = isFullCanvasBackgroundLayerName(layer.name);
  const isBase = isPrimaryBaseLayerName(layer.name);
  const isBgAccent = isBackgroundAccentLayerName(layer.name);
  const backgroundMode = isBackground ? "opaque" : "transparent";
  const anchorRef = (!isBackground && !isBase && !isBgAccent) ? await getActiveAnchorReferenceAttachment(project, layer) : null;
  const region = layer.region || null;
  const canvasW = project.canvas?.width || 1024;
  const canvasH = project.canvas?.height || 1024;
  const previewPromptForLayer = cleanText(layer.previewGenerationPrompt);
  const otherLayerNames = project.layers.filter((l) => l.id !== layer.id).map((l) => l.name);

  // Look up parent layer's actual drawn bounds for child placement
  let parentBounds = null;
  if (layer.parentLayer && !isBackground && !isBase) {
    const parentLayer = project.layers.find((l) =>
      cleanText(l.name).toLowerCase() === cleanText(layer.parentLayer).toLowerCase()
      || slugify(l.name) === slugify(layer.parentLayer)
    );
    if (parentLayer) {
      const parentVariant = (parentLayer.variants || []).find((v) => v.id === parentLayer.selectedVariantId) || (parentLayer.variants || [])[0];
      if (parentVariant?.imageUrl) {
        try {
          const parentPath = publicAssetUrlToAbsolutePath(parentVariant.imageUrl);
          const parentBuffer = await fs.readFile(parentPath);
          const parentAnalysis = await assetToolService.inspectPngBuffer(parentBuffer);
          if (parentAnalysis.bounds) {
            const parentRegion = parentLayer.region;
            parentBounds = {
              ...parentAnalysis.bounds,
              estimatedX: parentRegion?.x || 0,
              estimatedY: parentRegion?.y || 0,
              estimatedW: parentRegion?.width || canvasW,
              estimatedH: parentRegion?.height || canvasH
            };
          }
        } catch (e) {
          console.warn(`[drawLayer] Could not read parent layer bounds: ${e.message}`);
        }
      }
    }
  }

  for (let vi = 0; vi < plan.variants.length; vi++) {
    const item = plan.variants[vi];
    const isFirst = vi === 0;
    const basePrompt = (isFirst && previewPromptForLayer)
      ? openaiService.buildLayerAssetPrompt({ project, layer, promptText: previewPromptForLayer })
      : item.prompt;
    const exclusionPrompt = otherLayerNames.length
      ? ` STRICT RULE: Output ONLY the ${layer.name} element. Do NOT draw, include, or reproduce ANY of these: ${otherLayerNames.join(", ")}. The reference image is ONLY for understanding scale, position, and perspective — do NOT copy its content. Draw ONLY ${layer.name} on a transparent background.`
      : "";
    const regionPrompt = region && !isBackground
      ? ` Target region on the ${canvasW}x${canvasH} canvas: approximately centered around (${Math.round(region.x + region.width / 2)}, ${Math.round(region.y + region.height / 2)}) at roughly ${region.width}x${region.height} pixels.`
      : "";
    const anchorLayerName = anchorRef?.targetLayerName || "base body";
    const perspectivePrompt = (!isBackground && !isBase && anchorRef)
      ? ` CRITICAL 3D RULE: The reference image shows the ${anchorLayerName} at a specific 3D camera angle. This ${layer.name} sits on that same construct and MUST be drawn at the EXACT same camera angle. Study the reference — match its perspective foreshortening, vanishing point direction, and surface angles precisely. If the ${anchorLayerName} is turned, this ${layer.name} must show the same turn on the surface where it attaches. NEVER draw this element flat, front-facing, or leaning away from the reference's angle.`
      : "";
    const fullPrompt = basePrompt + exclusionPrompt + regionPrompt + perspectivePrompt;

    let imageAsset;
    if (anchorRef?.dataUrl && !isBackground && !isBase) {
      imageAsset = await openaiService.editImageAsset({ apiKey, prompt: fullPrompt, images: [anchorRef.dataUrl], background: "transparent", inputFidelity: "high" });
    } else {
      imageAsset = await openaiService.generateImageAsset({ apiKey, prompt: fullPrompt, size: project.canvas.generationSize, background: backgroundMode });
    }

    let resizedBuffer = await resizePng(imageAsset.buffer, project.canvas);

    if (region && !isBackground && !isBase) {
      resizedBuffer = await fitLayerToRegion(resizedBuffer, region, canvasW, canvasH, parentBounds);
    }

    const variantId = createId("variant");
    const filename = `${variantId}.png`;
    await fs.writeFile(path.join(variantFolder, filename), resizedBuffer);

    layer.variants.push({
      id: variantId,
      name: item.name,
      notes: item.notes,
      prompt: item.prompt,
      imageUrl: `/generated/${project.id}/layers/${layer.id}/${filename}`,
      createdAt: new Date().toISOString()
    });

    if (!layer.selectedVariantId) layer.selectedVariantId = variantId;
  }

  project.updatedAt = new Date().toISOString();
  await projectService.writeProject(project);
  return project;
}

async function fitLayerToRegion(buffer, targetRegion, canvasW, canvasH, parentBounds, layerName) {
  // Deterministic post-processing: extract DALL-E's opaque content, scale it
  // to fit the target region from the preview analysis, and place it at the
  // exact pixel position.
  //
  // parentBounds (optional): the actual opaque bounds of the parent layer. When
  // provided, the target region is refined to align with where the parent was
  // actually drawn, not just where the AI estimated it would be.
  //
  // layerName (optional): used to detect structural overlays (door, panel) that
  // should fill their region exactly rather than preserving aspect ratio.

  const analysis = await assetToolService.inspectPngBuffer(buffer);
  if (!analysis.bounds || analysis.emptyAlpha) return buffer;

  const actual = analysis.bounds;
  const contentW = actual.right - actual.left + 1;
  const contentH = actual.bottom - actual.top + 1;

  // If a parent layer was already drawn, refine the target region relative to
  // the parent's ACTUAL bounds instead of the AI-estimated region. This keeps
  // child assets precisely clipped to the real parent edges.
  let region = targetRegion;
  if (parentBounds) {
    const parentW = parentBounds.right - parentBounds.left + 1;
    const parentH = parentBounds.bottom - parentBounds.top + 1;
    const relX = (targetRegion.x - parentBounds.estimatedX) / parentBounds.estimatedW;
    const relY = (targetRegion.y - parentBounds.estimatedY) / parentBounds.estimatedH;
    const relW = targetRegion.width / parentBounds.estimatedW;
    const relH = targetRegion.height / parentBounds.estimatedH;
    region = {
      x: Math.round(parentBounds.left + relX * parentW),
      y: Math.round(parentBounds.top + relY * parentH),
      width: Math.max(1, Math.round(relW * parentW)),
      height: Math.max(1, Math.round(relH * parentH))
    };
  }

  const targetW = Math.max(1, region.width);
  const targetH = Math.max(1, region.height);

  // Structural overlays (door, panel, plate) must FILL their region to cover
  // the parent surface opening. Other accessories scale proportionally.
  const isStructural = /door|panel|plate|face|hatch|lid|cover/i.test(cleanText(layerName));
  const scale = isStructural
    ? Math.max(targetW / contentW, targetH / contentH)  // fill: cover the region
    : Math.min(targetW / contentW, targetH / contentH); // fit: stay inside the region

  // Extract just the opaque content
  const contentBuffer = await sharp(buffer)
    .extract({ left: actual.left, top: actual.top, width: contentW, height: contentH })
    .png()
    .toBuffer();

  // Scale if meaningfully different from target size (>5% off)
  let finalContent = contentBuffer;
  let finalW = contentW;
  let finalH = contentH;
  if (isStructural) {
    // Structural overlays resize to EXACT region dimensions to cover the surface
    finalW = targetW;
    finalH = targetH;
    finalContent = await sharp(contentBuffer)
      .resize({ width: finalW, height: finalH, fit: "fill" })
      .png()
      .toBuffer();
  } else if (Math.abs(scale - 1) > 0.05) {
    finalW = Math.max(1, Math.round(contentW * scale));
    finalH = Math.max(1, Math.round(contentH * scale));
    finalContent = await sharp(contentBuffer)
      .resize({ width: finalW, height: finalH, fit: "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const meta = await sharp(finalContent).metadata();
    finalW = meta.width;
    finalH = meta.height;
  }

  // Place at the target region's center, clamped to canvas
  const placeLeft = Math.max(0, Math.min(canvasW - finalW,
    Math.round(region.x + (targetW - finalW) / 2)));
  const placeTop = Math.max(0, Math.min(canvasH - finalH,
    Math.round(region.y + (targetH - finalH) / 2)));

  return sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{ input: finalContent, left: placeLeft, top: placeTop }])
    .png()
    .toBuffer();
}

function computeRegionFromTransform(transform, variant, canvas) {
  const canvasW = Math.max(1, Number(canvas?.width || 1024));
  const canvasH = Math.max(1, Number(canvas?.height || 1024));
  const t = normalizeLayerTransform(transform);

  // The variant PNG is generated at canvas size. The composite renderer applies
  // scale and offset: targetW = canvasW * scale, left = (canvasW - targetW)/2 + x * canvasW
  // We also need to account for the actual content bounds within the variant image.
  // For simplicity, use the full canvas dimensions as the base — the repositioner
  // will refine from the actual content bounds at generation time.
  const regionW = Math.round(canvasW * t.scale);
  const regionH = Math.round(canvasH * t.scale);
  const regionX = Math.round((canvasW - regionW) / 2 + t.x * canvasW);
  const regionY = Math.round((canvasH - regionH) / 2 + t.y * canvasH);

  return {
    x: Math.max(0, regionX),
    y: Math.max(0, regionY),
    width: Math.min(regionW, canvasW - Math.max(0, regionX)),
    height: Math.min(regionH, canvasH - Math.max(0, regionY))
  };
}

async function computeLayerTransformFromContent(layer, canvas) {
  // Generated layers are already full-canvas PNGs (same size as the canvas) with
  // content positioned where it belongs. The composite renderer centers them and
  // applies scale/offset from the transform. So the correct default for all
  // generated layers is identity: no offset, no scaling — just stack them as-is.
  // Only apply fit-profile defaults for layers that were NOT generated from the
  // preview (i.e. they have no variants yet or were manually uploaded at a
  // different resolution).

  const variant = (layer.variants || []).find((v) => v.id === layer.selectedVariantId) || (layer.variants || [])[0];
  if (!variant?.imageUrl) return { x: 0, y: 0, scale: 1 };

  try {
    const absolutePath = publicAssetUrlToAbsolutePath(variant.imageUrl);
    const metadata = await sharp(absolutePath).metadata();
    const canvasW = canvas.width || 1024;
    const canvasH = canvas.height || 1024;
    const imgW = metadata.width || canvasW;
    const imgH = metadata.height || canvasH;

    // If the layer image matches the canvas size, it was generated to fit —
    // use identity transform so it composites exactly where the content sits.
    if (imgW === canvasW && imgH === canvasH) {
      return { x: 0, y: 0, scale: 1 };
    }

    // If the image is a different size (e.g. manually uploaded), scale to fit.
    const scale = Math.min(canvasW / imgW, canvasH / imgH);
    return normalizeLayerTransform({ x: 0, y: 0, scale: Number(scale.toFixed(3)) });
  } catch {
    return { x: 0, y: 0, scale: 1 };
  }
}

function sortLayersByType(layers) {
  const order = [
    "background", "background-accent", "base", "body", "character", "avatar",
    "outfit", "neckwear", "mouth", "eyewear", "headwear",
    "handheld", "surface-overlay"
  ];

  return [...layers].sort((a, b) => {
    const aIdx = getLayerSortIndex(a.name, order);
    const bIdx = getLayerSortIndex(b.name, order);
    return aIdx - bIdx;
  });
}

function getLayerSortIndex(layerName, order) {
  const lowered = cleanText(layerName).toLowerCase();

  if (isFullCanvasBackgroundLayerName(lowered)) return 0;
  if (isBackgroundAccentLayerName(lowered)) return 1;
  if (isPrimaryBaseLayerName(lowered)) return 2;

  const fitProfile = getLayerFitProfile(layerName);
  const profileId = cleanText(fitProfile?.id).toLowerCase();
  const idx = order.indexOf(profileId);
  if (idx !== -1) return idx;

  if (/outfit|shirt|hoodie|jacket/.test(lowered)) return 5;
  if (/neck|chain|scarf/.test(lowered)) return 6;
  if (/mouth|smile|teeth/.test(lowered)) return 7;
  if (/eye|glasses|shades/.test(lowered)) return 8;
  if (/head|hat|crown|tiara/.test(lowered)) return 9;
  if (/hand|weapon|sword|prop/.test(lowered)) return 10;

  return 50;
}

function calculateSupplyInfo(project) {
  const layers = (project.layers || []).filter((l) => l.variants && l.variants.length > 0);
  if (!layers.length) return { totalCombos: 0, layers: [], hasConflicts: false };

  let totalCombos = 1;
  const layerInfo = layers.map((layer) => {
    const count = layer.variants.length;
    totalCombos *= count;
    return {
      name: layer.name,
      variantCount: count,
      variants: layer.variants.map((v) => ({
        name: v.name,
        weight: Number.isFinite(v.rarityWeight) ? v.rarityWeight : 50
      }))
    };
  });

  const hasConflicts = layers.some((l) => Array.isArray(l.conflicts) && l.conflicts.length > 0);
  return { totalCombos, layers: layerInfo, hasConflicts };
}

function buildHashLipsLayerFolders(project) {
  return project.layers
    .map((layer, index) => {
      const variants = (layer.variants || []).map((variant) => {
        const weight = Number.isFinite(variant.rarityWeight) ? variant.rarityWeight : 50;
        const safeName = sanitizeFileName(variant.name, "variant");
        return {
          ...variant,
          absolutePath: publicAssetUrlToAbsolutePath(variant.imageUrl),
          fileName: `${safeName}#${weight}.png`
        };
      });

      return {
        id: layer.id,
        name: layer.name,
        folderName: `${String(index + 1).padStart(2, "0")}_${sanitizeFileName(layer.name, "Layer")}`,
        variants
      };
    })
    .filter((layer) => layer.variants.length);
}

async function refreshMemoryIfPossible(project, memory, apiKey = runtimeState.sessionApiKey || process.env.OPENAI_API_KEY || "") {
  if (!apiKey) {
    return memory;
  }

  try {
    return await refreshMemoryWithApi(project, memory, apiKey);
  } catch {
    return memory;
  }
}

async function refreshMemoryWithApi(project, memory, apiKey) {
  const brain = await studioBrainService.getBrain();
  const toolManifest = await studioBrainService.getToolManifest();
  const aiMemory = await openaiService.refreshStudioMemory(apiKey, project, memory, brain, toolManifest);
  const normalized = {
    ...memory,
    contextSummary: aiMemory.contextSummary || memory.contextSummary,
    styleRules: aiMemory.styleRules.length ? aiMemory.styleRules : memory.styleRules,
    lockedDecisions: aiMemory.lockedDecisions.length
      ? aiMemory.lockedDecisions.map((item, index) => ({
          id: memory.lockedDecisions[index]?.id || createId("decision"),
          title: item.title,
          detail: item.detail,
          createdAt: memory.lockedDecisions[index]?.createdAt || new Date().toISOString()
        }))
      : memory.lockedDecisions,
    updatedAt: new Date().toISOString()
  };

  await studioMemoryService.writeMemory(project.id, normalized);
  return normalized;
}

async function refreshBrainIfPossible(project, memory, apiKey = runtimeState.sessionApiKey || process.env.OPENAI_API_KEY || "", event = null) {
  if (!event) {
    return null;
  }

  const recordedBrain = await studioBrainService.recordSessionEvent(project, event);
  if (!apiKey) {
    return recordedBrain;
  }

  try {
    const toolManifest = await studioBrainService.getToolManifest();
    const reflection = await openaiService.refreshStudioBrain(
      apiKey,
      project,
      memory,
      recordedBrain,
      toolManifest,
      event
    );
    return await studioBrainService.mergeAiReflection({
      ...reflection,
      drawingLessons: (reflection.drawingLessons || []).map((lesson) => ({
        ...lesson,
        sourceProjectId: project.id,
        sourceProjectTitle: project.title
      }))
    });
  } catch {
    return recordedBrain;
  }
}

async function inspectVariantAgainstLayer(layer, variantBuffer) {
  const analysis = await assetToolService.inspectPngBuffer(variantBuffer);
  let strongestSimilarity = 0;
  let strongestMatchName = "";

  for (const existing of Array.isArray(layer.variants) ? layer.variants.slice(-4) : []) {
    try {
      const absolutePath = publicAssetUrlToAbsolutePath(existing.imageUrl);
      const existingBuffer = await fs.readFile(absolutePath);
      const comparison = await assetToolService.comparePngBuffers(variantBuffer, existingBuffer);
      if (comparison.similarity > strongestSimilarity) {
        strongestSimilarity = comparison.similarity;
        strongestMatchName = existing.name;
      }
    } catch {
      // Ignore a bad comparison so one missing file does not block generation.
    }
  }

  return {
    ...analysis,
    strongestMatchName,
    strongestSimilarity,
    possibleDuplicate: strongestSimilarity >= 0.985
  };
}

async function inspectDraftAgainstHistory(project, draftBuffer) {
  const analysis = await assetToolService.inspectPngBuffer(draftBuffer);
  let strongestSimilarity = 0;
  let strongestMatchName = "";

  for (const existing of (project.draftHistory || []).slice(0, 6)) {
    try {
      const absolutePath = publicAssetUrlToAbsolutePath(existing.imageUrl);
      const existingBuffer = await fs.readFile(absolutePath);
      const comparison = await assetToolService.comparePngBuffers(draftBuffer, existingBuffer);
      if (comparison.similarity > strongestSimilarity) {
        strongestSimilarity = comparison.similarity;
        strongestMatchName = existing.name;
      }
    } catch {
      // Skip bad draft comparisons.
    }
  }

  return {
    ...analysis,
    strongestMatchName,
    strongestSimilarity,
    possibleDuplicate: strongestSimilarity >= 0.985
  };
}

function summarizeVariantAnalysis(variants) {
  const analyses = variants.map((variant) => variant.analysis).filter(Boolean);
  if (!analyses.length) {
    return null;
  }

  return {
    width: analyses[0].width,
    height: analyses[0].height,
    alphaCoverage: Number(
      (analyses.reduce((sum, item) => sum + Number(item.alphaCoverage || 0), 0) / analyses.length).toFixed(4)
    ),
    touchesEdge: analyses.some((item) => item.touchesEdge),
    possibleDuplicate: analyses.some((item) => item.possibleDuplicate),
    strongestMatchName: analyses.find((item) => item.strongestMatchName)?.strongestMatchName || "",
    strongestSimilarity: Math.max(...analyses.map((item) => Number(item.strongestSimilarity || 0)))
  };
}

function getAccessibleUrls(port) {
  const urls = [`http://localhost:${port}`];
  const interfaces = os.networkInterfaces();

  for (const values of Object.values(interfaces)) {
    for (const entry of values || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }

  return [...new Set(urls)];
}

function buildHashLipsExportManifest(project, layerFolders) {
  return {
    projectId: project.id,
    title: project.title,
    canvas: project.canvas,
    planSummary: project.planSummary,
    exportedAt: new Date().toISOString(),
    layers: layerFolders.map((layer) => ({
      id: layer.id,
      name: layer.name,
      folderName: layer.folderName,
      variants: layer.variants.map((variant) => ({
        id: variant.id,
        name: variant.name,
        fileName: variant.fileName,
        prompt: variant.prompt,
        createdAt: variant.createdAt
      }))
    }))
  };
}

async function getPreviewCompositeSources(project) {
  const sources = [];
  const seen = new Set();

  const pushSource = async (imageUrl, meta = {}) => {
    const cleanUrl = cleanText(imageUrl);
    if (!cleanUrl || seen.has(cleanUrl)) {
      return;
    }

    const absolutePath = publicAssetUrlToAbsolutePath(cleanUrl);
    try {
      await fs.access(absolutePath);
      sources.push({
        imageUrl: cleanUrl,
        absolutePath,
        layerId: cleanText(meta.layerId),
        layerName: cleanText(meta.layerName),
        layerIndex: Number.isFinite(meta.layerIndex) ? Number(meta.layerIndex) : -1,
        isBaseLayer: Boolean(meta.isBaseLayer),
        analysis: meta.analysis || null
      });
      seen.add(cleanUrl);
    } catch (err) {
      console.warn(`[composite] Skipping missing asset: ${cleanUrl} — ${err.message || "file not found"}`);
    }
  };

  for (const layer of project.layers || []) {
    const variant = (layer.variants || []).find((item) => item.id === layer.selectedVariantId);
    if (variant?.imageUrl) {
      await pushSource(variant.imageUrl, {
        layerId: layer.id,
        layerName: layer.name,
        layerIndex: project.layers.indexOf(layer),
        isBaseLayer: isPrimaryBaseLayerName(layer.name),
        analysis: variant.analysis || null
      });
      const latest = sources[sources.length - 1];
      if (latest) {
        latest.transform = getVariantPlacementTransform(layer, variant);
      }
    }
  }

  return sources;
}

async function buildCompositeLayers(source, width, height, baseSource = null) {
  const transform = normalizeLayerTransform(source.transform);
  const fitProfile = getLayerFitProfile(source.layerName);
  const clipStrategy = cleanText(fitProfile?.clipStrategy).toLowerCase();
  const metadata = await sharp(source.absolutePath).metadata();
  const baseWidth = Math.max(1, Number(metadata.width || width));
  const baseHeight = Math.max(1, Number(metadata.height || height));
  const targetWidth = Math.max(1, Math.round(baseWidth * transform.scale));
  const targetHeight = Math.max(1, Math.round(baseHeight * transform.scale));
  let left = Math.round((width - targetWidth) / 2 + transform.x * width);
  let top = Math.round((height - targetHeight) / 2 + transform.y * height);

  let input = await sharp(source.absolutePath)
    .resize({
      width: targetWidth,
      height: targetHeight,
      fit: "contain"
    })
    .png()
    .toBuffer();

  // Apply rotation if set (non-zero). Rotate expands the bounding box, so
  // recalculate left/top to keep the layer centered at its original position.
  const rotation = transform.rotation || 0;
  if (rotation > 0) {
    const preRotateMeta = await sharp(input).metadata();
    input = await sharp(input)
      .rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const postRotateMeta = await sharp(input).metadata();
    // Adjust placement so the center stays in the same spot
    left = left - Math.round((postRotateMeta.width - preRotateMeta.width) / 2);
    top = top - Math.round((postRotateMeta.height - preRotateMeta.height) / 2);
  }

  const sourceIndex = Number.isFinite(source.layerIndex) ? Number(source.layerIndex) : -1;
  const baseIndex = Number.isFinite(baseSource?.layerIndex) ? Number(baseSource.layerIndex) : -1;
  const isBehindBase = baseSource && sourceIndex !== -1 && baseIndex !== -1 && sourceIndex < baseIndex;
  const isInFrontOfBase = baseSource && sourceIndex !== -1 && baseIndex !== -1 && sourceIndex > baseIndex;
  const shouldWrapBehindBase =
    transform.depthMode === "headwear_wrap" &&
    /headwear|hat|crown|tiara/.test(cleanText(source.layerName).toLowerCase()) &&
    isBehindBase;

  if (shouldWrapBehindBase) {
    return [
      {
        input,
        left,
        top,
        stage: "headwear-wrap"
      }
    ];
  }

  if (isBehindBase) {
    if (clipStrategy === "behind_anchor") {
      const clippedInput = await buildBehindAnchorLayerInput(input, left, top, baseSource, width, height);
      return [
        {
          input: clippedInput,
          left: 0,
          top: 0,
          stage: "behind-base"
        }
      ];
    }

    return [
      {
        input,
        left,
        top,
        stage: "behind-base"
      }
    ];
  }

  if (isInFrontOfBase) {
    return [
      {
        input,
        left,
        top,
        stage: "in-front-base"
      }
    ];
  }

  return [
    {
      input,
      left,
      top,
      stage: source.isBaseLayer ? "base" : "normal"
    }
  ];
}

async function buildAnchorOccluderPiece(sources, width, height) {
  const baseSource = sources.find((source) => source.isBaseLayer);
  const baseIndex = Number.isFinite(baseSource?.layerIndex) ? Number(baseSource.layerIndex) : -1;
  const headwearSource = sources.find(
    (source) =>
      normalizeLayerTransform(source.transform).depthMode === "headwear_wrap" &&
      /headwear|hat|crown|tiara/.test(cleanText(source.layerName).toLowerCase()) &&
      Number.isFinite(source.layerIndex) &&
      baseIndex !== -1 &&
      Number(source.layerIndex) < baseIndex
  );
  if (!baseSource || !headwearSource) {
    return null;
  }

  const baseAnalysis = baseSource.analysis || null;
  const baseBounds = baseAnalysis?.bounds || null;
  if (!baseBounds) {
    return null;
  }

  const fitProfile = getLayerFitProfile(headwearSource.layerName);
  const occluderRatio = Math.min(0.5, coerceProfileNumber(fitProfile?.anchorBottomRatio, 0.22) + 0.035);
  const transform = normalizeLayerTransform(baseSource.transform);
  const metadata = await sharp(baseSource.absolutePath).metadata();
  const imageWidth = Math.max(1, Number(metadata.width || width));
  const imageHeight = Math.max(1, Number(metadata.height || height));
  const targetWidth = Math.max(1, Math.round(imageWidth * transform.scale));
  const targetHeight = Math.max(1, Math.round(imageHeight * transform.scale));
  const left = Math.round((width - targetWidth) / 2 + transform.x * width);
  const top = Math.round((height - targetHeight) / 2 + transform.y * height);
  const resizedBase = await sharp(baseSource.absolutePath)
    .resize({
      width: targetWidth,
      height: targetHeight,
      fit: "contain"
    })
    .png()
    .toBuffer();

  const anchorHeight = Math.max(1, Number(baseBounds.bottom) - Number(baseBounds.top) + 1);
  const capBottom = Math.max(
    1,
    Math.min(
      targetHeight,
      Math.round((Number(baseBounds.top) + anchorHeight * occluderRatio) * transform.scale)
    )
  );

  return {
    input: await sharp(resizedBase)
      .extract({
        left: 0,
        top: 0,
        width: targetWidth,
        height: capBottom
      })
      .png()
      .toBuffer(),
    left,
    top,
    stage: "anchor-occluder"
  };
}

async function buildBehindAnchorLayerInput(sourceInput, sourceLeft, sourceTop, baseSource, width, height) {
  if (!baseSource?.absolutePath) {
    return sourceInput;
  }

  const baseTransform = normalizeLayerTransform(baseSource.transform);
  const baseMetadata = await sharp(baseSource.absolutePath).metadata();
  const baseWidth = Math.max(1, Number(baseMetadata.width || width));
  const baseHeight = Math.max(1, Number(baseMetadata.height || height));
  const baseTargetWidth = Math.max(1, Math.round(baseWidth * baseTransform.scale));
  const baseTargetHeight = Math.max(1, Math.round(baseHeight * baseTransform.scale));
  const baseLeft = Math.round((width - baseTargetWidth) / 2 + baseTransform.x * width);
  const baseTop = Math.round((height - baseTargetHeight) / 2 + baseTransform.y * height);
  const baseInput = await sharp(baseSource.absolutePath)
    .resize({
      width: baseTargetWidth,
      height: baseTargetHeight,
      fit: "contain"
    })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([
      {
        input: sourceInput,
        left: sourceLeft,
        top: sourceTop
      },
      {
        input: baseInput,
        left: baseLeft,
        top: baseTop,
        blend: "dest-out"
      }
    ])
    .png()
    .toBuffer();
}

function isPrimaryBaseLayerName(layerName) {
  const token = cleanText(layerName).toLowerCase();
  if (!token) {
    return false;
  }

  return /(base|body|character|avatar|shell|vault|safe|chest|crate|trunk)/.test(token);
}

function publicAssetUrlToAbsolutePath(assetUrl) {
  const cleanUrl = cleanText(assetUrl);
  if (!cleanUrl) {
    return "";
  }

  const normalized = cleanUrl.replaceAll("/", path.sep);
  if (cleanUrl.startsWith("/generated/")) {
    return path.join(generatedDir, normalized.replace(/^\\generated\\/, ""));
  }

  if (cleanUrl.startsWith("/uploads/")) {
    return path.join(uploadsDir, normalized.replace(/^\\uploads\\/, ""));
  }

  return path.join(rootDir, normalized.replace(/^[\\/]+/, ""));
}

function buildHashLipsConfig(project, layerFolders) {
  return {
    namePrefix: project.title,
    description: project.collectionGoal || "Generated with Draw Tech",
    width: project.canvas.width,
    height: project.canvas.height,
    layersOrder: layerFolders.map((layer) => ({ name: layer.folderName })),
    preview: {
      thumbWidth: Math.min(project.canvas.width, 512),
      thumbHeight: Math.min(project.canvas.height, 512),
      imageRatio: "1:1"
    }
  };
}

function buildHashLipsReadme(project) {
  return [
    `Project: ${project.title}`,
    "",
    "This zip was exported from Draw Tech in a HashLips-friendly layout.",
    "",
    "Contents:",
    "- layers/: numbered layer folders containing PNG assets",
    "- hashlips.config.json: starter width, height, and layer order metadata",
    "- draw-tech.project.json: prompts and export manifest",
    "",
    "If your HashLips variant expects a different config filename or object shape, use the layer folders directly and adapt hashlips.config.json to your fork."
  ].join("\n");
}
