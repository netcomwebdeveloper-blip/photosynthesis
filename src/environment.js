import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/* ============================================================================
   The forest
   ---------------------------------------------------------------------------
   v1_forest_terrain.glb, measured rather than guessed at. What the file turned
   out to be, and what each fact forced:

   • It is already in metres. Birch trees measure about 28 m tall, so nothing is
     rescaled. Normalising it to a fixed span — the obvious thing to do with an
     unknown model — would have shrunk those trees to about two metres.

   • Its origin is not a sensible place to stand. The ground near (0,0) sits at
     y ≈ -28.3 and slopes into a hill that fills the view. The flattest open
     clearing is at (-14, 10): within four metres of it the ground varies by
     less than half a metre and there is not one prop in the way. So the model
     is shifted to bring that clearing under the plant, rather than the plant
     being moved off into the woods.

   • Its bounding box is useless for height. The box top is +36 m, which is a
     mountain peak two hundred metres away, so aligning by the box would sink
     the forest by sixty metres. Ground height is found by casting a ray down
     at the spot the viewer actually stands.

   • It was 79 MB in 1250 draw calls, because the same tree geometry was
     duplicated once per instance. Deduplicated and GPU-instanced that is
     424 KB in 22 batches — but it is still a million triangles submitted, and
     that is the one number here that could undo the frame budget. Distance
     culling is the fix: within 80 m only about a third of them remain.

   The terrain receives shadow and never casts one; casting would force the
   baked shadow map to re-render every frame.
   ========================================================================== */

export const TERRAIN = {
    url: './assets/v1_forest_terrain.opt.glb',

    /* The measured clearing, in the file's own coordinates. The model is
       translated so this point lands under the viewer. */
    clearing: { x: -14.0, z: 10.0 },

    /* Ground height there. Used only if the raycast misses. */
    fallbackGroundY: -28.33,

    /* Sink the terrain slightly so nothing pokes up through the lawn the plant
       stands on. Ground within 4 m peaks at +0.30 m relative to the clearing,
       so half a metre clears it with room to spare. */
    groundDrop: 0.5,

    alignByRaycast: true,
    yawDegrees: 0,

    /* Culling. keepRadius is the hard limit; past thinBeyond only a fraction of
       the small scattered props survive. */
    keepRadius: 88,
    thinBeyond: 46,
    keepFraction: 0.55,
    clearRadius: 4.6,        // nothing at all this close to the plant

    fog: { color: 0xcfe9f5, near: 26, far: 96 }
};

export class Environment {
    constructor(scene, { renderer = null } = {}) {
        this.scene = scene;
        this.renderer = renderer;
        this.root = new THREE.Group();
        this.root.name = 'environment';
        this.scene.add(this.root);

        this.model = null;
        this.loaded = false;
        this.groundY = 0;

        this._ray = new THREE.Raycaster();
        this._down = new THREE.Vector3(0, -1, 0);
        this._m = new THREE.Matrix4();
        this._p = new THREE.Vector3();
    }

