// Wrapper around the vendored codrops RainEffect (see ./LICENSE).
// Exposes a clean init/destroy/resize API for a single canvas; bundles textures + shaders.

// Vite handles these import forms: ?url for asset URL, ?raw for inline string.
import dropAlphaUrl from './assets/drop-alpha.png';
import dropColorUrl from './assets/drop-color.png';
import textureRainFgUrl from './assets/texture-rain-fg.png';
import textureRainBgUrl from './assets/texture-rain-bg.png';
import vertShader from './shaders/simple.vert?raw';
import fragShader from './shaders/water.frag?raw';

import Raindrops from './raindrops.js';
import RainRenderer from './rain-renderer.js';
import { loadImages } from './util.js';
import { getContext } from './webgl.js';

export interface RainOptions {
	maxDpr?: number;
}

export interface RainInstance {
	destroy(): void;
	resize(): void;
}

const textureFgSize = { width: 96, height: 64 };
const textureBgSize = { width: 384, height: 256 };

function makeCanvas(w: number, h: number): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return c;
}

function measure(
	canvas: HTMLCanvasElement,
	maxDpr: number
): { width: number; height: number; dpi: number } {
	const dpi = Math.min(window.devicePixelRatio || 1, maxDpr);
	const width = canvas.clientWidth || window.innerWidth;
	const height = canvas.clientHeight || window.innerHeight;
	return { width, height, dpi };
}

export async function initRain(
	canvas: HTMLCanvasElement,
	options: RainOptions = {}
): Promise<RainInstance> {
	const maxDpr = options.maxDpr ?? 2;
	const { width, height, dpi } = measure(canvas, maxDpr);

	// Set the drawingbuffer BEFORE we touch getContext. WebGL's viewport is
	// initialized from drawingBufferWidth/Height at context-creation time and
	// is NOT auto-updated when the canvas is resized later — so getting the
	// dimensions right before the first getContext() call is load-bearing.
	canvas.width = Math.max(1, Math.floor(width * dpi));
	canvas.height = Math.max(1, Math.floor(height * dpi));

	// Probe WebGL here (not in the Svelte component) so the viewport lines up
	// with the just-resized drawingbuffer; throw to trigger the gradient fallback.
	const probe = getContext(canvas, { alpha: false });
	if (!probe) {
		throw new Error('webgl: no context available');
	}

	const images = (await loadImages({
		dropAlpha: dropAlphaUrl,
		dropColor: dropColorUrl,
		textureRainFg: textureRainFgUrl,
		textureRainBg: textureRainBgUrl
	})) as Record<string, HTMLImageElement>;

	const raindrops = new Raindrops(
		canvas.width,
		canvas.height,
		dpi,
		images.dropAlpha,
		images.dropColor,
		{
			trailRate: 1,
			trailScaleRange: [0.2, 0.45],
			collisionRadius: 0.45,
			dropletsCleaningRadiusMultiplier: 0.28
		}
	);

	const textureFg = makeCanvas(textureFgSize.width, textureFgSize.height);
	const textureFgCtx = textureFg.getContext('2d')!;
	const textureBg = makeCanvas(textureBgSize.width, textureBgSize.height);
	const textureBgCtx = textureBg.getContext('2d')!;
	textureFgCtx.drawImage(images.textureRainFg, 0, 0, textureFgSize.width, textureFgSize.height);
	textureBgCtx.drawImage(images.textureRainBg, 0, 0, textureBgSize.width, textureBgSize.height);

	const renderer = new RainRenderer(
		canvas,
		raindrops.canvas,
		textureFg,
		textureBg,
		null,
		vertShader,
		fragShader,
		{
			brightness: 1.04,
			alphaMultiply: 6,
			alphaSubtract: 3
		}
	);

	return {
		destroy() {
			raindrops.destroy();
			renderer.destroy();
		},
		resize() {
			// Resize the drawingbuffer to match the new layout, then re-pin the
			// GL viewport — see comment on the load-bearing first assignment above.
			const next = measure(canvas, maxDpr);
			const w = Math.max(1, Math.floor(next.width * next.dpi));
			const h = Math.max(1, Math.floor(next.height * next.dpi));
			if (w === canvas.width && h === canvas.height) return;
			canvas.width = w;
			canvas.height = h;
			renderer.resize(w, h);
		}
	};
}
