// Global guard for the macOS WKWebView function-key tofu leak.
//
// When the user presses an arrow / page-up / home / end key at a textarea
// boundary (cursor at index 0 pressing ←, or cursor at end pressing →),
// AppKit's NSEvent characters carry the key as a Unicode private-use
// codepoint in the U+F700-F74F band — see NSFunctionKey in AppKit.
// WebKit *should* consume these in `keydown` to move the cursor, but at
// the boundary the cursor cannot move; the codepoint then falls through
// to the default `insertText:` AppKit selector and lands in the input
// value as a tofu glyph (no font carries U+F700-F74F).
//
// We use **two layers** because empirically `beforeinput` is not always
// fired for this leak path on Tauri's WKWebView (the codepoint can
// reach the value via the AppKit selector route that bypasses
// WebCore's edit-command pipeline). Belt-and-suspenders:
//
//   1. **`beforeinput` capture-phase preventDefault** — when WebKit
//      *does* route the leak through the standard edit pipeline, we
//      cancel the insertion at source. DOM is never mutated, no
//      `input` event fires, React is never disturbed.
//
//   2. **`input` capture-phase native-setter strip** — fallback for
//      paths that bypass `beforeinput`. We rewrite the DOM value via
//      the **native** prototype setter (NOT via `el.value = ...`,
//      which would go through React's intercepted setter and update
//      its valueTracker, suppressing the legitimate `onChange`). The
//      tracker stays at its pre-leak value, so React's bubble-phase
//      listener correctly fires `onChange` with the cleaned string
//      when there's a real diff, and stays silent when the leak was
//      the only mutation (state was already clean — no work to do).
//
// IME composition (`insertCompositionText`), paste (`insertFromPaste`),
// drag-drop, and other inputTypes are skipped — empirically no leak,
// and intercepting them risks breaking real input. The fallback
// strip-on-input also runs for any input event, but the F700-F74F
// presence check fast-paths in microseconds for clean text and is the
// only thing that actually triggers a write.
//
// Tauri's WKWebView on macOS exposes the bug; WebView2 (Win) and
// webkit2gtk (Linux) don't, so the codepoint check fast-paths out on
// every keystroke outside macOS — effectively a no-op.

let installed = false;

// Capture the original prototype setters once, before React has had any
// chance to patch them. We reach for these in `flushDom` to write back
// the cleaned value WITHOUT going through React's valueTracker — that
// is what preserves the legitimate `onChange` for mixed-content cases.
// (Note: React patches the *instance* value setter on each tracked
// element, layered on top of the prototype setter. Calling the
// prototype setter directly bypasses the patch.)
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
)?.set;
const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  'value',
)?.set;

export function installMacFunctionKeyGuard(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('beforeinput', onBeforeInput, { capture: true });
  document.addEventListener('input', onInput, { capture: true });
  // Diagnostic — appears once at startup, in the Tauri DevTools console.
  // If you don't see this line in DevTools, the renderer bundle wasn't
  // rebuilt and the running app is still on stale JS.
  console.info('[macFunctionKeyGuard] installed (beforeinput + input capture)');
}

function onBeforeInput(e: Event): void {
  const ie = e as InputEvent;
  // `insertReplacementText` is included for defense-in-depth — spell-
  // correct accept and autocomplete commit route through it, and the
  // F700-F74F gate is the only thing that pulls the trigger.
  if (ie.inputType !== 'insertText' && ie.inputType !== 'insertReplacementText') {
    return;
  }
  const data = ie.data;
  if (!data) return;
  if (containsLeakedFunctionKey(data)) {
    e.preventDefault();
    console.warn('[macFunctionKeyGuard] beforeinput blocked leak', {
      inputType: ie.inputType,
      codepoints: [...data].map(c => c.codePointAt(0)?.toString(16)),
    });
  }
}

function onInput(e: Event): void {
  const target = e.target;
  if (target instanceof HTMLTextAreaElement) {
    flushIfLeaked(target, nativeTextareaValueSetter);
    return;
  }
  if (target instanceof HTMLInputElement) {
    // Only text-shaped inputs hold a string value of interest. Leak
    // codepoints can't sneak into checkbox / file / range / color etc.
    if (!isTextInputType(target.type)) return;
    flushIfLeaked(target, nativeInputValueSetter);
  }
}

function flushIfLeaked(
  el: HTMLInputElement | HTMLTextAreaElement,
  setter: ((this: HTMLInputElement | HTMLTextAreaElement, v: string) => void) | undefined,
): void {
  const dirty = el.value;
  if (!containsLeakedFunctionKey(dirty)) return;

  const clean = stripLeakedFunctionKeys(dirty);
  console.warn('[macFunctionKeyGuard] input fallback stripped leak', {
    removed: dirty.length - clean.length,
    codepoints: [...dirty]
      .map(c => c.codePointAt(0) ?? 0)
      .filter(cp => cp >= 0xf700 && cp <= 0xf74f)
      .map(cp => cp.toString(16)),
  });

  // Save selection BEFORE writing — writing the value collapses the
  // selection on most engines.
  const start = el.selectionStart;
  const end = el.selectionEnd;

  if (setter) {
    setter.call(el, clean);
  } else {
    // Defensive fallback: if for any reason the prototype descriptor
    // wasn't readable, fall back to the regular setter. React's
    // valueTracker may then suppress the next onChange for mixed
    // content — strictly better than leaving the leak in the DOM.
    el.value = clean;
  }

  if (start !== null && end !== null) {
    const ns = clampSelection(start, dirty, clean);
    const ne = clampSelection(end, dirty, clean);
    el.setSelectionRange(ns, ne);
  }
}

function clampSelection(pos: number, dirty: string, clean: string): number {
  // How many leak chars sat at-or-before `pos` in the dirty string?
  // Subtract that count to map the caret to the clean-string position.
  let removed = 0;
  const limit = Math.min(pos, dirty.length);
  for (let i = 0; i < limit; i++) {
    const cp = dirty.charCodeAt(i);
    if (cp >= 0xf700 && cp <= 0xf74f) removed++;
  }
  const next = pos - removed;
  return Math.max(0, Math.min(next, clean.length));
}

function containsLeakedFunctionKey(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp >= 0xf700 && cp <= 0xf74f) return true;
  }
  return false;
}

function stripLeakedFunctionKeys(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp >= 0xf700 && cp <= 0xf74f) continue;
    out += s[i];
  }
  return out;
}

const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
]);

function isTextInputType(t: string): boolean {
  return TEXT_INPUT_TYPES.has(t.toLowerCase());
}
