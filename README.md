# KeyMagic Typing

A browser-based typing tool that runs [KeyMagic](https://github.com/thantthet/keymagic-3) `.kms` keyboard layouts entirely in JavaScript — no install, no IME setup. Type Myanmar and other ethnic-language scripts directly in the browser.

## Features

- Pure-JavaScript KeyMagic engine — parses and runs `.kms` scripts in the browser.
- Multiple built-in keyboards (Myanmar, Shan, Pa'O, Karen).
- Toggle the input method on/off with **Ctrl + Shift**.
- On-screen QWERTY keyboard that shows the mapped glyphs (base + shifted layers).
- Live text area with backspace, space, and selection handling.

## Included keyboards

| Keyboard | Script |
|----------|--------|
| MyanSan (မြန်စံ) | Myanmar |
| PangLong | Shan |
| PaOh | Pa'O |
| Sgaw Karen (Kawthoolei) | Karen |
| Western Pwo Karen | Karen |
| Eastern Pwo Karen | Karen |

## Usage

This is a static site — no build step.

1. Serve the folder with any static web server:
   ```bash
   python3 -m http.server 8000
   ```
2. Open `http://localhost:8000/` in your browser.
3. Pick a keyboard from the dropdown.
4. Press **Ctrl + Shift** to enable the layout, then start typing.
5. Press **Ctrl + Shift** again to switch back to normal input.

> Opening `index.html` directly via `file://` may not load the `.kms` files due to browser security; use a local server.

## Project structure

```
site/
├── index.html          # main typing page + UI
├── engine.html         # engine test page
├── test-engine.js      # engine tests
├── js/
│   ├── kms-parser.js   # parses .kms scripts into rules/variables/options
│   ├── kms-engine.js   # KeyMagic text-transformation engine (JS port)
│   ├── typing.js       # UI logic for index.html
│   ├── app.js          # shared app logic
│   └── default-keyboard.js
└── keyboards/          # .kms keyboard layout files
```

## How it works

- **`kms-parser.js`** tokenizes a `.kms` script and builds an in-memory keyboard (variables, options, rules), mirroring the reference KeyMagic parser.
- **`kms-engine.js`** keeps a context buffer and, for each keystroke, applies the first matching rule's replacement — a faithful port of the C++ `KeyMagicEngine`.
- **`typing.js`** wires keystrokes to the engine and keeps the text area in sync with the engine context.

## License

MIT
