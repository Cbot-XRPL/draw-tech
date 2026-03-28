import { cleanSlug, cleanText, safeJsonParse } from "./utils.js";

export function createOpenAIService() {
  return {
    routeUserPrompt,
    createPreviewPlan,
    createLayerVariantPlan,
    generateImageAsset,
    refreshStudioMemory,
    refreshStudioBrain
  };
}

async function routeUserPrompt(apiKey, project, memory, brain, toolManifest, promptText, attachments = []) {
  const prompt = [
    "You route a user's NFT-building request inside a layer-based art app.",
    "Return JSON only.",
    "Keys: actionType, assistantReply, title, targetLayerName, variantNameHint, variantDirection, removalTarget, canvasWidth, canvasHeight.",
    "Valid actionType values: preview, draft_variant, commit_draft, feedback, remove_variant, remove_layer, update_canvas, noop.",
    "Use preview when the user is describing a new scene, new collection direction, or wants to see a new overall image.",
    "Use draft_variant when the user asks to draw a trait, object, or isolated asset for review before it goes into a layer folder.",
    "Use commit_draft when the user is approving a recent draft and wants it added to a folder or layer.",
    "Use feedback when the user is telling you what they liked, disliked, or want remembered about prior generations or layer behavior.",
    "Use remove_variant or remove_layer only when the user clearly asks to delete.",
    "You can use recent chat history and recent generated images to resolve references like it, that, the cat from earlier, the last preview, or the one in chat.",
    "assistantReply should be one short sentence for the visible chat log.",
    "If targetLayerName is obvious, fill it in with a human-friendly layer name.",
    "variantDirection should capture the requested visual change in a short art-director style phrase.",
    "If the user is only changing the canvas, use update_canvas.",
    "Do not include markdown."
  ].join("\n");

  const payload = {
    promptText,
    project: buildProjectPayload(project),
    studio: buildStudioPayload(memory, brain, toolManifest),
    references: buildAttachmentPayload(attachments)
  };

  const response = await callOpenAIJson(apiKey, {
    model: "gpt-5.4",
    input: buildVisionInput(prompt, payload, attachments)
  });

  return {
    actionType: cleanText(response?.actionType).toLowerCase() || "preview",
    assistantReply: cleanText(response?.assistantReply),
    title: cleanText(response?.title),
    targetLayerName: cleanText(response?.targetLayerName),
    variantNameHint: cleanText(response?.variantNameHint),
    variantDirection: cleanText(response?.variantDirection),
    removalTarget: cleanText(response?.removalTarget),
    canvasWidth: Number(response?.canvasWidth || 0),
    canvasHeight: Number(response?.canvasHeight || 0)
  };
}

async function createPreviewPlan(apiKey, project, memory, brain, toolManifest, attachments = []) {
  const prompt = [
    "You are helping build a layered NFT collection.",
    "Return JSON only.",
    "The JSON must have these keys:",
    "collectionSummary: string",
    "styleGuide: string",
    "previewPrompt: string",
    "layers: array of objects with keys id, name, description, placementNotes, variantIdeas",
    "Each variantIdeas value should be an array of 3 short strings.",
    "Keep prompts highly visual and consistent across a collection.",
    "If the incoming layer list is empty or weak, infer a sensible layer stack from the prompt and project direction.",
    "Assume later each layer will be generated on a transparent background and stacked with the others.",
    "Respect cross-project lessons, but keep this collection original instead of repetitive.",
    "Do not include markdown fences."
  ].join("\n");

  const payload = {
    project: buildProjectPayload(project),
    studio: buildStudioPayload(memory, brain, toolManifest),
    references: buildAttachmentPayload(attachments)
  };

  const response = await callOpenAIJson(apiKey, {
    model: "gpt-5.4",
    input: buildVisionInput(prompt, payload, attachments)
  });

  return validatePreviewPlan(response);
}

