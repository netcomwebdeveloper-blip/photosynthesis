import * as THREE from 'three';
import { TextLabel } from './labels.js';

/* ============================================================================
   Leaving
   ---------------------------------------------------------------------------
   Two controls, because one is not enough:

   • A DOM button, for the flat page and for the moment right after a session
     ends. Fine on a desktop, invisible from inside a headset.
   • An in-world button, because from inside a headset the DOM does not exist.
     Without this, leaving means finding the system menu, which children do not.

   The in-world button is anchored to the rig, not to the camera. Head-locked UI
   follows your gaze, which means it can never be looked away from and it is the
   fastest route to making someone feel sick. Anchored to the rig it sits at a
   fixed spot at waist height on the right — glance down, point, gone — and the
   rest of the time it is out of the frame entirely.
   ========================================================================== */

const ANCHOR = { x: 0.46, y: 1.02, z: -0.62 };

export class ExitControl {
    constructor({ renderer, rig, interaction, audio }) {
        this.renderer = renderer;
        this.rig = rig;
        this.interaction = interaction;
        this.audio = audio;

        this.group = new THREE.Group();
        this.group.name = 'exit-control';
        this.group.position.set(ANCHOR.x, ANCHOR.y, ANCHOR.z);
        this.group.rotation.set(-0.42, -0.28, 0);   // tilted up towards the face
        this.group.visible = false;
        this.rig.add(this.group);

        this.hoverT = 0;
        this.target = 0;

        this.#buildPanel();
        this.#buildDom();

        renderer.xr.addEventListener('sessionstart', () => this.#onSession(true));
        renderer.xr.addEventListener('sessionend', () => this.#onSession(false));
    }

    #buildPanel() {
        // A rounded plate, unlike every label in the project — which is the
        // point. Labels are words floating in the world; this is a control, and
        // it should not be mistakable for part of the lesson.
        const shape = new THREE.Shape();
        const w = 0.30, h = 0.135, r = 0.045;
        shape.moveTo(-w / 2 + r, -h / 2);
        shape.lineTo(w / 2 - r, -h / 2);
        shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
        shape.lineTo(w / 2, h / 2 - r);
        shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
        shape.lineTo(-w / 2 + r, h / 2);
        shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
        shape.lineTo(-w / 2, -h / 2 + r);
        shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);

        this.plateMat = new THREE.MeshBasicMaterial({
            color: 0x1c3326, transparent: true, opacity: 0.92,
            depthWrite: false, side: THREE.DoubleSide, toneMapped: false
        });
        this.plate = new THREE.Mesh(new THREE.ShapeGeometry(shape), this.plateMat);
        this.plate.renderOrder = 14;
        this.group.add(this.plate);

        this.edgeMat = new THREE.MeshBasicMaterial({
            color: 0xffd98a, transparent: true, opacity: 0.5,
            depthWrite: false, side: THREE.DoubleSide, toneMapped: false
        });
        const edge = new THREE.Mesh(
            new THREE.ShapeGeometry(shape), this.edgeMat
        );
        edge.scale.set(1.07, 1.16, 1);
        edge.position.z = -0.002;
        edge.renderOrder = 13;
        this.group.add(edge);

        this.label = new TextLabel({
            text: 'Exit VR', worldWidth: 0.23, fontSize: 96,
            outlineWidth: 8, color: '#ffffff'
        });
        this.label.mesh.position.z = 0.004;
        this.label.mesh.renderOrder = 15;
        this.group.add(this.label.mesh);

        // The whole plate is the hit target, with generous padding — pointing a
        // controller accurately at a small target across a room is hard.
        this.hit = new THREE.Mesh(
            new THREE.PlaneGeometry(w * 1.5, h * 1.9),
            new THREE.MeshBasicMaterial({ visible: false })
        );
        this.hit.position.z = 0.01;
        this.group.add(this.hit);

        this.interaction?.register(this.hit, {
            onHover: () => { this.target = 1; },
            onBlur: () => { this.target = 0; },
            onSelect: () => this.exit()
        });
    }

    #buildDom() {
        let btn = document.getElementById('exit-vr');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'exit-vr';
            btn.type = 'button';
            btn.textContent = 'Exit VR';
            Object.assign(btn.style, {
                position: 'fixed', top: '18px', right: '18px', zIndex: '30',
                display: 'none', padding: '11px 20px', border: '0',
                borderRadius: '999px', cursor: 'pointer',
                font: '600 15px/1 "Baloo 2", "Segoe UI Rounded", Verdana, sans-serif',
                letterSpacing: '0.01em',
                color: '#f4fff8', background: 'rgba(20, 48, 33, 0.86)',
                boxShadow: '0 6px 20px rgba(8, 26, 16, 0.34)',
                backdropFilter: 'blur(6px)'
            });
            document.body.appendChild(btn);
        }
        btn.addEventListener('click', () => this.exit());
        this.dom = btn;
    }

    #onSession(active) {
        this.group.visible = active;
        if (this.dom) this.dom.style.display = active ? 'block' : 'none';
        if (!active) { this.target = 0; this.hoverT = 0; }
    }

    exit() {
        this.audio?.sfx('click');
        const session = this.renderer.xr.getSession();
        if (session) session.end().catch((e) => console.warn('[xr] exit failed', e));
    }

    update(dt) {
        if (!this.group.visible) return;
        this.hoverT += (this.target - this.hoverT) * Math.min(dt * 10, 1);
        this.plateMat.color.setHSL(0.38, 0.30, 0.14 + this.hoverT * 0.22);
        this.edgeMat.opacity = 0.5 + this.hoverT * 0.45;
        this.group.scale.setScalar(1 + this.hoverT * 0.08);
    }

    dispose() {
        this.interaction?.unregister(this.hit);
        this.label.dispose();
        this.plate.geometry.dispose();
        this.plateMat.dispose();
        this.edgeMat.dispose();
    }
}
