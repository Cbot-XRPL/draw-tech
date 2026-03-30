import { cleanSlug, cleanText, safeJsonParse } from "./utils.js";

export function createOpenAIService() {
  return {
    routeUserPrompt,
    createPreviewPlan,
    createLayerVariantPlan,
    generateImageAsset,
    editImageAsset,
    refreshStudioMemory,
    refreshStudioBrain
  };
}

async function routeUserPrompt(apiKey, project, memory, brain, toolManifest, promptText, attachments = []) {
  const prompt = [
    "You route a user's NFT-building request inside a layer-based art app.",
    "Return JSON only.",
    "Keys: actionType, assistantReply, title, targetLayerName, variantNameHint, variantDirection, removalTarget, canvasWidth, canvasHeight.",
    "Valid actionType values: preview, draft_variant, commit_draft, edit_layer_variant, transform_layer_variant, feedback, remove_variant, remove_layer, update_canvas, noop.",
    "Use preview when the user is describing a new scene, new collection direction, or wants to see a new overall image.",
    "Use draft_variant when the user asks to draw a trait, object, or isolated asset for review before it goes into a layer folder.",
    "If the user asks for a new or another trait like a new crown, new hat, new glasses, new prop, or any fresh asset concept, keep it separate from editing the existing layers by using draft_variant.",
    "Requests like add a safe door for the safe door layer, make a new crown for headwear, or build another trait for a named folder are still draft_variant requests even if the user also says it should fit the base layer nicely.",
    "Do not edit, replace, overwrite, or reuse an existing layer just because the trait family already exists.",
    "If the user says to leave the old layer alone, keep the old one too, make a separate layer, or not replace the current layer, that must stay draft_variant even if they also ask for the new trait to fit nicely on the base asset.",
    "A draft_variant may still target an existing semantic folder as the suggested destination for later commit; that does not mean editing that layer.",
    "If the user asks for a true background, full background, full paint background, full canvas background, or something that fills the entire canvas behind everything, target a Background layer rather than Background Accent.",
    "Use Background Accent only for halo, aura, glow, backdrop, or accent effects that sit behind the subject without acting as the full painted background plate.",
    "Use commit_draft when the user is approving a recent draft and wants it added to a folder or layer.",
    "Use edit_layer_variant when the user wants an existing layer image revised, such as removing a feature from the base/body layer so it only appears in its own trait layer, or reworking a trait so it fits correctly on the anchor character.",
    "For edit_layer_variant, preserve the exact source image composition and change only the requested feature unless the user explicitly asks for a redraw.",
    "Use transform_layer_variant when the user wants an existing layer asset moved, scaled, centered, lowered, raised, or fit better on the stack without redrawing the image.",
    "Only use edit_layer_variant or transform_layer_variant when the user explicitly asks to revise, modify, move, fit, transform, update, replace, or put something back into an existing layer or folder that already has an asset to work from.",
    "Use feedback when the user is telling you what they liked, disliked, or want remembered about prior generations or layer behavior.",
    "Use remove_variant or remove_layer only when the user clearly asks to delete.",
    "You can use recent chat history and recent generated images to resolve references like it, that, the cat from earlier, the last preview, or the one in chat.",
    "If reference attachments from another saved project are provided, treat them as explicit recalled examples for prompts like from the cat project or like the cosmic background from my other project.",
    "assistantReply should be one short sentence for the visible chat log.",
    "If targetLayerName is obvious, fill it in with a human-friendly layer name.",
    "For draft_variant, use variantNameHint to capture the specific fresh trait the user asked for.",
    "If an existing semantic folder clearly fits the draft, such as crowns or hats mapping to Headwear, prefer that folder name as targetLayerName unless the user explicitly asks for a separate folder or its own layer.",
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
    "If saved-project reference images are attached, use them as visual recall for the requested style or layer language without copying unrelated subjects into the new collection.",
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
  const fullCanvasBackground = isFullCanvasBackgroundLayerName(layer?.name);
  const structuralOverlay = isStructuralOverlayLayerName(layer?.name);
  const prompt = [
    "You are generating layered NFT image assets for a single collection.",
    "Return JSON only.",
    "The JSON must have one key named variants.",
    "variants must be an array.",
    "Each item must have name, notes, prompt.",
    ...(fullCanvasBackground
      ? [
          "Each prompt must describe exactly one full painted background plate for the requested layer.",
          "The background must fill the entire canvas edge to edge behind every other layer.",
          "Do not describe a small accent, halo, ring, floating object, or isolated transparent trait.",
          "Opaque backgrounds are allowed and preferred unless the user explicitly asks for transparency."
        ]
      : [
          "Each prompt must describe exactly one isolated visual asset for the requested layer only.",
          "Every prompt must explicitly require a transparent background, no extra objects, no scene, no border, no text, and consistent style."
        ]),
    ...(structuralOverlay
      ? [
          "Treat the target layer as a structural overlay piece that attaches to the active anchor construct.",
          "Each prompt must instruct the model to study the anchor reference like a construction template and build only the removable overlay piece shaped to that surface.",
          "Never redraw the base body, casing, door frame, or other anchor content into the overlay asset."
        ]
      : []),
    "Keep the prompts stack-friendly so they align with other layers in a layered NFT.",
    "Always consider the active stack before proposing a new layer asset.",
    "If the project has a centered base/body/character layer selected, treat that as the anchor construct that the new layer must fit around.",
    "Trait assets like headwear, eyewear, neckwear, outfits, and accessories should be sized and composed to fit the active base construct immediately instead of assuming a blank canvas.",
    "If the target layer has an approved family fit contract, every new variant must preserve that same seat, overlap, and clipping pattern so swapping variants does not degrade stack quality.",
    "If a saved-project reference image is attached, use it as a visual example for the requested layer look, mood, or construction while still creating a fresh asset for the current project.",
    "Make each new variant meaningfully different from earlier ones instead of tiny color drift."
  ].join("\n");

  const payload = {
    project: buildProjectPayload(project),
    studio: buildStudioPayload(memory, brain, toolManifest),
    allLayers: project.layers.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      placementNotes: item.placementNotes,
      fitContract: buildLayerFitContractPayload(item.fitContract)
    })),
    targetLayer: {
      id: layer.id,
      name: layer.name,
      description: layer.description,
      placementNotes: layer.placementNotes,
      variantIdeas: layer.variantIdeas,
      currentVariantNames: Array.isArray(layer.variants) ? layer.variants.map((item) => cleanText(item.name)) : [],
      fitContract: buildLayerFitContractPayload(layer.fitContract)
    },
    activeConstruct: buildActiveConstructPayload(project),
    targetLayerGuidance: buildLayerFitGuidance(project, layer),
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
      prompt: buildLayerAssetPrompt({
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

function buildLayerAssetPrompt({ project, layer, promptText }) {
  if (isFullCanvasBackgroundLayerName(layer?.name)) {
    return buildFullCanvasBackgroundPrompt({ project, layer, promptText });
  }

  return buildTransparentPrompt({ project, layer, promptText });
}

function buildTransparentPrompt({ project, layer, promptText }) {
  const activeConstruct = buildActiveConstructSummary(project);
  const layerFitGuidance = buildLayerFitPromptGuidance(project, layer);
  const fragments = [
    promptText,
    `Collection title: ${project.title}.`,
    project.styleGuide ? `Style guide: ${project.styleGuide}.` : "",
    `Layer name: ${layer.name}.`,
    layer.placementNotes ? `Placement notes: ${layer.placementNotes}.` : "",
    activeConstruct,
    layerFitGuidance,
    "If an anchor or example reference image is attached, use it as a construction map for scale, curvature, seat geometry, edge spacing, and contact points while still outputting only the isolated requested trait.",
    "Output a single isolated asset only.",
    "Transparent background.",
    "No mockup, no scene, no body parts from other layers, no labels, no watermark.",
    "Centered composition, stack-friendly proportions, crisp edges, PNG-ready."
  ];

  return fragments.filter(Boolean).join(" ");
}

function buildFullCanvasBackgroundPrompt({ project, layer, promptText }) {
  const activeConstruct = buildActiveConstructSummary(project);
  const layerFitGuidance = buildLayerFitPromptGuidance(project, layer);
  const fragments = [
    promptText,
    `Collection title: ${project.title}.`,
    project.styleGuide ? `Style guide: ${project.styleGuide}.` : "",
    `Layer name: ${layer.name}.`,
    layer.placementNotes ? `Placement notes: ${layer.placementNotes}.` : "",
    activeConstruct,
    layerFitGuidance,
    "Output one full painted background plate only.",
    "Fill the entire canvas edge to edge behind every other layer.",
    "This is not a halo, accent ring, sticker, trait cutout, or floating object.",
    "No character, no crown, no glasses, no body part redraw, no isolated prop, no text, no watermark.",
    "Opaque full-canvas background allowed and preferred unless transparency is explicitly requested.",
    "Leave readable breathing room for the foreground subject so the stack still reads clearly."
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
      fitContract: buildLayerFitContractPayload(layer.fitContract),
      variantCount: Array.isArray(layer.variants) ? layer.variants.length : 0,
      selectedVariant: Array.isArray(layer.variants)
        ? (() => {
            const variant = layer.variants.find((item) => item.id === layer.selectedVariantId);
            return variant
              ? {
                  id: cleanText(variant.id),
                  name: cleanText(variant.name),
                  notes: cleanText(variant.notes),
                  prompt: cleanText(variant.prompt)
                }
              : null;
          })()
        : null
    }))
  };
}

