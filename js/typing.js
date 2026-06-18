/*
 * typing.js — logic for typing.html
 *
 * - Loads one of three KMS keyboards (MyanSan / PangLong / PaOh), cached.
 * - A toggle flag (kmEnabled) gates whether keystrokes go through the engine.
 *   Default OFF. Ctrl+Shift flips it.
 * - When ON, the textarea mirrors the engine context (same proven routing as
 *   app.js: printable -> processChar, Backspace -> processBackspace, Space /
 *   numpad / OEM keys -> vkey routes with shift detection, selection-aware).
 * - An on-screen QWERTY grid is built by probing each physical key through the
 *   engine. Clicking a key types it (base glyph).
 */
(function () {
  'use strict';

  const SHIFT_MASK = 1;

  // ---- DOM ----
  const typed = document.getElementById('typed');
  const kbSelect = document.getElementById('kb-select');
  const toggle = document.getElementById('status-toggle');
  const toggleLabel = toggle.querySelector('.toggle-label');
  const keyboardEl = document.getElementById('keyboard');
  const btnClear = document.getElementById('btn-clear');

  // ---- state ----
  let kmEnabled = false;          // input-method toggle
  const engines = {};             // fileName -> { engine, parsed, name }
  let currentFile = 'keyboards/MyanSan.kms';
  let currentName = '';
  // layer state for the on-screen keyboard (mirrors physical Shift/CapsLock)
  let shiftHeld = false;
  let capsLock = false;
  // cached probe results: entry.code -> { base, shift }, rebuilt per keyboard
  const layoutCache = {};

  // The US QWERTY layout we render. Each entry: {code, label, base, shift}
  // where base/shift are the chars to probe (for letters) or null (for keys
  // that probe via vkey). `w` is an optional width class.
  const ROWS = [
    [
      { code: 'Backquote', label: '`', base: '`', shift: '~' },
      { code: 'Digit1', label: '1', base: '1', shift: '!' },
      { code: 'Digit2', label: '2', base: '2', shift: '@' },
      { code: 'Digit3', label: '3', base: '3', shift: '#' },
      { code: 'Digit4', label: '4', base: '4', shift: '$' },
      { code: 'Digit5', label: '5', base: '5', shift: '%' },
      { code: 'Digit6', label: '6', base: '6', shift: '^' },
      { code: 'Digit7', label: '7', base: '7', shift: '&' },
      { code: 'Digit8', label: '8', base: '8', shift: '*' },
      { code: 'Digit9', label: '9', base: '9', shift: '(' },
      { code: 'Digit0', label: '0', base: '0', shift: ')' },
      { code: 'Minus', label: '-', base: '-', shift: '_' },
      { code: 'Equal', label: '=', base: '=', shift: '+' },
      { code: 'Backspace', label: '⌫', type: 'action', w: 'wide-2' },
    ],
    [
      { code: 'KeyQ', label: 'q', base: 'q', shift: 'Q' },
      { code: 'KeyW', label: 'w', base: 'w', shift: 'W' },
      { code: 'KeyE', label: 'e', base: 'e', shift: 'E' },
      { code: 'KeyR', label: 'r', base: 'r', shift: 'R' },
      { code: 'KeyT', label: 't', base: 't', shift: 'T' },
      { code: 'KeyY', label: 'y', base: 'y', shift: 'Y' },
      { code: 'KeyU', label: 'u', base: 'u', shift: 'U' },
      { code: 'KeyI', label: 'i', base: 'i', shift: 'I' },
      { code: 'KeyO', label: 'o', base: 'o', shift: 'O' },
      { code: 'KeyP', label: 'p', base: 'p', shift: 'P' },
      { code: 'BracketLeft', label: '[', base: '[', shift: '{' },
      { code: 'BracketRight', label: ']', base: ']', shift: '}' },
      { code: 'Backslash', label: '\\', base: '\\', shift: '|' },
    ],
    [
      { code: 'KeyA', label: 'a', base: 'a', shift: 'A' },
      { code: 'KeyS', label: 's', base: 's', shift: 'S' },
      { code: 'KeyD', label: 'd', base: 'd', shift: 'D' },
      { code: 'KeyF', label: 'f', base: 'f', shift: 'F' },
      { code: 'KeyG', label: 'g', base: 'g', shift: 'G' },
      { code: 'KeyH', label: 'h', base: 'h', shift: 'H' },
      { code: 'KeyJ', label: 'j', base: 'j', shift: 'J' },
      { code: 'KeyK', label: 'k', base: 'k', shift: 'K' },
      { code: 'KeyL', label: 'l', base: 'l', shift: 'L' },
      { code: 'Semicolon', label: ';', base: ';', shift: ':' },
      { code: 'Quote', label: "'", base: "'", shift: '"' },
      { code: 'Enter', label: 'Enter ↵', type: 'action', w: 'wide-2' },
    ],
    [
      { code: 'ShiftLeft', label: '⇧ Shift', type: 'action', w: 'wide-3' },
      { code: 'KeyZ', label: 'z', base: 'z', shift: 'Z' },
      { code: 'KeyX', label: 'x', base: 'x', shift: 'X' },
      { code: 'KeyC', label: 'c', base: 'c', shift: 'C' },
      { code: 'KeyV', label: 'v', base: 'v', shift: 'V' },
      { code: 'KeyB', label: 'b', base: 'b', shift: 'B' },
      { code: 'KeyN', label: 'n', base: 'n', shift: 'N' },
      { code: 'KeyM', label: 'm', base: 'm', shift: 'M' },
      { code: 'Comma', label: ',', base: ',', shift: '<' },
      { code: 'Period', label: '.', base: '.', shift: '>' },
      { code: 'Slash', label: '/', base: '/', shift: '?' },
    ],
    [
      { code: 'Space', label: 'space', base: ' ', shift: ' ', w: 'wide-6' },
    ],
  ];

  // e.code -> vkey code. Covers OEM keys AND letter/digit keys, because some
  // keyboards (e.g. PangLong) map letters ONLY via <VK_KEY_*> rules, not via
  // string rules. We always try the vkey route first, then fall back to the
  // char route — this works for both PangLong (vkey-only) and MyanSan
  // (mostly string rules with a few vkey rules like VK_QUESTION).
  const CODE_TO_VKEY = {
    // OEM / punctuation
    Slash: 0xBF, Minus: 0xBD, Equal: 0xBB, BracketLeft: 0xDB,
    BracketRight: 0xDD, Backslash: 0xDC, Semicolon: 0xBA, Quote: 0xDE,
    Backquote: 0xC0, Comma: 0xBC, Period: 0xBE, Space: 0x20,
    // letters (VK_KEY_A..Z = 0x41..0x5A)
    KeyA: 0x41, KeyB: 0x42, KeyC: 0x43, KeyD: 0x44, KeyE: 0x45, KeyF: 0x46,
    KeyG: 0x47, KeyH: 0x48, KeyI: 0x49, KeyJ: 0x4A, KeyK: 0x4B, KeyL: 0x4C,
    KeyM: 0x4D, KeyN: 0x4E, KeyO: 0x4F, KeyP: 0x50, KeyQ: 0x51, KeyR: 0x52,
    KeyS: 0x53, KeyT: 0x54, KeyU: 0x55, KeyV: 0x56, KeyW: 0x57, KeyX: 0x58,
    KeyY: 0x59, KeyZ: 0x5A,
    // digits (VK_KEY_0..9 = 0x30..0x39)
    Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34,
    Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,
  };
  // (CODE_TO_VKLETTER removed — folded into CODE_TO_VKEY above.)

  // =====================================================================
  // Keyboard loading (cached)
  // =====================================================================
  async function loadKeyboard(file) {
    currentFile = file;
    if (engines[file]) {
      const e = engines[file];
      currentName = e.name;
      renderKeyboard();
      return;
    }
    try {
      const r = await fetch(file);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const src = await r.text();
      const parsed = KmsParser.parseScript(src);
      const engine = new KeyMagicEngine();
      engine.loadKeyboard(parsed);
      const name = parsed.infos.name || file.replace(/^.*\//, '').replace(/\.kms$/i, '');
      engines[file] = { engine, parsed, name };
      currentName = name;
    } catch (e) {
      console.error('Failed to load', file, e);
      currentName = '(load failed)';
    }
    // when switching keyboards while ON, reset the active engine's context
    if (kmEnabled) activateEngine();
    renderKeyboard();
    updateBadge();
  }

  // The currently-active engine instance (or null).
  function activeEngine() {
    return engines[currentFile] ? engines[currentFile].engine : null;
  }

  // When turning ON or switching keyboards, sync the engine context to the
  // current textarea contents so typing continues naturally.
  function activateEngine() {
    const e = activeEngine();
    if (!e) return;
    e.reset();
    e.setContext(typed.value);
  }

  // =====================================================================
  // Toggle
  // =====================================================================
  function setEnabled(on) {
    kmEnabled = on;
    if (on) {
      activateEngine();
      keyboardEl.classList.remove('dim');
    } else {
      keyboardEl.classList.add('dim');
    }
    updateBadge();
    typed.focus();
  }
  function updateBadge() {
    const label = currentName || '';
    if (kmEnabled) {
      toggle.classList.remove('off');
      toggle.classList.add('on');
      toggle.setAttribute('aria-checked', 'true');
      toggleLabel.textContent = 'ON' + (label ? ' · ' + label : '');
    } else {
      toggle.classList.remove('on');
      toggle.classList.add('off');
      toggle.setAttribute('aria-checked', 'false');
      toggleLabel.textContent = 'OFF' + (label ? ' · ' + label : '');
    }
  }

  // Click (or tap) the ON/OFF switch to toggle the input method — same effect
  // as Ctrl+Shift, but usable on touch devices and discoverable on screen.
  function handleToggleClick(ev) {
    ev.preventDefault();
    setEnabled(!kmEnabled);
  }
  toggle.addEventListener('click', handleToggleClick);

  // =====================================================================
  // Keystroke handling
  // =====================================================================
  // Ctrl+Shift toggle. We detect it on keydown of either modifier while the
  // other is held, debounced so one physical combo = one toggle.
  let lastToggle = 0;
  function isToggleCombo(e) {
    if (!(e.ctrlKey && e.shiftKey)) return false;
    // Only fire on the keydown of one of the two modifiers (not every repeat).
    if (e.key !== 'Control' && e.key !== 'Shift') return false;
    return true;
  }

  typed.addEventListener('keydown', function (e) {
    // 1. Ctrl+Shift toggles the input method (works in both ON and OFF).
    if (isToggleCombo(e)) {
      e.preventDefault();
      const now = Date.now();
      if (now - lastToggle < 400) return; // debounce key-repeat
      lastToggle = now;
      setEnabled(!kmEnabled);
      return;
    }

    // Track Shift / CapsLock for the on-screen keyboard layer highlight.
    // These fire regardless of the ON/OFF toggle so the layout reflects the
    // real modifier state.
    if (e.key === 'Shift') {
      if (!shiftHeld) { shiftHeld = true; renderKeyboard(); }
    } else if (e.key === 'CapsLock') {
      // CapsLock keydown fires only when turning it ON (browsers don't emit
      // keydown on the OFF press reliably). Use getModifierState for truth.
      capsLock = e.getModifierState && e.getModifierState('CapsLock');
      renderKeyboard();
    }

    // 2. When OFF, let the browser handle everything normally.
    if (!kmEnabled) return;
    if (!activeEngine()) return;

    // 3. When ON, route through the engine (same logic as app.js).
    const engine = activeEngine();
    const selStart = typed.selectionStart;
    const selEnd = typed.selectionEnd;
    const hasSelection = selStart !== selEnd;

    // allow copy/paste/etc.
    if (e.ctrlKey || e.metaKey) return;

    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      if (hasSelection) {
        deleteRange(selStart, selEnd);
      } else if (e.key === 'Backspace') {
        if (selStart > 0) {
          const out = processAtCursor((engine) => engine.processBackspace(0), true);
          if (out && out.result.handled) render(out.cursorPos);
        }
      } else if (selStart < typed.value.length) {
        // Delete: remove char at cursor (doesn't go through engine matching)
        const ctx = typed.value;
        const newCtx = ctx.slice(0, selStart) + ctx.slice(selStart + 1);
        engine.setContext(newCtx);
        engine.contextHistory.length = 0;
        render(selStart);
      }
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); if (hasSelection) deleteRange(selStart, selEnd); feedChar('\n'); return; }
    if (e.key === 'Tab')   { e.preventDefault(); if (hasSelection) deleteRange(selStart, selEnd); feedChar('\t'); return; }
    if (e.key === ' ') {
      e.preventDefault();
      if (hasSelection) deleteRange(selStart, selEnd);
      const out = processAtCursor((eng) => eng.processVKey(0x20, 0));
      if (out) {
        if (!out.result.handled) {
          // Manually insert space at cursor
          const fullText = typed.value;
          const pos = typed.selectionStart;
          const newText = fullText.slice(0, pos) + ' ' + fullText.slice(pos);
          engine.setContext(newText);
          render(pos + 1);
        } else {
          render(out.cursorPos);
        }
      }
      return;
    }
    // OEM punctuation keys: try vkey, fall back to char.
    if (e.code && CODE_TO_VKEY.hasOwnProperty(e.code) && e.key.length === 1) {
      e.preventDefault();
      if (hasSelection) deleteRange(selStart, selEnd);
      const vk = CODE_TO_VKEY[e.code];
      const mods = e.shiftKey ? SHIFT_MASK : 0;
      const out = processAtCursor((eng) => eng.processVKey(vk, mods));
      if (out) {
        if (!out.result.handled) feedChar(e.key); else render(out.cursorPos);
      }
      return;
    }
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') return;

    if (e.key.length === 1) {
      e.preventDefault();
      if (hasSelection) deleteRange(selStart, selEnd);
      feedChar(e.key);
    }
  });

  // keyup: clear the Shift highlight when released; refresh CapsLock truth.
  typed.addEventListener('keyup', function (e) {
    if (e.key === 'Shift') {
      if (shiftHeld) { shiftHeld = false; renderKeyboard(); }
    } else if (e.key === 'CapsLock') {
      capsLock = e.getModifierState ? e.getModifierState('CapsLock') : capsLock;
      renderKeyboard();
    }
  });
  // Also catch a blur (focus leaving the textarea) so Shift doesn't look stuck.
  typed.addEventListener('blur', function () {
    if (shiftHeld) { shiftHeld = false; renderKeyboard(); }
  });

  // Run an engine operation (processChar, processVKey, processBackspace) with
  // only the text before the cursor as context. This ensures typing happens
  // at the cursor position, not at the end of the text.
  function processAtCursor(operation, keepHistory = false) {
    const engine = activeEngine();
    if (!engine) return null;
    const fullText = typed.value;
    const cursorPos = typed.selectionStart;
    const beforeCursor = fullText.slice(0, cursorPos);
    const afterCursor = fullText.slice(cursorPos);
    const savedHistory = [...engine.contextHistory];
    // Set context to only the text before cursor
    engine.setContext(beforeCursor);
    engine.contextHistory = [];
    // Run the operation
    const result = operation(engine);
    // Get the processed text before cursor
    const newBefore = engine.getContext();
    // Reconstruct full text
    const newFullText = newBefore + afterCursor;
    engine.setContext(newFullText);
    // Restore or keep history
    if (keepHistory) {
      // For backspace: keep the engine's history (it tracks before-cursor states)
      const beforeHistory = engine.contextHistory;
      engine.contextHistory = beforeHistory;
    } else {
      // For other ops: restore original history
      engine.contextHistory = savedHistory;
    }
    return { result, cursorPos: newBefore.length, text: newFullText };
  }

  function feedChar(ch) {
    const engine = activeEngine();
    if (!engine) return;
    // Always insert \n and \t directly at cursor (engine with eat:true swallows them)
    if (ch === '\n' || ch === '\t') {
      const fullText = typed.value;
      const pos = typed.selectionStart;
      console.log('feedChar \\n: pos=', pos, 'fullText=', JSON.stringify(fullText));
      const newText = fullText.slice(0, pos) + ch + fullText.slice(pos);
      engine.setContext(newText);
      console.log('feedChar \\n: newText=', JSON.stringify(newText));
      render(pos + ch.length);
      return;
    }
    const out = processAtCursor(function (eng) { return eng.processChar(ch, 0); });
    if (!out) return;
    if (out.result.handled) {
      render(out.cursorPos);
    } else {
      // Manually insert char at cursor position
      const fullText = typed.value;
      const pos = typed.selectionStart;
      const newText = fullText.slice(0, pos) + ch + fullText.slice(pos);
      engine.setContext(newText);
      render(pos + ch.length);
    }
  }

  function deleteRange(from, to) {
    const engine = activeEngine();
    if (!engine) return;
    const ctx = engine.getContext();
    if (from < 0) from = 0;
    if (to > ctx.length) to = ctx.length;
    if (from >= to) return;
    engine.setContext(ctx.slice(0, from) + ctx.slice(to));
    engine.contextHistory.length = 0;
    render(from);
  }

  function render(cursorPos) {
    const engine = activeEngine();
    const ctx = engine ? engine.getContext() : typed.value;
    typed.value = ctx;
    // If cursorPos provided, use it; otherwise default to end
    const pos = (typeof cursorPos === 'number') ? cursorPos : ctx.length;
    typed.selectionStart = typed.selectionEnd = pos;
  }

  // If the user edits directly while ON (paste/cut), resync the engine.
  let syncTimer = null;
  typed.addEventListener('input', function () {
    if (!kmEnabled) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      const engine = activeEngine();
      if (engine && typed.value !== engine.getContext()) {
        engine.setContext(typed.value);
      }
    }, 30);
  });

  // =====================================================================
  // Layout probing + rendering
  // =====================================================================
  // Probe one key: what glyph does it produce (base and shift)? Returns
  // { base: string, shift: string } where '' means "unmapped / passthrough".
  function probeKey(engine, entry) {
    return { base: probeOne(engine, entry, false), shift: probeOne(engine, entry, true) };
  }
  function probeOne(engine, entry, shift) {
    engine.reset();
    let handled = false;
    // Route OEM/Space via vkey, letters/digits via char — matching how the
    // real keystroke handler dispatches. If a vkey rule exists it wins.
    if (CODE_TO_VKEY.hasOwnProperty(entry.code)) {
      const vk = CODE_TO_VKEY[entry.code];
      const res = engine.processVKey(vk, shift ? SHIFT_MASK : 0);
      handled = res.handled;
      if (!handled) {
        // fall back to char route
        const r2 = engine.processChar(shift ? entry.shift : entry.base, 0);
        handled = r2.handled;
      }
    } else {
      const ch = shift ? entry.shift : entry.base;
      const r2 = engine.processChar(ch, 0);
      handled = r2.handled;
    }
    let out = engine.getContext();
    engine.reset();
    // Treat as unmapped if: unhandled (passthrough of the literal input char),
    // empty output, or output identical to the input char.
    if (!handled) return '';
    if (!out) return '';
    const inputChar = shift ? entry.shift : entry.base;
    if (out === inputChar) return '';
    return out;
  }

  function renderKeyboard() {
    const engine = activeEngine();
    // (Re)build the probe cache when the engine changes or cache is empty.
    if (engine && (!layoutCache.file || layoutCache.file !== currentFile)) {
      buildLayoutCache(engine);
      layoutCache.file = currentFile;
    }
    // Effective shift layer: Shift OR (CapsLock on letter keys). For the
    // highlight we treat Shift-held and CapsLock the same way — both show the
    // shifted glyph prominently.
    const shiftLayer = shiftHeld ^ capsLock; // XOR = either-one for highlight

    keyboardEl.innerHTML = '';
    for (const row of ROWS) {
      const rowEl = document.createElement('div');
      rowEl.className = 'kb-row';
      for (const entry of row) {
        const isAction = entry.type === 'action';
        const key = document.createElement('button');
        key.className = 'key' + (entry.w ? ' ' + entry.w : '') + (isAction ? ' action-key' : '');
        key.type = 'button';
        // Keep focus on the textarea so physical Shift/CapsLock tracking keeps
        // working after a click. tabIndex=-1 makes the button non-focusable;
        // we refocus the textarea explicitly in typeKey() as a safety net.
        key.tabIndex = -1;

        // Highlight the Shift key when shift layer is active
        if (entry.code === 'ShiftLeft' && shiftLayer) {
          key.classList.add('shift-active');
        }

        if (isAction) {
          // Action keys: show only the label text (no glyphs, no US label)
          const baseEl = document.createElement('span');
          baseEl.className = 'base-glyph';
          baseEl.textContent = entry.label;
          key.appendChild(baseEl);
        } else {
          const cached = engine ? (layoutCache[entry.code] || { base: '', shift: '' }) : { base: '', shift: '' };
          const baseGlyph = cached.base;
          const shiftGlyph = cached.shift;

          // shift glyph (top-right) — highlighted when shift layer active
          const shiftEl = document.createElement('span');
          shiftEl.className = 'shift-glyph' + (shiftLayer ? ' active' : '');
          shiftEl.textContent = shiftGlyph || '';
          key.appendChild(shiftEl);

          // base glyph (center) — dimmed when shift layer active
          const baseEl = document.createElement('span');
          baseEl.className = 'base-glyph';
          if (shiftLayer) baseEl.classList.add('faded');
          else if (!baseGlyph) baseEl.classList.add('dim');
          if (entry.code === 'Space') {
            baseEl.textContent = 'space';
          } else {
            baseEl.textContent = baseGlyph || '·';
          }
          key.appendChild(baseEl);

          // tiny US label (bottom-left) for orientation
          if (entry.code !== 'Space') {
            const lab = document.createElement('span');
            lab.className = 'us-label';
            lab.textContent = entry.label;
            key.appendChild(lab);
          }
        }

        // Block mousedown so the button never steals focus from the textarea;
        // this keeps physical Shift/CapsLock tracking alive during clicks.
        if (entry.code === 'Backspace') {
          // Auto-repeat on long-press for Backspace
          let repeatTimer = null;
          let repeatInterval = null;
          const startRepeat = function () {
            typeKey(entry, false);
            repeatTimer = setTimeout(function () {
              repeatInterval = setInterval(function () { typeKey(entry, false); }, 50);
            }, 400);
          };
          const stopRepeat = function () {
            clearTimeout(repeatTimer); clearInterval(repeatInterval);
            repeatTimer = null; repeatInterval = null;
          };
          key.addEventListener('mousedown', function (ev) {
            ev.preventDefault();
            startRepeat();
          });
          key.addEventListener('mouseup', stopRepeat);
          key.addEventListener('mouseleave', stopRepeat);
          key.addEventListener('touchstart', function (ev) {
            ev.preventDefault(); startRepeat();
          });
          key.addEventListener('touchend', stopRepeat);
          key.addEventListener('touchcancel', stopRepeat);
        } else {
          key.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
          // Use pointerdown for action keys (Shift/Enter) for immediate response
          if (isAction) {
            key.addEventListener('pointerdown', function (ev) {
              ev.preventDefault();
              typeKey(entry, !!ev.shiftKey);
            });
            key.addEventListener('touchstart', function (ev) {
              ev.preventDefault();
              typeKey(entry, false);
            });
          } else {
            key.addEventListener('click', function (ev) {
              typeKey(entry, !!ev.shiftKey);
            });
            // right-click always forces shifted glyph
            key.addEventListener('contextmenu', function (e) {
              e.preventDefault();
              typeKey(entry, true);
            });
          }
        }

        rowEl.appendChild(key);
      }
      keyboardEl.appendChild(rowEl);
    }
    keyboardEl.classList.toggle('dim', !kmEnabled);
  }

  // Build (or rebuild) the per-key probe cache for the current engine.
  function buildLayoutCache(engine) {
    for (const row of ROWS) {
      for (const entry of row) {
        // Skip action keys (Shift/Enter/Backspace) — they don't produce glyphs
        if (entry.type === 'action') {
          layoutCache[entry.code] = { base: '', shift: '' };
          continue;
        }
        layoutCache[entry.code] = probeKey(engine, entry);
      }
    }
  }

  // Type a key from the on-screen keyboard (click).
  function typeKey(entry, shift) {
    typed.focus();

    // Handle action keys (Shift / Enter / Backspace)
    if (entry.type === 'action') {
      if (entry.code === 'ShiftLeft') {
        shiftHeld = !shiftHeld;
        renderKeyboard();
        return;
      }
      if (entry.code === 'Enter') {
        console.log('Enter clicked, kmEnabled:', kmEnabled, 'engine:', !!activeEngine(), 'selStart:', typed.selectionStart, 'value:', JSON.stringify(typed.value));
        if (!kmEnabled || !activeEngine()) {
          insertAtCaret('\n');
        } else {
          const selStart = typed.selectionStart, selEnd = typed.selectionEnd;
          if (selStart !== selEnd) deleteRange(selStart, selEnd);
          feedChar('\n');
        }
        return;
      }
      if (entry.code === 'Backspace') {
        if (!kmEnabled || !activeEngine()) {
          const s = typed.selectionStart, e = typed.selectionEnd;
          if (s !== e) {
            typed.value = typed.value.slice(0, s) + typed.value.slice(e);
            typed.selectionStart = typed.selectionEnd = s;
          } else if (s > 0) {
            const cp = [...typed.value.slice(0, s)];
            cp.pop();
            typed.value = cp.join('') + typed.value.slice(e);
            typed.selectionStart = typed.selectionEnd = cp.join('').length;
          }
        } else {
          const engine = activeEngine();
          const selStart = typed.selectionStart, selEnd = typed.selectionEnd;
          if (selStart !== selEnd) {
            deleteRange(selStart, selEnd);
          } else if (selStart > 0) {
            const out = processAtCursor(function (eng) { return eng.processBackspace(0); }, true);
            if (out && out.result.handled) render(out.cursorPos);
          }
        }
        return;
      }
      return;
    }

    // Use shifted glyph when on-screen Shift is toggled or physical Shift held
    const effectiveShift = shift || shiftHeld;

    if (!kmEnabled || !activeEngine()) {
      // OFF: append the literal char
      const ch = effectiveShift ? entry.shift : entry.base;
      if (ch && ch !== ' ') {
        insertAtCaret(ch);
      } else if (entry.code === 'Space') {
        insertAtCaret(' ');
      }
      return;
    }
    const engine = activeEngine();
    // collapse any selection first
    const selStart = typed.selectionStart, selEnd = typed.selectionEnd;
    if (selStart !== selEnd) deleteRange(selStart, selEnd);
    // route exactly like a physical keypress
    if (CODE_TO_VKEY.hasOwnProperty(entry.code)) {
      const vk = CODE_TO_VKEY[entry.code];
      const out = processAtCursor((eng) => eng.processVKey(vk, effectiveShift ? SHIFT_MASK : 0));
      if (out) {
        if (!out.result.handled) feedChar(effectiveShift ? entry.shift : entry.base); else render(out.cursorPos);
      }
    } else {
      feedChar(effectiveShift ? entry.shift : entry.base);
    }
  }

  function insertAtCaret(ch) {
    const s = typed.selectionStart, e = typed.selectionEnd;
    typed.value = typed.value.slice(0, s) + ch + typed.value.slice(e);
    typed.selectionStart = typed.selectionEnd = s + ch.length;
  }

  // =====================================================================
  // Wire up controls
  // =====================================================================
  kbSelect.addEventListener('change', function () {
    loadKeyboard(kbSelect.value);
  });
  btnClear.addEventListener('click', function () {
    typed.value = '';
    const engine = activeEngine();
    if (engine) engine.reset();
    typed.focus();
  });

  // ---- boot ----
  keyboardEl.classList.add('dim');   // start dimmed (OFF)
  loadKeyboard(kbSelect.value).then(function () {
    updateBadge();
    typed.focus();
  });
})();
