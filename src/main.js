import { parse, loadData, resolveIngredient } from './pipeline-a.js'
// Note: resolveIngredient is used in showState(error) to give helpful messages
import PipelineBWorker from './worker-b.js?worker'
import { fetchData } from './config.js'

let ingredients = [], units = { lookup: {} }, aliases = {}
try {
  ;({ ingredients, units, aliases } = await fetchData())
  loadData(ingredients, units, aliases)
} catch (e) {
  console.error('Failed to load data files:', e)
}

// ─── Elements ─────────────────────────────────────────────────────────────────
const input          = document.getElementById('ingredientInput')
const micBtn         = document.getElementById('micBtn')
const stateEmpty     = document.getElementById('stateEmpty')
const stateResult    = document.getElementById('stateResult')
const stateError     = document.getElementById('stateError')
const gramNumber     = document.getElementById('gramNumber')
const ingredientEl   = document.getElementById('ingredientResolved')
const parseTokens    = document.getElementById('parseTokens')
const sourceBadge    = document.getElementById('sourceBadge')
const debugPanel     = document.getElementById('debugPanel')
const debugGrid      = document.getElementById('debugGrid')
const debugSource    = document.getElementById('debugSource')
const debugCandidates = document.getElementById('debugCandidates')
const debugSlm       = document.getElementById('debugSlm')
const slmStatus      = document.getElementById('slmStatus')

