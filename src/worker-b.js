/**
 * Pipeline B Web Worker
 *
 * Hosts the web-llm runtime. The main thread sends parse requests via postMessage
 * and receives structured results back. Heavy model loading happens once; subsequent
 * calls are fast inference-only.
 *
 * Message protocol:
 *   → { type: "load" }
 *   ← { type: "load:progress", progress: 0..1, text: "..." }
 *   ← { type: "load:done" }
 *   ← { type: "load:error", error: "..." }
 *
 *   → { type: "parse", id: string, input: string }
 *   ← { type: "parse:result", id: string, ingredient: string, quantity: number, unit: string }
 *   ← { type: "parse:error", id: string, error: string }
 */

console.log('[worker-b] module top')
import * as webllm from "@mlc-ai/web-llm";
console.log('[worker-b] webllm imported')

const MLC_MODEL_ID  = "weightconvert-smollm2-135m-mlc";
// Construct absolute URL — web workers require absolute URLs for fetch.
// VITE_MODEL_BASE_URL is empty in dev (serve from same origin at /model/).
const _modelBase = (import.meta.env.VITE_MODEL_BASE_URL ?? '').replace(/\/$/, '');
// web-llm's cleanModelUrl() appends "resolve/main/" to any URL that doesn't
// already contain it (designed for HuggingFace URLs). Include it upfront so
// the URL passes through unchanged, then the Vite middleware strips it.
const MLC_MODEL_URL = (_modelBase || self.location.origin) + '/model/resolve/main/';

const SYSTEM_PROMPT =
  "You are a baking ingredient parser. " +
  "Given a raw ingredient string, output a single JSON object with three fields: " +
  '"ingredient" (the canonical King Arthur Baking ingredient name), ' +
  '"quantity" (a number), and "unit" (one of: cup, tablespoon, teaspoon, ' +
  "fluid_ounce, liter, milliliter, pint, quart, gram, kilogram, ounce, pound). " +
  "Output only the JSON object, nothing else.";

console.log('[worker-b] MLC_MODEL_URL:', MLC_MODEL_URL)

// Patch fetch BEFORE web-llm can capture it — use a Proxy on globalThis.fetch
// so all fetch calls (even those captured by web-llm at import time) go through
Object.defineProperty(globalThis, 'fetch', {
  get() { return this._fetch },
  set(fn) {
    this._fetch = async (url, opts) => {
      const res = await fn(url, opts)
      const ct = res.headers.get('content-type') ?? ''
      console.log('[fetch]', res.status, ct.slice(0,20), String(url).replace(self.location.origin,'').slice(0,80))
      return res
    }
  },
  configurable: true
})
globalThis.fetch = self.fetch  // trigger the setter with the current fetch

// Catch all uncaught errors in the worker
self.addEventListener('error', e => console.error('[worker-b] uncaught error:', e.message, e.filename, e.lineno, e.error))
self.addEventListener('unhandledrejection', e => console.error('[worker-b] unhandled rejection:', e.reason))

// Intercept TextDecoder to find which arraybuffer decoded to HTML
const _origDecode = TextDecoder.prototype.decode
TextDecoder.prototype.decode = function(data, ...args) {
  const result = _origDecode.call(this, data, ...args)
  if (result.trimStart().startsWith('<')) {
    console.error('[worker-b] TextDecoder got HTML, length:', data?.byteLength, 'preview:', result.slice(0, 100))
    console.trace()
  }
  return result
}

// Override JSON.parse to find which call gets HTML
const _origJSONParse = JSON.parse
JSON.parse = function(text, ...args) {
  if (typeof text === 'string' && text.trimStart().startsWith('<')) {
    console.error('[worker-b] JSON.parse received HTML, first 100:', text.slice(0, 100))
    console.trace('[worker-b] JSON.parse stack trace')
  }
  return _origJSONParse.call(JSON, text, ...args)
}

// Also override Response.prototype.json
const _origJson = Response.prototype.json
Response.prototype.json = async function() {
  try {
    return await _origJson.call(this)
  } catch(e) {
    console.error('[worker-b] response.json() failed url:', this.url, 'status:', this.status)
    throw e
  }
}

let engine = null;

async function loadModel() {
  // Clear web-llm's Cache API entries so stale responses (e.g. cached HTML
  // from a previous failed attempt) don't prevent loading.
  try {
    const keys = await caches.keys()
    await Promise.all(keys.filter(k => k.startsWith('webllm')).map(k => caches.delete(k)))
    console.log('[worker-b] cleared caches:', keys.filter(k => k.startsWith('webllm')))
  } catch(e) {
    console.warn('[worker-b] could not clear caches:', e)
  }

  const appConfig = {
    model_list: [
      {
        model: MLC_MODEL_URL,
        model_id: MLC_MODEL_ID,
        model_lib: webllm.modelLibURLPrefix + webllm.modelVersion + "/SmolLM2-135M-Instruct-q0f16_cs1k-webgpu.wasm",
      },
    ],
  };

  // CreateMLCEngine runs directly in this worker — no inner worker needed.
  engine = await webllm.CreateMLCEngine(MLC_MODEL_ID, {
    appConfig,
    initProgressCallback: (report) => {
      self.postMessage({ type: "load:progress", progress: report.progress, text: report.text });
    },
  });
  self.postMessage({ type: "load:done" });
}

async function parse(id, input) {
  if (!engine) throw new Error("Model not loaded — send { type: 'load' } first");

  const reply = await engine.chat.completions.create({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: input },
    ],
    max_tokens: 80,
    temperature: 0,
  });

  const text = reply.choices[0].message.content.trim();
  const jsonStr = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  const parsed = JSON.parse(jsonStr);

  // Post-process: fuzzy-resolve the model's ingredient name against the canonical list.
  // The model often outputs near-miss names ("Sticky Bun Topping" → "Sticky Bun Sugar").
  // Resolving through the same fuzzy matcher as Pipeline A keeps conversion math correct.
  const resolvedIngredient = resolveIngredient(parsed.ingredient);

  return { id, ...parsed, ingredient: resolvedIngredient ?? parsed.ingredient };
}

// Trigram fuzzy resolver — mirrors pipeline-a.js
function resolveIngredient(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();

  // Exact match
  const exact = _ingredientData?.find(i => i.name.toLowerCase() === lower);
  if (exact) return exact.name;

  // Alias
  if (_aliasData?.[lower]) return _aliasData[lower];

  // Trigram fuzzy
  const qTg = trigrams(lower);
  let best = null, bestScore = 0;
  for (const ing of (_ingredientData ?? [])) {
    const score = dice(qTg, trigrams(ing.name.toLowerCase()));
    if (score > bestScore) { bestScore = score; best = ing.name; }
  }
  return bestScore >= 0.35 ? best : null;
}

function trigrams(s) {
  const p = "  " + s + "  ";
  const tg = new Set();
  for (let i = 0; i < p.length - 2; i++) tg.add(p.slice(i, i + 3));
  return tg;
}
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0; for (const t of a) if (b.has(t)) n++;
  return 2 * n / (a.size + b.size);
}

let _ingredientData = null;
let _aliasData = null;

self.addEventListener("message", async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      if (msg.ingredients) _ingredientData = msg.ingredients;
      if (msg.aliases)     _aliasData      = msg.aliases;
      await loadModel();
    } else if (msg.type === "parse") {
      const result = await parse(msg.id, msg.input);
      self.postMessage({ type: "parse:result", ...result });
    }
  } catch (err) {
    const errType = msg.type === "load" ? "load:error" : "parse:error";
    self.postMessage({ type: errType, id: msg.id, error: String(err) });
  }
});
