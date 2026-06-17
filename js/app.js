/*
 * app.js — wire the textarea to the KeyMagic engine.
 *
 * Strategy: the <textarea> is the visible surface; the engine holds the
 * authoritative "context buffer". On each keystroke we:
 *   1. preventDefault so the browser doesn't insert its own char,
 *   2. feed the key to the engine,
 *   3. re-render the textarea from engine.getContext().
 *
 * We treat the whole textarea as the engine context. Cursor movement and
 * mid-string edits are supported only at the end (matching how IMEs work).
 */
(function () {
  'use strict';

  const SHIFT_MASK = 1, CTRL_MASK = 2, ALT_MASK = 4;

  const typed = document.getElementById('typed');
  const scriptEl = document.getElementById('script');
  const errorsEl = document.getElementById('errors');
  const kbBadge = document.getElementById('kb-badge');
  const ruleCount = document.getElementById('rule-count');
  const stContext = document.getElementById('st-context');
  const stSwitches = document.getElementById('st-switches');
  const stHistory = document.getElementById('st-history');

  const engine = new KeyMagicEngine();
  let lastParsed = null;

  // ---- load & apply script ----
  function applyScript(src) {
    const text = src != null ? src : scriptEl.value;
    let parsed;
    try {
      parsed = KmsParser.parseScript(text);
    } catch (e) {
      showError('Parse crashed: ' + e.message);
      return;
    }
    if (parsed.errors.length) {
      showError(parsed.errors.join('\n'));
    } else {
      hideError();
    }
    engine.loadKeyboard(parsed);
    lastParsed = parsed;

    // badges / status
    const name = parsed.infos && parsed.infos.name;
    kbBadge.textContent = name ? name : `${parsed.rules.length} rules`;
    kbBadge.className = 'badge ok';
    ruleCount.textContent = `${parsed.rules.length} rules`;

    // reset the typing area so stale context from a previous keyboard doesn't
    // produce weird matches against the new rules.
    engine.reset();
    typed.value = '';
    render();
  }

  function showError(msg) {
    errorsEl.textContent = msg;
    errorsEl.classList.add('show');
  }
  function hideError() {
    errorsEl.classList.remove('show');
    errorsEl.textContent = '';
  }

  // ---- render engine state into the UI ----
  function render() {
    const ctx = engine.getContext();
    typed.value = ctx;
    // move caret to end so typing continues from where the user expects
    typed.selectionStart = typed.selectionEnd = ctx.length;

    stContext.textContent = JSON.stringify(ctx);
    const sw = engine.switch;
    const swKeys = Object.keys(sw);
    stSwitches.textContent = swKeys.length
      ? swKeys.map(k => k + ':' + (sw[k] ? 'on' : 'off')).join(' ')
      : '—';
    stHistory.textContent = engine.contextHistory.length;
  }

  // Delete a code-point range [from, to) from the engine context and resync.
  // Used when the user has a selection and presses Backspace/Delete or types
  // over it. Indices are measured in UTF-16 code units as exposed by the
  // textarea's selectionStart/End, which is what we store in the context too.
  function deleteSelection(from, to) {
    const ctx = engine.getContext();
    if (from < 0) from = 0;
    if (to > ctx.length) to = ctx.length;
    if (from >= to) return;
    engine.setContext(ctx.slice(0, from) + ctx.slice(to));
    // A bulk edit invalidates the smart-backspace history (it tracks a linear
    // typing sequence), so drop it to avoid wrong undo jumps.
    engine.contextHistory.length = 0;
    render();
  }

  // ---- keystroke handling ----
  // We handle printable chars, Backspace, Enter, Space, and numpad keys.
  // Ctrl/Cmd combos (copy/paste/save) are left to the browser.
  typed.addEventListener('keydown', function (e) {
    // Allow browser shortcuts through.
    if (e.ctrlKey || e.metaKey) return;

    // A non-empty selection changes how Backspace/Delete/typing behave: the
    // whole selected range is removed rather than a single trailing char.
    const selStart = typed.selectionStart;
    const selEnd = typed.selectionEnd;
    const hasSelection = selStart !== selEnd;

    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      if (hasSelection) {
        // Delete the highlighted range in either direction.
        deleteSelection(selStart, selEnd);
      } else if (e.key === 'Backspace') {
        const res = engine.processBackspace(0);
        if (res.handled) render();
      } else {
        // Forward Delete with no selection: drop the char after the caret.
        // We only support caret-at-end (IME-style), so this is equivalent to
        // a no-op there; mid-string, remove the next code unit.
        const ctx = engine.getContext();
        if (selStart < ctx.length) {
          engine.setContext(ctx.slice(0, selStart) + ctx.slice(selStart + 1));
          engine.contextHistory.length = 0;
          render();
        }
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (hasSelection) deleteSelection(selStart, selEnd);
      feedChar('\n');
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (hasSelection) deleteSelection(selStart, selEnd);
      feedChar('\t');
      return;
    }

    if (e.key === ' ') {
      // Space is a vkey in many layouts (<VK_SPACE> => ' '). Route it so
      // vkey rules can match; fall back to a literal space if unhandled.
      e.preventDefault();
      if (hasSelection) deleteSelection(selStart, selEnd);
      const res = engine.processVKey(0x20, 0);
      if (!res.handled) { engine.setContext(engine.getContext() + ' '); }
      render();
      return;
    }

    // Physical keys that layouts may map via vkey rules (e.g. MyanSan's
    // <VK_QUESTION> => ။ and <VK_SHIFT & VK_QUESTION> => ၊). The browser
    // reports these via e.code; we translate to the OEM vkey code and forward
    // the shift state so <VK_SHIFT & ...> combos match.
    //
    // IMPORTANT: many of these keys are ALSO mapped by string rules (e.g.
    // MyanSan's ';' => း via $aftereK). So we try the vkey route first, and if
    // no vkey rule matches, fall back to the char route (processChar) rather
    // than emitting the literal key — that way ';' goes through the string
    // rules and produces း, while '/' (which has a vkey rule) uses the vkey.
    const CODE_TO_VKEY = {
      Slash: 0xBF,        // VK_OEM_2 = VK_QUESTION  -> / and ?
      Minus: 0xBD,        // VK_OEM_MINUS            -> - and _
      Equal: 0xBB,        // VK_OEM_PLUS             -> = and +
      BracketLeft: 0xDB,  // VK_OEM_4                -> [ and {
      BracketRight: 0xDD, // VK_OEM_6                -> ] and }
      Backslash: 0xDC,    // VK_OEM_5                -> \ and |
      Semicolon: 0xBA,    // VK_OEM_1                -> ; and :
      Quote: 0xDE,        // VK_OEM_7                -> ' and "
      Backquote: 0xC0,    // VK_OEM_3 = VK_CFLEX     -> ` and ~
      Comma: 0xBC,        // VK_OEM_COMMA            -> , and <
      Period: 0xBE,       // VK_OEM_PERIOD           -> . and >
    };
    if (e.code && CODE_TO_VKEY.hasOwnProperty(e.code) && e.key.length === 1) {
      e.preventDefault();
      if (hasSelection) deleteSelection(selStart, selEnd);
      const vk = CODE_TO_VKEY[e.code];
      const mods = e.shiftKey ? 1 /* SHIFT_MASK */ : 0;
      const res = engine.processVKey(vk, mods);
      if (!res.handled) {
        // No vkey rule matched — route the printable char through the string
        // rules instead (covers ';', ':', etc. that have string mappings).
        feedChar(e.key);
      } else {
        render();
      }
      return;
    }

    // Numpad keys route as vkeys (VK_NUMPAD0..9, VK_MULTIPLY, etc.) so that
    // layouts like MyanSan can map them distinctly from the top-row digits.
    if (e.code && e.code.startsWith('Numpad')) {
      e.preventDefault();
      if (hasSelection) deleteSelection(selStart, selEnd);
      const map = {
        Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64,
        Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
        NumpadMultiply: 0x6A, NumpadAdd: 0x6B, NumpadSubtract: 0x6D,
        NumpadDecimal: 0x6E, NumpadDivide: 0x6F,
      };
      const vk = map[e.code];
      if (vk !== undefined) {
        const res = engine.processVKey(vk, 0);
        if (!res.handled && e.key.length === 1) {
          engine.setContext(engine.getContext() + e.key);
        }
        render();
      }
      return;
    }

    // Arrow keys / navigation: allow default but resync afterwards.
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
      // no-op; let the browser move the caret. We won't fight it.
      return;
    }

    // Printable single char (length 1). Note e.key for dead keys can be longer;
    // we ignore those.
    if (e.key.length === 1) {
      e.preventDefault();
      // Typing over a selection replaces it, like a normal text field.
      if (hasSelection) deleteSelection(selStart, selEnd);
      feedChar(e.key);
    }
  });

  function feedChar(ch) {
    // Only feed printable characters; ignore the dead-key surrogate stuff.
    const code = ch.codePointAt(0);
    if (code < 0x20 && ch !== '\n' && ch !== '\t' && ch !== '\b') return;

    let mods = 0;
    // we don't pass shift (it's already reflected in the char's case), but we
    // could pass it for VK_SHIFT rules. For now keep it simple.
    const res = engine.processChar(ch, mods);
    if (res.handled) {
      render();
    } else {
      // not handled by engine -> let it fall through as a normal char so the
      // textarea still works for space/punctuation that has no rule.
      // We mirror the engine's "passthrough" append so context stays in sync.
      engine.setContext(engine.getContext() + ch);
      render();
    }
  }

  // If the user pastes or otherwise edits directly, resync the engine to the
  // raw textarea contents (treat it as a fresh context).
  let pasteTimer = null;
  typed.addEventListener('input', function (e) {
    // skip the input event we generate ourselves in render() — there's no
    // perfect signal, so we debounce and reconcile.
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(function () {
      const v = typed.value;
      if (v !== engine.getContext()) {
        engine.setContext(v);
        render();
      }
    }, 30);
  });

  // ---- buttons ----
  document.getElementById('btn-apply').addEventListener('click', function () {
    applyScript();
  });
  document.getElementById('btn-default').addEventListener('click', function () {
    scriptEl.disabled = true;
    scriptEl.value = 'Loading MyanSan.kms...';
    window.loadDefaultKms().then(function (kms) {
      scriptEl.value = kms;
      scriptEl.disabled = false;
      applyScript();
      typed.focus();
    });
  });
  document.getElementById('btn-reset').addEventListener('click', function () {
    engine.reset();
    typed.value = '';
    render();
  });
  document.getElementById('btn-clear').addEventListener('click', function () {
    engine.reset();
    typed.value = '';
    render();
  });
  document.getElementById('btn-sample').addEventListener('click', function () {
    // Type a short Myanmar phrase demo: " Mingalarbar" greeting keys.
    // q w e r t map to ဆ တ န မ အ in MyanSan; this just shows it working.
    engine.reset();
    const seq = 'rwfm';
    let i = 0;
    const t = setInterval(function () {
      if (i >= seq.length) { clearInterval(t); return; }
      feedChar(seq[i]);
      i++;
    }, 180);
  });

  // ---- boot ----
  // Load the real MyanSan.kms (async fetch), falling back to a tiny demo
  // script if the fetch fails (e.g. when opened via file://).
  scriptEl.value = 'Loading MyanSan.kms...';
  scriptEl.disabled = true;
  window.loadDefaultKms().then(function (kms) {
    scriptEl.value = kms;
    scriptEl.disabled = false;
    applyScript();
    typed.focus();
  });
})();