// ─── SVG icons ────────────────────────────────────────────────────────────────
const ICON_DET = `<svg width="13" height="13" viewBox="0 0 12 12" fill="none" title="Deterministic">
  <rect x=".75" y=".75" width="4.5" height="4.5" rx=".75" stroke="currentColor" stroke-width="1.2"/>
  <rect x="6.75" y=".75" width="4.5" height="4.5" rx=".75" stroke="currentColor" stroke-width="1.2"/>
  <rect x=".75" y="6.75" width="4.5" height="4.5" rx=".75" stroke="currentColor" stroke-width="1.2"/>
  <rect x="6.75" y="6.75" width="4.5" height="4.5" rx=".75" stroke="currentColor" stroke-width="1.2"/>
</svg>`
const ICON_SLM = `<svg width="13" height="13" viewBox="0 0 12 12" fill="none" title="Language Model">
  <path d="M6 .5l1.2 3.8L11 6l-3.8 1.2L6 11l-1.2-3.8L1 6l3.8-1.2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

// ─── Pipeline B state ─────────────────────────────────────────────────────────
// 'loading' | 'ready' | 'failed'
let pipelineBState  = 'loading'
let pipelineBWorker = null
let pendingBId      = null
let lastInput       = ''

const PIPELINE_B_THRESHOLD = 0.5

function setSlmStatus(state) {
  pipelineBState = state
  slmStatus.dataset.state = state
}

function startPipelineB() {
  pipelineBWorker = new PipelineBWorker()
  pipelineBWorker.onerror = (e) => {
    console.error('[main] worker error:', e.message)
    setSlmStatus('failed')
  }
  pipelineBWorker.onmessage = (e) => {
    const msg = e.data
    if (msg.type === 'load:progress') {
      slmStatus.title = `Language model: ${msg.text || 'downloading…'}`
    } else if (msg.type === 'load:done') {
      setSlmStatus('ready')
      // Re-run for current input if needed
      if (input.value.trim()) maybeRunPipelineB(input.value)
    } else if (msg.type === 'load:error') {
      setSlmStatus('failed')
      slmStatus.title = `Language model unavailable: ${msg.error}`
      console.warn('[slm] load error:', msg.error)
    } else if (msg.type === 'parse:result') {
      if (msg.id !== pendingBId) return
      handlePipelineBResult(msg)
    } else if (msg.type === 'parse:error') {
      if (msg.id !== pendingBId) return
      renderSlmSection(null, msg.error)
    }
  }
  pipelineBWorker.postMessage({ type: 'load', ingredients, aliases })
}

function maybeRunPipelineB(text) {
  if (pipelineBState !== 'ready' || !pipelineBWorker || !text.trim()) return
  const id = `${Date.now()}-${Math.random()}`
  pendingBId = id
  pipelineBWorker.postMessage({ type: 'parse', id, input: text })
  renderSlmSection('loading')
}

function handlePipelineBResult(msg) {
  const ingRow   = ingredients.find(i => i.name === msg.ingredient)
  const unitEntry = units.lookup[msg.unit]
  const qty = parseFloat(msg.quantity)
  let grams = null
  if (ingRow && unitEntry && !isNaN(qty)) {
    if (unitEntry.ml && ingRow.gPerMl) grams = Math.round(qty * unitEntry.ml * ingRow.gPerMl * 10) / 10
    else if (unitEntry.massG)           grams = Math.round(qty * unitEntry.massG * 10) / 10
  } else if (ingRow?.perItem && !isNaN(qty)) {
    grams = Math.round(qty * ingRow.gramsEach * 10) / 10
  }

  renderSlmSection(null, null, { ingredient: msg.ingredient, quantity: qty, unit: msg.unit, grams })

  // Promote SLM result to main display if deterministic was low-confidence
  const currentResult = _lastDeterministicResult
  if (currentResult && currentResult.confidence < PIPELINE_B_THRESHOLD && grams) {
    const synthetic = {
      input: input.value,
      quantity: qty, unit: msg.unit, ingredient: msg.ingredient, grams,
      confidence: 0.9,
      debug: {
        ingredientPhrase: msg.ingredient?.toLowerCase(),
        method: 'language-model',
        topCandidates: [],
        unitMl: unitEntry?.ml ?? null,
        unitMassG: unitEntry?.massG ?? null,
        sourceRow: ingRow ? { name: ingRow.name, grams: ingRow.grams, volume: ingRow.volume } : null,
      },
    }
    renderResult(synthetic, 'slm')
  }
}

// ─── Parse & render ───────────────────────────────────────────────────────────
let lastGrams = null
let _lastDeterministicResult = null

function runParse(text, speakResult = false) {
  lastInput = text
  if (!text.trim()) {
    showState('empty')
    pendingBId = null
    return
  }

  const result = parse(text)
  _lastDeterministicResult = result

  const hasResult = result.grams && result.confidence >= 0.15

  if (hasResult) {
    renderResult(result, 'det')
  } else {
    showState('error', result)
  }

  // Always update the deterministic debug section
  renderDebugDeterministic(result)
  debugPanel.hidden = false

  // Run SLM if: (a) low confidence fallback, OR (b) detail panel is already open
  if (pipelineBState === 'ready' && (result.confidence < PIPELINE_B_THRESHOLD || debugPanel.open)) {
    maybeRunPipelineB(text)
  } else if (pipelineBState !== 'ready') {
    renderSlmSection('pending')
  } else {
    renderSlmSection('idle')
  }

  if (speakResult && hasResult) speakGrams(result.grams, result.ingredient)
}

function showState(name, failedResult) {
  stateEmpty.hidden  = name !== 'empty'
  stateResult.hidden = name !== 'result'
  stateError.hidden  = name !== 'error'

  // On error, show what we did find in the error state
  if (name === 'error' && failedResult) {
    const el = stateError.querySelector('.error-message')
    const phrase = failedResult.debug?.ingredientPhrase
    const det = phrase ? resolveIngredient(phrase) : null
    if (det?.ingredient) {
      el.innerHTML = `Couldn't compute weight —<br/><em>${escHtml(det.ingredient.name)}</em> has no volume data`
    } else if (phrase) {
      el.innerHTML = `Couldn't parse <em>${escHtml(phrase)}</em>`
    } else {
      el.innerHTML = `Couldn't parse that —<br/>try <em>1 cup flour</em>`
    }
  }
}

