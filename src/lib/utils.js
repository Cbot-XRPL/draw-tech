export function cleanText(value) {
  return String(value || "").trim();
}

export function cleanSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function slugify(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function createId(prefix) {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${stamp}-${random}`;
}

export function clampVariantCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 4;
  }
  return Math.min(8, Math.max(1, Math.round(numeric)));
}

export function clampInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(numeric)));
}

export function supportedGenerationSizeForCanvas(width, height) {
  const ratio = width / height;
  const portraitDelta = Math.abs(ratio - 2 / 3);
  const squareDelta = Math.abs(ratio - 1);
  const landscapeDelta = Math.abs(ratio - 3 / 2);

  if (portraitDelta <= squareDelta && portraitDelta <= landscapeDelta) {
    return "1024x1536";
  }

  if (landscapeDelta <= squareDelta && landscapeDelta <= portraitDelta) {
    return "1536x1024";
  }

  return "1024x1024";
}

export function getAspectRatioLabel(width, height) {
  const size = supportedGenerationSizeForCanvas(width, height);
  if (size === "1024x1536") {
    return "portrait";
  }

  if (size === "1536x1024") {
    return "landscape";
  }

  return "square";
}

export function sanitizeFileName(value, fallback = "item") {
  const cleaned = cleanText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || fallback;
}

export function safeJsonParse(text) {
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

export function loadEnvFile(envPath, readFileSync) {
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      value = value.replace(/^["']|["']$/g, "");

      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Optional env file.
  }
}
