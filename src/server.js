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
  "When editing an existing layer image, preserve the source drawing and change only the requested feature unless the user explicitly asks for a redraw."
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

    res.json({ project, memory, action, assistantReply });
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

    const variants = [];
    for (const item of plan.variants) {
      const imageAsset = await openaiService.generateImageAsset({
        apiKey,
        prompt: item.prompt,
        size: project.canvas.generationSize,
        background: "transparent"
      });

      const variantId = createId("variant");
      const filename = `${variantId}.png`;
      await fs.writeFile(
        path.join(variantFolder, filename),
        await resizePng(imageAsset.buffer, project.canvas)
      );

      variants.push({
        id: variantId,
        name: item.name,
        notes: item.notes,
        prompt: item.prompt,
        imageUrl: `/generated/${project.id}/layers/${layer.id}/${filename}`,
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
    res.json({ project, variants, memory });
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
    const useVariantTransform = requestedScope === "variant" || isVariantUsingCustomTransform(variant);
    const currentTransform = useVariantTransform
      ? getVariantPlacementTransform(layer, variant)
      : getLayerPlacementTransform(layer, variant);
    const nextTransform = mergeLayerTransform(currentTransform, patch);
    applyPlacementTransformForVariant(layer, variant, nextTransform, useVariantTransform ? "custom" : "sync");
    layer.selectedVariantId = variant.id;
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
        : null
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
      fit: "fill"
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
  const previewEntry = {
    id: previewId,
    imageUrl: `/generated/${project.id}/preview/${previewFilename}`,
    prompt: plan.previewPrompt,
    notes: plan.collectionSummary,
    createdAt: now
  };
  project.previewHistory.unshift(previewEntry);
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
  const layerTransform = getLayerPlacementTransform(layer);
  for (const item of plan.variants) {
    const imageAsset = await openaiService.generateImageAsset({
      apiKey,
      prompt: [item.prompt, cleanText(options.extraDirection)].filter(Boolean).join(" "),
      size: project.canvas.generationSize,
      background: "transparent"
    });

    const variantId = createId("variant");
    const filename = `${variantId}.png`;
    const absolutePath = path.join(variantFolder, filename);
    await fs.writeFile(absolutePath, await resizePng(imageAsset.buffer, project.canvas));
    const variantBuffer = await fs.readFile(absolutePath);
    const analysis = await inspectVariantAgainstLayer(layer, variantBuffer);

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
  const targetLayerName = cleanText(options.targetLayerName) || "Unsorted";
  const draftLayer = {
    id: `draft-${slugify(targetLayerName) || "layer"}`,
    name: targetLayerName,
    description: cleanText(options.extraDirection) || cleanText(options.promptText),
    placementNotes: "Single isolated asset for draft review before folder commit.",
    variantIdeas: [],
    variants: project.draftHistory
      .filter((item) => cleanText(item.targetLayerName) === targetLayerName)
      .map((item) => ({ id: item.id, name: item.name, imageUrl: item.imageUrl }))
  };

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
    options.attachments || []
  );
  const item = plan.variants[0];
  const imageAsset = await openaiService.generateImageAsset({
    apiKey,
    prompt: [item?.prompt, cleanText(options.extraDirection)].filter(Boolean).join(" "),
    size: project.canvas.generationSize,
    background: "transparent"
  });

  const draftId = createId("draft");
  const draftFolder = path.join(generatedDir, project.id, "drafts");
  const filename = `${draftId}.png`;
  const absolutePath = path.join(draftFolder, filename);
  await fs.mkdir(draftFolder, { recursive: true });
  await fs.writeFile(absolutePath, await resizePng(imageAsset.buffer, project.canvas));
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

  const layerTransform = getLayerPlacementTransform(layer);
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

  layer.variants.push(variant);
  applyLayerPlacementTransform(layer, layerTransform);
  layer.selectedVariantId = variant.id;
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

  const normalizedName = cleanText(layerName) || "Layer";
  const layer = {
    id: `layer-${project.layers.length + 1}-${slugify(normalizedName) || "layer"}`,
    name: normalizedName,
    description: "",
    placementNotes: "",
    variantIdeas: [],
    variants: [],
    selectedVariantId: null,
    transform: getDefaultTransformForLayer(normalizedName)
  };
  project.layers.push(layer);
  return layer;
}

function shouldForceFreshTraitDraft(project, promptText, route = {}) {
  const lowered = cleanText(promptText).toLowerCase();
  const routedAction = cleanText(route.actionType).toLowerCase();
  const guessedLayerName = cleanText(route.targetLayerName) || guessLayerNameFromPrompt(promptText);
  const matchingExistingLayer = guessedLayerName ? findLayer(project, guessedLayerName) : null;
  const keepExistingIntent = hasKeepExistingTraitIntent(lowered);
  const explicitSeparateFolderIntent = hasExplicitSeparateFolderIntent(lowered);
  const freshCreationIntent =
    /\b(draw|make|create|generate|design|craft|show|give)\b/.test(lowered) ||
    /\b(new|another|fresh|different)\b/.test(lowered);

  if (!freshCreationIntent) {
    return false;
  }

  if (!keepExistingIntent && !explicitSeparateFolderIntent && mentionsExplicitExistingLayerMutation(lowered)) {
    return false;
  }

  if (["commit_draft", "remove_variant", "remove_layer", "update_canvas"].includes(routedAction)) {
    return false;
  }

  if (keepExistingIntent || explicitSeparateFolderIntent) {
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
    /\b(add|put|save|commit)\b[\s\S]*\b(layer|folder)\b/.test(
      lowered
    )
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

function resolveDraftTargetLayerName(project, promptText, route = {}) {
  const explicitTarget = cleanText(route.targetLayerName);
  const semanticTarget = guessLayerNameFromPrompt(promptText);
  const guessedTarget = explicitTarget || semanticTarget;
  const separateFolderIntent = hasExplicitSeparateFolderIntent(promptText);
  const existingSemanticTarget = semanticTarget ? findLayer(project, semanticTarget) : null;

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
  return {
    x: clampTransformNumber(transform?.x, 0, -0.45, 0.45),
    y: clampTransformNumber(transform?.y, 0, -0.45, 0.45),
    scale: clampTransformNumber(transform?.scale, 1, 0.15, 1.8),
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

function mergeLayerTransform(current, patch) {
  const next = {
    x: patch.x ?? current.x,
    y: patch.y ?? current.y,
    scale: patch.scale ?? current.scale,
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
    /(back part|back hoop|really on|sit naturally|sits naturally|see how|example|proper|fit|fits|fitting|tighten|tighter|too wide|wide|narrow|narrower|slimmer|stack|overlay|clip|sized?|wear|worn|hold|held|grip|gripping|hand|paw|arm|eye line|face better)/.test(
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
  return /(head|face|eye|eyes|eye line|forehead|brow|cheek|muzzle|base|body|character|avatar|subject|construct|center piece|centerpiece|main asset|main body|main character|upper area|upper body|hand|hands|paw|paws|arm|arms|grip|holding)/.test(
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

  const sourceBottom = Number(sourceAnalysis?.bounds?.bottom ?? 0);
  const revisedBottom = Number(revisedAnalysis?.bounds?.bottom ?? 0);
  const sourceHeight = Math.max(1, Number(sourceAnalysis?.height || revisedAnalysis?.height || 1024));
  const revisedBottomRatio = revisedBottom / sourceHeight;
  const sourceBottomRatio = sourceBottom / sourceHeight;
  const sourceCoverage = Number(sourceAnalysis?.alphaCoverage || 0);
  const revisedCoverage = Number(revisedAnalysis?.alphaCoverage || 0);

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

  const height = Math.max(1, Number(analysis?.height || 1024));
  const bottomRatio = Number(analysis?.bounds?.bottom ?? 0) / height;
  const coverage = Number(analysis?.alphaCoverage || 0);
  const lowered = cleanText(layer?.name).toLowerCase();

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
  if (!anchorBounds || !variantBounds) {
    return mergeLayerTransform(currentTransform, {
      depthMode: cleanText(fitProfile?.clipStrategy) === "headwear_wrap" ? "headwear_wrap" : "flat",
      backCutoff: coerceProfileNumber(fitProfile?.backCutoff, currentTransform.backCutoff),
      frontStart: coerceProfileNumber(fitProfile?.frontStart, currentTransform.frontStart)
    });
  }

  const defaultTransform = normalizeLayerTransform(getDefaultTransformForLayer(layer?.name));
  const anchorWidth = Math.max(1, Number(anchorBounds.right) - Number(anchorBounds.left) + 1);
  const anchorHeight = Math.max(1, Number(anchorBounds.bottom) - Number(anchorBounds.top) + 1);
  const variantWidth = Math.max(1, Number(variantBounds.right) - Number(variantBounds.left) + 1);
  const anchorCenterX = (Number(anchorBounds.left) + Number(anchorBounds.right)) / 2;
  const variantCenterX = (Number(variantBounds.left) + Number(variantBounds.right)) / 2;
  const variantCenterY = (Number(variantBounds.top) + Number(variantBounds.bottom)) / 2;
  let baseScale = defaultTransform.scale;
  let imageLeft = 0;
  let imageTop = 0;

  if (profileId === "headwear") {
    const targetWidth = anchorWidth * coerceProfileNumber(fitProfile?.anchorWidthRatio, 0.64);
    baseScale = clampTransformNumber(targetWidth / variantWidth, defaultTransform.scale, 0.15, 1.8);
    const targetBottom = Number(anchorBounds.top) + anchorHeight * coerceProfileNumber(fitProfile?.anchorBottomRatio, 0.22);
    imageLeft = anchorCenterX - variantCenterX * baseScale;
    imageTop = targetBottom - Number(variantBounds.bottom) * baseScale;
  } else if (profileId === "eyewear") {
    let targetWidthRatio = coerceProfileNumber(fitProfile?.anchorWidthRatio, 0.68);
    let targetCenterYRatio = coerceProfileNumber(fitProfile?.anchorCenterYRatio, 0.46);
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
    imageLeft = anchorCenterX - variantCenterX * baseScale;
    imageTop = targetCenterY - variantCenterY * baseScale;
  } else {
    return null;
  }

  const fittedTransform = normalizeLayerTransform({
    x: (imageLeft - (canvasWidth - imageWidth * baseScale) / 2) / canvasWidth,
    y: (imageTop - (canvasHeight - imageHeight * baseScale) / 2) / canvasHeight,
    scale: baseScale,
    depthMode: cleanText(fitProfile?.clipStrategy) === "headwear_wrap" ? "headwear_wrap" : "flat",
    backCutoff: coerceProfileNumber(fitProfile?.backCutoff, currentTransform.backCutoff),
    frontStart: coerceProfileNumber(fitProfile?.frontStart, currentTransform.frontStart)
  });

  if (profileId === "eyewear") {
    return fittedTransform;
  }

  return applyTransformResidual(fittedTransform, currentTransform, defaultTransform);
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
  const fitProfile = getLayerFitProfile(layerName);
  if (fitProfile?.defaultTransform) {
    return normalizeLayerTransform(fitProfile.defaultTransform);
  }

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

  if (fitProfile?.guidance) {
    return `Fit profile ${fitProfile.label || fitProfile.id} for ${anchorLabel}: ${fitProfile.guidance}`;
  }

  if (/headwear|hat|crown|tiara/.test(lowered)) {
    return `Keep this headwear sized and aligned for ${anchorLabel}: centered in the upper anchor region, stack-safe, and shaped to feel built for that character instead of a random standalone canvas.`;
  }

  if (/eyes|eyewear|glasses|shades/.test(lowered)) {
    return `Keep this eyewear aligned to ${anchorLabel}: centered over the eye line, narrowed to the visible face width, stack-safe over the eyes, and never redrawing any head or face content into the trait.`;
  }

  if (/neckwear|necklace|chain|scarf|bow/.test(lowered)) {
    return `Keep this neckwear aligned to ${anchorLabel}: centered around the neck/chest area with clean spacing and no body redraw.`;
  }

  if (/handheld|weapon|sword|staff|wand|gun|tool|prop|item|orb|flower|cane|bat|microphone/.test(lowered)) {
    return `Keep this handheld trait aligned to ${anchorLabel}: size it to the character and place it so it reads as being held by the visible hand or grip area instead of floating beside the body.`;
  }

  if (/background/.test(lowered)) {
    return `Treat ${anchorLabel} as the foreground subject and keep this background supportive instead of overlapping the character silhouette.`;
  }

  return anchor ? `Fit this ${layer.name} asset so it stacks cleanly around ${anchorLabel} without redrawing the anchor layer.` : "";
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
      dataUrl: `data:image/png;base64,${fileBuffer.toString("base64")}`
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
  const match = lowered.match(/from\s+the\s+(.+?)\s+layer/);
  if (match?.[1]) {
    return match[1];
  }

  const fallback = lowered.match(/(?:from|on)\s+(.+?)\s+layer/);
  return fallback?.[1] || "";
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
    /(?:draw|make|create|generate|design|craft|show|give)\s+(?:me\s+)?(?:a\s+|an\s+|another\s+|new\s+)?(.+)/i
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
  const source = getLatestCommitSource(project, promptText);
  if (!source || !shouldUseLatestDraftAsReference(promptText)) {
    return values;
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
      dataUrl: `data:image/png;base64,${fileBuffer.toString("base64")}`
    });
  } catch {
    return values;
  }

  return values.slice(0, 6);
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

  const known = ["background", "body", "base cat", "cat base", "face", "eyes", "mouth", "hat", "headwear", "crown", "tiara", "clothes", "clothing", "fur", "weapon", "sword", "staff", "wand", "gun", "tool", "prop", "handheld", "accessory"];
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

function buildHashLipsLayerFolders(project) {
  return project.layers
    .map((layer, index) => {
      const variants = (layer.variants || []).map((variant, variantIndex) => ({
        ...variant,
        absolutePath: publicAssetUrlToAbsolutePath(variant.imageUrl),
        fileName: `${String(variantIndex + 1).padStart(2, "0")}_${sanitizeFileName(variant.name, "variant")}.png`
      }));

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
    } catch {
      // Ignore missing assets so one broken file does not stop the composite render.
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
  const metadata = await sharp(source.absolutePath).metadata();
  const baseWidth = Math.max(1, Number(metadata.width || width));
  const baseHeight = Math.max(1, Number(metadata.height || height));
  const targetWidth = Math.max(1, Math.round(baseWidth * transform.scale));
  const targetHeight = Math.max(1, Math.round(baseHeight * transform.scale));
  const left = Math.round((width - targetWidth) / 2 + transform.x * width);
  const top = Math.round((height - targetHeight) / 2 + transform.y * height);

  const input = await sharp(source.absolutePath)
    .resize({
      width: targetWidth,
      height: targetHeight,
      fit: "contain"
    })
    .png()
    .toBuffer();

  const sourceIndex = Number.isFinite(source.layerIndex) ? Number(source.layerIndex) : -1;
  const baseIndex = Number.isFinite(baseSource?.layerIndex) ? Number(baseSource.layerIndex) : -1;
  const shouldWrapBehindBase =
    transform.depthMode === "headwear_wrap" &&
    /headwear|hat|crown|tiara/.test(cleanText(source.layerName).toLowerCase()) &&
    baseSource &&
    sourceIndex !== -1 &&
    baseIndex !== -1 &&
    sourceIndex < baseIndex;

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

function isPrimaryBaseLayerName(layerName) {
  const token = cleanText(layerName).toLowerCase();
  if (!token) {
    return false;
  }

  return /(base|body|character|avatar)/.test(token);
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
