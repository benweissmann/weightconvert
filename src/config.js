// Base URL for data files (ingredients.json, units.json, aliases.json).
// Set VITE_DATA_BASE_URL in .env.production.local to point at S3.
// Leave empty to serve from same origin (Vite dev server or dist/data/).
export const DATA_BASE_URL = (import.meta.env.VITE_DATA_BASE_URL ?? '').replace(/\/$/, '')

export async function fetchData() {
  const [ingredients, units, aliases] = await Promise.all([
    fetch(`${DATA_BASE_URL}/data/ingredients.json`).then(r => r.json()),
    fetch(`${DATA_BASE_URL}/data/units.json`).then(r => r.json()),
    fetch(`${DATA_BASE_URL}/data/aliases.json`).then(r => r.json()),
  ])
  return { ingredients, units, aliases }
}
