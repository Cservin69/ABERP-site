// Wrapper around the vendored codrops RainEffect (see ./LICENSE).
// Exposes a clean init/destroy API for a single canvas; bundles textures + shaders.

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

export interface RainOptions {
	maxDpr?: number;
}

export interface RainInstance {
	destroy(): void;
}

const textureFgSize = { width: 96, height: 64 };
const textureBgSize = { width: 384, height: 256 };

function makeCanvas(w: number, h: number): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return c;
}

export async function initRain(
	canvas: HTMLCanvasElement,
	options: RainOptions = {}
): Promise<RainInstance> {
	const maxDpr = options.maxDpr ?? 2;
	const dpi = Math.min(window.devicePixelRatio || 1, maxDpr);

	const width = canvas.clientWidth || window.innerWidth;
	const height = canvas.clientHeight || window.innerHeight;

	canvas.width = Math.max(1, Math.floor(width * dpi));
	canvas.height = Math.max(1, Math.floor(height * dpi));

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
		}
	};
}