async function createLayerVariantPlan(apiKey, project, layer, count, memory, brain, toolManifest, attachments = []) {
  const prompt = [
    "You are generating transparent PNG NFT layers for a single collection.",
    "Return JSON only.",
    "The JSON must have one key named variants.",
    "variants must be an array.",
    "Each item must have name, notes, prompt.",
    "Each prompt must describe exactly one isolated visual asset for the requested layer only.",
    "Every prompt must explicitly require a transparent background, no extra objects, no scene, no border, no text, and consistent style.",
    "Keep the prompts stack-friendly so they align with other layers in a layered NFT.",
    "Make each new variant meaningfully different from earlier ones instead of tiny color drift."
  ].join("\n");

  const payload = {
    project: buildProjectPayload(project),
    studio: buildStudioPayload(memory, brain, toolManifest),
    allLayers: project.layers.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      placementNotes: item.placementNotes
    })),
    targetLayer: {
      id: layer.id,
      name: layer.name,
      description: layer.description,
      placementNotes: layer.placementNotes,
      variantIdeas: layer.variantIdeas,
      currentVariantNames: Array.isArray(layer.variants) ? layer.variants.map((item) => cleanText(item.name)) : []
    },
    references: buildAttachmentPayload(attachments),
    count
  };

  const response = await callOpenAIJson(apiKey, {
    model: "gpt-5.4",
    input: buildVisionInput(prompt, payload, attachments)
  });

  const variants = Array.isArray(response?.variants) ? response.variants : [];
  return {
    variants: variants.slice(0, count).map((item, index) => ({
      name: cleanText(item?.name) || `${layer.name} Variant ${index + 1}`,
      notes: cleanText(item?.notes),
      prompt: buildTransparentPrompt({
        project,
        layer,
        promptText: cleanText(item?.prompt)
      })
    }))
  };
}

async function refreshStudioMemory(apiKey, project, memory, brain, toolManifest) {
  const prompt = [
    "You maintain long-running creative memory for one NFT project.",
    "Return JSON only.",
    "The JSON must include contextSummary, styleRules, lockedDecisions.",
    "contextSummary must be a concise paragraph capturing the current style and production direction.",
    "styleRules must be an array of short imperative rules.",
    "lockedDecisions must be an array of objects with title and detail.",
    "Only preserve the strongest still-relevant rules and approvals.",
    "Use the global studio brain only as support, not as a reason to erase this project's identity.",
    "Do not output markdown."
  ].join("\n");

  const payload = {
    project: buildProjectPayload(project),
    projectMemory: buildMemoryPayload(memory),
    studioBrain: buildBrainPayload(brain),
    toolManifest: buildToolManifestPayload(toolManifest)
  };

  const response = await callOpenAIJson(apiKey, {
    model: "gpt-5.4",
    input: buildVisionInput(prompt, payload, [])
  });

  const lockedDecisions = Array.isArray(response?.lockedDecisions) ? response.lockedDecisions : [];
  return {
    contextSummary: cleanText(response?.contextSummary),
    styleRules: Array.isArray(response?.styleRules)
      ? response.styleRules.map((item) => cleanText(item)).filter(Boolean).slice(0, 12)
      : [],
    lockedDecisions: lockedDecisions
      .map((item) => ({
        title: cleanText(item?.title),
        detail: cleanText(item?.detail)
      }))
      .filter((item) => item.title || item.detail)
      .slice(0, 12)
  };
}