function renderResult(result, source = 'det') {
  const newGrams = Math.round(result.grams * 10) / 10
  const display  = Number.isInteger(newGrams) ? String(newGrams) : newGrams.toFixed(1)

  if (lastGrams !== newGrams) {
    gramNumber.classList.add('flash')
    requestAnimationFrame(() => requestAnimationFrame(() => {
      gramNumber.textContent = display
      gramNumber.classList.remove('flash')
      lastGrams = newGrams
    }))
  }

  ingredientEl.textContent = result.ingredient ?? ''

  parseTokens.innerHTML = ''
  if (result.quantity !== null) appendChip(parseTokens, result.quantity, 'qty')
  if (result.unit)               appendChip(parseTokens, result.unit, 'unit')
  if (result.debug?.ingredientPhrase) appendChip(parseTokens, result.debug.ingredientPhrase, 'phrase')

  // Source icon
  if (source === 'slm') {
    sourceBadge.innerHTML = `<span class="source-slm">${ICON_SLM}</span>`
    sourceBadge.title = 'Result from Language Model'
  } else if (result.confidence < PIPELINE_B_THRESHOLD) {
    sourceBadge.innerHTML = `<span class="source-det source-low">${ICON_DET}</span>`
    sourceBadge.title = 'Deterministic — low confidence'
  } else {
    sourceBadge.innerHTML = `<span class="source-det">${ICON_DET}</span>`
    sourceBadge.title = 'Deterministic'
  }

  showState('result')
}

function appendChip(container, value, label) {
  const chip = document.createElement('span')
  chip.className = 'token-chip'
  chip.innerHTML = `<span class="token-label">${label}</span>${escHtml(String(value))}`
  container.appendChild(chip)
}

