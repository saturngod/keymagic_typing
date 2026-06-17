/*
 * kms-parser.js — parse a KeyMagic .kms script into an in-memory keyboard
 * representation (variables, options, rules) that the engine can run.
 *
 * This mirrors the reference parser:
 *   cross-platform/parser/parser/keymagic-scanner.ll   (lexer)
 *   cross-platform/parser/parser/keymagic-parser.tab.*  (grammar actions)
 *
 * Grammar recap (what we need to support):
 *   options     : NAME/FONTFAMILY/DESCRIPTION/ICON/HOTKEY "str" newline
 *               | TRACK_CAPSLOCK/EAT_ALL_UNUSED_KEYS/US_LAYOUT_BASED/
 *                 SMART_BACKSPACE/TREAT_CTRL_ALT_AS_RALT bool newline
 *   var_decl    : $ident = char_array
 *   char_array  : string | predefined | $ident | char_array + char_array
 *   rule        : left_rule_exps => right_rule_exps newline
 *   left_rule_exp : string [modifier]   ; modifier = [*] | [^] | [$n]
 *                 | ANY
 *                 | <VK & VK ...>        (virtual-key states)
 *                 | (switch string)      (switch)
 *   right_rule_exp: string | $n | NULL | (switch) | <VK>
 *
 * We don't need a full yacc parser; a tokenizer + recursive matcher is enough
 * because the grammar is simple and line-oriented.
 */
