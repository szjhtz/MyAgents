// Global guard for the macOS WKWebView function-key tofu leak.
//
// When the user presses an arrow / page-up / home / end key at a textarea
// boundary (cursor at index 0 pressing ←, or cursor at end pressing →),
// AppKit's NSEvent characters carry the key as a Unicode private-use
// codepoint in the U+F700-F74F band — see NSFunctionKey in AppKit.
// WebKit *should* consume these in `keydown` to move the cursor, but at
// the boundary the cursor cannot move; the codepoint then falls through
// to the default `insertText` action and lands in the input value as a
// tofu glyph (no font carries U+F700-F74F).
//
// We intercept this **at the source** with a document-level capture-phase
// `beforeinput` listener: when the upcoming insertion is plain text and
// the data contains any byte in F700-F74F, we cancel the event. The DOM
// is never mutated, no `input` event fires, React is never disturbed.
//
// Why `beforeinput` and not `input` capture + strip:
//   - No `el.value` write → no React valueTracker side-effects → no risk
//     of suppressing legitimate onChange firings on mixed-content
//     insertions.
//   - No caret-restore math.
//   - No interaction with React 19's identical-value `setState` bailout
//     (the original reason the per-call-site strip helper failed).
//
// IME / paste / drag-drop are skipped via `inputType` — the leak only
// arrives via `insertText`, so other input types don't need touching.
//
// Tauri's WKWebView on macOS exposes the bug; WebView2 (Win) and
// webkit2gtk (Linux) don't, so the loop in `containsLeakedFunctionKey`
// returns false on every keystroke outside macOS — effectively a no-op.

let installed = false;

export function installMacFunctionKeyGuard(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('beforeinput', onBeforeInput, { capture: true });
}

function onBeforeInput(e: Event): void {
  const ie = e as InputEvent;
  // Only block plain text insertions. IME composition fires
  // `insertCompositionText`, paste fires `insertFromPaste`, drag-drop
  // fires `insertFromDrop`, etc. None of those carry the leak in
  // practice; touching them risks breaking real input.
  //
  // `insertReplacementText` (spell-correct accept, autocomplete commit)
  // is included for defense-in-depth — empirically the leak we
  // reproduced flows through `insertText`, but a future macOS build
  // could plausibly route a boundary-arrow leak through replacement
  // semantics, and the F700-F74F gate below is the only thing that
  // actually pulls the trigger. Cost: one extra string compare.
  if (ie.inputType !== 'insertText' && ie.inputType !== 'insertReplacementText') {
    return;
  }
  const data = ie.data;
  if (!data) return;
  if (containsLeakedFunctionKey(data)) {
    e.preventDefault();
  }
}

function containsLeakedFunctionKey(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp >= 0xf700 && cp <= 0xf74f) return true;
  }
  return false;
}
