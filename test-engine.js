/* test-engine.js — sanity checks for the kms parser + engine on MyanSan.kms.
 * Run with: node test-engine.js
 */
global.window = global;
const fs = require('fs');
require('./js/kms-parser.js');
require('./js/kms-engine.js');

const src = fs.existsSync('keyboards/MyanSan.kms')
  ? fs.readFileSync('keyboards/MyanSan.kms', 'utf8')
  : (window.DEFAULT_KMS_FALLBACK || '');

const parsed = global.KmsParser.parseScript(src);
console.log('parsed: rules=' + parsed.rules.length +
            ' vars=' + Object.keys(parsed.variables).length +
            ' errors=' + parsed.errors.length);
if (parsed.errors.length) console.log('  errors:', parsed.errors.slice(0, 5));
if (parsed.infos.name) console.log('  name: ' + parsed.infos.name);

const eng = new global.KeyMagicEngine();
eng.loadKeyboard(parsed);

function type(seq) {
  eng.reset();
  for (const k of seq) {
    const r = eng.processChar(k, 0);
    if (!r.handled) eng.setContext(eng.getContext() + k);
  }
  return eng.getContext();
}

const cases = [
  // MyanSan baseK[*] => baseU[$1] mappings (q w e r t = ဆ တ န မ အ)
  ['q', '\u1006'], ['w', '\u1010'], ['e', '\u1014'], ['r', '\u1019'], ['t', '\u1021'],
  // vowel-e prefix (a = filler + ေ)
  ['a', '\u200A\u1031'],
  // digits
  ['1', '\u1041'], ['2', '\u1042'],
];
if (src.includes('MyanSan') || parsed.infos.name) {
  // state rules: ` activates 'tick', then 2 => U100F+U1039+U100C, = => U00F7
  cases.push(['`2', '\u100F\u1039\u100C']);
  cases.push(['`=', '\u00F7']);
}

let pass = 0;
for (const [k, expect] of cases) {
  const got = type(k);
  const ok = got === expect;
  if (ok) pass++;
  console.log((ok ? 'PASS' : 'FAIL') + "  type '" + k + "' => " + JSON.stringify(got) +
              '  (expect ' + JSON.stringify(expect) + ')');
}
console.log('\n' + pass + '/' + cases.length + ' passed');
process.exit(pass === cases.length ? 0 : 1);
