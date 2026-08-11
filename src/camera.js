import * as THREE from 'three';
import { Ease } from './tween.js';

/* ============================================================================
   Camera direction
   ---------------------------------------------------------------------------
   THE ONE RULE: this class does nothing at all while an XR session is
   presenting.

   On a flat screen the camera is a film camera — it drifts in for the close-up
   on the leaf and pulls back out for the finale, which is what the brief asks
   for. In a headset the camera belongs to the headset. Moving it there means
   moving someone's head for them, and the result is the exact up-and-down
   swimming we spent the last project eliminating. Even a slow, smooth push-in
   reads as the world sliding around you.

   So the story never depends on camera movement to make sense. When it wants a
   close-up, the subject grows and floats towards the viewer instead — the same
   staging works in both modes, and only the flat build also moves the camera.
   ========================================================================== */

export class CameraDirector {
    constructor(camera, renderer, tweener) {
        this.camera = camera;
        this.renderer = renderer;
        this.tweener = tweener;

        this.position = new THREE.Vector3(0, 1.75, 6.4);
        this.target = new THREE.Vector3(0, 1.5, 0);

        // A little parallax so a flat screen never feels locked off.
        this.pointer = new THREE.Vector2(0, 0);
        this.smoothPointer = new THREE.Vector2(0, 0);
        this.parallax = 0.5;

        this._pos = new THREE.Vector3();
        this._look = new THREE.Vector3();

        window.addEventListener('pointermove', (e) => {
            this.pointer.set(
                (e.clientX / window.innerWidth) * 2 - 1,
                (e.clientY / window.innerHeight) * 2 - 1
            );
        });
    }

    get active() {
        return !this.renderer.xr.isPresenting;
    }

    /** Moves to a new shot. Resolves immediately (no wait) when in XR. */
    async moveTo({ pos, target, seconds = 3.0, ease = Ease.inOutCubic }) {
        const toPos = new THREE.Vector3().fromArray(pos);
        const toTarget = new THREE.Vector3().fromArray(target);

        if (!this.active) {
            // Keep the bookkeeping in step so leaving VR lands on the right shot.
            this.position.copy(toPos);
            this.target.copy(toTarget);
            return;
        }

        const fromPos = this.position.clone();
        const fromTarget = this.target.clone();

        await this.tweener.add(seconds, (p) => {
            if (!this.active) return;   // entered VR mid-move: stop touching it
            this.position.lerpVectors(fromPos, toPos, p);
            this.target.lerpVectors(fromTarget, toTarget, p);
        }, ease);

        this.position.copy(toPos);
        this.target.copy(toTarget);
    }

    update(dt) {
        if (!this.active) return;

        this.smoothPointer.x += (this.pointer.x - this.smoothPointer.x) * Math.min(dt * 2.5, 1);
        this.smoothPointer.y += (this.pointer.y - this.smoothPointer.y) * Math.min(dt * 2.5, 1);

        this._pos.copy(this.position);
        this._pos.x += this.smoothPointer.x * this.parallax;
        this._pos.y += -this.smoothPointer.y * this.parallax * 0.45;

        this.camera.position.copy(this._pos);
        this._look.copy(this.target);
        this.camera.lookAt(this._look);
    }

    /** Called when a session ends, so the flat camera resumes cleanly. */
    resync() {
        this.smoothPointer.set(0, 0);
    }
}