function buildLayerFitContractPayload(contract) {
  const safeContract = contract && typeof contract === "object" ? contract : null;
  if (!safeContract) {
    return null;
  }

  return {
    profileId: cleanText(safeContract.profileId),
    profileLabel: cleanText(safeContract.profileLabel),
    scope: cleanText(safeContract.scope),
    anchorLayerName: cleanText(safeContract.anchorLayerName),
    anchorVariantName: cleanText(safeContract.anchorVariantName),
    referenceVariantName: cleanText(safeContract.referenceVariantName),
    targetWidthRatio: toNumberOrNull(safeContract.targetWidthRatio),
    targetHeightRatio: toNumberOrNull(safeContract.targetHeightRatio),
    targetCenterXOffsetRatio: toNumberOrNull(safeContract.targetCenterXOffsetRatio),
    targetCenterYRatio: toNumberOrNull(safeContract.targetCenterYRatio),
    targetTopRatio: toNumberOrNull(safeContract.targetTopRatio),
    targetBottomRatio: toNumberOrNull(safeContract.targetBottomRatio),
    canvasWidthRatio: toNumberOrNull(safeContract.canvasWidthRatio),
    canvasHeightRatio: toNumberOrNull(safeContract.canvasHeightRatio),
    canvasCenterXRatio: toNumberOrNull(safeContract.canvasCenterXRatio),
    canvasCenterYRatio: toNumberOrNull(safeContract.canvasCenterYRatio),
    canvasTopRatio: toNumberOrNull(safeContract.canvasTopRatio),
    canvasBottomRatio: toNumberOrNull(safeContract.canvasBottomRatio),
    depthMode: cleanText(safeContract.depthMode),
    clipStrategy: cleanText(safeContract.clipStrategy),
    backCutoff: toNumberOrNull(safeContract.backCutoff),
    frontStart: toNumberOrNull(safeContract.frontStart),
    summary: cleanText(safeContract.summary),
    updatedAt: cleanText(safeContract.updatedAt)
  };
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildActiveConstructPayload(project) {
  const anchor = getActiveAnchorLayer(project);
  if (!anchor?.variant) {
    return null;
  }

  return {
    layerName: cleanText(anchor.layer.name),
    variantName: cleanText(anchor.variant.name),
    notes: cleanText(anchor.variant.notes),
    prompt: cleanText(anchor.variant.prompt)
  };
}

function buildActiveConstructSummary(project) {
  const anchor = getActiveAnchorLayer(project);
  if (!anchor?.variant) {
    return "";
  }

  return `Active construct anchor: use the selected ${anchor.layer.name} layer named ${anchor.variant.name} as the central construct that this asset must fit around.`;
}

function buildLayerFitPromptGuidance(project, layer) {
  const lowered = cleanText(layer?.name).toLowerCase();
  const anchor = getActiveAnchorLayer(project);
  const anchorLabel = anchor?.layer?.name ? anchor.layer.name : "the active base construct";
  const fitContractGuidance = buildLayerFitContractGuidance(layer);

  if (isBackgroundAccentLayerName(lowered)) {
    return [
      `Treat ${anchorLabel} as the foreground subject and design this background accent as a supportive transparent effect behind the silhouette without becoming the whole painted background.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (isFullCanvasBackgroundLayerName(lowered)) {
    return [
      `Treat ${anchorLabel} as the foreground subject and design this as the true background plate: full canvas, edge to edge, behind everything, and not just a halo or accent feature.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (isStructuralOverlayLayerName(lowered)) {
    return [
      `Fit this structural overlay to ${anchorLabel}: map the visible front face, opening, recess, or mounting seat on the anchor and draw only the removable overlay piece shaped to sit on that surface.`,
      `Match the anchor's contour, curvature, edge spacing, hinge alignment, and scale as closely as possible, but never redraw the anchor body, casing, frame, or other base content into the trait.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/headwear|hat|crown|tiara/.test(lowered)) {
    return [
      `Fit this headwear to ${anchorLabel}: keep it centered in the upper anchor region, readable at thumbnail size, and proportioned so it sits on the character instead of floating above a blank canvas.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/eyes|eyewear|glasses|shades/.test(lowered)) {
    return [
      `Fit this eyewear to ${anchorLabel}: keep it centered over the eye line, sized to the visible face width instead of the full canvas, and never redraw extra face or head content into the trait.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/neckwear|necklace|chain|scarf|bow/.test(lowered)) {
    return [`Fit this neckwear to ${anchorLabel}: keep it centered around the neck/chest area with clean stack-safe spacing.`, fitContractGuidance]
      .filter(Boolean)
      .join(" ");
  }

  if (/handheld|weapon|sword|staff|wand|gun|tool|prop|item|orb|flower|cane|bat|microphone/.test(lowered)) {
    return [
      `Fit this handheld trait to ${anchorLabel}: size it for the active construct and place it so it reads as being held by the visible hand, paw, arm, or grip area instead of floating beside the body.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/outfit|shirt|hoodie|jacket|body/.test(lowered)) {
    return [
      `Fit this body-related layer to ${anchorLabel}: preserve the active character proportions and keep the silhouette aligned to the torso area.`,
      fitContractGuidance
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (/background/.test(lowered)) {
    return [
      `Treat ${anchorLabel} as the foreground subject and design this background layer to support it without overlapping or cutting into the character silhouette.`,
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

function isBackgroundAccentLayerName(layerName) {
  const lowered = cleanText(layerName).toLowerCase();
  return /background accent|accent background|halo|aura|ring|burst|glow/.test(lowered);
}

function isStructuralOverlayLayerName(layerName) {
  const lowered = cleanText(layerName).toLowerCase();
  return /safe door|vault door|door face detail|door face|door panel|panel|face plate|faceplate|cover plate|front plate|cover|plate|hatch|lid|window|screen/.test(
    lowered
  );
}

function isFullCanvasBackgroundLayerName(layerName) {
  const lowered = cleanText(layerName).toLowerCase();
  if (!lowered) {
    return false;
  }

  if (isBackgroundAccentLayerName(lowered)) {
    return false;
  }

  return /true background|full background|full canvas background|background|scene|backdrop|\bbg\b/.test(lowered);
}

function buildLayerFitGuidance(project, layer) {
  return {
    activeConstructSummary: buildActiveConstructSummary(project),
    placementGuidance: buildLayerFitPromptGuidance(project, layer),
    familyContract: buildLayerFitContractGuidance(layer)
  };
}

function buildLayerFitContractGuidance(layer) {
  const summary = cleanText(layer?.fitContract?.summary);
  return summary ? `Approved interchangeable family contract: ${summary}` : "";
}

function getActiveAnchorLayer(project) {
  const layers = Array.isArray(project?.layers) ? project.layers : [];
  const candidates = [
    layers.find((layer) => isAnchorLayerName(layer.name)),
    ...layers.filter((layer) => !isAnchorLayerName(layer.name))
  ].filter(Boolean);

  for (const layer of candidates) {
    const variants = Array.isArray(layer.variants) ? layer.variants : [];
    const variant = variants.find((item) => item.id === layer.selectedVariantId) || variants[0] || null;
    if (variant?.imageUrl || variant?.prompt || variant?.name) {
      return { layer, variant };
    }
  }

  return null;
}

function isAnchorLayerName(layerName) {
  return /(base|body|character|avatar|cat)/.test(cleanText(layerName).toLowerCase());
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
        capabilities: Array.isArray(toolManifest.capabilities) ? toolManifest.capabilities : [],
        fitProfiles: Array.isArray(toolManifest.fitProfiles) ? toolManifest.fitProfiles : []
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
        height: Number(attachment?.height || 0),
        imageUrl: cleanText(attachment?.imageUrl),
        targetLayerName: cleanText(attachment?.targetLayerName),
        referenceType: cleanText(attachment?.referenceType),
        sourceType: cleanText(attachment?.sourceType),
        sourceProjectId: cleanText(attachment?.sourceProjectId),
        sourceProjectTitle: cleanText(attachment?.sourceProjectTitle),
        notes: cleanText(attachment?.notes),
        prompt: cleanText(attachment?.prompt)
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

async function editImageAsset({ apiKey, prompt, images, background = "transparent", inputFidelity = "high" }) {
  const references = Array.isArray(images)
    ? images
        .map((imageUrl) => cleanText(imageUrl))
        .filter(Boolean)
        .slice(0, 16)
        .map((imageUrl) => ({ image_url: imageUrl }))
    : [];

  if (!references.length) {
    const error = new Error("Image edit requires at least one source image.");
    error.status = 400;
    throw error;
  }

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-image-1.5",
      images: references,
      prompt,
      background,
      input_fidelity: inputFidelity,
      output_format: "png",
      moderation: "low"
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || "Image edit failed.";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const image = Array.isArray(data?.data) ? data.data[0] : null;
  if (!image?.b64_json) {
    const error = new Error("The image edit API did not return base64 image data.");
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
