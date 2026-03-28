const state = {
  project: null,
  config: null,
  pendingAttachments: [],
  busy: false,
  previewAsset: {
    requestKey: "",
    loaded: false,
    failed: false
  }
};

const elements = {
  apiKeyControls: document.getElementById("apiKeyControls"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  saveKeyBtn: document.getElementById("saveKeyBtn"),
  keyStatus: document.getElementById("keyStatus"),
  canvasWidthInput: document.getElementById("canvasWidthInput"),
  canvasHeightInput: document.getElementById("canvasHeightInput"),
  imageUploadInput: document.getElementById("imageUploadInput"),
  attachImagesBtn: document.getElementById("attachImagesBtn"),
  attachmentPreviewList: document.getElementById("attachmentPreviewList"),
  promptInput: document.getElementById("promptInput"),
  loadingRail: document.getElementById("loadingRail"),
  loadingFill: document.getElementById("loadingFill"),
  sendPromptBtn: document.getElementById("sendPromptBtn"),
  refreshPreviewBtn: document.getElementById("refreshPreviewBtn"),
  downloadHashlipsBtn: document.getElementById("downloadHashlipsBtn"),
  projectTitle: document.getElementById("projectTitle"),
  canvasBadge: document.getElementById("canvasBadge"),
  stage: document.getElementById("stage"),
  previewImage: document.getElementById("previewImage"),
  stageEmpty: document.getElementById("stageEmpty"),
  chatLog: document.getElementById("chatLog"),
  layersPanel: document.getElementById("layersPanel"),
  layerCount: document.getElementById("layerCount"),
  toast: document.getElementById("toast")
};

elements.previewImage.addEventListener("load", () => {
  state.previewAsset.loaded = true;
  state.previewAsset.failed = false;
  elements.previewImage.style.display = "block";
  elements.previewImage.classList.remove("hidden");
  syncPreviewStatus();
});

elements.previewImage.addEventListener("error", () => {
  state.previewAsset.loaded = false;
  state.previewAsset.failed = true;
  elements.previewImage.style.display = "none";
  elements.previewImage.classList.add("hidden");
  syncPreviewStatus();
});

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

elements.attachImagesBtn.addEventListener("click", () => {
  elements.imageUploadInput.click();
});

elements.imageUploadInput.addEventListener("change", async () => {
  const files = Array.from(elements.imageUploadInput.files || []);
  if (!files.length) {
    return;
  }

  await withBusy(async () => {
    const formData = new FormData();
    for (const file of files) {
      formData.append("images", file);
    }

    const response = await fetch("/api/uploads", {
      method: "POST",
      body: formData
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Upload failed.");
    }

    state.pendingAttachments.push(...(data.attachments || []));
    state.pendingAttachments = state.pendingAttachments.slice(-6);
    elements.imageUploadInput.value = "";
    render();
    showToast("Image refs attached.");
  });
});

elements.sendPromptBtn.addEventListener("click", async () => {
  await submitPrompt();
});

elements.refreshPreviewBtn.addEventListener("click", async () => {
  await submitPrompt({ rerunLatest: true, preservePrompt: true });
});

elements.promptInput.addEventListener("keydown", async (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    await submitPrompt();
  }
});

elements.downloadHashlipsBtn.addEventListener("click", () => {
  if (!state.project) {
    showToast("Generate something first.", true);
    return;
  }

  window.location.href = `/api/projects/${state.project.id}/export/hashlips`;
});

async function bootstrap() {
  await loadConfig();
  if (state.config?.defaultProjectId) {
    const response = await api(`/api/projects/${state.config.defaultProjectId}`);
    state.project = response.project;
    hydrateCanvasFromProject();
  }
  render();
}

async function loadConfig() {
  state.config = await api("/api/config");
}

async function submitPrompt(options = {}) {
  const prompt = resolvePromptForSubmit(options);
  if (!prompt) {
    showToast("Type a prompt first or rerun a previous one.", true);
    return;
  }

  await withBusy(async () => {
    const response = await api("/api/chat", {
      method: "POST",
      body: {
        projectId: state.project?.id || null,
        prompt,
        canvas: readCanvas(),
        attachmentIds: state.pendingAttachments.map((item) => item.id)
      }
    });

    state.project = response.project;
    hydrateCanvasFromProject();
    if (!options.preservePrompt) {
      elements.promptInput.value = "";
    }
    state.pendingAttachments = [];
    render();
    showToast(response.assistantReply || "Done.");
  });
}

function render() {
  const hasEnvKey = Boolean(state.config?.hasEnvKey);
  const hasSessionKey = Boolean(state.config?.hasSessionKey);
  const hasKey = hasEnvKey || hasSessionKey;
  elements.apiKeyControls.classList.toggle("hidden", hasEnvKey);
  elements.keyStatus.textContent = hasEnvKey ? "Env key ready" : hasSessionKey ? "Key ready" : "No key";
  elements.keyStatus.className = `badge ${hasKey ? "" : "badge-warn"}`.trim();

  elements.projectTitle.textContent = state.project?.title || "New Session";
  elements.canvasBadge.textContent = formatCanvas(readCanvasFromState());

  renderPreview();
  renderPendingAttachments();
  renderChat();
  renderLayers();
  syncBusyState();
}

function renderPreview() {
  const selectedPreview = getSelectedPreview();
  const selectedVariants = getSelectedVariants();
  const stackSources = buildPreviewStackSources(selectedPreview, selectedVariants);
  const renderToken = stackSources.map((item) => `${item.imageUrl}:${item.cacheKey}`).join("|");
  const previewUrl =
    state.project?.id && stackSources.length
      ? `/api/projects/${state.project.id}/preview/render?v=${encodeURIComponent(
          renderToken || state.project.updatedAt || Date.now()
        )}`
      : "";

  elements.stage.style.aspectRatio = getAspectRatio(readCanvasFromState());
  elements.previewImage.decoding = "sync";
  elements.previewImage.loading = "eager";
  elements.previewImage.style.display = "none";

  if (previewUrl) {
    state.previewAsset.requestKey = previewUrl;
    state.previewAsset.failed = false;
    if (elements.previewImage.dataset.requestKey !== previewUrl) {
      state.previewAsset.loaded = false;
      elements.previewImage.dataset.requestKey = previewUrl;
      elements.previewImage.removeAttribute("src");
      elements.previewImage.src = previewUrl;
    } else if (state.previewAsset.loaded && !state.previewAsset.failed) {
      elements.previewImage.style.display = "block";
      elements.previewImage.classList.remove("hidden");
    }
  } else {
    state.previewAsset.requestKey = "";
    state.previewAsset.loaded = false;
    state.previewAsset.failed = false;
    elements.previewImage.dataset.requestKey = "";
    elements.previewImage.removeAttribute("src");
    elements.previewImage.classList.add("hidden");
    elements.previewImage.style.display = "none";
  }

  syncPreviewStatus();
}

function renderChat() {
  const messages = state.project?.chatHistory || [];
  if (!messages.length) {
    elements.chatLog.className = "chat-log empty-state";
    elements.chatLog.textContent = "Send a prompt to start the session.";
    return;
  }

  elements.chatLog.className = "chat-log";
  elements.chatLog.innerHTML = messages
    .map(
      (message) => `
        <article class="chat-entry ${message.role === "user" ? "user" : "assistant"}">
          <div class="chat-role">${escapeHtml(message.role === "draw-tech" ? "Draw-Tech" : message.role)}</div>
          <div class="chat-text">${escapeHtml(message.text)}</div>
          ${
            message.generatedImage?.imageUrl
              ? `
                <div class="generated-card">
                  <img class="generated-preview" src="${message.generatedImage.imageUrl}" alt="${escapeHtml(message.generatedImage.name || "Generated image")}" />
                  <div class="generated-meta">
                    <div class="generated-name">${escapeHtml(message.generatedImage.name || (message.generatedImage.type === "preview" ? "Preview" : "Draft"))}</div>
                    <div class="generated-notes">${escapeHtml(message.generatedImage.notes || message.generatedImage.prompt || "")}</div>
                    <div class="generated-actions">
                      <span class="generated-status">${escapeHtml(message.generatedImage.status || "ready")}</span>
                      ${
                        message.generatedImage.type === "draft" && message.generatedImage.status !== "committed"
                          ? `<button
                              class="btn btn-ghost"
                              data-action="commit-draft"
                              data-draft-id="${message.generatedImage.id}"
                              data-layer-name="${escapeHtml(message.generatedImage.targetLayerName || "")}"
                            >
                              Add To ${escapeHtml(message.generatedImage.targetLayerName || "Layer")}
                            </button>`
                          : ""
                      }
                    </div>
                  </div>
                </div>
              `
              : ""
          }
          ${
            Array.isArray(message.attachments) && message.attachments.length
              ? `<div class="chat-attachments">${message.attachments
                  .map(
                    (attachment) =>
                      `<img class="chat-attachment-thumb" src="${attachment.imageUrl}" alt="${escapeHtml(attachment.name || "Attachment")}" />`
                  )
                  .join("")}</div>`
              : ""
          }
        </article>
      `
    )
    .join("");
  bindChatActions();
}

function renderPendingAttachments() {
  if (!state.pendingAttachments.length) {
    elements.attachmentPreviewList.className = "attachment-preview-list empty-inline";
    elements.attachmentPreviewList.textContent = "No image refs attached";
    return;
  }

  elements.attachmentPreviewList.className = "attachment-preview-list";
  elements.attachmentPreviewList.innerHTML = state.pendingAttachments
    .map(
      (attachment) => `
        <div class="attachment-chip">
          <img src="${attachment.imageUrl}" alt="${escapeHtml(attachment.name || "Attachment")}" />
          <button class="btn btn-ghost" data-action="remove-attachment" data-attachment-id="${attachment.id}">Remove</button>
        </div>
      `
    )
    .join("");

  elements.attachmentPreviewList.querySelectorAll("[data-action='remove-attachment']").forEach((button) => {
    button.addEventListener("click", () => {
      state.pendingAttachments = state.pendingAttachments.filter(
        (item) => item.id !== button.dataset.attachmentId
      );
      renderPendingAttachments();
    });
  });
}

function renderLayers() {
  const layers = state.project?.layers || [];
  elements.layerCount.textContent = `${layers.length} layer${layers.length === 1 ? "" : "s"}`;

  if (!layers.length) {
    elements.layersPanel.className = "layer-folder-list empty-state";
    elements.layersPanel.textContent = "Layer folders will appear here after the first prompt.";
    return;
  }

  elements.layersPanel.className = "layer-folder-list";
  elements.layersPanel.innerHTML = layers
    .map((layer) => {
      const variants = layer.variants || [];
      return `
        <details class="layer-folder" open>
          <summary>
            <div class="folder-title">
              <div class="folder-name">${escapeHtml(layer.name)}</div>
              <div class="folder-meta">${variants.length} image${variants.length === 1 ? "" : "s"}</div>
            </div>
            <div class="folder-actions">
              <button class="btn btn-danger" data-action="remove-layer" data-layer-id="${layer.id}">Remove Layer</button>
            </div>
          </summary>

          <div class="folder-body">
            ${
              variants.length
                ? variants
                    .map(
                      (variant) => `
                        <article class="variant-item">
                          <img src="${variant.imageUrl}" alt="${escapeHtml(variant.name)}" />
                          <div class="variant-meta">
                            <div class="variant-name">${escapeHtml(variant.name)}</div>
                            <div class="variant-notes">${escapeHtml(variant.notes || "")}</div>
                            <div class="variant-actions">
                              <button
                                class="check-toggle ${variant.id === layer.selectedVariantId ? "is-checked" : ""}"
                                data-action="select-variant"
                                data-layer-id="${layer.id}"
                                data-variant-id="${variant.id}"
                                aria-pressed="${variant.id === layer.selectedVariantId ? "true" : "false"}"
                              >
                                <span class="check-toggle-box" aria-hidden="true">${variant.id === layer.selectedVariantId ? "✓" : ""}</span>
                                <span>${variant.id === layer.selectedVariantId ? "On Preview" : "Show On Preview"}</span>
                              </button>
                              <button
                                class="btn btn-danger"
                                data-action="remove-variant"
                                data-layer-id="${layer.id}"
                                data-variant-id="${variant.id}"
                              >
                                Remove
                              </button>
                              ${
                                variant.id === layer.selectedVariantId
                                  ? '<span class="selected-chip">Checked into preview</span>'
                                  : ""
                              }
                            </div>
                          </div>
                        </article>
                      `
                    )
                    .join("")
                : `<div class="empty-state">No images in this layer folder yet.</div>`
            }
          </div>
        </details>
      `;
    })
    .join("");

  bindLayerActions();
}

function bindLayerActions() {
  elements.layersPanel.querySelectorAll("[data-action='select-variant']").forEach((button) => {
    button.addEventListener("click", async () => {
      await withBusy(async () => {
        const response = await api(
          `/api/projects/${state.project.id}/layers/${button.dataset.layerId}/select`,
          {
            method: "POST",
            body: { variantId: button.dataset.variantId }
          }
        );
        state.project = response.project;
        render();
      });
    });
  });

  elements.layersPanel.querySelectorAll("[data-action='remove-variant']").forEach((button) => {
    button.addEventListener("click", async () => {
      await withBusy(async () => {
        const response = await api(
          `/api/projects/${state.project.id}/layers/${button.dataset.layerId}/variants/${button.dataset.variantId}`,
          {
            method: "DELETE"
          }
        );
        state.project = response.project;
        render();
        showToast("Layer image removed.");
      });
    });
  });

  elements.layersPanel.querySelectorAll("[data-action='remove-layer']").forEach((button) => {
    button.addEventListener("click", async () => {
      await withBusy(async () => {
        const response = await api(`/api/projects/${state.project.id}/layers/${button.dataset.layerId}`, {
          method: "DELETE"
        });
        state.project = response.project;
        render();
        showToast("Layer removed.");
      });
    });
  });
}

function bindChatActions() {
  elements.chatLog.querySelectorAll("[data-action='commit-draft']").forEach((button) => {
    button.addEventListener("click", async () => {
      await withBusy(async () => {
        const response = await api(`/api/projects/${state.project.id}/drafts/${button.dataset.draftId}/commit`, {
          method: "POST",
          body: { layerName: button.dataset.layerName || "" }
        });
        state.project = response.project;
        render();
        showToast(`Draft added to ${response.layer?.name || "layer"}.`);
      });
    });
  });
}

function readCanvas() {
  return {
    width: Number(elements.canvasWidthInput.value || 1024),
    height: Number(elements.canvasHeightInput.value || 1024),
    preset: "1024x1024"
  };
}

function readCanvasFromState() {
  return state.project?.canvas || readCanvas();
}

function hydrateCanvasFromProject() {
  elements.canvasWidthInput.value = String(state.project?.canvas?.width || 1024);
  elements.canvasHeightInput.value = String(state.project?.canvas?.height || 1024);
}

function getSelectedPreview() {
  const previews = state.project?.previewHistory || [];
  if (!previews.length) {
    return null;
  }

  return previews.find((item) => item.id === state.project.selectedPreviewId) || previews[0];
}

function getSelectedVariants() {
  return (state.project?.layers || [])
    .map((layer) => layer.variants.find((variant) => variant.id === layer.selectedVariantId))
    .filter(Boolean);
}

function buildPreviewStackSources(selectedPreview, selectedVariants) {
  const seen = new Set();
  const items = [];

  const pushSource = (source) => {
    const imageUrl = String(source?.imageUrl || "").trim();
    if (!imageUrl || seen.has(imageUrl)) {
      return;
    }

    seen.add(imageUrl);
    items.push({
      imageUrl,
      name: source.name || "Preview image",
      cacheKey: source.createdAt || source.id || state.project?.updatedAt || "",
      className: source.className || "stack-layer"
    });
  };

  pushSource({
    imageUrl: selectedPreview?.imageUrl,
    name: selectedPreview?.name || state.project?.title || "Preview",
    createdAt: selectedPreview?.createdAt,
    id: selectedPreview?.id,
    className: "stage-image stack-base-preview"
  });

  for (const variant of selectedVariants) {
    pushSource({
      imageUrl: variant.imageUrl,
      name: variant.name,
      createdAt: variant.createdAt,
      id: variant.id,
      className: "stack-layer"
    });
  }

  return items;
}

function resolvePromptForSubmit(options = {}) {
  const typedPrompt = elements.promptInput.value.trim();
  if (typedPrompt) {
    return typedPrompt;
  }

  if (!options.rerunLatest) {
    return "";
  }

  const latestUserMessage = [...(state.project?.chatHistory || [])]
    .reverse()
    .find((message) => message.role === "user" && String(message.text || "").trim());

  return String(latestUserMessage?.text || "").trim();
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
  elements.loadingRail.classList.toggle("is-active", state.busy);
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
  elements.toast.style.borderColor = isError ? "rgba(255,120,120,0.4)" : "rgba(15,123,108,0.45)";
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.className = "toast hidden";
  }, 3000);
}

function getAspectRatio(canvas) {
  return `${Number(canvas?.width || 1024)} / ${Number(canvas?.height || 1024)}`;
}

function formatCanvas(canvas) {
  return `${Number(canvas?.width || 1024)} x ${Number(canvas?.height || 1024)}`;
}

function buildAssetUrl(url, cacheKey = "") {
  const cleanUrl = String(url || "").trim();
  if (!cleanUrl) {
    return "";
  }

  const separator = cleanUrl.includes("?") ? "&" : "?";
  return `${cleanUrl}${separator}v=${encodeURIComponent(String(cacheKey || "static"))}`;
}

function syncPreviewStatus() {
  const hasPreview = buildPreviewStackSources(getSelectedPreview(), getSelectedVariants()).length > 0;
  let message = "No preview yet";
  let showStatus = false;

  if (!hasPreview) {
    showStatus = true;
  } else if (!state.previewAsset.loaded && !state.previewAsset.failed) {
    message = "Loading preview...";
    showStatus = true;
  } else if (state.previewAsset.failed) {
    message = "Preview render failed.";
    showStatus = true;
  }

  elements.stageEmpty.textContent = message;
  elements.stageEmpty.classList.toggle("hidden", !showStatus);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
