const state = {
  project: null,
  config: null,
  projects: [],
  projectsLoading: false,
  projectShelfVisible: false,
  projectNameDraft: "",
  pendingAttachments: [],
  busy: false,
  lastFailedPrompt: null,
  hiddenLayers: new Set(),
  fitDebugVisible: false,
  fitDebugLoading: false,
  fitDebugData: null,
  dragMode: false,
  dragState: null,
  dragSelection: null,
  pendingDragTransforms: {},
  folderDrag: null,
  previewAsset: {
    requestKey: "",
    loaded: false,
    failed: false
  }
};

const ACTIVE_PROJECT_STORAGE_KEY = "draw-tech-active-project-id";

const elements = {
  apiKeyControls: document.getElementById("apiKeyControls"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  saveKeyBtn: document.getElementById("saveKeyBtn"),
  keyStatus: document.getElementById("keyStatus"),
  projectStatus: document.getElementById("projectStatus"),
  saveProjectBtn: document.getElementById("saveProjectBtn"),
  newProjectBtn: document.getElementById("newProjectBtn"),
  toggleProjectShelfBtn: document.getElementById("toggleProjectShelfBtn"),
  projectShelf: document.getElementById("projectShelf"),
  closeProjectShelfBtn: document.getElementById("closeProjectShelfBtn"),
  projectNameInput: document.getElementById("projectNameInput"),
  projectCurrentMeta: document.getElementById("projectCurrentMeta"),
  saveProjectShelfBtn: document.getElementById("saveProjectShelfBtn"),
  newProjectShelfBtn: document.getElementById("newProjectShelfBtn"),
  projectCountBadge: document.getElementById("projectCountBadge"),
  projectList: document.getElementById("projectList"),
  canvasWidthInput: document.getElementById("canvasWidthInput"),
  canvasHeightInput: document.getElementById("canvasHeightInput"),
  imageUploadInput: document.getElementById("imageUploadInput"),
  attachImagesBtn: document.getElementById("attachImagesBtn"),
  attachmentPreviewList: document.getElementById("attachmentPreviewList"),
  promptInput: document.getElementById("promptInput"),
  loadingRail: document.getElementById("loadingRail"),
  loadingFill: document.getElementById("loadingFill"),
  sendPromptBtn: document.getElementById("sendPromptBtn"),
  toggleFitDebugBtn: document.getElementById("toggleFitDebugBtn"),
  toggleDragModeBtn: document.getElementById("toggleDragModeBtn"),
  saveDragBtn: document.getElementById("saveDragBtn"),
  dragScaleControls: document.getElementById("dragScaleControls"),
  dragScaleDownBtn: document.getElementById("dragScaleDownBtn"),
  dragScaleReadout: document.getElementById("dragScaleReadout"),
  dragScaleUpBtn: document.getElementById("dragScaleUpBtn"),
  refreshPreviewBtn: document.getElementById("refreshPreviewBtn"),
  downloadHashlipsBtn: document.getElementById("downloadHashlipsBtn"),
  projectTitle: document.getElementById("projectTitle"),
  canvasBadge: document.getElementById("canvasBadge"),
  stage: document.getElementById("stage"),
  previewImage: document.getElementById("previewImage"),
  stageLayerStack: document.getElementById("stageLayerStack"),
  stageEmpty: document.getElementById("stageEmpty"),
  chatLog: document.getElementById("chatLog"),
  fitDebugPanel: document.getElementById("fitDebugPanel"),
  downloadFitDebugBtn: document.getElementById("downloadFitDebugBtn"),
  fitDebugSummary: document.getElementById("fitDebugSummary"),
  fitDebugContent: document.getElementById("fitDebugContent"),
  layersPanel: document.getElementById("layersPanel"),
  newLayerBtn: document.getElementById("newLayerBtn"),
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

elements.toggleProjectShelfBtn.addEventListener("click", async () => {
  state.projectShelfVisible = !state.projectShelfVisible;
  if (state.projectShelfVisible) {
    await loadProjects();
  }
  render();
});

elements.closeProjectShelfBtn.addEventListener("click", () => {
  state.projectShelfVisible = false;
  render();
});

elements.projectNameInput.addEventListener("input", () => {
  state.projectNameDraft = elements.projectNameInput.value;
});

elements.saveProjectBtn.addEventListener("click", async () => {
  await saveCurrentProject();
});

elements.saveProjectShelfBtn.addEventListener("click", async () => {
  await saveCurrentProject();
});

elements.newProjectBtn.addEventListener("click", async () => {
  await createNewProject();
});

elements.newProjectShelfBtn.addEventListener("click", async () => {
  await createNewProject();
});

elements.attachImagesBtn.addEventListener("click", () => {
  elements.imageUploadInput.click();
});

elements.imageUploadInput.addEventListener("change", async () => {
  const files = Array.from(elements.imageUploadInput.files || []);
  if (!files.length) {
    return;
  }

  await uploadAttachmentFiles(files, "Image refs attached.");
  elements.imageUploadInput.value = "";
});

elements.sendPromptBtn.addEventListener("click", async () => {
  await submitPrompt();
});

document.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && document.activeElement === elements.promptInput) {
    e.preventDefault();
    await submitPrompt();
  }
  if (e.key === "Escape") {
    if (state.projectShelfVisible) {
      state.projectShelfVisible = false;
      render();
    }
  }
});

elements.toggleFitDebugBtn.addEventListener("click", async () => {
  state.fitDebugVisible = !state.fitDebugVisible;
  if (state.fitDebugVisible && state.project?.id && !state.fitDebugData) {
    await loadFitDebug();
  }
  render();
});

elements.toggleDragModeBtn.addEventListener("click", () => {
  if (state.dragState) {
    cancelStageDrag();
  }

  if (state.dragMode && hasPendingDragTransforms()) {
    state.pendingDragTransforms = {};
    state.dragSelection = null;
    state.dragMode = false;
    render();
    showToast("Drag mode off. Unsaved layer moves were discarded.");
    return;
  }

  state.dragMode = !state.dragMode;
  if (!state.dragMode) {
    state.dragSelection = null;
  }
  render();
  showToast(state.dragMode ? "Drag mode on. Drag layers, use scale +/- if needed, then click Save Drag." : "Drag mode off.");
});

elements.saveDragBtn.addEventListener("click", async () => {
  await savePendingDragTransforms();
});

elements.dragScaleDownBtn.addEventListener("click", () => {
  adjustSelectedLayerScale(-0.05);
});

elements.dragScaleUpBtn.addEventListener("click", () => {
  adjustSelectedLayerScale(0.05);
});

elements.refreshPreviewBtn.addEventListener("click", async () => {
  if (!state.project?.id) {
    showToast("Save a project first.", true);
    return;
  }

  const hasVariants = (state.project.layers || []).some((l) => l.variants && l.variants.length > 0);
  if (!hasVariants) {
    showToast("Generate some layer variants first.", true);
    return;
  }

  await withBusy(async () => {
    const response = await api(`/api/projects/${state.project.id}/shuffle`, {
      method: "POST"
    });

    await applyProject(response.project);
    render();
    const picks = (response.shuffled || []).map((s) => s.variantName).join(", ");
    showToast(picks ? `Shuffled: ${picks}` : "Shuffled variants.");
  });
});

elements.stageLayerStack.addEventListener("pointerdown", handleStageLayerPointerDown);
window.addEventListener("pointermove", handleStageLayerPointerMove);
window.addEventListener("pointerup", handleStageLayerPointerUp);
window.addEventListener("pointercancel", handleStageLayerPointerUp);
window.addEventListener("keydown", handleDragModeKeyDown);