(function (global) {
  'use strict';

  // predefined id space (matches keymagic-driver.hpp predefinedID enum).
  // id 1 = NULL, 2 = VK_BACK, 3 = VK_TAB ... (KeyCodes ids are offset-aligned).
  const PREDEF = {};
  // helper: define a predefined name and all its aliases -> same id.
  let nextId = 1;
  function def(names, charCode) {
    const id = nextId++;
    for (const n of names) PREDEF[n.toUpperCase()] = { id, charCode };
  }
  def(['NULL'], 0);                 // pdNULL = 1, no output char
  def(['VK_BACK','VK_BACK'], 0x08);
  def(['VK_TAB'], 0x09);
  def(['VK_RETURN','VK_ENTER'], 0x0D);
  def(['VK_SHIFT'], 0x10);
  def(['VK_CONTROL','VK_CTRL'], 0x11);
  def(['VK_MENU','VK_ALT'], 0x12);
  def(['VK_PAUSE'], 0x13);
  def(['VK_CAPITAL','VK_CAPSLOCK'], 0x14);
  def(['VK_KANJI'], 0x19);
  def(['VK_ESCAPE','VK_ESC'], 0x1B);
  def(['VK_SPACE'], 0x20);
  def(['VK_PRIOR'], 0x21);
  def(['VK_NEXT'], 0x22);
  def(['VK_DELETE'], 0x2E);
  const digits = '0123456789';
  for (let i = 0; i < 10; i++) def(['VK_KEY_' + digits[i]], digits[i].charCodeAt(0));
  for (let i = 0; i < 26; i++) {
    const L = String.fromCharCode(65 + i);
    def(['VK_KEY_' + L], L.charCodeAt(0));
  }
  for (let i = 0; i < 10; i++) def(['VK_NUMPAD' + i], 0x60 + i);
  def(['VK_MULTIPLY'], 0x6A); def(['VK_ADD'], 0x6B); def(['VK_SEPARATOR'], 0x6C);
  def(['VK_SUBTRACT'], 0x6D); def(['VK_DECIMAL'], 0x6E); def(['VK_DIVIDE'], 0x6F);
  for (let i = 1; i <= 12; i++) def(['VK_F' + i], 0x6F + i);
  def(['VK_LSHIFT'], 0xA0); def(['VK_RSHIFT'], 0xA1);
  def(['VK_LCONTROL','VK_LCTRL'], 0xA2); def(['VK_RCONTROL','VK_RCTRL'], 0xA3);
  def(['VK_LMENU','VK_LALT'], 0xA4); def(['VK_RMENU','VK_RALT','VK_ALT_GR'], 0xA5);
  def(['VK_OEM_1','VK_COLON'], 0xBA);
  def(['VK_OEM_PLUS'], 0xBB); def(['VK_OEM_COMMA'], 0xBC);
  def(['VK_OEM_MINUS'], 0xBD); def(['VK_OEM_PERIOD'], 0xBE);
  def(['VK_OEM_2','VK_QUESTION'], 0xBF);
  def(['VK_OEM_3','VK_CFLEX'], 0xC0);
  def(['VK_OEM_4','VK_LBRACKET'], 0xDB);
  def(['VK_OEM_5','VK_BACKSLASH'], 0xDC);
  def(['VK_OEM_6','VK_RBRACKET'], 0xDD);
  def(['VK_OEM_7','VK_QUOTE'], 0xDE);
  def(['VK_OEM_8','VK_EXCM'], 0xDF);
  def(['VK_OEM_AX'], 0xE1);
  def(['VK_OEM_102','VK_LESSTHEN'], 0xE2);
  def(['VK_ICO_HELP'], 0xE3); def(['VK_ICO_00'], 0xE4);

  function isPredefined(name) {
    return Object.prototype.hasOwnProperty.call(PREDEF, name.toUpperCase());
  }

  // ---- string-literal unescaping (scanner.ll S_DQSTRING/S_SQSTRING) -----
  function parseStringLiteral(raw, quote) {
    // raw is the text WITHOUT the surrounding quotes.
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === '\\' && i + 1 < raw.length) {
        const n = raw[i + 1];
        if ((n === 'u' || n === 'U') && i + 5 < raw.length + 1 && /[0-9a-fA-F]{4}/.test(raw.substr(i + 2, 4))) {
          out += String.fromCodePoint(parseInt(raw.substr(i + 2, 4), 16));
          i += 5;
        } else if ((n === 'x' || n === 'X') && /[0-9a-fA-F]{2}/.test(raw.substr(i + 2, 2))) {
          // \xHH or \xHHHH — grab up to 4 hex digits (scanner allows 2..4)
          let hex = '';
          let j = i + 2;
          while (j < raw.length && hex.length < 4 && /[0-9a-fA-F]/.test(raw[j])) { hex += raw[j]; j++; }
          out += String.fromCodePoint(parseInt(hex, 16));
          i = j - 1;
        } else if (n === 'b') { out += '\b'; i++; }
        else if (n === 't') { out += '\t'; i++; }
        else if (n === 'n') { out += '\n'; i++; }
        else if (n === 'v') { out += '\v'; i++; }
        else if (n === 'f') { out += '\f'; i++; }
        else if (n === 'r') { out += '\r'; i++; }
        else { out += n; i++; }
      } else {
        out += c;
      }
    }
    return out;
  }

  // ---- tokenizer --------------------------------------------------------
  // We tokenize a single "rule line" (LHS / RHS expressions). The high-level
  // line parser splits on newlines and `=>` first, then hands each half here.
  //
  // Token kinds:
  //   {t:'str',   v:string}
  //   {t:'var',   name:'varname'}      // $ident  (also legal inside expr)
  //   {t:'ref',   n:int}               // $1 .. $9
  //   {t:'mod',   kind:'any'|'not'|'ref', n?:int}  // [*] [^] [$n]
  //   {t:'predef', name:'VK_KEY_A', id:int, char:int}
  //   {t:'any'}                          // ANY keyword
  //   {t:'vkeys',  keys:[{id,char,name}]}
  //   {t:'switch', text:string}         // ( ... ) — body string
  //   {t:'null'}                         // NULL keyword
  function tokenizeExpr(text) {
    const tokens = [];
    let i = 0;
    const len = text.length;
    function skipWs() { while (i < len && /[ \t]/.test(text[i])) i++; }

    while (i < len) {
      skipWs();
      if (i >= len) break;
      const c = text[i];

      // '+' is an explicit separator — we just skip it; tokens are already
      // separate list elements.
      if (c === '+') { i++; continue; }

      // string literal " ... " or ' ... '
      if (c === '"' || c === "'") {
        const q = c; i++;
        let body = '';
        while (i < len && text[i] !== q) {
          if (text[i] === '\\' && i + 1 < len) {
            body += text[i] + text[i + 1]; i += 2;
          } else { body += text[i]; i++; }
        }
        i++; // closing quote
        let str = parseStringLiteral(body, q);
        // check for modifier [...]
        skipWs();
        let mod = null;
        if (text[i] === '[') {
          mod = readModifier();
        }
        tokens.push({ t: 'str', v: str, mod });
        continue;
      }

      // modifier starting without a string? Not legal in source; skip.
      if (c === '[') { readModifier(); continue; }

      // virtual-key states  < VK & VK >
      if (c === '<') {
        i++;
        const keys = [];
        skipWs();
        while (i < len && text[i] !== '>') {
          // read a word
          let word = '';
          while (i < len && /[^\s&>]/.test(text[i])) { word += text[i]; i++; }
          skipWs();
          if (text[i] === '&') { i++; skipWs(); }
          if (word) {
            const up = word.toUpperCase();
            if (isPredefined(up)) {
              const p = PREDEF[up];
              keys.push({ id: p.id, char: p.charCode, name: up });
            }
          }
        }
        if (text[i] === '>') i++;
        tokens.push({ t: 'vkeys', keys });
        continue;
      }

      // switch  ( "..." )   or   ( raw )
      if (c === '(') {
        i++;
        let body = '';
        // a switch wraps a quoted string per grammar; capture inner text.
        // We accept both quoted and unquoted bodies.
        if (text[i] === '"' || text[i] === "'") {
          const q = text[i]; i++;
          while (i < len && text[i] !== q) {
            if (text[i] === '\\' && i + 1 < len) { body += text[i] + text[i+1]; i += 2; }
            else { body += text[i]; i++; }
          }
          i++; // close quote
        } else {
          while (i < len && text[i] !== ')') { body += text[i]; i++; }
        }
        while (i < len && text[i] !== ')') i++;
        if (text[i] === ')') i++;
        tokens.push({ t: 'switch', text: body });
        continue;
      }

      // uXXXX / UXXXX unicode literal (scanner: (u|U){hex}{4})
      if ((c === 'u' || c === 'U') && len - i >= 5 && /[0-9a-fA-F]{4}/.test(text.substr(i + 1, 4))) {
        const cp = parseInt(text.substr(i + 1, 4), 16);
        i += 5;
        let str = String.fromCodePoint(cp);
        skipWs();
        let mod = null;
        if (text[i] === '[') mod = readModifier();
        tokens.push({ t: 'str', v: str, mod });
        continue;
      }

      // $identifier or $number
      if (c === '$') {
        i++;
        if (i < len && /[0-9]/.test(text[i])) {
          let num = '';
          while (i < len && /[0-9]/.test(text[i])) { num += text[i]; i++; }
          tokens.push({ t: 'ref', n: parseInt(num, 10) });
        } else {
          let name = '';
          while (i < len && /[A-Za-z0-9_]/.test(text[i])) { name += text[i]; i++; }
          // a variable may carry a trailing modifier: $var[*], $var[^], $var[$n]
          skipWs();
          let mod = null;
          if (text[i] === '[') mod = readModifier();
          tokens.push({ t: 'var', name, mod });
        }
        continue;
      }

      // keyword / predefined word  [A-Za-z0-9_]+ and other punctuation words
      if (/[A-Za-z0-9_]/.test(c)) {
        let word = '';
        while (i < len && /[A-Za-z0-9_]/.test(text[i])) { word += text[i]; i++; }
        const up = word.toUpperCase();
        if (up === 'ANY') {
          tokens.push({ t: 'any' });
          continue;
        }
        if (up === 'NULL') {
          tokens.push({ t: 'null' });
          continue;
        }
        if (isPredefined(up)) {
          const p = PREDEF[up];
          tokens.push({ t: 'predef', name: up, id: p.id, char: p.charCode });
          continue;
        }
        // unknown bareword — ignore (avoid emitting junk).
        continue;
      }

      // anything else: skip one char
      i++;
    }

    function readModifier() {
      // assumes text[i] === '['
      i++; // [
      skipWs();
      let kind = null, n = null;
      if (text[i] === '*') { kind = 'any'; i++; }
      else if (text[i] === '^') { kind = 'not'; i++; }
      else if (text[i] === '$') {
        i++;
        let num = '';
        while (i < len && /[0-9]/.test(text[i])) { num += text[i]; i++; }
        kind = 'ref'; n = parseInt(num, 10);
      } else if (/[0-9]/.test(text[i])) {
        // lenient: bare [N] (km2reader emits this form). Treat as [$N].
        let num = '';
        while (i < len && /[0-9]/.test(text[i])) { num += text[i]; i++; }
        kind = 'ref'; n = parseInt(num, 10);
      }
      skipWs();
      while (i < len && text[i] !== ']') i++;
      if (text[i] === ']') i++;
      return { kind, n };
    }

    return tokens;
  }

  // ---- build LHS/RHS item lists from tokens -----------------------------
  // LHS items: {type:'string'|'anyOf'|'notOf'|'any'|'vkey'|'vkeys'|'switch', ...}
  // RHS items: {type:'string'|'ref'|'backref'|'vkey'|'switch'|'null'}

  // Apply a trailing [..] modifier to a string-valued segment, returning the
  // LHS item. Shared by string literals and variable references.
  function lhsStringSegment(value, mod, segIndex, fromVar) {
    const base = { value, segIndex };
    if (fromVar) base.fromVar = fromVar;
    if (!mod) return Object.assign({ type: 'string' }, base);
    if (mod.kind === 'any')  return Object.assign({ type: 'anyOf' }, base);
    if (mod.kind === 'not')  return Object.assign({ type: 'notOf' }, base);
    if (mod.kind === 'ref')  return Object.assign({ type: 'backref', refIndex: mod.n - 1 }, base);
    return Object.assign({ type: 'string' }, base);
  }

  function buildLhs(tokens, variables) {
    const items = [];
    let segIndex = -1; // which segment we're on (for ref modifiers)
    for (const tk of tokens) {
      if (tk.t === 'str') {
        segIndex++;
        items.push(lhsStringSegment(tk.v, tk.mod, segIndex));
      } else if (tk.t === 'var') {
        segIndex++;
        const v = resolveVar(tk.name, variables);
        items.push(lhsStringSegment(v, tk.mod, segIndex, tk.name));
      } else if (tk.t === 'any') {
        segIndex++;
        items.push({ type: 'any', segIndex });
      } else if (tk.t === 'predef') {
        // a bare predefined on the LHS outside <> — treat as a literal char
        segIndex++;
        items.push({ type: 'string', value: String.fromCodePoint(tk.char), segIndex });
      } else if (tk.t === 'vkeys') {
        // virtual-key state group — these don't consume context chars
        for (const k of tk.keys) items.push({ type: 'vkey', keyCode: k.char, name: k.name });
      } else if (tk.t === 'switch') {
        items.push({ type: 'switch', text: tk.text });
      }
    }
    return items;
  }

  function buildRhs(tokens, variables) {
    const items = [];
    for (const tk of tokens) {
      if (tk.t === 'str') {
        if (tk.mod && tk.mod.kind === 'ref') {
          items.push({ type: 'backref', value: tk.v, refIndex: tk.mod.n - 1 });
        } else {
          items.push({ type: 'string', value: tk.v });
        }
      } else if (tk.t === 'var') {
        const v = resolveVar(tk.name, variables);
        if (tk.mod && tk.mod.kind === 'ref') {
          // $var[$n] — back-ref array: pick from this variable's value at the
          // position matched by back-ref #n.
          items.push({ type: 'backref', value: v, refIndex: tk.mod.n - 1 });
        } else {
          items.push({ type: 'string', value: v });
        }
      } else if (tk.t === 'ref') {
        items.push({ type: 'ref', index: tk.n - 1 });
      } else if (tk.t === 'predef') {
        items.push({ type: 'vkey', keyCode: tk.char });
      } else if (tk.t === 'any') {
        // ANY on RHS isn't meaningful; ignore
      } else if (tk.t === 'vkeys') {
        for (const k of tk.keys) items.push({ type: 'vkey', keyCode: k.char });
      } else if (tk.t === 'switch') {
        items.push({ type: 'switch', text: tk.text });
      } else if (tk.t === 'null') {
        items.push({ type: 'null' });
      }
    }
    return items;
  }

  function resolveVar(name, variables) {
    return Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : '';
  }

  // ---- top-level script parser ------------------------------------------
  // Returns { variables, layoutOptions, infos, rules, errors }.
  function parseScript(source) {
    const variables = {};
    const varOrder = [];     // for round-trip ordering (not strictly needed)
    const layoutOptions = {
      trackCaps: true,
      autoBksp: false,   // SMART_BACKSPACE
      eat: false,
      posBased: false,   // US_LAYOUT_BASED
      rightAlt: true,
    };
    const infos = { name: null, fontFamily: null, description: null, hotkey: null };
    const rules = [];
    const errors = [];

    // Strip block comments /* ... */ and line comments //
    // (but not inside strings — we operate line-by-line and strings don't
    // span newlines per the grammar, so a simple per-line scan is fine as
    // long as we don't split inside a string).
    const lines = splitLogicalLines(source);

    // @OPTION directives harvested from comments (e.g. `@NAME = "Foo"`).
    // Process these first so layout/infos are set before rules reference them.
    const atOptions = splitLogicalLines.lastAtOptions || [];
    for (const opt of atOptions) {
      try { parseOption(opt); } catch (e) { errors.push('Option: ' + e.message); }
    }

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const { text, raw } = lines[lineNo];
      const trimmed = text.trim();
      if (trimmed === '') continue;

      try {
        parseLine(trimmed);
      } catch (e) {
        errors.push(`Line ${lineNo + 1}: ${e.message}`);
      }
    }

    // Wire up switch ids. Switches are identified by their *text*; the
    // compiler assigns an index per unique switch string. We mirror that.
    const switchIds = {};
    let switchCount = 0;
    function switchIdFor(text) {
      if (!Object.prototype.hasOwnProperty.call(switchIds, text)) {
        switchIds[text] = switchCount++;
      }
      return switchIds[text];
    }
    // now patch rules
    for (const r of rules) {
      for (const it of r.lhs) if (it.type === 'switch') it.id = switchIdFor(it.text);
      for (const it of r.rhs) if (it.type === 'switch') it.id = switchIdFor(it.text);
    }

    return { variables, varOrder, layoutOptions, infos, rules, errors };

    // ---- nested: parse one logical line ----
    function parseLine(line) {
      // rule:  <lhs> => <rhs>   — check BEFORE variable assignment, since
      // `=>` contains `=` and would otherwise match the var-decl regex.
      const arrowIdx = findArrow(line);
      if (arrowIdx >= 0) {
        const lhsText = line.slice(0, arrowIdx);
        const rhsText = line.slice(arrowIdx + 2);
        const lhsToks = tokenizeExpr(lhsText);
        const rhsToks = tokenizeExpr(rhsText);
        const lhs = buildLhs(lhsToks, variables);
        const rhs = buildRhs(rhsToks, variables);
        // compute match length = number of context chars the LHS consumes
        // (everything except vkeys & switches). A plain string segment
        // consumes its full length, but any-of / not-of segments consume
        // exactly ONE char (see RuleInfo::toRuleInfo: opMODIFIER does
        // patLength -= len; patLength++).
        let matchLength = 0;
        for (const it of lhs) {
          if (it.type === 'string' || it.type === 'backref') matchLength += [...it.value].length;
          else if (it.type === 'anyOf' || it.type === 'notOf') matchLength += 1;
          else if (it.type === 'any') matchLength += 1;
        }
        rules.push({ lhs, rhs, matchLength, source: line });
        return;
      }

      // variable declaration:  $name = <expr>
      const varMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
      if (varMatch) {
        const name = varMatch[1];
        const eqIdx = line.indexOf('=');
        const expr = line.slice(eqIdx + 1);
        const value = evalCharArray(expr);
        variables[name] = value;
        if (!varOrder.includes(name)) varOrder.push(name);
        return;
      }

      // option lines
      parseOption(line);
    }

    // evaluate a char_array expression to a string (for variable values).
    function evalCharArray(expr) {
      const toks = tokenizeExpr(expr);
      let out = '';
      for (const tk of toks) {
        if (tk.t === 'str') out += tk.v;
        else if (tk.t === 'var') out += resolveVar(tk.name, variables);
        else if (tk.t === 'predef') out += String.fromCodePoint(tk.char);
        else if (tk.t === 'null') { /* NULL contributes nothing */ }
        // vkeys/switch/any/ref aren't valid in a char array; ignore.
      }
      return out;
    }

    function parseOption(line) {
      const m = /^([A-Z_]+)\s+(.+)$/.exec(line);
      if (!m) return; // unknown line; silently ignore
      const key = m[1];
      const val = m[2].trim();
      const boolVal = /^["']?(true|TRUE)["']?$/.test(val);
      const falseVal = /^["']?(false|FALSE)["']?$/.test(val);
      const strVal = stripQuotes(val);

      switch (key) {
        case 'NAME': infos.name = strVal; break;
        case 'FONTFAMILY': infos.fontFamily = strVal; break;
        case 'DESCRIPTION': infos.description = strVal; break;
        case 'ICON': infos.icon = strVal; break;
        case 'HOTKEY': infos.hotkey = strVal; break;
        case 'TRACK_CAPSLOCK': layoutOptions.trackCaps = boolVal; break;
        case 'EAT_ALL_UNUSED_KEYS':
        case 'EAT_KEYS': layoutOptions.eat = boolVal; break;
        case 'US_LAYOUT_BASED':
        case 'POSITIONAL_LAYOUT': layoutOptions.posBased = boolVal; break;
        case 'SMART_BACKSPACE': layoutOptions.autoBksp = boolVal; break;
        case 'TREAT_CTRL_ALT_AS_RALT': layoutOptions.rightAlt = boolVal; break;
        default: break;
      }
    }
  }

  // Split source into logical lines. Handles `\` line-continuation (scanner
  // S_NEXTLINE), line comments //, and block comments /* */ (which may span
  // lines). Strings never span newlines in this grammar.
  function splitLogicalLines(source) {
    // First, strip comments while respecting strings, and harvest any
    // @OPTION directives embedded in comments (per the scanner, a `@` at the
    // start of a comment line switches to option-parsing mode).
    const { cleaned, atOptions } = stripComments(source);
    // Stash the harvested options on the function so parseScript can read them.
    splitLogicalLines.lastAtOptions = atOptions;
    const out = [];
    let buf = '';
    const raw = cleaned.split(/\r?\n/);
    for (let i = 0; i < raw.length; i++) {
      let line = raw[i];
      // line continuation: trailing backslash joins next line
      if (/(^|[^\\])\\$/.test(line)) {
        buf += line.replace(/\\$/, '');
        continue;
      }
      buf += line;
      if (buf.trim() !== '') out.push({ text: buf, raw: buf });
      buf = '';
    }
    if (buf.trim() !== '') out.push({ text: buf, raw: buf });
    return out;
  }

  function stripComments(source) {
    // Returns { cleaned, atOptions } where atOptions is an array of
    // "@NAME = \"value\"" strings extracted from comments.
    const atOptions = [];
    let out = '';
    let i = 0;
    const n = source.length;
    let quote = null;
    let inLineComment = false;
    let inBlockComment = false;
    let lineStart = i; // index where the current line began (for @ detection)
    while (i < n) {
      const c = source[i];
      if (quote) {
        out += c;
        if (c === '\\' && i + 1 < n) { out += source[i + 1]; i += 2; continue; }
        if (c === quote) quote = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; out += c; i++; continue; }
      if (c === '/' && source[i + 1] === '/') {
        // line comment: capture until end of line, harvesting @OPTION lines.
        i += 2;
        let commentLine = '';
        while (i < n && source[i] !== '\n') { commentLine += source[i]; i++; }
        harvestAtOptions(commentLine, atOptions);
        continue;
      }
      if (c === '/' && source[i + 1] === '*') {
        i += 2;
        // block comment: harvest @OPTION from each line within it.
        let commentLine = '';
        while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
          if (source[i] === '\n') {
            harvestAtOptions(commentLine, atOptions);
            out += '\n'; // preserve line numbering
            commentLine = '';
          } else {
            commentLine += source[i];
          }
          i++;
        }
        harvestAtOptions(commentLine, atOptions);
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return { cleaned: out, atOptions };
  }

  // Pull "@NAME = \"value\"" out of a single comment line. Per the scanner,
  // a `@` (optionally after whitespace) begins an option directive.
  function harvestAtOptions(commentLine, atOptions) {
    const m = /^\s*@([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(commentLine);
    if (m) atOptions.push(m[1] + ' ' + m[2]);
  }

  function findArrow(line) {
    // find `=>` that's not inside a string
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\' && i + 1 < line.length) { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '=' && line[i + 1] === '>') return i;
    }
    return -1;
  }

  function stripQuotes(s) {
    if (s.length >= 2) {
      const q = s[0];
      if ((q === '"' || q === "'") && s[s.length - 1] === q) {
        return parseStringLiteral(s.slice(1, -1), q);
      }
    }
    return s;
  }

  global.KmsParser = {
    parseScript,
    isPredefined,
    PREDEF,
  };
})(typeof window !== 'undefined' ? window : globalThis);
