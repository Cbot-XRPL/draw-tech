# Draw-Tech — NFT Layer Builder

## What This Project Is

A prompt-driven NFT layer builder. Users describe what they want, an AI routes the intent, generates/edits images via DALL-E, and organizes them into stackable transparent layers for NFT collections. Express backend, vanilla JS frontend, no build step.

## Quick Start

```bash
npm run dev          # Start dev server (nodemon, port 3000)
npm start            # Production start
```

Requires `OPENAI_API_KEY` in `.env` (or pasted into the session key input at runtime).

## Architecture At A Glance

```
public/              # Frontend — single-page vanilla JS app
  index.html         # UI shell
  app.js             # State machine, rendering, event handling (~2200 lines)
  styles.css         # All styles

src/
  server.js          # Express app — every API route lives here (~5900 lines)
  lib/
    project-service.js      # Project CRUD, normalization, merge, sync
    openai-service.js       # AI routing, plan generation, image generation
    studio-memory-service.js # Per-project memory (style rules, decisions, changelog)
    studio-brain-service.js  # Cross-project learning (quality rules, lessons)
    asset-tool-service.js    # PNG inspection (alpha, bounds, duplicates)
    utils.js                 # IDs, slugs, clamping, JSON parsing, env loading
  config/
    creative-tool-manifest.json  # Fit profiles, capabilities, tool metadata

data/                # All persisted state (gitignored)
  projects/          # {projectId}.json — full project documents
  memory/            # {projectId}.json — per-project style memory
  brain/             # studio-brain.json — cross-project lessons (single file)
  generated/         # {projectId}/preview/ and layers/{layerId}/{variantId}.png
  uploads/           # Temporary reference images + metadata JSON
```

## Key Concepts

- **Project** — A collection with title, canvas size, layers, chat history, preview history, and style metadata. Stored as one JSON file per project.
- **Layer** — A named folder (e.g. "Background", "Headwear") containing variants. Has a transform, optional fitContract, and selectedVariantId.
- **Variant** — A single generated PNG within a layer. All trait variants are transparent; backgrounds are opaque.
- **Fit Profile** — Positioning template from `creative-tool-manifest.json` (headwear, eyewear, mouth, neckwear, outfit, handheld, surface-overlay, background-accent, background). Auto-detected from layer name keywords.
- **Studio Memory** — Per-project working memory: style rules, locked decisions, changelog. Keeps AI consistent within a project.
- **Studio Brain** — Cross-project intelligence: quality rules, drawing lessons, session notes. Carries learnings forward.

## Data Flow

1. User types a prompt in the frontend
2. `POST /api/chat` sends prompt + project + attachments to server
3. `openaiService.routeUserPrompt()` classifies intent → action type
4. Server executes action (generate, edit, transform, remove, commit, preview, feedback, noop)
5. Project + memory updated on disk
6. Response returned → frontend updates state → re-renders

### Action Types (from routeUserPrompt)
| Action | Meaning |
|--------|---------|
| `draft_variant` | Generate new isolated asset for review |
| `edit_layer_variant` | Revise existing asset (preserve source, change one thing) |
| `transform_layer_variant` | Reposition/refit without redrawing |
| `preview` | Full collection scene or direction change |
| `feedback` | Store preference for future generations |
| `commit_draft` | Approve recent draft into a layer |
| `remove_layer` / `remove_variant` | Delete |
| `noop` | Conversational reply, no generation |

## API Endpoints

### Projects
- `GET /api/projects` — List all (sorted by updatedAt)
- `POST /api/projects` — Create new
- `GET /api/projects/:id` — Load single (returns project + memory)
- `PUT /api/projects/:id` — Merge updates (title, canvas, etc.)

### Chat & Generation
- `POST /api/chat` — Main prompt handler (routes through AI)
- `POST /api/projects/:id/preview` — Generate full collection preview
- `POST /api/projects/:id/layers/:layerId/variants` — Generate N variants (1-8)