elements.promptInput.addEventListener("keydown", async (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    await submitPrompt();
  }
});

elements.promptInput.addEventListener("paste", async (event) => {
  const files = extractImageFilesFromClipboard(event.clipboardData);
  if (!files.length) {
    return;
  }

  event.preventDefault();
  await uploadAttachmentFiles(files, files.length === 1 ? "Pasted image attached." : "Pasted images attached.");
});

elements.downloadHashlipsBtn.addEventListener("click", () => {
  if (!state.project) {
    showToast("Generate something first.", true);
    return;
  }

  window.location.href = `/api/projects/${state.project.id}/export/hashlips`;
});

elements.downloadFitDebugBtn.addEventListener("click", async () => {
  if (!state.project?.id) {
    showToast("Generate something first.", true);
    return;
  }

  try {
    const response = await fetch(`/api/projects/${state.project.id}/fit-debug`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data?.error || "Could not download fit debug JSON.");
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slugify(state.project.title || "draw-tech")}-fit-debug.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    showToast(error.message || "Could not download fit debug JSON.", true);
  }
});

elements.newLayerBtn.addEventListener("click", async () => {
  if (!state.project?.id) {
    showToast("Start a session first, then add folders.", true);
    return;
  }

  const nextName = window.prompt("New layer folder name", "");
  if (nextName === null) {
    return;
  }

  const trimmedName = nextName.trim();
  if (!trimmedName) {
    return;
  }

  await withBusy(async () => {
    const response = await api(`/api/projects/${state.project.id}/layers`, {
      method: "POST",
      body: {
        name: trimmedName
      }
    });
    await applyProject(response.project);
    render();
    showToast(`Created ${response.layer?.name || "new"} folder.`);
  });
});

async function bootstrap() {
  await loadConfig();
  await loadProjects({ silent: true });

  const storedProjectId = getStoredActiveProjectId();
  const initialProjectId = storedProjectId || state.config?.defaultProjectId || state.projects[0]?.id || "";
  if (initialProjectId) {
    const loaded = await tryOpenProject(initialProjectId);
    if (!loaded && state.config?.defaultProjectId && state.config.defaultProjectId !== initialProjectId) {
      await tryOpenProject(state.config.defaultProjectId);
    }
  }
  render();
}

async function loadConfig() {
  state.config = await api("/api/config");
}

async function loadProjects(options = {}) {
  const silent = Boolean(options.silent);
  state.projectsLoading = true;
  if (!silent) {
    renderProjectShelf();
  }

  try {
    const response = await api("/api/projects");
    state.projects = Array.isArray(response.projects) ? response.projects.slice() : [];
    state.projects.sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
  } finally {
    state.projectsLoading = false;
    if (!silent) {
      renderProjectShelf();
    }
  }
}

async function tryOpenProject(projectId) {
  const targetId = String(projectId || "").trim();
  if (!targetId) {
    return false;
  }

  try {
    const response = await api(`/api/projects/${targetId}`);
    await applyProject(response.project);
    upsertProjectSummary(response.project);
    return true;
  } catch (error) {
    if (getStoredActiveProjectId() === targetId) {
      clearStoredActiveProjectId();
    }
    return false;
  }
}

async function openProject(projectId) {
  await withBusy(async () => {
    const response = await api(`/api/projects/${projectId}`);
    state.pendingAttachments = [];
    elements.promptInput.value = "";
    await applyProject(response.project);
    upsertProjectSummary(response.project);
    state.projectShelfVisible = false;
    render();
    showToast(`Opened ${response.project.title || "project"}.`);
  });
}

async function saveCurrentProject() {
  await withBusy(async () => {
    const title = normalizeProjectTitle(state.projectNameDraft || state.project?.title || "");
    const canvas = readCanvas();
    let response;

    if (state.project?.id) {
      response = await api(`/api/projects/${state.project.id}`, {
        method: "PUT",
        body: {
          title,
          canvas
        }
      });
    } else {
      response = await api("/api/projects", {
        method: "POST",
        body: {
          title,
          artDirection: "",
          collectionGoal: "Layered NFT build session",
          canvas,
          layers: []
        }
      });
    }

    await applyProject(response.project);
    upsertProjectSummary(response.project);
    await loadProjects({ silent: true });
    state.projectShelfVisible = true;
    render();
    showToast("Project saved.");
  });
}

async function createNewProject() {
  await withBusy(async () => {
    const response = await api("/api/projects", {
      method: "POST",
      body: {
        title: buildNewProjectTitle(),
        artDirection: "",
        collectionGoal: "Layered NFT build session",
        canvas: readCanvas(),
        layers: []
      }
    });

    state.pendingAttachments = [];
    elements.promptInput.value = "";
    await applyProject(response.project);
    upsertProjectSummary(response.project);
    await loadProjects({ silent: true });
    state.projectShelfVisible = true;
    render();
    showToast("New project ready.");
  });
}

async function submitPrompt(options = {}) {
  const prompt = resolvePromptForSubmit(options);
  if (!prompt) {
    showToast("Type a prompt first or rerun a previous one.", true);
    return;
  }

  await withBusy(async () => {
    showChatLoading(prompt);
    try {
      const response = await api("/api/chat", {
        method: "POST",
        body: {
          projectId: state.project?.id || null,
          prompt,
          canvas: readCanvas(),
          attachmentIds: state.pendingAttachments.map((item) => item.id)
        }
      });

      state.lastFailedPrompt = null;
      await applyProject(response.project);
      if (!options.preservePrompt) {
        elements.promptInput.value = "";
      }
      state.pendingAttachments = [];
      render();

      const warns = response.qualityWarnings || [];
      if (warns.length) {
        showToast(`${response.assistantReply || "Done."}\n⚠ ${warns.join(" • ")}`, true);
      } else {
        showToast(response.assistantReply || "Done.");
      }
    } catch (error) {
      state.lastFailedPrompt = prompt;
      hideChatLoading();
      throw error;
    }
  });
}

