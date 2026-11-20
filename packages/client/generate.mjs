import { readFile } from 'node:fs/promises';
import { createFromRoot } from 'codama';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';

const idl = JSON.parse(await readFile(new URL('../../target/idl/learned_markets.json', import.meta.url), 'utf8'));
await createFromRoot(rootNodeFromAnchor(idl)).accept(renderVisitor(import.meta.dirname, {
    erasableSyntax: true,
    importExtension: 'ts',
    kitImportStrategy: 'rootOnly',
    syncPackageJson: false,
}));
