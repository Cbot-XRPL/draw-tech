const state = {
  project: null,
  memory: null,
  config: null,
  busy: false
};

const elements = {
  apiKeyInput: document.getElementById("apiKeyInput"),
  saveKeyBtn: document.getElementById("saveKeyBtn"),
  keyStatus: document.getElementById("keyStatus"),
  titleInput: document.getElementById("titleInput"),
  directionInput: document.getElementById("directionInput"),
  goalInput: document.getElementById("goalInput"),
  canvasPresetInput: document.getElementById("canvasPresetInput"),
  canvasWidthInput: document.getElementById("canvasWidthInput"),
  canvasHeightInput: document.getElementById("canvasHeightInput"),
  layersInput: document.getElementById("layersInput"),
  saveProjectBtn: document.getElementById("saveProjectBtn"),
  newProjectBtn: document.getElementById("newProjectBtn"),
  generatePreviewBtn: document.getElementById("generatePreviewBtn"),
  downloadHashlipsBtn: document.getElementById("downloadHashlipsBtn"),
  memorySystemInput: document.getElementById("memorySystemInput"),
  memoryGuidanceInput: document.getElementById("memoryGuidanceInput"),
  changelogInput: document.getElementById("changelogInput"),
  saveMemoryBtn: document.getElementById("saveMemoryBtn"),
  refreshMemoryBtn: document.getElementById("refreshMemoryBtn"),
  logNoteBtn: document.getElementById("logNoteBtn"),
  lockDecisionBtn: document.getElementById("lockDecisionBtn"),
  projectBadge: document.getElementById("projectBadge"),
  summaryText: document.getElementById("summaryText"),
  canvasBadge: document.getElementById("canvasBadge"),
  stage: document.getElementById("stage"),
  previewImage: document.getElementById("previewImage"),
  stageEmpty: document.getElementById("stageEmpty"),
  layerStack: document.getElementById("layerStack"),
  previewHistory: document.getElementById("previewHistory"),
  previewCount: document.getElementById("previewCount"),
  layersPanel: document.getElementById("layersPanel"),
  layerCount: document.getElementById("layerCount"),
  memorySummary: document.getElementById("memorySummary"),
  memoryRules: document.getElementById("memoryRules"),
  memoryLog: document.getElementById("memoryLog"),
  toast: document.getElementById("toast")
};

bootstrap().catch((error) => showToast(error.message, true));

elements.saveKeyBtn.addEventListener("click", async () => {
  await withBusy(async () => {
    await api("/api/session", {
      method: "POST",
      body: { apiKey: elements.apiKeyInput.value.trim() }
    });
    await loadConfig();
    render();
    showToast("Session key saved.");
  });
});

elements.saveProjectBtn.addEventListener("click", async () => {
  await withBusy(async () => {
    const payload = readProjectForm();
    if (!payload.layers.length) {
      throw new Error("Add at least one layer name before saving the project.");
    }

    if (!state.project) {
      const response = await api("/api/projects", {
        method: "POST",
        body: payload
      });
      state.project = response.project;
      state.memory = response.memory || null;
    } else {
      const response = await api(`/api/projects/${state.project.id}`, {
        method: "PUT",
        body: payload
      });
      state.project = response.project;
      state.memory = response.memory || state.memory;
    }

    populateForm(state.project);
    populateMemoryForm(state.memory);
    render();
    showToast("Project saved.");
  });
});

elements.newProjectBtn.addEventListener("click", () => {
  state.project = null;
  state.memory = null;
  populateForm(blankProjectShape());
  populateMemoryForm(null);
  render();
  showToast("Form reset. Saved project files remain on disk.");
});

elements.generatePreviewBtn.addEventListener("click", async () => {
  await withBusy(async () => {
    const draft = readProjectForm();
    if (!draft.layers.length) {
      throw new Error("Add at least one layer name before generating a test NFT.");
    }

    if (!state.project) {
      const created = await api("/api/projects", {
        method: "POST",
        body: draft
      });
      state.project = created.project;
      state.memory = created.memory || null;
    } else {
      const saved = await api(`/api/projects/${state.project.id}`, {
        method: "PUT",
        body: draft
      });
      state.project = saved.project;
      state.memory = saved.memory || state.memory;
    }

    const result = await api(`/api/projects/${state.project.id}/preview`, {
      method: "POST"
    });
    state.project = result.project;
    state.memory = result.memory || state.memory;
    populateForm(state.project);
    populateMemoryForm(state.memory);
    render();
    showToast("Test NFT generated.");
  });
});

elements.downloadHashlipsBtn.addEventListener("click", () => {
  if (!state.project) {
    showToast("Save a project first, then generate some layer variants.", true);
    return;
  }

  window.location.href = `/api/projects/${state.project.id}/export/hashlips`;
});

