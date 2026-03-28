import { cleanSlug, cleanText } from "./utils.js";

export function createOpenAIService() {
  return {
    createPreviewPlan,
    createLayerVariantPlan,
    generateImageAsset,
    refreshStudioMemory
  };
}

async function createPreviewPlan(apiKey, project, memory) {
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
    "Assume later each layer will be generated on a transparent background and stacked with the others.",
    "Do not include markdown fences."
  ].join("\n");

  const payload = {
    title: project.title,
    artDirection: project.artDirection,
    collectionGoal: project.collectionGoal,
    canvas: project.canvas,
    studioMemory: buildMemoryPayload(memory),
    layers: project.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      currentDescription: layer.description,
      currentPlacementNotes: layer.placementNotes
    }))
  };

  const response = await callOpenAIJson(apiKey, {
    model: "gpt-5.4",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: prompt }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify(payload) }]
      }
    ]
  });

  return validatePreviewPlan(response);
}

async function createLayerVariantPlan(apiKey, project, layer, count, memory) {
  const prompt = [
    "You are generating transparent PNG NFT layers for a single collection.",
    "Return JSON only.",
    "The JSON must have one key named variants.",
    "variants must be an array.",
    "Each item must have name, notes, prompt.",
    "Each prompt must describe exactly one isolated visual asset for the requested layer only.",
    "Every prompt must explicitly require a transparent background, no extra objects, no scene, no border, no text, and consistent style.",
    "Keep the prompts stack-friendly so they align with other layers in a layered NFT."
  ].join("\n");

  const payload = {
    project: {
      title: project.title,
      artDirection: project.artDirection,
      collectionGoal: project.collectionGoal,
      styleGuide: project.styleGuide,
      canvas: project.canvas
    },
    studioMemory: buildMemoryPayload(memory),
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
      variantIdeas: layer.variantIdeas
    },
    count
  };

  const response = await callOpenAIJson(apiKey, {
    model: "gpt-5.4",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: prompt }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify(payload) }]
      }
    ]
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

async function refreshStudioMemory(apiKey, project, memory) {
  const prompt = [
    "You maintain long-running creative memory for an NFT project.",
    "Return JSON only.",
    "The JSON must include contextSummary, styleRules, lockedDecisions.",
    "contextSummary must be a concise paragraph capturing the current style and production direction.",
    "styleRules must be an array of short imperative rules.",
    "lockedDecisions must be an array of objects with title and detail.",
    "Only preserve the strongest still-relevant rules and approvals.",
    "Do not output markdown."
  ].join("\n");

  const payload = {
    project: {
      title: project.title,
      artDirection: project.artDirection,
      collectionGoal: project.collectionGoal,
      styleGuide: project.styleGuide,
      canvas: project.canvas
    },
    memory: buildMemoryPayload(memory),
    latestLayers: project.layers.map((layer) => ({
      name: layer.name,
      description: layer.description,
      placementNotes: layer.placementNotes,
      variantIdeas: layer.variantIdeas || [],
      variantCount: Array.isArray(layer.variants) ? layer.variants.length : 0
    }))
  };

  const response = await callOpenAIJson(apiKey, {
    model: "gpt-5.4",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: prompt }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify(payload) }]
      }
    ]
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

function safeJsonParse(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}$/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error("The model returned invalid JSON.");
  }
}
