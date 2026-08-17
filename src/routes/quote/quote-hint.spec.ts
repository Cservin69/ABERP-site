import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The visible upload hint and the file picker's `accept=` attribute are the
// promise we make to the customer before they spend time exporting. S204: the
// pipeline only processes STEP, so the form must not advertise anything else.
// Asserted against the component source because the storefront has no
// component-render harness — a DOM test would be heavier without catching more
// (the strings below are plain literals in the template, not computed).
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(HERE, '+page.svelte'), 'utf8');

const RETIRED = [
	'.iges',
	'.igs',
	'.x_t',
	'.x_b',
	'.sldprt',
	'.ipt',
	'.f3d',
	'.dxf',
	'.dwg',
	'.3mf',
	'.obj',
	'.stl'
];

describe('/quote CAD upload hint (S204 STEP-only)', () => {
	it('offers only .step and .stp in the file picker', () => {
		expect(SOURCE).toMatch(/const ACCEPT_EXT = '\.step,\.stp';/);
	});

	it('states STEP-only in the visible hint', () => {
		expect(SOURCE).toMatch(/STEP only \(\.step \/ \.stp\)/);
	});

	it('keeps the file-count and size limits in the hint', () => {
		expect(SOURCE).toMatch(/max \{MAX_FILES\} files, 50&nbsp;MB total/);
		expect(SOURCE).toMatch(/const MAX_FILES = 10;/);
		expect(SOURCE).toMatch(/const MAX_TOTAL_BYTES = 50 \* 1024 \* 1024;/);
	});

	it('advertises no retired format anywhere in the accept attribute', () => {
		const accept = SOURCE.match(/const ACCEPT_EXT = '([^']*)';/);
		expect(accept).not.toBeNull();
		const offered = accept![1].split(',');
		expect(offered).toEqual(['.step', '.stp']);
		for (const ext of RETIRED) {
			expect(offered, ext).not.toContain(ext);
		}
	});

	it('does not name a retired format in the rendered template', () => {
		// Strip the <script> block: the explanatory comment there legitimately
		// mentions the retired formats; the markup the customer reads must not.
		const template = SOURCE.replace(/<script[\s\S]*?<\/script>/g, '');
		for (const ext of RETIRED) {
			expect(template, ext).not.toContain(ext);
		}
	});
});
