/*
 * kms-engine.js — a KeyMagic text-transformation engine in JavaScript.
 *
 * Faithful port of the matching/replacement semantics in
 *   cross-platform/libkeymagic/KeyMagicEngine.cpp
 *
 * The engine keeps an internal "context buffer" (m_textContext) and, given a
 * keystroke, tries each rule in order. The first rule whose LHS matches the
 * tail of the context wins; its RHS is substituted for the matched tail.
 *
 * Public API:
 *   const engine = new KeyMagicEngine();
 *   engine.loadKeyboard(parsed);              // from KmsParser.parseScript
 *   const handled = engine.processChar(ch);   // ch is a single character
 *   engine.getContext();                      // current context string
 *   engine.backspace();                       // VK_BACK handling
 *   engine.reset();
 *
 * The engine works on a pure string context (no real IME/text-field wiring),
 * so the UI layer is responsible for syncing the textarea with getContext().
 */
(function (global) {
  'use strict';

  const SHIFT_MASK = 1 << 0;
  const CTRL_MASK  = 1 << 1;
  const ALT_MASK   = 1 << 2;
  const CAPS_MASK  = 1 << 3;

  // VK keycodes we care about for modifier detection (from KeyCodes.cpp).
  const VK_SHIFT    = 0x10;
  const VK_LSHIFT   = 0xA0;
  const VK_RSHIFT   = 0xA1;
  const VK_CONTROL  = 0x11;
  const VK_LCONTROL = 0xA2;
  const VK_RCONTROL = 0xA3;
  const VK_MENU     = 0x12;  // ALT
  const VK_LMENU    = 0xA4;
  const VK_RMENU    = 0xA5;  // AltGr / right Alt
  const VK_BACK     = 0x08;

  class KeyMagicEngine {
    constructor() {
      this.reset();
      this.haveKeyboard = false;
      this.rules = [];
      this.variables = {};
      this.layoutOptions = { trackCaps: true, autoBksp: false, eat: false, posBased: false, rightAlt: true };
      this.onLog = null;
    }

    loadKeyboard(parsed) {
      this.variables = parsed.variables || {};
      this.rules = (parsed.rules || []).slice();
      this.layoutOptions = parsed.layoutOptions || this.layoutOptions;
      this.infos = parsed.infos || {};
      // Apply rule precedence per KMS_FORMAT.md "Rule Precedence and Matching
      // Order":
      //   1. state-specific rules (LHS has a switch) before global rules
      //   2. virtual-key rules (LHS has a vkey) before string-pattern rules
      //   3. longer patterns before shorter ones (greedy)
      // We assign each rule a priority tuple and sort descending so the
      // highest-priority rule is tried first. The sort is stable, preserving
      // source order among equal-priority rules ("first match wins" within a
      // tier).
      this.rules.sort((a, b) => priority(b) - priority(a));
      this.haveKeyboard = true;
      this.reset();
    }

    reset() {
      this.textContext = '';
      this.switch = {};        // currently-active state ids (set of id -> true)
      this.pendingSwitch = {}; // states activated during THIS event (for next)
      this.contextHistory = [];
      this.keyStates = new Uint8Array(256);
      this.backRef = [];
      this.matchedVK = false;
      this.shouldMatchAgain = false;
    }

    // Promote pending states to active at the start of a new key event. Per
    // KMS_FORMAT.md "State Management": states active at the start of an
    // event are cleared; only states explicitly re-activated by the matched
    // rule's RHS survive into the next event.
    beginEvent() {
      this.switch = this.pendingSwitch;
      this.pendingSwitch = {};
    }

    getContext() { return this.textContext; }
    setContext(s) { this.textContext = s; }

    log(...args) { if (this.onLog) this.onLog(args.join(' ')); }

    // =====================================================================
    // processKeyEvent (the main entry from KeyMagicEngine.cpp).
    // Here we expose a simpler API: processChar(ch, modifiers).
    //
    // `ch` is a single character. For ordinary printable input we pass
    // keycode=0 so that vkey-only rules (<VK_NUMPAD5>, <VK_KEY_A>, ...) do
    // NOT match — those require an explicit vkey event via processVKey().
    // This avoids the char-code/vkey collision (e.g. 'e'=0x65 == VK_NUMPAD5).
    // =====================================================================
    processChar(ch, modifiers = 0) {
      if (!this.haveKeyboard) return { handled: false };
      this.beginEvent();
      const charCode = ch.codePointAt(0);
      const keyval = charCode;
      const keycode = 0; // printables carry no vkey; see processVKey

      const oldText = this.textContext;
      const success = this.processInput(keyval, keycode, modifiers);

      // C++ clears the switch when a char key (>= 0x20) fails to match. We
      // use keyval (the actual character) since printables carry keycode 0.
      if (!success && keyval >= 0x20) {
        this.switch = {};
      }

      // re-matching loop (m_shouldMatchAgain) — mirror the C++ loop.
      if (success) {
        let looped = 0;
        let cont = true;
        while (cont) {
          if (this.shouldMatchAgain) {
            const again = this.processInput(0, 0, 0);
            looped++;
            if (looped >= 20) { cont = false; break; }
            if (!again) {
              this.updateHistory(oldText);
              cont = false;
            }
          } else {
            this.updateHistory(oldText);
            cont = false;
          }
        }
        return { handled: true };
      }

      // not matched:
      if (modifiers & (CTRL_MASK | ALT_MASK)) return { handled: false };

      if (ch === '\b' || keycode === VK_BACK) {
        // backspace fallback
        return this.handleBackspace();
      }

      // Decide passthrough based on the actual character, not the clamped
      // keycode (high codepoints get keycode 0 but are still printable).
      // Control chars (keyval < 0x20 except newline/tab) are not appended.
      if (keyval > 0x20 || ch === '\n' || ch === '\t') {
        if (this.layoutOptions.eat) {
          return { handled: true }; // eat
        }
        this.textContext += ch;
        return { handled: true, passthrough: true };
      }
      return { handled: false };
    }

    // Explicit backspace handling (used by the UI's Backspace key).
    processBackspace(modifiers = 0) {
      if (!this.haveKeyboard) return { handled: false };
      this.beginEvent();
      const oldText = this.textContext;
      // Try to match a VK_BACK rule first (smart backspace rules).
      const success = this.processInput(0x08, VK_BACK, modifiers);
      if (success) {
        this.updateHistory(oldText);
        return { handled: true };
      }
      return this.handleBackspace();
    }

    // Process a virtual-key event (e.g. VK_NUMPAD0, VK_SPACE, VK_F5). Use this
    // for the special keys the browser reports via event.code rather than the
    // printable character. Returns {handled}. The output (if any) is appended
    // to the context as the rule's RHS dictates.
    processVKey(vkCode, modifiers = 0) {
      if (!this.haveKeyboard) return { handled: false };
      this.beginEvent();
      const oldText = this.textContext;
      const success = this.processInput(0, vkCode, modifiers);
      if (success) {
        // re-match loop, same as processChar
        let looped = 0;
        while (this.shouldMatchAgain) {
          const again = this.processInput(0, 0, 0);
          looped++;
          if (looped >= 20 || !again) break;
        }
        this.updateHistory(oldText);
        return { handled: true };
      }
      // unmatched vkey: clear active switch (transient states don't persist)
      this.switch = {};
      this.pendingSwitch = {};
      return { handled: false };
    }

    handleBackspace() {
      if (this.layoutOptions.autoBksp && this.contextHistory.length !== 0) {
        this.textContext = this.contextHistory[this.contextHistory.length - 1];
        this.contextHistory.pop();
        return { handled: true };
      } else if (this.textContext.length) {
        // remove one code point from the end
        this.textContext = sliceLastCodePoint(this.textContext);
        return { handled: true };
      }
      return { handled: false };
    }

    updateHistory(text) {
      if (this.contextHistory.length === 0) {
        this.contextHistory.push(text);
      } else if (text !== this.contextHistory[this.contextHistory.length - 1]) {
        this.contextHistory.push(text);
      }
    }

    // =====================================================================
    // processInput — try every rule in order; first match wins.
    // =====================================================================
    processInput(keyval, keycode, modifiers) {
      let success = false;
      for (const rule of this.rules) {
        success = this.matchRule(rule, keyval, keycode, modifiers);
        if (success) {
          if (keycode) this.switch = {};

          // if a string-pattern matched (not a pure VK match) and we have a
          // real keyval, append it to the context first (so the LHS can match
          // against it).
          if (!this.matchedVK && keyval !== 0) {
            this.textContext += String.fromCodePoint(keyval);
          }

          const ok = this.processOutput(rule);
          // un-press
          this.keyStates[keycode] = 0;
          return ok;
        }
      }
      return false;
    }

    // =====================================================================
    // matchKeyStates — handle the <VK & VK> part of a rule's LHS.
    // Returns the count of matched VK items, or -1 if they don't match.
    //
    // `pressedKey` is the vkey actually being processed this event (e.g.
    // VK_NUMPAD0, VK_BACK, or a printable char's code), or 0 if we're in a
    // re-match pass (no new key). Modifier keys (SHIFT/CTRL/ALT) are matched
    // against `modifiers` instead.
    // =====================================================================
    matchKeyStates(modifiers, rule, pressedKey) {
      let matchedCount = 0;
      let modStates = modifiers;

      for (const curRule of rule.lhs) {
        if (curRule.type !== 'vkey') continue;
        const kc = curRule.keyCode;
        if (kc === VK_SHIFT || kc === VK_RSHIFT || kc === VK_LSHIFT) {
          if (modStates & SHIFT_MASK) modStates -= SHIFT_MASK;
          else return -1;
        } else if (kc === VK_CONTROL || kc === VK_RCONTROL || kc === VK_LCONTROL) {
          if (modStates & CTRL_MASK) modStates -= CTRL_MASK;
          else return -1;
        } else if (kc === VK_MENU || kc === VK_RMENU || kc === VK_LMENU) {
          if (modStates & ALT_MASK) modStates -= ALT_MASK;
          else return -1;
        } else {
          // A concrete key (VK_NUMPAD0, VK_BACK, VK_KEY_A, ...). The native
          // engine checks m_keyStates[kc] & 0x80; we instead compare against
          // the single key this event is actually processing. A vkey-only rule
          // can never match during a re-match pass (pressedKey === 0).
          if (kc !== pressedKey) return -1;
        }
        matchedCount++;
      }

      if ((modStates & CTRL_MASK) || (modStates & ALT_MASK)) return -1;
      return matchedCount;
    }

    // =====================================================================
    // matchRule — does this rule's LHS match the tail of the context?
    // =====================================================================
    matchRule(rule, keyval, keycode, modifiers) {
      let appendedContext = this.textContext;

      this.matchedVK = false;
      // The concrete key this event is processing. For vkey rules we compare
      // against this; `keycode` carries the vkey (e.g. VK_BACK=0x08) when the
      // event is a special key, otherwise it's the printable's code.
      const pressedKey = keycode;
      const kcode = this.matchKeyStates(modifiers, rule, pressedKey);
      if (kcode === -1) return false;
      if (kcode === 0) {
        if (keyval !== 0) appendedContext = this.textContext + String.fromCodePoint(keyval);
      } else {
        this.matchedVK = true;
      }

      const lenToMatch = rule.matchLength;
      const codePoints = [...appendedContext];
      const lenAppended = codePoints.length;
      if (lenToMatch > lenAppended) return false;

      // the substring to match = last lenToMatch code points
      const stringToMatch = codePoints.slice(lenAppended - lenToMatch);
      let idx = 0;

      this.backRef = [];

      for (const curRule of rule.lhs) {
        switch (curRule.type) {
          case 'string': {
            const pat = [...curRule.value];
            for (const p of pat) {
              if (idx >= stringToMatch.length) return false;
              if (stringToMatch[idx] !== p) return false;
              idx++;
            }
            this.backRef.push(curRule.value);
            break;
          }
          case 'anyOf': {
            if (idx >= stringToMatch.length) return false;
            const ch = stringToMatch[idx];
            if (![...curRule.value].includes(ch)) return false;
            this.backRef.push(ch);
            idx++;
            break;
          }
          case 'notOf': {
            // tNotOfString in the C++ — note: its condition is inverted from
            // what the name suggests: it matches if the char IS in the set.
            if (idx >= stringToMatch.length) return false;
            const ch = stringToMatch[idx];
            if (![...curRule.value].includes(ch)) return false;
            this.backRef.push(ch);
            idx++;
            break;
          }
          case 'backref':
            // not supported by the engine on LHS
            return false;
          case 'any': {
            if (idx >= stringToMatch.length) return false;
            const ch = stringToMatch[idx];
            const cp = ch.codePointAt(0);
            // engine: 0x21..0x7D or 0xFF..0xFFFF
            if ((cp >= 0x21 && cp <= 0x7D) || (cp >= 0xFF && cp <= 0xFFFF)) {
              this.backRef.push(ch);
              idx++;
            } else {
              return false;
            }
            break;
          }
          case 'switch': {
            const id = curRule.id;
            if (!this.switch[id]) return false;
            break;
          }
          case 'vkey':
            // already handled in matchKeyStates
            break;
          default:
            break;
        }
      }
      return true;
    }

    // =====================================================================
    // processOutput — apply the RHS, replacing the matched tail.
    // =====================================================================
    processOutput(rule) {
      let outputResult = '';
      const length = rule.matchLength;

      for (const curRule of rule.rhs) {
        switch (curRule.type) {
          case 'string':
            outputResult += curRule.value;
            break;
          case 'ref': {
            if (this.backRef.length <= curRule.index) return false;
            outputResult += this.backRef[curRule.index];
            break;
          }
          case 'backref': {
            // back-ref string: find which char of the LHS set matched, then
            // pick the same-position char from the RHS set.
            if (this.backRef.length <= curRule.refIndex) return false;
            const matched = this.backRef[curRule.refIndex];
            const lhsItem = rule.lhs.find(it => it.segIndex === curRule.refIndex) ||
                            rule.lhs[curRule.refIndex];
            // The C++ uses inRules->at(refIndex).stringValue.find(string)
            // where inRules excludes vkey/switch. We approximate by searching
            // the corresponding LHS string-segment's value.
            const lhsString = lhsItem ? lhsItem.value : '';
            const pos = lhsString ? lhsString.indexOf(matched) : -1;
            if (pos !== -1 && pos < [...curRule.value].length) {
              outputResult += [...curRule.value][pos];
            }
            break;
          }
          case 'vkey':
            outputResult += String.fromCodePoint(curRule.keyCode);
            break;
          case 'switch': {
            const id = curRule.id;
            // Activate this state for the NEXT key event. (Single-event
            // lifecycle: it will be cleared at the start of the event after
            // next unless a rule re-activates it.)
            this.pendingSwitch[id] = true;
            break;
          }
          case 'null':
            // NULL -> output nothing (deletes the matched text)
            break;
          default:
            break;
        }
      }

      // replace the matched tail
      const codePoints = [...this.textContext];
      this.textContext = codePoints.slice(0, codePoints.length - length).join('') + outputResult;

      // decide whether to re-match (the engine re-runs when output is "wide")
      if (outputResult.length === 0 ||
          (outputResult.length === 1 && outputResult.codePointAt(0) > 0x20 && outputResult.codePointAt(0) < 0x7F)) {
        this.shouldMatchAgain = false;
      } else {
        this.shouldMatchAgain = true;
      }
      return true;
    }
  }

  function sliceLastCodePoint(str) {
    const arr = [...str];
    arr.pop();
    return arr.join('');
  }

  // Rule precedence key (higher = tried first). Tiers, most significant first:
  //   1. state-specific rules (LHS has a switch) before global rules
  //   2. virtual-key rules (LHS has vkeys) before string-pattern rules
  //   3. MORE vkeys before FEWER (so <VK_SHIFT & VK_QUESTION> beats <VK_QUESTION>)
  //   4. longer string patterns before shorter (greedy)
  function priority(rule) {
    let p = 0;
    let hasState = false, hasVkey = false, vkeyCount = 0;
    for (const it of rule.lhs) {
      if (it.type === 'switch') hasState = true;
      if (it.type === 'vkey') { hasVkey = true; vkeyCount++; }
    }
    if (hasState) p += 1000000;
    if (hasVkey) p += 100000;
    p += vkeyCount * 1000;          // more vkeys = more specific
    p += rule.matchLength;          // typically < a few hundred
    return p;
  }

  global.KeyMagicEngine = KeyMagicEngine;
  global.KeyMagicConstants = { SHIFT_MASK, CTRL_MASK, ALT_MASK, CAPS_MASK, VK_BACK };
})(typeof window !== 'undefined' ? window : globalThis);
