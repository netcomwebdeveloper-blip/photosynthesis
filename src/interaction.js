import * as THREE from 'three';

/* ============================================================================
   Pointing at things
   ---------------------------------------------------------------------------
   One raycaster, two input paths, identical callbacks. On a flat screen the ray
   comes from the mouse through the camera; in a headset it comes from whichever
   controller is being used. Nothing else in the project needs to know which.

   Registration is by mesh. Hover and select are separate so a target can grow
   under the ray before it is pressed — in VR that growth is the only depth cue
   telling you the ray has actually landed on something.
   ========================================================================== */

export class Interaction {
    constructor(renderer, camera, scene) {
        this.renderer = renderer;
        this.camera = camera;
        this.scene = scene;

        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2(-2, -2);   // offscreen until moved
        this.targets = new Map();                    // mesh -> handlers
        this.hovered = null;
        this.enabled = true;

        this._m = new THREE.Matrix4();
        this._hits = [];

        this.controllers = [];
        this.#initMouse();
        this.#initControllers();
    }

    #initMouse() {
        const el = this.renderer.domElement;
        el.addEventListener('pointermove', (e) => {
            this.pointer.set(
                (e.clientX / window.innerWidth) * 2 - 1,
                -(e.clientY / window.innerHeight) * 2 + 1
            );
        });
        el.addEventListener('pointerdown', () => {
            if (!this.renderer.xr.isPresenting) this.#select();
        });
    }

    #initControllers() {
        // A thin line is enough. A full laser with a reticle costs draw calls
        // and this scene is already budgeting frames carefully.
        const geo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)
        ]);

        for (let i = 0; i < 2; i++) {
            const controller = this.renderer.xr.getController(i);
            const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false
            }));
            line.name = 'ray';
            line.scale.z = 4;
            line.renderOrder = 12;
            controller.add(line);
            controller.userData.active = false;

            controller.addEventListener('connected', () => { controller.userData.active = true; });
            controller.addEventListener('disconnected', () => { controller.userData.active = false; });
            controller.addEventListener('selectstart', () => {
                this.active = controller;
                this.#select();
            });

            this.controllers.push(controller);
        }
    }

    /** Controllers live under the rig so they inherit the viewer's position. */
    attachTo(rig) {
        this.controllers.forEach((c) => rig.add(c));
    }

    /**
     * @param {THREE.Object3D} mesh    the thing to point at
     * @param {object} handlers        { onSelect, onHover, onBlur, enabled }
     */
    register(mesh, handlers = {}) {
        this.targets.set(mesh, handlers);
        mesh.userData.interactive = true;
        return mesh;
    }

    unregister(mesh) {
        if (this.hovered === mesh) this.#blur();
        this.targets.delete(mesh);
    }

    clear() {
        this.#blur();
        this.targets.clear();
    }

    #list() {
        const out = [];
        for (const [mesh, h] of this.targets) {
            if (h.enabled === false) continue;
            if (!mesh.visible) continue;
            // A parent faded to nothing should not still be clickable.
            let node = mesh, shown = true;
            while (node) { if (!node.visible) { shown = false; break; } node = node.parent; }
            if (shown) out.push(mesh);
        }
        return out;
    }

    #cast() {
        const list = this.#list();
        if (!list.length) return null;

        if (this.renderer.xr.isPresenting) {
            const c = this.active && this.active.userData.active
                ? this.active
                : this.controllers.find((x) => x.userData.active);
            if (!c) return null;
            this._m.identity().extractRotation(c.matrixWorld);
            this.raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
            this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this._m);
        } else {
            if (this.pointer.x < -1.5) return null;
            this.raycaster.setFromCamera(this.pointer, this.camera);
        }

        this._hits.length = 0;
        this.raycaster.intersectObjects(list, true, this._hits);
        if (!this._hits.length) return null;

        // Hits can land on a child mesh; walk up to the registered ancestor.
        let node = this._hits[0].object;
        while (node && !this.targets.has(node)) node = node.parent;
        return node || null;
    }

    #blur() {
        if (!this.hovered) return;
        this.targets.get(this.hovered)?.onBlur?.(this.hovered);
        this.hovered = null;
    }

    #select() {
        if (!this.enabled) return;
        const hit = this.hovered || this.#cast();
        if (!hit) return;
        this.targets.get(hit)?.onSelect?.(hit);
    }

    update() {
        if (!this.enabled) { this.#blur(); return; }
        const hit = this.#cast();
        if (hit === this.hovered) return;
        this.#blur();
        if (hit) {
            this.hovered = hit;
            this.targets.get(hit)?.onHover?.(hit);
        }
    }
}

/* -------------------------------------------------------------------------- */

/**
 * A round in-world button: a disc, a ring that lights on hover, and a label.
 * Used for the exit control and for every hotspot in the root lab, so pressing
 * anything in this project feels the same.
 */
export class Hotspot {
    constructor({
        label = '',
        radius = 0.09,
        color = 0x8fe3c0,
        hoverColor = 0xffffff,
        labelFactory = null,
        labelOffset = 0.17,
        labelWidth = 0.62
    } = {}) {
        this.group = new THREE.Group();
        this.color = new THREE.Color(color);
        this.hoverColor = new THREE.Color(hoverColor);

        this.disc = new THREE.Mesh(
            new THREE.CircleGeometry(radius, 28),
            new THREE.MeshBasicMaterial({
                color: this.color, transparent: true, opacity: 0.9,
                depthWrite: false, side: THREE.DoubleSide, toneMapped: false
            })
        );
        this.disc.renderOrder = 9;
        this.group.add(this.disc);

        this.ring = new THREE.Mesh(
            new THREE.RingGeometry(radius * 1.16, radius * 1.34, 32),
            new THREE.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0.0,
                depthWrite: false, side: THREE.DoubleSide, toneMapped: false
            })
        );
        this.ring.renderOrder = 9;
        this.group.add(this.ring);

        if (labelFactory && label) {
            this.label = labelFactory({ text: label, worldWidth: labelWidth });
            this.label.mesh.position.y = labelOffset;
            this.group.add(this.label.mesh);
        }

        this.hoverT = 0;
        this.pulse = 0;
        this.done = false;
    }

    setHover(on) { this.target = on ? 1 : 0; }

    press() { this.pulse = 1; }

    /** Marks a hotspot as already visited — it dims but stays pressable. */
    markDone() {
        this.done = true;
        this.disc.material.opacity = 0.4;
        if (this.label) this.label.setOpacity(0.55);
    }

    setOpacity(v) {
        this.disc.material.opacity = v * (this.done ? 0.4 : 0.9);
        this.ring.material.opacity = v * this.hoverT * 0.9;
        if (this.label) this.label.setOpacity(v * (this.done ? 0.55 : 1));
        this.group.visible = v > 0.01;
    }

    update(dt) {
        this.hoverT += ((this.target || 0) - this.hoverT) * Math.min(dt * 9, 1);
        this.ring.material.opacity = this.hoverT * 0.9;
        this.pulse = Math.max(0, this.pulse - dt * 3.2);
        const s = 1 + this.hoverT * 0.18 + this.pulse * 0.3;
        this.disc.scale.setScalar(s);
        this.ring.scale.setScalar(s);
        this.disc.material.color.lerpColors(this.color, this.hoverColor, this.hoverT);
    }

    dispose() {
        this.disc.geometry.dispose();
        this.disc.material.dispose();
        this.ring.geometry.dispose();
        this.ring.material.dispose();
        this.label?.dispose();
    }
}