async function uploadAttachmentFiles(files, successMessage = "Image refs attached.") {
  const uploadFiles = Array.from(files || []).filter((file) => String(file?.type || "").startsWith("image/"));
  if (!uploadFiles.length) {
    return;
  }

  await withBusy(async () => {
    const formData = new FormData();
    for (const file of uploadFiles.slice(0, 6)) {
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
    render();
    showToast(successMessage);
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

  renderProjectShelf();
  renderPreview();
  renderPendingAttachments();
  renderChat();
  renderFitDebug();
  renderLayers();
  syncBusyState();
}

function renderProjectShelf() {
  const currentProject = state.project;
  const projectCount = state.projects.length;
  const currentTitle = currentProject?.title || "";
  const currentMeta = currentProject
    ? `${currentProject.layers?.length || 0} folders • ${formatCanvas(currentProject.canvas)} • Auto-saves while you work`
    : "Save the current build, then open another one whenever you want.";

  elements.projectStatus.textContent = currentProject
    ? `Project: ${summarizeDisplayText(currentTitle, 32) || "Untitled"}`
    : "No saved project";
  elements.projectStatus.className = `badge badge-project${currentProject ? "" : " badge-warn"}`;
  elements.toggleProjectShelfBtn.classList.toggle("is-active", state.projectShelfVisible);
  elements.projectShelf.classList.toggle("hidden", !state.projectShelfVisible);
  elements.projectCurrentMeta.textContent = currentMeta;
  elements.projectCountBadge.textContent = state.projectsLoading ? "Loading..." : `${projectCount} saved`;
  elements.saveProjectBtn.textContent = currentProject ? "Save Project" : "Save New Project";
  elements.saveProjectShelfBtn.textContent = currentProject ? "Save Project" : "Save New Project";

  if (document.activeElement !== elements.projectNameInput) {
    elements.projectNameInput.value = state.projectNameDraft || currentTitle || "";
  }

  if (state.projectsLoading) {
    elements.projectList.className = "project-list empty-state";
    elements.projectList.textContent = "Loading saved projects...";
    return;
  }

  if (!state.projects.length) {
    elements.projectList.className = "project-list empty-state";
    elements.projectList.textContent = "Save a project to see it here.";
    return;
  }

  elements.projectList.className = "project-list";
  elements.projectList.innerHTML = state.projects
    .map((project) => {
      const active = project.id === currentProject?.id;
      return `
        <article class="project-card ${active ? "is-active" : ""}" data-card-id="${escapeHtml(project.id)}" data-action="open-project" data-project-id="${escapeHtml(project.id)}">
          <div class="project-card-head">
            <div>
              <div class="project-card-title">${escapeHtml(project.title || "Untitled NFT Collection")}</div>
              <input
                class="project-card-rename-input hidden"
                type="text"
                value="${escapeHtml(project.title || "Untitled NFT Collection")}"
                data-project-id="${escapeHtml(project.id)}"
              />
              <div class="project-card-meta">
                ${escapeHtml(`${project.layerCount || 0} folders • Updated ${formatProjectTimestamp(project.updatedAt)}`)}
              </div>
            </div>
            <span class="badge ${active ? "project-card-badge-active" : ""}">${active ? "Open now" : "Saved"}</span>
          </div>
          <div class="project-card-actions">
            <button
              class="btn btn-ghost btn-compact"
              type="button"
              data-action="rename-project"
              data-project-id="${escapeHtml(project.id)}"
            >
              Rename
            </button>
          </div>
        </article>
      `;
    })
    .join("");

  bindProjectShelfActions();
}

function renderPreview() {
  const selectedEntries = getSelectedLayerEntries();
  syncDragSelection(selectedEntries);
  const activeDragEntry = getActiveDragEntry(selectedEntries);
  const stackSources = buildPreviewStackSources(selectedEntries);
  const renderToken = stackSources.map((item) => `${item.imageUrl}:${item.cacheKey}`).join("|");
  const previewUrl =
    state.project?.id && stackSources.length
      ? `/api/projects/${state.project.id}/preview/render?v=${encodeURIComponent(
          renderToken || state.project.updatedAt || Date.now()
        )}`
      : "";

  elements.stage.style.aspectRatio = getAspectRatio(readCanvasFromState());
  elements.toggleDragModeBtn.classList.toggle("is-active", state.dragMode);
  elements.saveDragBtn.classList.toggle("hidden", !state.dragMode || !hasPendingDragTransforms());
  elements.saveDragBtn.textContent = hasPendingDragTransforms() ? "Save Drag" : "Save Drag";
  elements.dragScaleControls.classList.toggle("hidden", !state.dragMode || !activeDragEntry);
  elements.dragScaleReadout.textContent = activeDragEntry
    ? `Scale ${Math.round(getEntryDisplayTransform(activeDragEntry).scale * 100)}%`
    : "Scale 100%";
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

  renderStageLayerStack(selectedEntries);
  elements.previewImage.classList.toggle("is-stage-hidden", state.dragMode && selectedEntries.length > 0);
  syncPreviewStatus();
}

function renderChat() {
  const messages = state.project?.chatHistory || [];
  if (!messages.length && !state.busy) {
    elements.chatLog.className = "chat-log empty-state";
    elements.chatLog.innerHTML = `<div class="chat-empty-guide">
      <p>Send a prompt to start building.</p>
      <p class="chat-empty-tips">Try something like:<br>"Make me a cyber frog NFT with layered traits"<br>"Generate a full preview of a pixel art robot collection"</p>
    </div>`;
    return;
  }

  elements.chatLog.className = "chat-log";
  elements.chatLog.innerHTML = messages
    .map(
      (message) => {
        const generatedTargetLayerName = resolveGeneratedTargetLayerName(message.generatedImage);
        const timestamp = message.createdAt ? formatChatTimestamp(message.createdAt) : "";
        return `
        <article class="chat-entry ${message.role === "user" ? "user" : "assistant"}">
          <div class="chat-entry-head">
            <div class="chat-role">${escapeHtml(message.role === "draw-tech" ? "Draw-Tech" : message.role)}</div>
            ${timestamp ? `<span class="chat-timestamp">${escapeHtml(timestamp)}</span>` : ""}
          </div>
          <div class="chat-text">${escapeHtml(message.text)}</div>
          ${
            message.generatedImage?.imageUrl
              ? `
                <div class="generated-card">
                  <img class="generated-preview" src="${message.generatedImage.imageUrl}" alt="${escapeHtml(message.generatedImage.name || "Generated image")}" />
                  <div class="generated-meta">
                    <div class="generated-name">${escapeHtml(message.generatedImage.name || (message.generatedImage.type === "preview" ? "Preview" : "Draft"))}</div>
                    <div
                      class="generated-notes"
                      title="${escapeHtml(message.generatedImage.notes || message.generatedImage.prompt || "")}"
                    >${escapeHtml(summarizeDisplayText(message.generatedImage.notes || message.generatedImage.prompt || "", 160))}</div>
                    <div class="generated-actions">
                      <span class="generated-status">${escapeHtml(message.generatedImage.status || "ready")}</span>
                      ${
                        message.generatedImage.type === "draft" && message.generatedImage.status !== "committed"
                          ? `<button
                              class="btn btn-ghost"
                              data-action="commit-draft"
                              data-draft-id="${message.generatedImage.id}"
                              data-layer-name="${escapeHtml(generatedTargetLayerName)}"
                            >
                              Add To ${escapeHtml(generatedTargetLayerName || "Layer")}
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
      `;
      }
    )
    .join("");

  if (state.lastFailedPrompt) {
    elements.chatLog.insertAdjacentHTML("beforeend", `
      <article class="chat-entry chat-entry-error">
        <div class="chat-role">Error</div>
        <div class="chat-text">Generation failed. <button class="btn btn-ghost btn-retry" data-action="retry-prompt">Retry</button></div>
      </article>
    `);
  }

  bindChatActions();
}

function renderFitDebug() {
  const hasProject = Boolean(state.project?.id);
  elements.toggleFitDebugBtn.classList.toggle("is-active", state.fitDebugVisible);
  elements.toggleFitDebugBtn.textContent = state.fitDebugVisible ? "Hide Inspector" : "Layer Inspector";
  elements.fitDebugPanel.classList.toggle("hidden", !state.fitDebugVisible || !hasProject);

  if (!state.fitDebugVisible || !hasProject) {
    return;
  }

  if (state.fitDebugLoading) {
    elements.fitDebugSummary.textContent = "Loading fit profile data...";
    elements.fitDebugContent.innerHTML = "";
    return;
  }

  if (!state.fitDebugData) {
    elements.fitDebugSummary.textContent = "No fit profile data loaded yet.";
    elements.fitDebugContent.innerHTML = "";
    return;
  }

  const data = state.fitDebugData;
  const activeAnchor = data.activeAnchor
    ? `
      <article class="fit-debug-card fit-debug-card-anchor">
        <div class="fit-debug-card-head">
          <strong>Active Anchor</strong>
          <span class="badge">${escapeHtml(data.activeAnchor.layerName || "None")}</span>
        </div>
        <div class="fit-debug-kv">
          <span>Variant</span>
          <span>${escapeHtml(data.activeAnchor.variantName || "No selected asset")}</span>
        </div>
        <div class="fit-debug-kv">
          <span>Image</span>
          <span>${escapeHtml(data.activeAnchor.imageUrl || "n/a")}</span>
        </div>
      </article>
    `
    : `
      <article class="fit-debug-card fit-debug-card-anchor">
        <div class="fit-debug-card-head">
          <strong>Active Anchor</strong>
          <span class="badge badge-warn">Missing</span>
        </div>
        <div class="fit-debug-empty">No base or anchor layer is selected right now.</div>
      </article>
    `;

  elements.fitDebugSummary.innerHTML = `
    <div class="fit-debug-summary-row">
      <span class="badge">${escapeHtml(data.projectTitle || "Project")}</span>
      <span class="badge">${escapeHtml(formatCanvas(data.canvas || {}))}</span>
      <span class="badge">${Number(data.layers?.length || 0)} layer${Number(data.layers?.length || 0) === 1 ? "" : "s"}</span>
      <span class="badge">${Number(data.selectedLayerCount || 0)} selected</span>
    </div>
    <div class="fit-debug-summary-note">
      Hidden inspector for anchor, fit profile, clip strategy, and live transform values.
    </div>
  `;

  elements.fitDebugContent.innerHTML = [
    activeAnchor,
    ...(data.layers || []).map(
      (layer) => `
        <article class="fit-debug-card">
          <div class="fit-debug-card-head">
            <strong>${escapeHtml(layer.name || "Layer")}</strong>
            <div class="fit-debug-card-badges">
              ${layer.isBaseLayer ? '<span class="badge">Base</span>' : ""}
              <span class="badge ${layer.selected ? "" : "badge-warn"}">${layer.selected ? "Selected" : "Unselected"}</span>
            </div>
          </div>
          <div class="fit-debug-kv">
            <span>Profile</span>
            <span>${escapeHtml(layer.fitProfile?.label || layer.fitProfile?.id || "none")}</span>
          </div>
          <div class="fit-debug-kv">
            <span>Anchor Region</span>
            <span>${escapeHtml(layer.fitProfile?.anchorRegion || "none")}</span>
          </div>
          <div class="fit-debug-kv">
            <span>Clip Strategy</span>
            <span>${escapeHtml(layer.fitProfile?.clipStrategy || "none")}</span>
          </div>
          <div class="fit-debug-kv">
            <span>Selected Asset</span>
            <span>${escapeHtml(layer.selectedVariant?.name || "none")}</span>
          </div>
          <div class="fit-debug-kv">
            <span>Placement Mode</span>
            <span>${escapeHtml(layer.selectedVariantTransformMode || "sync")}</span>
          </div>
          <div class="fit-debug-kv">
            <span>Image</span>
            <span>${escapeHtml(layer.selectedVariant?.imageUrl || "n/a")}</span>
          </div>
          <pre class="fit-debug-code">${escapeHtml(
            JSON.stringify(layer.transform || {}, null, 2)
          )}</pre>
          ${
            layer.fitProfile?.guidance
              ? `<div class="fit-debug-guidance">${escapeHtml(layer.fitProfile.guidance)}</div>`
              : ""
          }
        </article>
      `
    )
  ].join("");
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
    .map((layer, index) => ({ layer, actualIndex: index }))
    .reverse()
    .map(({ layer, actualIndex }) => {
      const variants = layer.variants || [];
      const isBackmostLayer = actualIndex === 0;
      const isFrontmostLayer = actualIndex === layers.length - 1;
      const frontRank = layers.length - actualIndex;
      return `
        <details class="layer-folder" open>
          <summary>
            <div class="folder-title">
              <div class="folder-name">${escapeHtml(layer.name)}</div>
              <div class="folder-meta">
                ${variants.length} image${variants.length === 1 ? "" : "s"} / Front ${frontRank} of ${layers.length}
              </div>
            </div>
            <div class="folder-actions">
              <button
                class="btn btn-ghost btn-visibility${state.hiddenLayers.has(layer.id) ? " is-hidden-layer" : ""}"
                data-action="toggle-layer-visibility"
                data-layer-id="${layer.id}"
                title="${state.hiddenLayers.has(layer.id) ? "Show layer in preview" : "Hide layer from preview"}"
                aria-label="Toggle ${escapeHtml(layer.name)} visibility"
              >
                ${state.hiddenLayers.has(layer.id) ? "Hidden" : "Visible"}
              </button>
              <button
                class="btn btn-ghost btn-stack"
                data-action="move-layer-back"
                data-layer-id="${layer.id}"
                title="Send layer backward"
                aria-label="Send ${escapeHtml(layer.name)} backward"
                ${isBackmostLayer ? "disabled" : ""}
              >
                -
              </button>
              <button
                class="btn btn-ghost btn-stack"
                data-action="move-layer-forward"
                data-layer-id="${layer.id}"
                title="Bring layer forward"
                aria-label="Bring ${escapeHtml(layer.name)} forward"
                ${isFrontmostLayer ? "disabled" : ""}
              >
                +
              </button>
              <button
                class="btn btn-ghost"
                data-action="rename-layer"
                data-layer-id="${layer.id}"
                data-layer-name="${escapeHtml(layer.name)}"
              >
                Rename
              </button>
              <button class="btn btn-danger" data-action="remove-layer" data-layer-id="${layer.id}">Remove Layer</button>
            </div>
          </summary>

          <div class="folder-body" data-drop-layer-id="${layer.id}">
            ${
              variants.length
                ? variants
                    .map(
                      (variant) => `
                        <article
                          class="variant-item"
                          draggable="true"
                          data-source-layer-id="${layer.id}"
                          data-variant-id="${variant.id}"
                          data-variant-name="${escapeHtml(variant.name)}"
                        >
                          <img src="${variant.imageUrl}" alt="${escapeHtml(variant.name)}" />
                          <div class="variant-meta">
                            <div class="variant-name" title="${escapeHtml(variant.name)}">${escapeHtml(summarizeDisplayText(variant.name, 48))}</div>
                            <div class="variant-notes" title="${escapeHtml(variant.notes || "")}">${escapeHtml(summarizeDisplayText(variant.notes || "", 120))}</div>
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
                                class="btn btn-ghost btn-sync-toggle ${isVariantUsingCustomTransform(variant) ? "is-custom" : ""}"
                                data-action="toggle-variant-placement-mode"
                                data-layer-id="${layer.id}"
                                data-variant-id="${variant.id}"
                                data-mode="${isVariantUsingCustomTransform(variant) ? "sync" : "custom"}"
                              >
                                ${isVariantUsingCustomTransform(variant) ? "Resync" : "Break Sync"}
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
                              ${
                                isVariantUsingCustomTransform(variant)
                                  ? '<span class="selected-chip selected-chip-custom">Custom transform</span>'
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
  const clearFolderDropTargets = () => {
    elements.layersPanel.querySelectorAll(".folder-body.is-drop-target").forEach((folderBody) => {
      folderBody.classList.remove("is-drop-target");
    });
  };

  const readVariantDragPayload = (event) => {
    if (state.folderDrag) {
      return state.folderDrag;
    }

    const raw =
      event.dataTransfer?.getData("application/json") ||
      event.dataTransfer?.getData("text/plain") ||
      "";
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  elements.layersPanel.querySelectorAll(".variant-item[draggable='true']").forEach((item) => {
    item.addEventListener("dragstart", (event) => {
      if (state.busy) {
        event.preventDefault();
        return;
      }

      const payload = {
        sourceLayerId: item.dataset.sourceLayerId,
        variantId: item.dataset.variantId,
        variantName: item.dataset.variantName || "Layer image"
      };
      state.folderDrag = payload;
      item.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", JSON.stringify(payload));
      }
    });

    item.addEventListener("dragend", () => {
      item.classList.remove("is-dragging");
      state.folderDrag = null;
      clearFolderDropTargets();
    });
  });

  elements.layersPanel.querySelectorAll(".folder-body[data-drop-layer-id]").forEach((folderBody) => {
    folderBody.addEventListener("dragover", (event) => {
      const payload = readVariantDragPayload(event);
      if (!payload || payload.sourceLayerId === folderBody.dataset.dropLayerId) {
        return;
      }

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      clearFolderDropTargets();
      folderBody.classList.add("is-drop-target");
    });

    folderBody.addEventListener("dragleave", (event) => {
      if (event.currentTarget.contains(event.relatedTarget)) {
        return;
      }
      folderBody.classList.remove("is-drop-target");
    });

    folderBody.addEventListener("drop", async (event) => {
      const payload = readVariantDragPayload(event);
      clearFolderDropTargets();
      if (!payload || payload.sourceLayerId === folderBody.dataset.dropLayerId) {
        return;
      }

      event.preventDefault();
      await withBusy(async () => {
        const response = await api(
          `/api/projects/${state.project.id}/layers/${payload.sourceLayerId}/variants/${payload.variantId}/move`,
          {
            method: "POST",
            body: {
              targetLayerId: folderBody.dataset.dropLayerId
            }
          }
        );
        await applyProject(response.project);
        render();
        showToast(
          response.moved
            ? `Moved ${payload.variantName || "layer image"} to ${response.targetLayer?.name || "layer"}.`
            : `${payload.variantName || "Layer image"} is already in ${response.targetLayer?.name || "that folder"}.`
        );
      });
    });
  });

  elements.layersPanel.querySelectorAll("[data-action='move-layer-back'], [data-action='move-layer-forward']").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      await withBusy(async () => {
        const response = await api(`/api/projects/${state.project.id}/layers/${button.dataset.layerId}/move`, {
          method: "POST",
          body: {
            direction: button.dataset.action === "move-layer-forward" ? "forward" : "backward"
          }
        });
        await applyProject(response.project);
        render();
        showToast(
          button.dataset.action === "move-layer-forward"
            ? "Layer moved forward."
            : "Layer moved backward."
        );
      });
    });
  });

  elements.layersPanel.querySelectorAll("[data-action='rename-layer']").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const currentName = String(button.dataset.layerName || "").trim();
      const nextName = window.prompt("Rename layer folder", currentName);
      if (nextName === null) {
        return;
      }

      const trimmedName = nextName.trim();
      if (!trimmedName || trimmedName === currentName) {
        return;
      }

      await withBusy(async () => {
        const response = await api(`/api/projects/${state.project.id}/layers/${button.dataset.layerId}/rename`, {
          method: "POST",
          body: {
            name: trimmedName
          }
        });
        await applyProject(response.project);
        render();
        showToast("Layer renamed.");
      });
    });
  });

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
        await applyProject(response.project);
        render();
      });
    });
  });

  elements.layersPanel.querySelectorAll("[data-action='toggle-variant-placement-mode']").forEach((button) => {
    button.addEventListener("click", async () => {
      await withBusy(async () => {
        const response = await api(
          `/api/projects/${state.project.id}/layers/${button.dataset.layerId}/variants/${button.dataset.variantId}/placement-mode`,
          {
            method: "POST",
            body: {
              mode: button.dataset.mode || "custom"
            }
          }
        );
        await applyProject(response.project);
        render();
        showToast(
          response.mode === "custom"
            ? "Trait broke out of folder sync. Drag and scale it independently now."
            : "Trait resynced to the shared folder placement."
        );
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
        await applyProject(response.project);
        render();
        showToast("Layer image removed.");
      });
    });
  });

  elements.layersPanel.querySelectorAll("[data-action='remove-layer']").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      await withBusy(async () => {
        const response = await api(`/api/projects/${state.project.id}/layers/${button.dataset.layerId}`, {
          method: "DELETE"
        });
        await applyProject(response.project);
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
        await applyProject(response.project);
        render();
        showToast(`Draft added to ${response.layer?.name || "layer"}.`);
      });
    });
  });

  elements.chatLog.querySelectorAll("[data-action='retry-prompt']").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!state.lastFailedPrompt) return;
      const prompt = state.lastFailedPrompt;
      state.lastFailedPrompt = null;
      elements.promptInput.value = prompt;
      await submitPrompt({ preservePrompt: true });
    });
  });
}