### Layers
- `POST /api/projects/:id/layers` — Create empty layer
- `POST /api/projects/:id/layers/:layerId/rename` — Rename layer
- `DELETE /api/projects/:id/layers/:layerId` — Delete layer
- `POST /api/projects/:id/layers/:layerId/select` — Toggle variant selection
- `POST /api/projects/:id/layers/:layerId/transform` — Update position/scale
- `POST /api/projects/:id/layers/:layerId/move` — Reorder in stack

### Memory & Brain
- `GET /api/projects/:id/memory` — Get project memory
- `PUT /api/projects/:id/memory` — Update memory fields
- `POST /api/projects/:id/memory/changelog` — Append log entry
- `POST /api/projects/:id/memory/approve` — Lock a design decision
- `POST /api/projects/:id/memory/refresh` — AI-refresh memory

### Other
- `GET /api/config` — Env key presence + default project
- `POST /api/session` — Save runtime API key
- `POST /api/uploads` — Upload reference images (max 6, 12MB each)
- `GET /api/projects/:id/export/hashlips` — Download ZIP for HashLips
- `GET /api/projects/:id/preview/render` — Server-side composite PNG
- `GET /api/projects/:id/fit-debug` — Layer fit contract debug data
- `DELETE /api/projects/:id/layers/:layerId/variants/:variantId` — Delete variant

## Conventions

### IDs
All IDs use `createId(prefix)` → `{prefix}-{base36(Date.now())}-{random5}`.
Prefixes: `project`, `layer`, `variant`, `upload`, `preview`, `user`, `draw-tech`, `decision`, `log`, `session`, `lesson`.

### Text Handling
- `cleanText()` for user input (trim)
- `cleanSlug()` for machine-safe slugs (lowercase, alphanumeric + hyphens)
- `slugify()` for human-readable slugs (max 40 chars)
- `sanitizeFileName()` for filesystem-safe names

### Canvas Sizes
Supported generation sizes: `1024x1024`, `1024x1536`, `1536x1024`. Canvas inputs accept 256–4096px and map to nearest supported size for generation.

### Limits
- Chat history: last 24 messages per project
- Memory changelog: last 30 entries
- Memory locked decisions: last 20
- Brain session notes: last 60
- Brain recent projects: last 16
- Brain drawing lessons: max 40
- Brain quality rules: max 18
- Memory style rules: max 12

## Frontend Patterns

- **State-driven rendering**: Global `state` object → `render()` dispatches to sub-renderers (renderProjectShelf, renderPreview, renderChat, renderLayers, etc.)
- **No framework**: All DOM manipulation is direct. Event listeners bound after render via `bind*Actions()` functions.
- **Drag mode**: Layer repositioning via pointer events on the preview stage. Pending transforms saved in `state.pendingDragTransforms`, committed on explicit save.
- **localStorage**: `draw-tech-active-project-id` persists last active project across reloads.

## Working In This Codebase

- **Adding a new endpoint**: Add route in `src/server.js`, follow existing pattern (try/catch, service call, project/memory update, response).
- **Changing AI behavior**: Edit prompts in `src/lib/openai-service.js`. The system messages are long and detailed — read them fully before modifying.
- **Adding a fit profile**: Add entry in `creative-tool-manifest.json` with keywords, anchor region, clip strategy, and default transform.
- **Modifying project schema**: Update `normalizeProjectInput()` and `mergeProject()` in `project-service.js`. Both must handle the new field.
- **Frontend features**: Add state field → update in handler → render in appropriate `render*()` function → bind events in `bind*Actions()`.

## Things To Watch Out For

- `server.js` is large (~5900 lines). The main chat handler (`POST /api/chat`) is the most complex section — it branches on action type with significant logic per branch.
- `openai-service.js` contains long system prompts embedded as template strings. Changes to these affect all AI behavior.
- The brain and memory services auto-create default data on first access — don't assume files exist in `data/`.
- Generated images are stored on disk, not in the project JSON. The project stores `imageUrl` paths pointing to `data/generated/`.
- Transforms use normalized ratios (not pixel values) on the frontend drag system.
- The `mergeProject()` function is the only safe way to update a project — it handles normalization and timestamp updates.