elements.saveMemoryBtn.addEventListener("click", async () => {
  if (!state.project) {
    showToast("Save a project first so the brain has somewhere to live.", true);
    return;
  }

  await withBusy(async () => {
    const response = await api(`/api/projects/${state.project.id}/memory`, {
      method: "PUT",
      body: {
        systemPrompt: elements.memorySystemInput.value.trim(),
        userGuidance: elements.memoryGuidanceInput.value.trim()
      }
    });
    state.memory = response.memory;
    populateMemoryForm(state.memory);
    render();
    showToast("Studio brain saved.");
  });
});

elements.refreshMemoryBtn.addEventListener("click", async () => {
  if (!state.project) {
    showToast("Save a project first.", true);
    return;
  }

  await withBusy(async () => {
    const response = await api(`/api/projects/${state.project.id}/memory/refresh`, {
      method: "POST"
    });
    state.memory = response.memory;
    populateMemoryForm(state.memory);
    render();
    showToast("AI memory refreshed.");
  });
});

elements.logNoteBtn.addEventListener("click", async () => {
  await submitMemoryNote("note");
});

elements.lockDecisionBtn.addEventListener("click", async () => {
  await submitMemoryNote("approval");
});

elements.canvasPresetInput.addEventListener("change", () => {
  const preset = elements.canvasPresetInput.value;
  if (preset === "1024x1536") {
    elements.canvasWidthInput.value = "1024";
    elements.canvasHeightInput.value = "1536";
  } else if (preset === "1536x1024") {
    elements.canvasWidthInput.value = "1536";
    elements.canvasHeightInput.value = "1024";
  } else {
    elements.canvasWidthInput.value = "1024";
    elements.canvasHeightInput.value = "1024";
  }

  render();
});

async function bootstrap() {
  await loadConfig();
  if (state.config?.defaultProjectId) {
    const response = await api(`/api/projects/${state.config.defaultProjectId}`);
    state.project = response.project;
    state.memory = response.memory || null;
    populateForm(state.project);
    populateMemoryForm(state.memory);
  } else {
    populateForm(blankProjectShape());
    populateMemoryForm(null);
  }
  render();
}

async function loadConfig() {
  const response = await api("/api/config");
  state.config = response;
}

function readProjectForm() {
  const layers = elements.layersInput.value
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((name, index) => {
      const existingLayer = state.project?.layers?.find(
        (layer) => layer.name.toLowerCase() === name.toLowerCase()
      );

      return {
        id: existingLayer?.id || `layer-${index + 1}-${slugify(name)}`,
        name,
        description: existingLayer?.description || "",
        placementNotes: existingLayer?.placementNotes || "",
        variantIdeas: existingLayer?.variantIdeas || [],
        variants: existingLayer?.variants || [],
        selectedVariantId: existingLayer?.selectedVariantId || null
      };
    });

  return {
    title: elements.titleInput.value.trim(),
    artDirection: elements.directionInput.value.trim(),
    collectionGoal: elements.goalInput.value.trim(),
    canvas: {
      preset: elements.canvasPresetInput.value,
      width: Number(elements.canvasWidthInput.value || 1024),
      height: Number(elements.canvasHeightInput.value || 1024)
    },
    layers,
    selectedPreviewId: state.project?.selectedPreviewId || null
  };
}

function populateForm(project) {
  elements.titleInput.value = project?.title || "";
  elements.directionInput.value = project?.artDirection || "";
  elements.goalInput.value = project?.collectionGoal || "";
  elements.canvasPresetInput.value = project?.canvas?.generationSize || "1024x1024";
  elements.canvasWidthInput.value = String(project?.canvas?.width || 1024);
  elements.canvasHeightInput.value = String(project?.canvas?.height || 1024);
  elements.layersInput.value = Array.isArray(project?.layers)
    ? project.layers.map((layer) => layer.name).join("\n")
    : "";
}

function populateMemoryForm(memory) {
  elements.memorySystemInput.value = memory?.systemPrompt || "";
  elements.memoryGuidanceInput.value = memory?.userGuidance || "";
}

function render() {
  const hasRuntimeKey = state.config?.hasEnvKey || state.config?.hasSessionKey;
  elements.keyStatus.textContent = hasRuntimeKey ? "Key ready" : "No key yet";
  elements.keyStatus.className = `pill ${hasRuntimeKey ? "" : "pill-warn"}`.trim();

  elements.projectBadge.textContent = state.project ? state.project.title : "New project";
  elements.summaryText.textContent =
    state.project?.planSummary ||
    "Save a project, generate a theme preview, then build out each layer variant.";
  elements.canvasBadge.textContent = formatCanvasBadge(state.project?.canvas || readProjectForm().canvas);

  renderPreview();
  renderPreviewHistory();
  renderLayers();
  renderMemory();
  syncBusyState();
}