function bindProjectShelfActions() {
  elements.projectList.querySelectorAll(".project-card[data-action='open-project']").forEach((card) => {
    card.addEventListener("click", async (e) => {
      if (e.target.closest("[data-action='rename-project']") || e.target.closest("[data-action='confirm-rename']") || e.target.closest(".project-card-rename-input")) {
        return;
      }

      const projectId = card.dataset.projectId;
      if (!projectId || projectId === state.project?.id) {
        state.projectShelfVisible = false;
        render();
        return;
      }

      await openProject(projectId);
    });
  });

  elements.projectList.querySelectorAll("[data-action='rename-project']").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const projectId = button.dataset.projectId;
      const card = elements.projectList.querySelector(`[data-card-id="${projectId}"]`);
      if (!card) return;

      const titleEl = card.querySelector(".project-card-title");
      const inputEl = card.querySelector(".project-card-rename-input");
      if (!titleEl || !inputEl) return;

      titleEl.classList.add("hidden");
      inputEl.classList.remove("hidden");
      inputEl.focus();
      inputEl.select();

      button.textContent = "Save Name";
      button.dataset.action = "confirm-rename";
    });
  });

  elements.projectList.querySelectorAll("[data-action='confirm-rename']").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const projectId = button.dataset.projectId;
      const card = elements.projectList.querySelector(`[data-card-id="${projectId}"]`);
      const inputEl = card?.querySelector(".project-card-rename-input");
      if (inputEl) finishProjectRename(projectId, inputEl.value);
    });
  });

  elements.projectList.querySelectorAll(".project-card-rename-input").forEach((inputEl) => {
    inputEl.addEventListener("click", (e) => e.stopPropagation());

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finishProjectRename(inputEl.dataset.projectId, inputEl.value);
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        render();
      }
    });

    inputEl.addEventListener("blur", () => {
      setTimeout(() => {
        const card = inputEl.closest(".project-card");
        if (card && card.querySelector("[data-action='confirm-rename']")) {
          finishProjectRename(inputEl.dataset.projectId, inputEl.value);
        }
      }, 150);
    });
  });
}