async function refreshStudioBrain(apiKey, project, memory, brain, toolManifest, event) {
  const prompt = [
    "You maintain a hidden cross-project studio brain for an NFT art tool.",
    "Return JSON only.",
    "The JSON must include crossProjectSummary, qualityRules, drawingLessons.",
    "crossProjectSummary must be one short paragraph.",
    "qualityRules must be an array of short imperative rules.",
    "drawingLessons must be an array of objects with title, detail, tags.",
    "Keep only durable lessons that improve future drawing and layer production.",
    "Prefer lessons about composition, consistency, stack safety, silhouette clarity, and useful prompt phrasing.",
    "If an event shows a near-duplicate or weak layer outcome, convert that into a practical lesson.",
    "Do not output markdown."
  ].join("\n");

  const payload = {
    event: {
      type: cleanText(event?.type),
      prompt: cleanText(event?.prompt),
      layerName: cleanText(event?.layerName),
      summary: cleanText(event?.summary),
      analysis: event?.analysis || null
    },
    project: buildProjectPayload(project),
    projectMemory: buildMemoryPayload(memory),
    studioBrain: buildBrainPayload(brain),
    toolManifest: buildToolManifestPayload(toolManifest)
  };

  const response = await callOpenAIJson(apiKey, {
    model: "gpt-5.4",
    input: buildVisionInput(prompt, payload, [])
  });

  return {
    crossProjectSummary: cleanText(response?.crossProjectSummary),
    qualityRules: Array.isArray(response?.qualityRules)
      ? response.qualityRules.map((item) => cleanText(item)).filter(Boolean).slice(0, 18)
      : [],
    drawingLessons: Array.isArray(response?.drawingLessons)
      ? response.drawingLessons
          .map((item) => ({
            title: cleanText(item?.title),
            detail: cleanText(item?.detail),
            tags: Array.isArray(item?.tags)
              ? item.tags.map((tag) => cleanText(tag)).filter(Boolean).slice(0, 8)
              : []
          }))
          .filter((item) => item.title || item.detail)
          .slice(0, 12)
      : []
  };
}

function buildTransparentPrompt({ project, layer, promptText }) {
  const fragments = [
    promptText,
    `Collection title: ${project.title}.`,
    project.styleGuide ? `Style guide: ${project.styleGuide}.` : "",
    `Layer name: ${layer.name}.`,
    layer.placementNotes ? `Placement notes: ${layer.placementNotes}.` : "",
    "Output a single isolated asset only.",
    "Transparent background.",
    "No mockup, no scene, no body parts from other layers, no labels, no watermark.",
    "Centered composition, stack-friendly proportions, crisp edges, PNG-ready."
  ];

  return fragments.filter(Boolean).join(" ");
}

function validatePreviewPlan(plan) {
  const layers = Array.isArray(plan?.layers) ? plan.layers : [];
  return {
    collectionSummary: cleanText(plan?.collectionSummary),
    styleGuide: cleanText(plan?.styleGuide),
    previewPrompt: cleanText(plan?.previewPrompt),
    layers: layers.map((layer, index) => ({
      id: cleanSlug(layer?.id) || `layer-${index + 1}`,
      name: cleanText(layer?.name) || `Layer ${index + 1}`,
      description: cleanText(layer?.description),
      placementNotes: cleanText(layer?.placementNotes),
      variantIdeas: Array.isArray(layer?.variantIdeas)
        ? layer.variantIdeas.map((idea) => cleanText(idea)).filter(Boolean).slice(0, 3)
        : []
    }))
  };
}

function buildProjectPayload(project) {
  return {
    title: project.title,
    artDirection: project.artDirection,
    collectionGoal: project.collectionGoal,
    styleGuide: project.styleGuide,
    canvas: project.canvas,
    recentChat: (project.chatHistory || []).slice(-10).map((message) => ({
      role: cleanText(message.role),
      text: cleanText(message.text),
      generatedImage: message.generatedImage
        ? {
            id: cleanText(message.generatedImage.id),
            type: cleanText(message.generatedImage.type),
            name: cleanText(message.generatedImage.name),
            notes: cleanText(message.generatedImage.notes),
            prompt: cleanText(message.generatedImage.prompt),
            targetLayerName: cleanText(message.generatedImage.targetLayerName),
            status: cleanText(message.generatedImage.status)
          }
        : null
    })),
    draftHistory: (project.draftHistory || []).slice(0, 8).map((draft) => ({
      id: draft.id,
      name: draft.name,
      prompt: draft.prompt,
      status: draft.status,
      targetLayerName: draft.targetLayerName
    })),
    layers: project.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      description: layer.description,
      placementNotes: layer.placementNotes,
      variantIdeas: layer.variantIdeas,
      variantCount: Array.isArray(layer.variants) ? layer.variants.length : 0
    }))
  };
}