function renderPreview() {
  const selectedPreview = getSelectedPreview();
  const selectedVariants = state.project?.layers
    ?.map((layer) => layer.variants.find((variant) => variant.id === layer.selectedVariantId))
    .filter(Boolean);

  elements.stage.style.aspectRatio = getStageAspectRatio(state.project?.canvas || readProjectForm().canvas);

  if (selectedPreview?.imageUrl) {
    elements.previewImage.src = selectedPreview.imageUrl;
    elements.previewImage.classList.remove("hidden");
  } else {
    elements.previewImage.removeAttribute("src");
    elements.previewImage.classList.add("hidden");
  }

  elements.layerStack.innerHTML = "";
  for (const variant of selectedVariants || []) {
    const img = document.createElement("img");
    img.className = "stack-layer";
    img.src = variant.imageUrl;
    img.alt = variant.name;
    elements.layerStack.appendChild(img);
  }

  if (selectedPreview?.imageUrl || selectedVariants?.length) {
    elements.stageEmpty.classList.add("hidden");
  } else {
    elements.stageEmpty.classList.remove("hidden");
  }
}

function renderPreviewHistory() {
  const previews = state.project?.previewHistory || [];
  elements.previewCount.textContent = String(previews.length);

  if (!previews.length) {
    elements.previewHistory.className = "preview-history empty-state";
    elements.previewHistory.textContent = "Generate your first test NFT to start the collection.";
    return;
  }

  elements.previewHistory.className = "preview-history";
  elements.previewHistory.innerHTML = previews
    .map(
      (preview) => `
        <article class="preview-card">
          <img src="${preview.imageUrl}" alt="Preview ${escapeHtml(preview.id)}" />
          <div class="preview-card-body">
            <div class="card-head">
              <strong>${formatDate(preview.createdAt)}</strong>
              <button class="btn btn-ghost" data-action="pick-preview" data-preview-id="${preview.id}">
                Use
              </button>
            </div>
            <p class="hint">${escapeHtml(preview.notes || "Collection preview")}</p>
          </div>
        </article>
      `
    )
    .join("");

  elements.previewHistory.querySelectorAll("[data-action='pick-preview']").forEach((button) => {
    button.addEventListener("click", async () => {
      state.project.selectedPreviewId = button.dataset.previewId;
      const response = await api(`/api/projects/${state.project.id}`, {
        method: "PUT",
        body: readProjectForm()
      });
      state.project = response.project;
      state.memory = response.memory || state.memory;
      render();
    });
  });
}