async function finishProjectRename(projectId, rawTitle) {
  const newTitle = normalizeProjectTitle(rawTitle);
  if (!newTitle || !projectId) return;

  await withBusy(async () => {
    await api(`/api/projects/${projectId}`, {
      method: "PUT",
      body: { title: newTitle }
    });

    const entry = state.projects.find((p) => p.id === projectId);
    if (entry) entry.title = newTitle;

    if (state.project?.id === projectId) {
      state.project.title = newTitle;
      state.projectNameDraft = newTitle;
    }

    render();
    showToast("Project renamed.");
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

function getSelectedLayerEntries() {
  return (state.project?.layers || [])
    .map((layer, layerIndex) => {
      if (state.hiddenLayers.has(layer.id)) return null;
      const variant = layer.variants.find((item) => item.id === layer.selectedVariantId);
      const usesCustomTransform = isVariantUsingCustomTransform(variant);
      return variant
        ? {
            ...variant,
            layerId: layer.id,
            layerName: layer.name,
            layerIndex,
            isBaseLayer: isPrimaryBaseLayerName(layer.name),
            usesCustomTransform,
            transformScope: usesCustomTransform ? "variant" : "layer",
            transform: getVariantPlacementTransform(layer, variant),
            analysis: variant.analysis || null
          }
        : null;
    })
    .filter(Boolean);
}

function buildPreviewStackSources(selectedEntries) {
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

  for (const entry of selectedEntries) {
    pushSource({
      imageUrl: entry.imageUrl,
      name: entry.name,
      createdAt: entry.createdAt,
      id: entry.id,
      className: "stack-layer"
    });
  }

  return items;
}

function renderStageLayerStack(selectedEntries) {
  if (!state.dragMode || !selectedEntries.length) {
    elements.stageLayerStack.className = "stage-layer-stack hidden";
    elements.stageLayerStack.innerHTML = "";
    return;
  }

  const orderedEntries = [...selectedEntries].sort((left, right) => left.layerIndex - right.layerIndex);
  elements.stageLayerStack.className = `stage-layer-stack is-active${state.busy ? " is-disabled" : ""}`;
  elements.stageLayerStack.innerHTML = orderedEntries
    .map((entry) => {
      const transform = getEntryDisplayTransform(entry);
      const layout = computeStageLayerLayout(entry, transform);
      const active = state.dragState?.layerId === entry.layerId && state.dragState?.variantId === entry.id;
      const selected = state.dragSelection?.layerId === entry.layerId && state.dragSelection?.variantId === entry.id;
      return `
        <div
          class="stage-drag-layer ${active ? "is-active" : ""} ${selected ? "is-selected" : ""}"
          data-layer-id="${entry.layerId}"
          data-variant-id="${entry.id}"
          style="left:${formatPercent(layout.leftPercent)}%;top:${formatPercent(layout.topPercent)}%;width:${formatPercent(layout.widthPercent)}%;height:${formatPercent(layout.heightPercent)}%;z-index:${entry.layerIndex + 1};"
        >
          <img
            class="stage-drag-image"
            src="${buildAssetUrl(entry.imageUrl, entry.createdAt || entry.id || state.project?.updatedAt || "drag")}"
            alt="${escapeHtml(entry.name || entry.layerName)}"
            draggable="false"
          />
          <div
            class="stage-drag-hitbox"
            data-drag-layer-id="${entry.layerId}"
            data-variant-id="${entry.id}"
            title="Drag ${escapeHtml(entry.layerName)}"
            style="left:${formatPercent(layout.hitLeftPercent)}%;top:${formatPercent(layout.hitTopPercent)}%;width:${formatPercent(layout.hitWidthPercent)}%;height:${formatPercent(layout.hitHeightPercent)}%;"
          >
            <span class="stage-drag-label">${escapeHtml(entry.layerName)}</span>
          </div>
        </div>
      `;
    })
    .join("");
}

function computeStageLayerLayout(entry, transformOverride = null) {
  const canvas = readCanvasFromState();
  const transform = normalizeClientTransform(transformOverride || entry.transform);
  const canvasWidth = Math.max(1, Number(canvas?.width || 1024));
  const canvasHeight = Math.max(1, Number(canvas?.height || 1024));
  const imageWidth = Math.max(1, Number(entry.analysis?.width || canvasWidth));
  const imageHeight = Math.max(1, Number(entry.analysis?.height || canvasHeight));
  const scaledWidth = imageWidth * transform.scale;
  const scaledHeight = imageHeight * transform.scale;
  const left = (canvasWidth - scaledWidth) / 2 + transform.x * canvasWidth;
  const top = (canvasHeight - scaledHeight) / 2 + transform.y * canvasHeight;
  const bounds = entry.analysis?.bounds || {
    left: 0,
    top: 0,
    right: imageWidth - 1,
    bottom: imageHeight - 1
  };
  const hitWidth = Math.max(1, Number(bounds.right) - Number(bounds.left) + 1);
  const hitHeight = Math.max(1, Number(bounds.bottom) - Number(bounds.top) + 1);

  return {
    leftPercent: (left / canvasWidth) * 100,
    topPercent: (top / canvasHeight) * 100,
    widthPercent: (scaledWidth / canvasWidth) * 100,
    heightPercent: (scaledHeight / canvasHeight) * 100,
    hitLeftPercent: (Number(bounds.left) / imageWidth) * 100,
    hitTopPercent: (Number(bounds.top) / imageHeight) * 100,
    hitWidthPercent: (hitWidth / imageWidth) * 100,
    hitHeightPercent: (hitHeight / imageHeight) * 100
  };
}

function normalizeClientTransform(transform) {
  return {
    x: clampClientNumber(transform?.x, 0, -0.45, 0.45),
    y: clampClientNumber(transform?.y, 0, -0.45, 0.45),
    scale: clampClientNumber(transform?.scale, 1, 0.15, 1.8),
    depthMode: String(transform?.depthMode || "").toLowerCase() === "headwear_wrap" ? "headwear_wrap" : "flat",
    backCutoff: clampClientNumber(transform?.backCutoff, 0.6, 0.2, 0.9),
    frontStart: clampClientNumber(transform?.frontStart, 0.56, 0.1, 0.95)
  };
}

function normalizeVariantTransformMode(mode) {
  return String(mode || "").toLowerCase() === "custom" ? "custom" : "sync";
}

function isVariantUsingCustomTransform(variant) {
  return normalizeVariantTransformMode(variant?.transformMode) === "custom";
}

function getVariantPlacementTransform(layer, variant = null) {
  return normalizeClientTransform(
    isVariantUsingCustomTransform(variant) ? variant?.transform || layer?.transform : layer?.transform || variant?.transform
  );
}

function clampClientNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Number(numeric.toFixed(3))));
}