    #loader() {
        const loader = new GLTFLoader();
        try {
            // The optimised file is Draco-compressed, so this is required
            // rather than a nicety — without it the load fails obscurely.
            const draco = new DRACOLoader();
            draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
            loader.setDRACOLoader(draco);
        } catch (_) { /* an uncompressed source file still loads */ }
        return loader;
    }

    /** @returns {Promise<boolean>} false → caller keeps whatever ground it had. */
    async load(url = TERRAIN.url) {
        try {
            const gltf = await this.#loader().loadAsync(url);
            this.model = gltf.scene;
        } catch (err) {
            console.warn('[env] terrain failed to load, keeping fallback ground:', err);
            return false;
        }

        this.#prepare(this.model);

        // Bring the measured clearing to the origin first, so the ray is cast
        // straight down at the viewer's feet.
        this.model.position.set(-TERRAIN.clearing.x, 0, -TERRAIN.clearing.z);
        this.root.rotation.y = THREE.MathUtils.degToRad(TERRAIN.yawDegrees);
        this.root.add(this.model);
        this.root.updateMatrixWorld(true);

        const ground = TERRAIN.alignByRaycast ? this.#sampleGround(0, 0) : null;
        if (ground === null && TERRAIN.alignByRaycast) {
            console.warn('[env] ground raycast missed, using measured fallback');
        }
        this.groundY = ground ?? TERRAIN.fallbackGroundY;

        this.model.position.y = -this.groundY - TERRAIN.groundDrop;
        this.root.updateMatrixWorld(true);

        this.cull();

        if (TERRAIN.fog) {
            this.scene.fog = new THREE.Fog(TERRAIN.fog.color, TERRAIN.fog.near, TERRAIN.fog.far);
        }

        console.log('[env] terrain ready — ground %s m, %s meshes',
            this.groundY.toFixed(2), this.#countMeshes());
        this.loaded = true;
        return true;
    }

    /** Highest surface directly under (x, z), or null if the ray misses. */
    #sampleGround(x, z) {
        this._ray.set(new THREE.Vector3(x, 400, z), this._down);
        this._ray.far = 1000;
        const hits = this._ray.intersectObject(this.model, true);
        if (!hits.length) return null;
        // Mountains are hollow shells, so skip anything absurdly high above the
        // play area before trusting a hit.
        for (const h of hits) if (h.point.y < 200) return h.point.y;
        return hits[0].point.y;
    }

    #prepare(model) {
        model.traverse((node) => {
            if (!node.isMesh) return;
            node.castShadow = false;
            node.receiveShadow = true;
            node.frustumCulled = true;
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            for (const m of mats) {
                if (m?.map) m.map.anisotropy = 4;
            }
        });
    }

    #countMeshes() {
        let n = 0;
        this.model.traverse((o) => { if (o.isMesh && o.visible) n++; });
        return n;
    }

    /**
     * Distance culling — the difference between a million triangles and roughly
     * a third of that, for one pass at load time.
     *
     * Instances are compacted to the front of the buffer and `count` lowered,
     * so the geometry is untouched and only the matrix array is re-uploaded.
     */
    cull(at = new THREE.Vector3(0, 0, 0)) {
        if (!this.model) return;
        this.root.updateMatrixWorld(true);

        let before = 0, after = 0;
        this.model.traverse((node) => {
            if (node.isInstancedMesh) {
                const arr = node.instanceMatrix.array;
                const total = node.userData.sourceCount ?? node.count;
                node.userData.sourceCount = total;
                let kept = 0;
                before += total;

                for (let i = 0; i < total; i++) {
                    this._m.fromArray(arr, i * 16);
                    this._p.setFromMatrixPosition(this._m).applyMatrix4(node.matrixWorld);
                    const d = Math.hypot(this._p.x - at.x, this._p.z - at.z);

                    if (d > TERRAIN.keepRadius) continue;
                    if (d < TERRAIN.clearRadius) continue;
                    // Deterministic thinning. A random draw here would give a
                    // different forest on every reload.
                    if (d > TERRAIN.thinBeyond &&
                        ((i * 2654435761) % 1000) / 1000 > TERRAIN.keepFraction) continue;

                    if (kept !== i) {
                        for (let k = 0; k < 16; k++) arr[kept * 16 + k] = arr[i * 16 + k];
                    }
                    kept++;
                }
                node.count = kept;
                after += kept;
                node.instanceMatrix.needsUpdate = true;
                node.computeBoundingSphere?.();
            } else if (node.isMesh) {
                // The handful of one-off meshes: ground shells, and a stray 2 m
                // cube sitting at the source file's origin.
                if (!node.geometry.boundingSphere) node.geometry.computeBoundingSphere();
                const s = node.geometry.boundingSphere;
                if (!s) return;
                this._p.copy(s.center).applyMatrix4(node.matrixWorld);
                const scale = Math.max(node.scale.x, node.scale.z);
                const d = Math.hypot(this._p.x - at.x, this._p.z - at.z);
                const r = s.radius * scale;
                node.visible = !(d - r > TERRAIN.keepRadius) && !(r < 3 && d < TERRAIN.clearRadius);
            }
        });
        console.log('[env] instances %d → %d', before, after);
    }

    /** Matches the app's adaptive quality step. */
    setQuality(level) {
        if (level !== 'low' || !this.model) return;
        TERRAIN.keepRadius = Math.min(TERRAIN.keepRadius, 52);
        TERRAIN.thinBeyond = 26;
        TERRAIN.keepFraction = 0.3;
        this.cull();
        this.model.traverse((n) => { if (n.isMesh) n.receiveShadow = false; });
        if (this.scene.fog) this.scene.fog.far = Math.min(this.scene.fog.far, 56);
    }

    dispose() {
        this.root.traverse((n) => {
            if (n.isMesh) {
                n.geometry?.dispose();
                const mats = Array.isArray(n.material) ? n.material : [n.material];
                mats.forEach((m) => m?.dispose());
            }
        });
        this.scene.remove(this.root);
    }
}
