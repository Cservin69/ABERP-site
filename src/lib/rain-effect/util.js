// @ts-nocheck
// Vendored & adapted from https://github.com/codrops/RainEffect — see LICENSE.

export function createCanvas(width, height) {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

export function random(from = null, to = null, interpolation = null) {
	if (from == null) {
		from = 0;
		to = 1;
	} else if (from != null && to == null) {
		to = from;
		from = 0;
	}
	const delta = to - from;
	if (interpolation == null) interpolation = (n) => n;
	return from + interpolation(Math.random()) * delta;
}

export function chance(c) {
	return random() <= c;
}

export function times(n, f) {
	for (let i = 0; i < n; i++) f.call(null, i);
}

export function loadImage(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.addEventListener('load', () => resolve(img));
		img.addEventListener('error', (e) => reject(e));
		img.src = src;
	});
}

export function loadImages(srcs) {
	return Promise.all(
		Object.entries(srcs).map(([name, src]) => loadImage(src).then((img) => [name, img]))
	).then((pairs) => Object.fromEntries(pairs));
}