function formatPercent(value) {
  return Number(value || 0).toFixed(4);
}

function createDragTransformKey(layerIdOrEntry, variantId = "", scope = "layer") {
  if (layerIdOrEntry && typeof layerIdOrEntry === "object") {
    const entry = layerIdOrEntry;
    return entry.transformScope === "variant"
      ? `variant:${String(entry.layerId || "").trim()}:${String(entry.id || "").trim()}`
      : `layer:${String(entry.layerId || "").trim()}`;
  }

  const normalizedLayerId = String(layerIdOrEntry || "").trim();
  return scope === "variant"
    ? `variant:${normalizedLayerId}:${String(variantId || "").trim()}`
    : `layer:${normalizedLayerId}`;
}

function getPendingDragRecord(layerIdOrEntry, variantId = "", scope = "layer") {
  return state.pendingDragTransforms[createDragTransformKey(layerIdOrEntry, variantId, scope)] || null;
}

function getPendingDragTransform(layerIdOrEntry, variantId = "", scope = "layer") {
  return getPendingDragRecord(layerIdOrEntry, variantId, scope)?.transform || null;
}

function hasPendingDragTransforms() {
  return Object.keys(state.pendingDragTransforms).length > 0;
}

function getEntryDisplayTransform(entry) {
  if (!entry) {
    return normalizeClientTransform({});
  }

  if (state.dragState?.layerId === entry.layerId && state.dragState?.variantId === entry.id) {
    return normalizeClientTransform(state.dragState.transform);
  }

  return normalizeClientTransform(getPendingDragTransform(entry) || entry.transform);
}

function syncDragSelection(selectedEntries) {
  if (!state.dragMode || !selectedEntries.length) {
    state.dragSelection = null;
    return;
  }

  const currentSelection = state.dragSelection
    ? selectedEntries.find(
        (entry) =>
          entry.layerId === state.dragSelection.layerId &&
          entry.id === state.dragSelection.variantId
      ) || null
    : null;

  if (currentSelection) {
    return;
  }

  const frontmostEntry = [...selectedEntries].sort((left, right) => right.layerIndex - left.layerIndex)[0] || null;
  state.dragSelection = frontmostEntry
    ? {
        layerId: frontmostEntry.layerId,
        variantId: frontmostEntry.id
      }
    : null;
}

