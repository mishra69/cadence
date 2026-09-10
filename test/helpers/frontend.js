// Loads a browser-side plain script so node:test can reach the logic inside it.
//
// frontend/js/calc.js is deliberately not an ES module: the page loads every
// script in that directory with a `?v=` stamp and the service worker precaches
// it by that URL, and a module's relative imports cannot carry the query (see
// the webpush-edge note in deploy.conf). So it declares one global instead, and
// this evaluates it the way a browser would.
//
// A vm context rather than eval, so the script cannot reach this process's
// globals — if calc.js ever touches `document`, the test fails here rather than
// passing on a shim that production does not have.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/** @returns {object} the `Calc` global, as the page would see it. */
export function loadCalc() {
  const path = fileURLToPath(new URL('../../frontend/js/calc.js', import.meta.url));
  const context = vm.createContext({});
  vm.runInContext(readFileSync(path, 'utf8'), context, { filename: 'calc.js' });
  if (!context.Calc) throw new Error('calc.js did not define a Calc global');
  return context.Calc;
}
