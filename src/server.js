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
import { clampVariantCount, cleanText, createId, loadEnvFile, sanitizeFileName, slugify } from "./lib/utils.js";

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

const app = express();
const runtimeState = {
  sessionApiKey: ""
};

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
    const contextualAttachments = await extendAttachmentsWithLatestDraft(project, promptText, attachments);
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
        targetLayerName: route.targetLayerName || guessLayerNameFromPrompt(promptText),
        extraDirection: route.variantDirection,
        attachments: contextualAttachments
      });
      project = draftResult.project;
      memory = draftResult.memory;
      assistantGenerated = toAssistantGeneratedImage(draftResult.draft);
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
      const latestDraft = getLatestOpenDraft(project);
      if (!latestDraft) {
        assistantReply = "There is no draft waiting in chat to add yet.";
      } else {
        const targetLayerName =
          route.targetLayerName || guessLayerNameFromPrompt(promptText) || latestDraft.targetLayerName || "Accessory";
        const commitResult = await commitDraftToLayer(project, latestDraft.id, targetLayerName);
        project = commitResult.project;
        memory = commitResult.memory;
        assistantGenerated = toAssistantGeneratedImage(commitResult.draft);
        assistantReply = assistantReply || `Added that draft into ${commitResult.layer.name}.`;
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
      id: createId("assistant"),
      role: "assistant",
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
    layer.selectedVariantId = layer.variants.some((variant) => variant.id === variantId)
      ? variantId
      : null;
    project.updatedAt = new Date().toISOString();
    await projectService.writeProject(project);
    const memory = await studioMemoryService.appendChangelog(project, {
      type: "selection",
      title: `Selected ${layer.name} variant`,
      detail: variantId || "Cleared active variant selection."
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
      draft: result.draft,
      layer: result.layer,
      variant: result.variant
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
  await fs.mkdir(uploadsDir, { recursive: true });
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

async function commitDraftToLayer(project, draftId, targetLayerName) {
  project.draftHistory = Array.isArray(project.draftHistory) ? project.draftHistory : [];
  const draft = project.draftHistory.find((item) => item.id === draftId);
  if (!draft) {
    const error = new Error("Draft not found.");
    error.status = 404;
    throw error;
  }

  const layer = ensureLayer(project, targetLayerName || draft.targetLayerName || "Accessory");
  if (!Array.isArray(layer.variants)) {
    layer.variants = [];
  }

  const variant = {
    id: createId("variant"),
    name: cleanText(draft.name) || `${layer.name} Variant`,
    notes: cleanText(draft.notes),
    prompt: cleanText(draft.prompt),
    imageUrl: draft.imageUrl,
    analysis: draft.analysis || null,
    createdAt: new Date().toISOString()
  };

  layer.variants.push(variant);
  layer.selectedVariantId = variant.id;
  draft.status = "committed";
  draft.committedLayerId = layer.id;
  draft.committedLayerName = layer.name;
  draft.committedVariantId = variant.id;
  draft.updatedAt = new Date().toISOString();
  project.updatedAt = new Date().toISOString();
  await projectService.writeProject(project);

  let memory = await studioMemoryService.appendChangelog(project, {
    type: "commit-draft",
    title: `Committed ${variant.name}`,
    detail: `Added to ${layer.name}.`
  });
  memory = await refreshMemoryIfPossible(project, memory);
  return { project, memory, draft, layer, variant };
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
    selectedVariantId: null
  };
  project.layers.push(layer);
  return layer;
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

async function extendAttachmentsWithLatestDraft(project, promptText, attachments) {
  const values = Array.isArray(attachments) ? [...attachments] : [];
  const latestDraft = getLatestOpenDraft(project);
  if (!latestDraft || !shouldUseLatestDraftAsReference(promptText)) {
    return values;
  }

  try {
    const absolutePath = path.join(rootDir, latestDraft.imageUrl.replace(/^\//, "").replaceAll("/", path.sep));
    const fileBuffer = await fs.readFile(absolutePath);
    values.push({
      id: latestDraft.id,
      name: latestDraft.name || "Latest draft",
      mimeType: "image/png",
      width: Number(project.canvas?.width || 0),
      height: Number(project.canvas?.height || 0),
      imageUrl: latestDraft.imageUrl,
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

function guessLayerNameFromPrompt(promptText) {
  const lowered = cleanText(promptText).toLowerCase();
  const known = ["background", "body", "face", "eyes", "mouth", "hat", "headwear", "clothes", "clothing", "fur", "accessory"];
  const match = known.find((item) => lowered.includes(item));
  if (!match) {
    return "";
  }

  return match === "clothes" ? "Clothing" : match === "headwear" ? "Hat" : match.charAt(0).toUpperCase() + match.slice(1);
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
        absolutePath: path.join(rootDir, variant.imageUrl.replace(/^\//, "").replaceAll("/", path.sep)),
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
      const absolutePath = path.join(rootDir, existing.imageUrl.replace(/^\//, "").replaceAll("/", path.sep));
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
      const absolutePath = path.join(rootDir, existing.imageUrl.replace(/^\//, "").replaceAll("/", path.sep));
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