function getActiveDragEntry(selectedEntries = getSelectedLayerEntries()) {
  if (!state.dragSelection) {
    return null;
  }

  return (
    selectedEntries.find(
      (entry) =>
        entry.layerId === state.dragSelection.layerId &&
        entry.id === state.dragSelection.variantId
    ) || null
  );
}

function getStageEntryByIds(layerId, variantId) {
  return getSelectedLayerEntries().find(
    (entry) => entry.layerId === layerId && entry.id === variantId
  ) || null;
}

function handleStageLayerPointerDown(event) {
  if (!state.dragMode || state.busy) {
    return;
  }

  const handle = event.target.closest("[data-drag-layer-id]");
  if (!handle) {
    return;
  }

  const layerId = String(handle.dataset.dragLayerId || "").trim();
  const variantId = String(handle.dataset.variantId || "").trim();
  const entry = getStageEntryByIds(layerId, variantId);
  if (!entry) {
    return;
  }

  event.preventDefault();
  state.dragSelection = {
    layerId,
    variantId
  };
  const captureTarget = handle;
  if (typeof captureTarget.setPointerCapture === "function") {
    try {
      captureTarget.setPointerCapture(event.pointerId);
    } catch {
      // Ignore pointer capture issues on older browsers.
    }
  }

  state.dragState = {
    pointerId: event.pointerId,
    layerId,
    variantId,
    entry,
    captureTarget,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startTransform: normalizeClientTransform(getPendingDragTransform(entry) || entry.transform),
    transform: normalizeClientTransform(getPendingDragTransform(entry) || entry.transform),
    moved: false,
    saving: false
  };

  renderStageLayerStack(getSelectedLayerEntries());
}

function handleStageLayerPointerMove(event) {
  if (!state.dragState || state.dragState.saving || event.pointerId !== state.dragState.pointerId) {
    return;
  }

  event.preventDefault();
  const stageRect = elements.stage.getBoundingClientRect();
  const deltaX = (event.clientX - state.dragState.startClientX) / Math.max(1, stageRect.width);
  const deltaY = (event.clientY - state.dragState.startClientY) / Math.max(1, stageRect.height);
  const nextTransform = normalizeClientTransform({
    ...state.dragState.startTransform,
    x: state.dragState.startTransform.x + deltaX,
    y: state.dragState.startTransform.y + deltaY
  });

  state.dragState.transform = nextTransform;
  state.dragState.moved = state.dragState.moved || Math.abs(deltaX) > 0.002 || Math.abs(deltaY) > 0.002;

  const layerElement = elements.stageLayerStack.querySelector(
    `[data-layer-id="${state.dragState.layerId}"][data-variant-id="${state.dragState.variantId}"]`
  );
  if (layerElement) {
    const layout = computeStageLayerLayout(state.dragState.entry, nextTransform);
    layerElement.style.left = `${formatPercent(layout.leftPercent)}%`;
    layerElement.style.top = `${formatPercent(layout.topPercent)}%`;
    layerElement.style.width = `${formatPercent(layout.widthPercent)}%`;
    layerElement.style.height = `${formatPercent(layout.heightPercent)}%`;
  }
}

function handleStageLayerPointerUp(event) {
  if (!state.dragState || state.dragState.saving || event.pointerId !== state.dragState.pointerId) {
    return;
  }

  const dragState = state.dragState;
  if (typeof dragState.captureTarget?.releasePointerCapture === "function") {
    try {
      dragState.captureTarget.releasePointerCapture(dragState.pointerId);
    } catch {
      // Ignore pointer release issues on older browsers.
    }
  }

  if (!dragState.moved) {
    cancelStageDrag();
    render();
    return;
  }

  stageDraggedLayerTransform(dragState);
}

function cancelStageDrag() {
  if (typeof state.dragState?.captureTarget?.releasePointerCapture === "function") {
    try {
      state.dragState.captureTarget.releasePointerCapture(state.dragState.pointerId);
    } catch {
      // Ignore pointer release issues on older browsers.
    }
  }
  state.dragState = null;
}

function stageDraggedLayerTransform(dragState) {
  const key = createDragTransformKey(dragState.entry);
  state.pendingDragTransforms[key] = {
    layerId: dragState.layerId,
    variantId: dragState.variantId,
    scope: dragState.entry.transformScope || "layer",
    transform: normalizeClientTransform(dragState.transform)
  };
  state.dragSelection = {
    layerId: dragState.layerId,
    variantId: dragState.variantId
  };
  state.dragState = null;
  render();
  showToast(
    dragState.entry.transformScope === "variant"
      ? `Custom move staged for ${dragState.entry.name || dragState.entry.layerName}. Click Save Drag.`
      : `Move staged for ${dragState.entry.layerName}. Click Save Drag.`
  );
}

function adjustSelectedLayerScale(delta) {
  if (!state.dragMode || state.busy) {
    return;
  }

  const selectedEntries = getSelectedLayerEntries();
  syncDragSelection(selectedEntries);
  const activeEntry = getActiveDragEntry(selectedEntries);
  if (!activeEntry) {
    showToast("Select a layer on the canvas first.", true);
    return;
  }

  const currentTransform = getEntryDisplayTransform(activeEntry);
  const nextTransform = normalizeClientTransform({
    ...currentTransform,
    scale: currentTransform.scale + delta
  });

  const key = createDragTransformKey(activeEntry);
  state.pendingDragTransforms[key] = {
    layerId: activeEntry.layerId,
    variantId: activeEntry.id,
    scope: activeEntry.transformScope || "layer",
    transform: nextTransform
  };
  state.dragSelection = {
    layerId: activeEntry.layerId,
    variantId: activeEntry.id
  };
  render();
}

function handleDragModeKeyDown(event) {
  if (!state.dragMode || state.busy) {
    return;
  }

  if (isTypingTarget(event.target)) {
    return;
  }

  const key = String(event.key || "");
  const isArrowKey =
    key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight";
  if (!isArrowKey) {
    return;
  }

  const stepPixels = event.shiftKey ? 10 : 2;
  const canvas = readCanvasFromState();
  const stepX = stepPixels / Math.max(1, Number(canvas?.width || 1024));
  const stepY = stepPixels / Math.max(1, Number(canvas?.height || 1024));

  let deltaX = 0;
  let deltaY = 0;
  if (key === "ArrowLeft") {
    deltaX = -stepX;
  } else if (key === "ArrowRight") {
    deltaX = stepX;
  } else if (key === "ArrowUp") {
    deltaY = -stepY;
  } else if (key === "ArrowDown") {
    deltaY = stepY;
  }

  const moved = nudgeSelectedLayer(deltaX, deltaY);
  if (!moved) {
    return;
  }

  event.preventDefault();
}

function nudgeSelectedLayer(deltaX, deltaY) {
  const selectedEntries = getSelectedLayerEntries();
  syncDragSelection(selectedEntries);
  const activeEntry = getActiveDragEntry(selectedEntries);
  if (!activeEntry) {
    return false;
  }

  const currentTransform = getEntryDisplayTransform(activeEntry);
  const nextTransform = normalizeClientTransform({
    ...currentTransform,
    x: currentTransform.x + deltaX,
    y: currentTransform.y + deltaY
  });

  const key = createDragTransformKey(activeEntry);
  state.pendingDragTransforms[key] = {
    layerId: activeEntry.layerId,
    variantId: activeEntry.id,
    scope: activeEntry.transformScope || "layer",
    transform: nextTransform
  };
  state.dragSelection = {
    layerId: activeEntry.layerId,
    variantId: activeEntry.id
  };
  render();
  return true;
}