function renderLayers() {
  const layers = state.project?.layers || [];
  elements.layerCount.textContent = String(layers.length);

  if (!layers.length) {
    elements.layersPanel.className = "layers-panel empty-state";
    elements.layersPanel.textContent = "Layer cards will show up here after you save a project.";
    return;
  }

  elements.layersPanel.className = "layers-panel";
  elements.layersPanel.innerHTML = layers
    .map((layer) => {
      const variants = layer.variants || [];
      const selectedId = layer.selectedVariantId;

      return `
        <article class="layer-card">
          <div class="layer-card-body">
            <div class="layer-card-head">
              <div>
                <h3>${escapeHtml(layer.name)}</h3>
                <p class="layer-description">${escapeHtml(
                  layer.description || "Generate the preview first to let the bot define this layer."
                )}</p>
              </div>
              <span class="pill">${variants.length} vars</span>
            </div>

            <p class="hint">${escapeHtml(layer.placementNotes || "No placement guidance yet.")}</p>

            <div class="variant-toolbar">
              <label class="field">
                <span>Count</span>
                <input id="count-${layer.id}" type="number" min="1" max="8" value="4" />
              </label>
              <button class="btn btn-primary" data-action="generate-variants" data-layer-id="${layer.id}">
                Generate Variants
              </button>
            </div>

            <div class="variant-grid">
              ${
                variants.length
                  ? variants
                      .map(
                        (variant) => `
                          <article class="variant-card">
                            <img src="${variant.imageUrl}" alt="${escapeHtml(variant.name)}" />
                            <div class="variant-meta">
                              <div class="variant-name">${escapeHtml(variant.name)}</div>
                              <div class="variant-notes">${escapeHtml(variant.notes || "")}</div>
                              <button
                                class="btn ${variant.id === selectedId ? "btn-primary" : "btn-ghost"}"
                                data-action="select-variant"
                                data-layer-id="${layer.id}"
                                data-variant-id="${variant.id}"
                              >
                                ${variant.id === selectedId ? "Selected" : "Use In Stack"}
                              </button>
                            </div>
                          </article>
                        `
                      )
                      .join("")
                  : `<div class="empty-state variant-card">No variants yet for ${escapeHtml(layer.name)}.</div>`
              }
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  bindLayerActions();
}

function renderMemory() {
  elements.memorySummary.textContent =
    state.memory?.contextSummary ||
    "Save notes and approvals here. The AI will condense them into a reusable memory for future generations.";

  if (state.memory?.styleRules?.length) {
    elements.memoryRules.className = "memory-rules";
    elements.memoryRules.innerHTML = state.memory.styleRules
      .map((rule) => `<article class="memory-card"><strong>${escapeHtml(rule)}</strong></article>`)
      .join("");
  } else {
    elements.memoryRules.className = "memory-rules empty-state";
    elements.memoryRules.textContent = "No active style rules yet.";
  }

  if (state.memory?.changelog?.length) {
    elements.memoryLog.className = "memory-log";
    elements.memoryLog.innerHTML = state.memory.changelog
      .slice(0, 8)
      .map(
        (entry) => `
          <article class="memory-card">
            <span class="memory-type">${escapeHtml(entry.type || "note")}</span>
            <div class="variant-name">${escapeHtml(entry.title || "Studio note")}</div>
            <div class="variant-notes">${escapeHtml(entry.detail || "")}</div>
          </article>
        `
      )
      .join("");
  } else {
    elements.memoryLog.className = "memory-log empty-state";
    elements.memoryLog.textContent = "No changelog entries yet.";
  }
}

function bindLayerActions() {
  elements.layersPanel.querySelectorAll("[data-action='generate-variants']").forEach((button) => {
    button.addEventListener("click", async () => {
      const { layerId } = button.dataset;
      const countInput = document.getElementById(`count-${layerId}`);
      const count = Number(countInput?.value || 4);

      await withBusy(async () => {
        const response = await api(`/api/projects/${state.project.id}/layers/${layerId}/variants`, {
          method: "POST",
          body: { count }
        });
        state.project = response.project;
        state.memory = response.memory || state.memory;
        render();
        showToast("New layer variants generated.");
      });
    });
  });

  elements.layersPanel.querySelectorAll("[data-action='select-variant']").forEach((button) => {
    button.addEventListener("click", async () => {
      const { layerId, variantId } = button.dataset;
      await withBusy(async () => {
        const response = await api(`/api/projects/${state.project.id}/layers/${layerId}/select`, {
          method: "POST",
          body: { variantId }
        });
        state.project = response.project;
        state.memory = response.memory || state.memory;
        render();
      });
    });
  });
}

async function submitMemoryNote(mode) {
  if (!state.project) {
    showToast("Save a project first.", true);
    return;
  }

  const text = elements.changelogInput.value.trim();
  if (!text) {
    showToast("Write a note first.", true);
    return;
  }

  await withBusy(async () => {
    const path = mode === "approval" ? "approve" : "changelog";
    const response = await api(`/api/projects/${state.project.id}/memory/${path}`, {
      method: "POST",
      body:
        mode === "approval"
          ? { title: "Locked style decision", detail: text }
          : { type: "note", title: "Studio note", detail: text }
    });
    state.memory = response.memory;
    elements.changelogInput.value = "";
    render();
    showToast(mode === "approval" ? "Decision locked into memory." : "Studio note added.");
  });
}

async function withBusy(work) {
  state.busy = true;
  syncBusyState();
  try {
    await work();
  } catch (error) {
    showToast(error.message || "Something went wrong.", true);
  } finally {
    state.busy = false;
    syncBusyState();
  }
}

function syncBusyState() {
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = state.busy;
  });
}

function getSelectedPreview() {
  const previews = state.project?.previewHistory || [];
  if (!previews.length) {
    return null;
  }

  return previews.find((preview) => preview.id === state.project?.selectedPreviewId) || previews[0];
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || "Request failed.");
  }
  return data;
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.className = "toast";
  elements.toast.style.borderColor = isError ? "rgba(255,120,120,0.4)" : "rgba(124,247,197,0.35)";
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.className = "toast hidden";
  }, 3200);
}

function formatDate(value) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function getStageAspectRatio(size) {
  if (!size) {
    return "1 / 1";
  }

  if (size.width && size.height) {
    return `${size.width} / ${size.height}`;
  }

  if (size === "1024x1536") {
    return "2 / 3";
  }

  if (size === "1536x1024") {
    return "3 / 2";
  }

  return "1 / 1";
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function blankProjectShape() {
  return {
    title: "",
    artDirection: "",
    collectionGoal: "",
    canvas: { preset: "1024x1024", width: 1024, height: 1024, generationSize: "1024x1024" },
    layers: []
  };
}

function formatCanvasBadge(canvas) {
  const width = Number(canvas?.width || 1024);
  const height = Number(canvas?.height || 1024);
  return `${width} x ${height}`;
}
