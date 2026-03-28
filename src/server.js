import express from "express";
import archiver from "archiver";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createOpenAIService } from "./lib/openai-service.js";
import { createProjectService } from "./lib/project-service.js";
import { createStudioMemoryService } from "./lib/studio-memory-service.js";
import { clampVariantCount, createId, loadEnvFile, sanitizeFileName } from "./lib/utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const projectsDir = path.join(dataDir, "projects");
const generatedDir = path.join(dataDir, "generated");
const memoryDir = path.join(dataDir, "memory");

loadEnvFile(path.join(rootDir, ".env"), readFileSync);

const projectService = createProjectService({ projectsDir });
const studioMemoryService = createStudioMemoryService({ memoryDir });
const openaiService = createOpenAIService();

const app = express();
const runtimeState = {
  sessionApiKey: ""
};

app.use(express.json({ limit: "2mb" }));
app.use("/generated", express.static(generatedDir));
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

    const plan = await openaiService.createPreviewPlan(apiKey, project, memory);
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

    const plan = await openaiService.createLayerVariantPlan(apiKey, project, layer, count, memory);
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

app.use((error, _req, res, _next) => {
  const status = Number(error.status || 500);
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
  const aiMemory = await openaiService.refreshStudioMemory(apiKey, project, memory);
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