async function savePendingDragTransforms() {
  const pendingItems = Object.values(state.pendingDragTransforms || {});
  if (!state.project?.id) {
    showToast("Generate something first.", true);
    return;
  }

  if (!pendingItems.length) {
    showToast("Drag a layer first.", true);
    return;
  }

  let latestProject = state.project;
  let savedCount = 0;
  let completed = false;

  await withBusy(async () => {
    for (const item of pendingItems) {
      const response = await api(`/api/projects/${state.project.id}/layers/${item.layerId}/transform`, {
        method: "POST",
        body: {
          variantId: item.variantId,
          scope: item.scope || "layer",
          transform: item.transform
        }
      });
      latestProject = response.project;
      savedCount += 1;
    }

    await applyProject(latestProject);
    render();
    completed = true;
  });

  if (completed && savedCount) {
    showToast(savedCount === 1 ? "Layer move saved." : `${savedCount} layer moves saved.`);
  }
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

function extractImageFilesFromClipboard(clipboardData) {
  if (!clipboardData) {
    return [];
  }

  const items = Array.from(clipboardData.items || []);
  const files = items
    .filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);

  if (files.length) {
    return files;
  }

  return Array.from(clipboardData.files || []).filter((file) =>
    String(file?.type || "").startsWith("image/")
  );
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

async function applyProject(project) {
  state.project = project;
  state.projectNameDraft = project?.title || "";
  state.fitDebugData = null;
  state.dragState = null;
  state.dragSelection = null;
  state.pendingDragTransforms = {};
  state.folderDrag = null;
  upsertProjectSummary(project);
  storeActiveProjectId(project?.id || "");
  hydrateCanvasFromProject();
  if (state.fitDebugVisible && state.project?.id) {
    await loadFitDebug();
  }
}

async function loadFitDebug() {
  if (!state.project?.id) {
    state.fitDebugData = null;
    return;
  }

  state.fitDebugLoading = true;
  renderFitDebug();
  try {
    const response = await api(`/api/projects/${state.project.id}/fit-debug`);
    state.fitDebugData = response;
  } catch (error) {
    state.fitDebugData = null;
    showToast(error.message || "Could not load fit debug.", true);
  } finally {
    state.fitDebugLoading = false;
    renderFitDebug();
  }
}

function syncBusyState() {
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = state.busy;
  });
  elements.loadingRail.classList.toggle("is-active", state.busy);
  elements.stageLayerStack.classList.toggle("is-disabled", state.busy);
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

function normalizeProjectTitle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || "Untitled NFT Collection";
}

function buildNewProjectTitle() {
  const untitledCount = state.projects.filter((project) =>
    /^Untitled NFT Collection(?: \d+)?$/i.test(String(project.title || "").trim())
  ).length;
  return untitledCount ? `Untitled NFT Collection ${untitledCount + 1}` : "Untitled NFT Collection";
}

function summarizeProjectClient(project) {
  return {
    id: project.id,
    title: project.title,
    layerCount: Array.isArray(project.layers) ? project.layers.length : 0,
    updatedAt: project.updatedAt,
    createdAt: project.createdAt
  };
}

function upsertProjectSummary(project) {
  if (!project?.id) {
    return;
  }

  const summary = summarizeProjectClient(project);
  const existingIndex = state.projects.findIndex((item) => item.id === summary.id);
  if (existingIndex >= 0) {
    state.projects.splice(existingIndex, 1, summary);
  } else {
    state.projects.unshift(summary);
  }
  state.projects.sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
}

function getStoredActiveProjectId() {
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storeActiveProjectId(projectId) {
  try {
    if (projectId) {
      window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, String(projectId));
    } else {
      window.localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
    }
  } catch {
    // Ignore storage issues in private or restricted browsers.
  }
}

function clearStoredActiveProjectId() {
  storeActiveProjectId("");
}

function formatProjectTimestamp(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) {
    return "recently";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatChatTimestamp(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function showChatLoading(promptText) {
  const el = document.getElementById("chatLoadingIndicator");
  if (el) el.remove();
  elements.chatLog.insertAdjacentHTML("beforeend", `
    <article id="chatLoadingIndicator" class="chat-entry chat-entry-loading">
      <div class="chat-role">Draw-Tech</div>
      <div class="chat-text chat-loading-text">
        <span class="chat-loading-dots"></span> Working on it...
      </div>
    </article>
  `);
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
}

function hideChatLoading() {
  const el = document.getElementById("chatLoadingIndicator");
  if (el) el.remove();
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.className = "toast";
  if (isError) {
    elements.toast.style.borderColor = "rgba(255,120,120,0.4)";
    const dismiss = document.createElement("button");
    dismiss.className = "toast-dismiss";
    dismiss.textContent = "\u00d7";
    dismiss.onclick = () => { elements.toast.className = "toast hidden"; };
    elements.toast.appendChild(dismiss);
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      elements.toast.className = "toast hidden";
    }, 10000);
  } else {
    elements.toast.style.borderColor = "rgba(15,123,108,0.45)";
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      elements.toast.className = "toast hidden";
    }, 3000);
  }
}

function getAspectRatio(canvas) {
  return `${Number(canvas?.width || 1024)} / ${Number(canvas?.height || 1024)}`;
}

function formatCanvas(canvas) {
  return `${Number(canvas?.width || 1024)} x ${Number(canvas?.height || 1024)}`;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "draw-tech";
}

function summarizeDisplayText(value, maxLength = 140) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function resolveGeneratedTargetLayerName(image) {
  if (!image) {
    return "";
  }

  const explicit = String(image.targetLayerName || "").trim();
  const combined = [image.name, image.notes, image.prompt].filter(Boolean).join(" ").toLowerCase();
  if (isTrueBackgroundPromptText(combined)) {
    return "Background";
  }
  if (explicit.toLowerCase() === "true background") {
    return "Background";
  }
  if (explicit) {
    return explicit;
  }
  if (isBackgroundAccentPromptText(combined)) {
    return "Background Accent";
  }
  return "";
}

function isBackgroundAccentPromptText(value) {
  const lowered = String(value || "").toLowerCase();
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

function isTrueBackgroundPromptText(value) {
  const lowered = String(value || "").toLowerCase();
  if (!/\bbackground\b|\bbg\b|\bbackdrop\b|\bscene\b/.test(lowered)) {
    return false;
  }

  if (isBackgroundAccentPromptText(lowered)) {
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

function buildAssetUrl(url, cacheKey = "") {
  const cleanUrl = String(url || "").trim();
  if (!cleanUrl) {
    return "";
  }

  const separator = cleanUrl.includes("?") ? "&" : "?";
  return `${cleanUrl}${separator}v=${encodeURIComponent(String(cacheKey || "static"))}`;
}

function isTypingTarget(target) {
  if (!target || !(target instanceof Element)) {
    return false;
  }

  const tagName = String(target.tagName || "").toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
  );
}

function syncPreviewStatus() {
  const hasPreview = buildPreviewStackSources(getSelectedLayerEntries()).length > 0;
  const hasInteractivePreview = state.dragMode && getSelectedLayerEntries().length > 0;
  let message = "No preview yet";
  let showStatus = false;

  if (!hasPreview) {
    showStatus = true;
  } else if (hasInteractivePreview) {
    showStatus = false;
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

function isPrimaryBaseLayerName(layerName) {
  return /(base|body|character|avatar)/.test(String(layerName || "").toLowerCase());
}

