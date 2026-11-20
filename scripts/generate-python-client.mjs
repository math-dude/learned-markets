import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFromRoot } from 'codama-python-core';
import { rootNodeFromAnchor } from 'codama-python-anchor';
import { renderVisitor } from 'codama-py';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';

// codama-py 0.1.7-beta omits its templates from npm and resolves them outside
// its package. Use the matching upstream tag's templates for this generation.
const configure = nunjucks.configure;
nunjucks.configure = (_path, options) => configure(
    fileURLToPath(new URL('./vendor/codama-py/templates', import.meta.url)), { ...options, autoescape: false },
);

const idl = JSON.parse(await readFile(new URL('../target/idl/learned_markets.json', import.meta.url), 'utf8'));
const root = rootNodeFromAnchor(idl);
const output = fileURLToPath(new URL('../apps/backend/src/learned_markets_backend/generated', import.meta.url));
await createFromRoot(root).accept(renderVisitor(output));

// Keep generated diffs clean while preserving the renderer's Python structure.
async function normalizeWhitespace(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await normalizeWhitespace(path);
        else if (entry.name.endsWith('.py')) {
            const source = await readFile(path, 'utf8');
            await writeFile(path, source.replace(/[ \t]+$/gm, '').trimEnd() + '\n');
        }
    }
}
await normalizeWhitespace(output);