// ─── Debug panel ──────────────────────────────────────────────────────────────
function renderDebugDeterministic(result) {
  const d = result.debug ?? {}
  const rows = [
    ['confidence', (result.confidence * 100).toFixed(0) + '%'],
    ['method',     d.method ?? '—'],
  ]
  if (d.unitMl)                  rows.push(['volume', d.unitMl.toFixed(2) + ' mL'])
  if (d.unitMassG && !d.unitMl)  rows.push(['mass unit', d.unitMassG + ' g/unit'])

  debugGrid.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escHtml(v)}</dd>`).join('')

  if (d.sourceRow) {
    debugSource.innerHTML = `
      <p>King Arthur source row</p>
      <a href="https://www.kingarthurbaking.com/learn/ingredient-weight-chart" target="_blank" rel="noopener">
        ${escHtml(d.sourceRow.volume)} ${escHtml(d.sourceRow.name)} = ${escHtml(String(d.sourceRow.grams))}g
      </a>`
    debugSource.hidden = false
  } else {
    debugSource.hidden = true
  }

  const candidates = d.topCandidates ?? []
  if (candidates.length > 0) {
    debugCandidates.innerHTML = candidates.slice(0, 5).map(c => {
      const ing = ingredients.find(i => i.name === c.name)
      let gramsLabel = ''
      if (ing && result.quantity !== null) {
        let g = null
        if (d.unitMl && ing.gPerMl)        g = Math.round(result.quantity * d.unitMl * ing.gPerMl * 10) / 10
        else if (d.unitMassG)               g = Math.round(result.quantity * d.unitMassG * 10) / 10
        else if (ing.perItem && ing.gramsEach) g = Math.round(result.quantity * ing.gramsEach * 10) / 10
        if (g !== null) gramsLabel = `<span class="candidate-grams">${g}g</span>`
      }
      return `<div class="candidate-row">
        <span class="candidate-name">${gramsLabel}${escHtml(c.name)}</span>
        <div class="candidate-bar-wrap"><div class="candidate-bar" style="width:${Math.round(c.score * 100)}%"></div></div>
        <span class="candidate-score">${(c.score * 100).toFixed(0)}%</span>
      </div>`
    }).join('')
    debugCandidates.hidden = false
  } else {
    debugCandidates.hidden = true
  }
}

function renderSlmSection(loadingState, error, parsed) {
  if (loadingState === 'loading') {
    debugSlm.innerHTML = '<span class="debug-slm-loading">Asking language model…</span>'
  } else if (loadingState === 'pending') {
    debugSlm.innerHTML = '<span class="debug-slm-idle">Model downloading…</span>'
  } else if (loadingState === 'idle') {
    debugSlm.innerHTML = '<span class="debug-slm-idle">Open panel to run</span>'
  } else if (error) {
    debugSlm.innerHTML = `<span class="debug-slm-error">${escHtml(error)}</span>`
  } else if (parsed) {
    const gramsStr = parsed.grams != null ? `${parsed.grams}g` : 'no weight'
    debugSlm.innerHTML = `
      <div class="slm-result">
        <span class="slm-ingredient">${escHtml(parsed.ingredient ?? '—')}</span>
        <span class="slm-detail">${parsed.quantity ?? '?'} ${parsed.unit ?? '?'} → ${gramsStr}</span>
      </div>`
  } else {
    debugSlm.innerHTML = '<span class="debug-slm-idle">—</span>'
  }
}

// Run SLM when panel is opened
debugPanel.addEventListener('toggle', () => {
  if (debugPanel.open && input.value.trim() && pipelineBState === 'ready') {
    maybeRunPipelineB(input.value)
  }
})

// ─── Debounced input ──────────────────────────────────────────────────────────
let debounceTimer
input.addEventListener('input', () => {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => runParse(input.value, false), 150)
})

// ─── Speech recognition ───────────────────────────────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition
if (SR) {
  const recognition = new SR()
  recognition.lang = 'en-US'
  recognition.interimResults = false
  recognition.maxAlternatives = 1
  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript
    input.value = transcript
    runParse(transcript, true)
  }
  recognition.onend   = () => micBtn.classList.remove('listening')
  recognition.onerror = () => micBtn.classList.remove('listening')
  micBtn.addEventListener('click', () => {
    if (micBtn.classList.contains('listening')) {
      recognition.stop()
    } else {
      window.speechSynthesis?.cancel()
      recognition.start()
      micBtn.classList.add('listening')
    }
  })
} else {
  micBtn.hidden = true
}

// ─── Speech synthesis ─────────────────────────────────────────────────────────
function speakGrams(grams, ingredient) {
  if (!window.speechSynthesis) return
  const rounded = Math.round(grams * 10) / 10
  const text = `${rounded} grams${ingredient ? ' of ' + ingredient : ''}`
  window.speechSynthesis.cancel()
  const utt = new SpeechSynthesisUtterance(text)
  utt.rate = 0.92
  window.speechSynthesis.speak(utt)
}

// ─── Util ─────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ─── Example chips ────────────────────────────────────────────────────────────
document.querySelectorAll('.example-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    input.value = btn.dataset.value
    input.focus()
    runParse(btn.dataset.value)
  })
})

// ─── Visual viewport tracking ─────────────────────────────────────────────────
// On iOS the browser scrolls the layout viewport when the keyboard opens rather
// than resizing it, so dvh/100vh stay full height and the content slides off.
// We drive the app height from visualViewport.height instead, which DOES shrink.
function updateVvh() {
  const h = window.visualViewport?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--vvh', `${h}px`)
  // Compact padding class when keyboard is open
  const base = window._vvhBase ?? h
  document.body.classList.toggle('keyboard-open', h < base * 0.8)
}
if (window.visualViewport) {
  window._vvhBase = window.visualViewport.height
  window.visualViewport.addEventListener('resize', updateVvh)
  window.visualViewport.addEventListener('scroll', updateVvh)
}
updateVvh()

// ─── Init ─────────────────────────────────────────────────────────────────────
showState('empty')
debugPanel.hidden = true
input.focus()
startPipelineB()   // always start in background