function buildStudioPayload(memory, brain, toolManifest) {
  return {
    projectMemory: buildMemoryPayload(memory),
    studioBrain: buildBrainPayload(brain),
    toolManifest: buildToolManifestPayload(toolManifest)
  };
}

function buildMemoryPayload(memory) {
  return memory
    ? {
        systemPrompt: cleanText(memory.systemPrompt),
        userGuidance: cleanText(memory.userGuidance),
        contextSummary: cleanText(memory.contextSummary),
        styleRules: Array.isArray(memory.styleRules) ? memory.styleRules : [],
        lockedDecisions: Array.isArray(memory.lockedDecisions)
          ? memory.lockedDecisions.map((item) => ({
              title: cleanText(item?.title),
              detail: cleanText(item?.detail)
            }))
          : [],
        changelog: Array.isArray(memory.changelog)
          ? memory.changelog.slice(0, 12).map((item) => ({
              type: cleanText(item?.type),
              title: cleanText(item?.title),
              detail: cleanText(item?.detail)
            }))
          : []
      }
    : null;
}

function buildBrainPayload(brain) {
  return brain
    ? {
        systemPrompt: cleanText(brain.systemPrompt),
        crossProjectSummary: cleanText(brain.crossProjectSummary),
        qualityRules: Array.isArray(brain.qualityRules) ? brain.qualityRules : [],
        drawingLessons: Array.isArray(brain.drawingLessons)
          ? brain.drawingLessons.slice(0, 16).map((item) => ({
              title: cleanText(item?.title),
              detail: cleanText(item?.detail),
              tags: Array.isArray(item?.tags) ? item.tags : []
            }))
          : [],
        recentSessionNotes: Array.isArray(brain.sessionNotes)
          ? brain.sessionNotes.slice(0, 8).map((item) => ({
              type: cleanText(item?.type),
              layerName: cleanText(item?.layerName),
              summary: cleanText(item?.summary),
              analysis: item?.analysis || null
            }))
          : []
      }
    : null;
}

function buildToolManifestPayload(toolManifest) {
  return toolManifest
    ? {
        name: cleanText(toolManifest.name),
        systemGuidance: cleanText(toolManifest.systemGuidance),
        packages: Array.isArray(toolManifest.packages) ? toolManifest.packages : [],
        capabilities: Array.isArray(toolManifest.capabilities) ? toolManifest.capabilities : []
      }
    : null;
}

function buildAttachmentPayload(attachments) {
  return Array.isArray(attachments)
    ? attachments.slice(0, 6).map((attachment) => ({
        id: cleanText(attachment?.id),
        name: cleanText(attachment?.name),
        mimeType: cleanText(attachment?.mimeType),
        width: Number(attachment?.width || 0),
        height: Number(attachment?.height || 0)
      }))
    : [];
}

function buildVisionInput(systemPrompt, payload, attachments) {
  const userContent = [{ type: "input_text", text: JSON.stringify(payload) }];

  for (const attachment of attachments) {
    if (attachment?.dataUrl) {
      userContent.push({
        type: "input_image",
        image_url: attachment.dataUrl,
        detail: "high"
      });
    }
  }

  return [
    {
      role: "system",
      content: [{ type: "input_text", text: systemPrompt }]
    },
    {
      role: "user",
      content: userContent
    }
  ];
}

async function callOpenAIJson(apiKey, body) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || "OpenAI request failed.";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return safeJsonParse(extractResponseText(data));
}

async function generateImageAsset({ apiKey, prompt, size, background }) {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-image-1.5",
      prompt,
      size,
      quality: "medium",
      output_format: "png",
      background,
      moderation: "low"
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || "Image generation failed.";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const image = Array.isArray(data?.data) ? data.data[0] : null;
  if (!image?.b64_json) {
    const error = new Error("The image API did not return base64 image data.");
    error.status = 502;
    throw error;
  }

  return {
    buffer: Buffer.from(image.b64_json, "base64")
  };
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}
