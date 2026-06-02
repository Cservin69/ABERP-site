// @ts-nocheck
// Vendored & adapted from https://github.com/codrops/RainEffect — see LICENSE.
// Adaptations: shader strings passed in (no glslify), exposed destroy()+resize()
// for SPA cleanup, explicit gl.viewport() so the drawingbuffer fills the canvas.

import GL from './gl-obj.js';
import { createCanvas } from './util.js';

const defaultOptions = {
	renderShadow: false,
	minRefraction: 256,
	maxRefraction: 512,
	brightness: 1,
	alphaMultiply: 20,
	alphaSubtract: 5,
	parallaxBg: 5,
	parallaxFg: 20
};

function RainRenderer(
	canvas,
	canvasLiquid,
	imageFg,
	imageBg,
	imageShine,
	vertShader,
	fragShader,
	options = {}
) {
	this.canvas = canvas;
	this.canvasLiquid = canvasLiquid;
	this.imageShine = imageShine;
	this.imageFg = imageFg;
	this.imageBg = imageBg;
	this.vertShader = vertShader;
	this.fragShader = fragShader;
	this.options = Object.assign({}, defaultOptions, options);
	this.rafId = null;
	this._stopped = false;
	this.init();
}

RainRenderer.prototype = {
	canvas: null,
	gl: null,
	canvasLiquid: null,
	width: 0,
	height: 0,
	imageShine: null,
	imageFg: null,
	imageBg: null,
	textures: null,
	programWater: null,
	parallaxX: 0,
	parallaxY: 0,
	options: null,
	init() {
		this.width = this.canvas.width;
		this.height = this.canvas.height;
		this.gl = new GL(this.canvas, { alpha: false }, this.vertShader, this.fragShader);
		const gl = this.gl;
		this.programWater = gl.program;

		gl.gl.viewport(0, 0, this.width, this.height);
		gl.createUniform('2f', 'resolution', this.width, this.height);
		gl.createUniform('1f', 'textureRatio', this.imageBg.width / this.imageBg.height);
		gl.createUniform('1i', 'renderShine', this.imageShine == null ? false : true);
		gl.createUniform('1i', 'renderShadow', this.options.renderShadow);
		gl.createUniform('1f', 'minRefraction', this.options.minRefraction);
		gl.createUniform(
			'1f',
			'refractionDelta',
			this.options.maxRefraction - this.options.minRefraction
		);
		gl.createUniform('1f', 'brightness', this.options.brightness);
		gl.createUniform('1f', 'alphaMultiply', this.options.alphaMultiply);
		gl.createUniform('1f', 'alphaSubtract', this.options.alphaSubtract);
		gl.createUniform('1f', 'parallaxBg', this.options.parallaxBg);
		gl.createUniform('1f', 'parallaxFg', this.options.parallaxFg);

		gl.createTexture(null, 0);

		this.textures = [
			{ name: 'textureShine', img: this.imageShine == null ? createCanvas(2, 2) : this.imageShine },
			{ name: 'textureFg', img: this.imageFg },
			{ name: 'textureBg', img: this.imageBg }
		];

		this.textures.forEach((texture, i) => {
			gl.createTexture(texture.img, i + 1);
			gl.createUniform('1i', texture.name, i + 1);
		});

		this.draw();
	},
	destroy() {
		this._stopped = true;
		if (this.rafId != null) cancelAnimationFrame(this.rafId);
		this.rafId = null;
	},
	resize(w, h) {
		this.width = w;
		this.height = h;
		this.gl.gl.viewport(0, 0, w, h);
		this.gl.useProgram(this.programWater);
		this.gl.createUniform('2f', 'resolution', w, h);
	},
	draw() {
		if (this._stopped) return;
		this.gl.useProgram(this.programWater);
		this.gl.createUniform('2f', 'parallax', this.parallaxX, this.parallaxY);
		this.updateTexture();
		this.gl.draw();
		this.rafId = requestAnimationFrame(this.draw.bind(this));
	},
	updateTextures() {
		this.textures.forEach((texture, i) => {
			this.gl.activeTexture(i + 1);
			this.gl.updateTexture(texture.img);
		});
	},
	updateTexture() {
		this.gl.activeTexture(0);
		this.gl.updateTexture(this.canvasLiquid);
	}
};

export default RainRenderer;
