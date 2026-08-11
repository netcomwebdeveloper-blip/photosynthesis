import * as THREE from 'three';

/**
 * In-world typography.
 *
 * Every label is glyphs on a fully transparent canvas with a dark contour and a
 * soft shadow. No card, no plate, no strip behind the words — a label is the
 * word itself. Contrast comes from the outline, which works over sky, foliage
 * and soil alike.
 */

/**
 * Both faces resolve to Baloo 2, the rounded face the page loads. Keeping the
 * canvas font stack in step with the <link> matters: a canvas silently falls
 * back to a default face if the webfont has not arrived, and label textures are
 * baked exactly once, so a mismatch is permanent for that session.
 */
export const DISPLAY_FONT = '"Baloo 2", "Segoe UI Rounded", "Trebuchet MS", Verdana, sans-serif';
export const UI_FONT = '"Baloo 2", "Segoe UI Rounded", "Trebuchet MS", Verdana, sans-serif';

let fontsReady = false;

/**
 * Canvas text silently falls back to a default face if the webfont has not
 * finished loading, and the texture is baked once — so wait before drawing.
 */
export async function whenFontsReady() {
    if (fontsReady) return;
    try {
        if (document.fonts?.ready) await document.fonts.ready;
    } catch (_) { /* older browsers: fall through with the fallback stack */ }
    fontsReady = true;
}

export class TextLabel {
    constructor({
        text = '',
        worldWidth = 1.2,
        canvasWidth = 1024,
        fontSize = 110,
        font = DISPLAY_FONT,
        weight = 700,
        color = '#ffffff',
        outline = 'rgba(10, 26, 16, 0.94)',
        outlineWidth = 12,
        lines = 1,
        lineHeight = 1.22,
        align = 'center',
        shadow = true
    } = {}) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = canvasWidth;
        this.canvas.height = Math.ceil(fontSize * lineHeight * lines + fontSize * 0.7);
        this.ctx = this.canvas.getContext('2d');

        Object.assign(this, {
            fontSize, font, weight, color, outline, outlineWidth,
            maxLines: lines, lineHeight, align, shadow
        });

        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.colorSpace = THREE.SRGBColorSpace;
        this.texture.anisotropy = 8;
        this.texture.minFilter = THREE.LinearMipmapLinearFilter;
        this.texture.magFilter = THREE.LinearFilter;

        this.material = new THREE.MeshBasicMaterial({
            map: this.texture,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false
        });

        this.worldWidth = worldWidth;
        const height = worldWidth * (this.canvas.height / this.canvas.width);
        this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldWidth, height), this.material);
        this.mesh.renderOrder = 8;
        this.mesh.userData.isLabel = true;

        this.setText(text);
    }

    setText(text) {
        const value = text ?? '';
        if (value === this.text) return;
        this.text = value;

        const { ctx, canvas } = this;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = `${this.weight} ${this.fontSize}px ${this.font}`;
        ctx.textAlign = this.align;
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;

        const pad = this.outlineWidth * 2;
        const maxWidth = canvas.width - pad * 2;
        const rows = this.#wrap(String(value), maxWidth).slice(0, this.maxLines);
        const stepY = this.fontSize * this.lineHeight;
        const x = this.align === 'left' ? pad : this.align === 'right' ? canvas.width - pad : canvas.width / 2;
        let y = canvas.height / 2 - ((rows.length - 1) * stepY) / 2;

        for (const row of rows) {
            if (this.shadow) {
                ctx.shadowColor = 'rgba(4, 18, 10, 0.55)';
                ctx.shadowBlur = this.fontSize * 0.22;
                ctx.shadowOffsetY = this.fontSize * 0.05;
            }
            ctx.lineWidth = this.outlineWidth;
            ctx.strokeStyle = this.outline;
            ctx.strokeText(row, x, y);

            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            ctx.fillStyle = this.color;
            ctx.fillText(row, x, y);
            y += stepY;
        }

        this.texture.needsUpdate = true;
    }

    setColor(color) {
        this.color = color;
        const cached = this.text;
        this.text = null;
        this.setText(cached);
    }

    setOpacity(value) {
        this.material.opacity = value;
        this.mesh.visible = value > 0.01;
    }

    #wrap(text, maxWidth) {
        const words = text.split(/\s+/).filter(Boolean);
        if (!words.length) return [''];
        const rows = [];
        let line = words[0];
        for (let i = 1; i < words.length; i++) {
            const test = `${line} ${words[i]}`;
            if (this.ctx.measureText(test).width > maxWidth) {
                rows.push(line);
                line = words[i];
            } else {
                line = test;
            }
        }
        rows.push(line);
        return rows;
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.dispose();
        this.texture.dispose();
    }
}

/**
 * Yaw-only billboarding. Labels stay upright — full billboarding tips text
 * backwards when you look down at it, which reads badly.
 */
export class BillboardSet {
    constructor() {
        this.items = [];
        this._head = new THREE.Vector3();
        this._world = new THREE.Vector3();
    }

    add(object3D) {
        this.items.push(object3D);
        return object3D;
    }

    update(camera) {
        if (!camera || !this.items.length) return;
        camera.getWorldPosition(this._head);
        for (const obj of this.items) {
            if (!obj.visible) continue;
            obj.getWorldPosition(this._world);
            obj.rotation.y = Math.atan2(this._head.x - this._world.x, this._head.z - this._world.z);
        }
    }
}
