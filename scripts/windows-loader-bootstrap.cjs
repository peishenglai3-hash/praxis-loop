const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

const testModule = `const test = globalThis.__praxisRegisterTest; export { test }; export default test;`;
const testModuleUrl = `data:text/javascript,${encodeURIComponent(testModule)}`;
const loaderSource = `
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:test') return { url: ${JSON.stringify(testModuleUrl)}, shortCircuit: true };
  if (specifier.startsWith('node:') || specifier.startsWith('data:')) return nextResolve(specifier, context);
  if (specifier.startsWith('file:')) return { url: specifier, shortCircuit: true };
  if (/^[A-Za-z]:[\\\\/]/u.test(specifier) || specifier.startsWith('\\\\\\\\')) {
    return { url: pathToFileURL(specifier).href, shortCircuit: true };
  }
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('file:')) {
    return { format: 'module', source: await readFile(fileURLToPath(url), 'utf8'), shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, {
  parentURL: pathToFileURL(`${process.cwd()}\\`).href,
});

const args = process.argv.slice(1).filter((value) => value !== '--');
const [entry, mode] = args;
if (!entry || !mode) throw new Error('Windows loader bootstrap requires an entry file and mode.');
process.argv = [process.execPath, entry, mode];
import(pathToFileURL(entry).href).catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
