# Draw Tech

Draw Tech is a local NFT layer builder with a simple Express backend and a browser UI.

## Workflow

1. Enter a collection brief and your layer list.
2. Generate a first test NFT to establish the style direction.
3. Approve the theme and expand one layer at a time into more variants.
4. Swap generated layer variants in a live stack preview.

## What this version includes

- Local project storage in `data/projects`
- Generated PNG storage in `data/generated`
- UI or `.env` based OpenAI API key entry
- Exact width and height canvas control
- Persistent per-project Studio Brain memory and changelog
- Hidden cross-project Studio Brain that carries lessons between sessions
- A local creative tool manifest so planning knows about the image pipeline and quality checks
- A broad collection preview generator
- Transparent PNG variant generation for individual layers
- Live layer stacking in the frontend
- One-click HashLips-friendly layer export zip

## Setup

1. Copy `.env.example` to `.env`
2. Add `OPENAI_API_KEY`
3. Run `npm install`
4. Run `npm run dev` for auto-restart while building, or `npm start` for a normal run
5. Open `http://localhost:3000`

On startup the console prints:

- `http://localhost:3000`
- your local network URL if one is available, such as `http://192.168.x.x:3000`

## Notes

- The backend uses `gpt-5.4` for planning and Studio Brain memory refreshes, and `gpt-image-1.5` for image generation.
- Layer generation is prompt-shaped to produce stack-friendly transparent assets, then resized to your chosen final canvas dimensions.
- The backend now keeps a shared lesson bank in `data/brain` and quietly learns from previews and layer generations across projects.
- Local image tooling includes `sharp`, `jimp`, `pngjs`, `pixelmatch`, and `image-size`, with a tracked manifest in `src/config/creative-tool-manifest.json`.
- The HashLips export includes numbered layer folders, a starter `hashlips.config.json`, and a manifest with prompt metadata.
