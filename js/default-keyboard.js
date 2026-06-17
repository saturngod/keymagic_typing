/*
 * default-keyboard.js — loads the default KMS script for the playground.
 *
 * The default is the real MyanSan.kms (မြန်စံ Smart) keyboard, fetched from
 * the site folder so it stays byte-identical to the source file. A small
 * built-in demo script is kept as a fallback if the fetch fails (e.g. when
 * the page is opened via file:// where fetch may be blocked).
 */
window.DEFAULT_KMS_FALLBACK = `// Minimal fallback keyboard (used only if MyanSan.kms can't be fetched)
// @NAME = "Demo (fallback)"
// @TRACK_CAPSLOCK = "FALSE"
"u" => "\\u1000"
"d" => "\\u102D"
"g" => "\\u102B"
"m" => "\\u102C"
"1234567890"[*] => "\\u1041\\u1042\\u1043\\u1044\\u1045\\u1046\\u1047\\u1048\\u1049\\u1040"[$1]
`;

// Fetch the real MyanSan.kms. Returns a Promise<string>.
window.loadDefaultKms = function () {
  return fetch('keyboards/MyanSan.kms')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .catch(function () {
      // file:// or offline — use the fallback so the page still works.
      return window.DEFAULT_KMS_FALLBACK;
    });
};
