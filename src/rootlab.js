import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TextLabel } from './labels.js';
import { Ease } from './tween.js';
import { Hotspot } from './interaction.js';
import { VIEWER_SPOT } from './world.js';

/* ============================================================================
   The root lab
   ---------------------------------------------------------------------------
   Beat 3 used to be one sentence: roots drink water. This turns it into the
   part of the lesson a child touches.

   WHAT THE MODEL ACTUALLY IS
   plant_cross_section.glb is not a round cross-section. It is a rectangular
   block, about 1.96 × 1.15 × 1.99 in its own units, cut open on its +Z face,
   with the tissue layered along X. Reading from the soil inwards, the bands
   were measured off the texture rather than guessed:

       x  +0.99 … +0.26   soil, with one root hair reaching out into it
       x  +0.26 … +0.08   epidermis — the big outer cells
       x  +0.08 … -0.52   cortex — the honeycomb
       x  -0.52 … -0.59   endodermis — the pale striped band
       x  -0.59 … -0.85   xylem and vascular tissue

   Those are stored below as fractions of the block's width, so they survive
   whatever scale it ends up displayed at.

   This geometry is a gift, because it makes the journey a straight line: water
   enters at the right, crosses each band in turn, reaches the xylem at the
   left, and only then turns and rises. A child can follow that with a finger.
   Particles float just in front of the cut face rather than inside the block —
   the classic diagram trick, and it means nothing is ever hidden by the solid
   geometry it is meant to be explaining.

   WHAT CAN BE PRESSED
     Root hairs    — why the surface is huge
     Osmosis       — water crosses on its own, more to less, no energy spent
     Mineral ions  — the opposite case, and the reason osmosis means something:
                     there are already more ions inside than out, so drifting
                     would carry them the wrong way, and the root has to spend
                     energy pulling them in
     Xylem         — where it all goes

   The two middle ideas sit next to each other on purpose, and the animation
   carries the contrast so the narration does not have to: water drifts
   smoothly and pinches as it squeezes through the membrane, ions stutter
   inward in discrete pumped hops with a beat of work behind each one.

   The block comes to the viewer and floats up to chest height. Nobody's head
   is moved — the same rule the beat 5 close-up follows.
   ========================================================================== */

export const ROOT_POSE = {
    url: './assets/plant_cross_section.opt.glb',
    anchor: new THREE.Vector3(0.95, 0.0, 2.15),   // viewer side of the plant, clear of the leaves
    riseTo: 1.30,                                  // final centre height, metres
    targetWidth: 0.95,                             // block is scaled to this

    /* Turn the cut face towards where the viewer actually stands, rather than
       towards the world's Z axis. Square-on to Z, the viewer sees this 0.96 m
       deep block at about 33 degrees and most of what they get is the plain
       brown soil side. Computed from VIEWER_SPOT so moving the anchor keeps
       it honest; set faceViewer false to use yawDegrees directly. */
    faceViewer: true,
    yawDegrees: 0
};

/* Bands as fractions of block width: 0 is the xylem end, 1 the outer soil. */
const U = {
    soilEdge: 1.00,
    epiOuter: 0.628,   // root surface — where soil ends
    epiInner: 0.536,
    cortex: 0.230,
    endoInner: 0.194,  // the Casparian strip
    xylem: 0.128
};

const WATER_COUNT = 130;
const ION_COUNT = 30;
const TOPICS = ['hair', 'osmosis', 'ions', 'xylem'];

const SCRIPT = {
    hair: {
        title: 'Root hairs',
        caption: 'Root hairs give the root a huge surface to drink from.',
        speech: 'See that thin hair reaching out into the soil? Each root hair is one long cell. Thousands of them together give the root an enormous surface, so it can take in far more water than a smooth root ever could.',
        band: [U.epiOuter, U.soilEdge]
    },
    osmosis: {
        title: 'Osmosis',
        caption: 'Water moves in by osmosis — nothing pushes it.',
        speech: 'There is more water out in the soil than inside the root cell, so water drifts across the cell membrane all by itself, from where there is more to where there is less. That is osmosis, and the root spends no energy on it at all.',
        band: [U.epiInner, U.epiOuter]
    },
    ions: {
        title: 'Mineral ions',
        caption: 'Minerals get pumped in — and that costs energy.',
        speech: 'Minerals are different. There are already more mineral ions inside the root than out in the soil, so drifting would carry them the wrong way. The root has to spend energy pumping them in against the flow. This is called active transport.',
        band: [U.endoInner, U.cortex]
    },
    xylem: {
        title: 'Xylem',
        caption: 'Water travels up the xylem to the leaves.',
        speech: 'Once inside, water passes from cell to cell across the cortex until it reaches the xylem. These tubes carry it all the way up the stem to the leaves, where the tiny kitchen is waiting.',
        band: [0.02, U.endoInner]
    }
};

export class RootLab {
    constructor({ scene, tweener, audio, interaction, billboards = null }) {
        this.scene = scene;
        this.tweener = tweener;
        this.audio = audio;
        this.interaction = interaction;
        this.billboards = billboards;

        this.group = new THREE.Group();
        this.group.name = 'root-lab';
        this.group.position.copy(ROOT_POSE.anchor);
        this.group.rotation.y = ROOT_POSE.faceViewer
            ? Math.atan2(VIEWER_SPOT.x - ROOT_POSE.anchor.x, VIEWER_SPOT.z - ROOT_POSE.anchor.z)
            : THREE.MathUtils.degToRad(ROOT_POSE.yawDegrees);
        this.group.visible = false;
        this.scene.add(this.group);

        this.opacity = 0;
        this.fadeables = [];
        this.hotspots = new Map();
        this.bands = new Map();

        this.flow = { water: 0, ions: 0, xylem: 0, hairs: 0 };
        this.talking = false;
        this.armed = false;
        this.idle = 0;
        this.elapsedLesson = 0;
        this.cap = 110;
        this.seen = new Set();

        // Block dimensions in metres, filled in once the model is measured.
        this.W = ROOT_POSE.targetWidth;
        this.H = 0.56;
        this.D = 0.96;

        this._v = new THREE.Vector3();
        this._m = new THREE.Matrix4();
        this._q = new THREE.Quaternion();
        this._s = new THREE.Vector3(1, 1, 1);
        this._axis = new THREE.Vector3(0.3, 1, 0.2).normalize();
    }

    /* ----------------------------------------------------------- geometry */

    /** u (0 = xylem end, 1 = soil edge) → local x in metres. */
    #x(u) { return (u - 0.5) * this.W; }
    /** v (0 = bottom, 1 = top) → local y in metres. */
    #y(v) { return (v - 0.5) * this.H; }
    /** Particles ride just in front of the cut face. */
    get #z() { return this.D * 0.5 + this.W * 0.03; }

    /* ----------------------------------------------------------- building */

    async build() {
        const ok = await this.#loadModel();
        if (!ok) this.#buildFallback();
        this.#buildBands();
        this.#buildWater();
        this.#buildIons();
        this.#buildHotspots();
        this.#buildCaption();
        this.setOpacity(0);
    }

    async #loadModel() {
        try {
            const loader = new GLTFLoader();
            try {
                const draco = new DRACOLoader();
                draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
                loader.setDRACOLoader(draco);
            } catch (_) {}
            const gltf = await loader.loadAsync(ROOT_POSE.url);
            const model = gltf.scene;

            const box = new THREE.Box3().setFromObject(model);
            const size = new THREE.Vector3();
            const center = new THREE.Vector3();
            box.getSize(size);
            box.getCenter(center);

            // Fit by width, because width is the axis the tissue bands run
            // along and the one the whole lesson is measured against.
            const scale = size.x > 0 ? ROOT_POSE.targetWidth / size.x : 1;
            model.scale.setScalar(scale);
            model.position.copy(center).multiplyScalar(-scale);

            this.W = size.x * scale;
            this.H = size.y * scale;
            this.D = size.z * scale;

            model.traverse((n) => {
                if (!n.isMesh) return;
                n.castShadow = false;
                n.receiveShadow = false;
                const mats = Array.isArray(n.material) ? n.material : [n.material];
                for (const m of mats) {
                    if (!m) continue;
                    m.transparent = true;
                    m.userData.baseOpacity = m.opacity ?? 1;
                    this.fadeables.push(m);
                }
            });

            this.model = model;
            this.group.add(model);
            console.log('[rootlab] block %s × %s × %s m',
                this.W.toFixed(2), this.H.toFixed(2), this.D.toFixed(2));
            return true;
        } catch (err) {
            console.warn('[rootlab] cross-section failed to load, using built-in:', err);
            return false;
        }
    }

    /**
     * If the glb is missing the lesson still runs: flat coloured bands in the
     * same proportions, so every position below still means what it says.
     */
    #buildFallback() {
        const model = new THREE.Group();
        this.W = ROOT_POSE.targetWidth; this.H = this.W * 0.586; this.D = this.W * 1.013;

        const band = (u0, u1, color) => {
            const w = (u1 - u0) * this.W;
            const m = new THREE.MeshStandardMaterial({
                color, roughness: 0.9, transparent: true, side: THREE.DoubleSide
            });
            m.userData.baseOpacity = 1;
            this.fadeables.push(m);
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, this.H, this.D), m);
            mesh.position.x = this.#x((u0 + u1) / 2);
            model.add(mesh);
        };
        band(U.epiOuter, U.soilEdge, 0x7a5a3c);
        band(U.epiInner, U.epiOuter, 0xcfe0b0);
        band(U.cortex, U.epiInner, 0xbcd9a6);
        band(U.endoInner, U.cortex, 0xe8e3d0);
        band(0.0, U.endoInner, 0x8fc4d8);

        this.model = model;
        this.group.add(model);
    }

    /** A soft vertical highlight over the band each idea is about. */
    #buildBands() {
        for (const key of TOPICS) {
            const [u0, u1] = SCRIPT[key].band;
            const mat = new THREE.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0,
                depthWrite: false, side: THREE.DoubleSide, toneMapped: false
            });
            const mesh = new THREE.Mesh(
                new THREE.PlaneGeometry((u1 - u0) * this.W, this.H * 1.04), mat
            );
            mesh.position.set(this.#x((u0 + u1) / 2), 0, this.#z - this.W * 0.012);
            mesh.renderOrder = 4;
            this.group.add(mesh);
            this.bands.set(key, { mesh, mat, lit: 0 });
        }
    }

    #buildWater() {
        const geo = new THREE.SphereGeometry(this.W * 0.016, 8, 6);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x6ec8ff, transparent: true, opacity: 0.95, toneMapped: false
        });
        this.water = new THREE.InstancedMesh(geo, mat, WATER_COUNT);
        this.water.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.water.frustumCulled = false;
        this.water.renderOrder = 6;
        this.group.add(this.water);

        this.waterState = [];
        for (let i = 0; i < WATER_COUNT; i++) this.waterState.push(this.#spawnWater(true));
    }

    #spawnWater(scatter) {
        return {
            v: 0.08 + Math.random() * 0.84,
            z: (Math.random() - 0.5) * 0.5,
            rise: 0,
            wobble: Math.random() * Math.PI * 2,
            speed: 0.13 + Math.random() * 0.1,
            p: scatter ? Math.random() * 0.3 : 0
        };
    }

    #buildIons() {
        const geo = new THREE.OctahedronGeometry(this.W * 0.021, 0);
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffc766, transparent: true, opacity: 0.98, toneMapped: false
        });
        this.ions = new THREE.InstancedMesh(geo, mat, ION_COUNT);
        this.ions.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.ions.frustumCulled = false;
        this.ions.renderOrder = 6;
        this.group.add(this.ions);

        this.ionState = [];
        for (let i = 0; i < ION_COUNT; i++) {
            this.ionState.push({
                v: 0.12 + Math.random() * 0.76,
                z: (Math.random() - 0.5) * 0.45,
                p: Math.random() * 0.25,
                hold: Math.random() * 1.4,
                spin: Math.random() * Math.PI * 2,
                pumped: 0
            });
        }
        this.ionPumpCooldown = 0;
    }

    #buildHotspots() {
        const labelFactory = ({ text, worldWidth }) => new TextLabel({
            text, worldWidth, fontSize: 92, outlineWidth: 10, lines: 1
        });

        const layout = {
            hair:    { u: 0.82, v: 1.30, color: 0xe9dcb4 },
            osmosis: { u: 0.60, v: -0.30, color: 0x6ec8ff },
            ions:    { u: 0.32, v: -0.30, color: 0xffc766 },
            xylem:   { u: 0.10, v: 1.30, color: 0x9ff0c8 }
        };

        for (const key of TOPICS) {
            const cfg = layout[key];
            const spot = new Hotspot({
                label: SCRIPT[key].title,
                radius: this.W * 0.062,
                color: cfg.color,
                labelFactory,
                labelWidth: this.W * 0.40,
                labelOffset: this.W * 0.11
            });
            spot.group.position.set(this.#x(cfg.u), this.#y(cfg.v), this.#z + this.W * 0.05);
            this.group.add(spot.group);
            this.billboards?.add(spot.group);
            this.hotspots.set(key, spot);

            this.interaction?.register(spot.disc, {
                onHover: () => { if (this.armed) spot.setHover(true); },
                onBlur: () => spot.setHover(false),
                onSelect: () => this.#press(key)
            });
        }

        // Deliberately last and deliberately plain: an exit from the lesson,
        // not one of the ideas in it.
        this.done = new Hotspot({
            label: 'Continue', radius: this.W * 0.055, color: 0xbfe4f2,
            labelFactory, labelWidth: this.W * 0.36, labelOffset: this.W * 0.10
        });
        this.done.group.position.set(this.#x(0.5), this.#y(-0.62), this.#z + this.W * 0.05);
        this.group.add(this.done.group);
        this.billboards?.add(this.done.group);
        this.interaction?.register(this.done.disc, {
            onHover: () => { if (this.armed) this.done.setHover(true); },
            onBlur: () => this.done.setHover(false),
            onSelect: () => this.#finish()
        });
    }

    #buildCaption() {
        this.caption = new TextLabel({
            text: '', worldWidth: this.W * 1.15, fontSize: 88, lines: 2,
            canvasWidth: 1024, outlineWidth: 11
        });
        this.caption.mesh.position.set(0, this.#y(1.62), this.#z);
        this.group.add(this.caption.mesh);
        this.billboards?.add(this.caption.mesh);
    }

    /* ------------------------------------------------------------ lesson */

    async show() {
        this.group.visible = true;
        this.group.position.copy(ROOT_POSE.anchor);
        this.audio?.sfx('rise');

        await this.tweener.add(1.5, (p) => {
            this.setOpacity(p);
            this.group.scale.setScalar(0.4 + p * 0.6);
            this.group.position.y = ROOT_POSE.anchor.y + p * ROOT_POSE.riseTo;
        }, Ease.outCubic);

        this.setOpacity(1);
        this.group.scale.setScalar(1);
    }

    async hide() {
        if (!this.group.visible) return;
        this.armed = false;
        this.#say('');
        await this.tweener.add(0.9, (p) => {
            this.setOpacity(1 - p);
            this.group.position.y = ROOT_POSE.anchor.y + (1 - p) * ROOT_POSE.riseTo;
        }, Ease.inOutCubic);

        this.setOpacity(0);
        this.group.visible = false;
        this.flow = { water: 0, ions: 0, xylem: 0, hairs: 0 };
        this.seen.clear();
        for (const b of this.bands.values()) { b.lit = 0; b.mat.opacity = 0; }
        for (const s of this.hotspots.values()) { s.done = false; s.setHover(false); }
    }

    /**
     * Opens the lesson to input and resolves when the viewer is finished —
     * Continue pressed, all four covered, or the cap reached. A guided showing
     * must not be able to stall here.
     */
    runLesson({ timeoutSeconds = 110 } = {}) {
        this.armed = true;
        this.idle = 0;
        this.elapsedLesson = 0;
        this.cap = timeoutSeconds;
        this.#say('Point and press to explore the root.');
        return new Promise((resolve) => { this.resolveLesson = resolve; });
    }

    #finish() {
        if (!this.armed) return;
        this.armed = false;
        this.audio?.sfx('click');
        const r = this.resolveLesson;
        this.resolveLesson = null;
        r?.();
    }

    async #press(key) {
        if (!this.armed || this.talking) return;   // one voice, always
        this.audio?.sfx('click');
        await this.teach(key);
    }

    /** Public, so the story can drive a topic without a press. */
    async teach(key) {
        const item = SCRIPT[key];
        if (!item) return;
        this.talking = true;
        this.idle = 0;

        const spot = this.hotspots.get(key);
        spot?.press();
        this.#say(item.caption);
        this.#applyFlow(key);

        await this.audio?.narrate(`root-${key}`, item.speech);

        spot?.markDone();
        this.seen.add(key);
        this.talking = false;

        if (this.seen.size === TOPICS.length && this.armed) {
            this.#say('Now the water is on its way to the leaves.');
            this.flow.xylem = 1;
        }
    }

    /** Each topic switches on the part of the simulation it describes. */
    #applyFlow(key) {
        const band = this.bands.get(key);
        if (band) band.lit = 1;
        if (key === 'hair') this.flow.hairs = 1;
        if (key === 'osmosis') { this.flow.hairs = 1; this.flow.water = 1; this.audio?.sfx('absorb'); }
        if (key === 'ions') { this.flow.ions = 1; this.audio?.sfx('pump'); }
        if (key === 'xylem') { this.flow.water = 1; this.flow.xylem = 1; this.audio?.sfx('rise'); }
    }

    #say(text) { this.caption?.setText(text); }

    /* ------------------------------------------------------------ visuals */

    setOpacity(v) {
        this.opacity = v;
        // Materials authored with their own alpha keep their ratio, so nothing
        // jumps to fully opaque on the way in.
        for (const m of this.fadeables) {
            if (m.userData.baseOpacity === undefined) m.userData.baseOpacity = m.opacity ?? 1;
            m.opacity = m.userData.baseOpacity * v;
        }
        if (this.water) this.water.material.opacity = 0.95 * v;
        if (this.ions) this.ions.material.opacity = 0.98 * v;
        for (const s of this.hotspots.values()) s.setOpacity(v);
        this.done?.setOpacity(v);
        this.caption?.setOpacity(v);
        this.group.visible = v > 0.01;
    }

    /** Progress 0..1 along the journey → u across the block. */
    #uAt(p) {
        if (p < 0.34) return THREE.MathUtils.lerp(U.soilEdge, U.epiOuter, p / 0.34);
        if (p < 0.50) return THREE.MathUtils.lerp(U.epiOuter, U.epiInner, (p - 0.34) / 0.16);
        if (p < 0.80) return THREE.MathUtils.lerp(U.epiInner, U.cortex, (p - 0.50) / 0.30);
        if (p < 0.90) return THREE.MathUtils.lerp(U.cortex, U.endoInner, (p - 0.80) / 0.10);
        return THREE.MathUtils.lerp(U.endoInner, U.xylem, (p - 0.90) / 0.10);
    }

    update(dt, elapsed) {
        if (!this.group.visible || this.opacity < 0.02) return;

        for (const s of this.hotspots.values()) s.update(dt);
        this.done?.update(dt);

        for (const b of this.bands.values()) {
            const want = b.lit ? 0.10 + Math.sin(elapsed * 2.4) * 0.045 : 0;
            b.mat.opacity += (want * this.opacity - b.mat.opacity) * Math.min(dt * 4, 1);
        }

        this.#updateWater(dt, elapsed);
        this.#updateIons(dt, elapsed);

        if (!this.armed) return;

        this.idle += dt;
        this.elapsedLesson += dt;

        // Patient, then helpful: after a quiet stretch the lesson shows the next
        // idea itself rather than waiting forever on an empty room. A press
        // always wins, because idle resets on every one.
        if (!this.talking && this.idle > 13) {
            const next = TOPICS.find((k) => !this.seen.has(k));
            if (next) this.teach(next);
            else this.#finish();
        }
        if (this.elapsedLesson > this.cap) this.#finish();
    }

    #updateWater(dt, elapsed) {
        const gate = this.flow.water;
        const z = this.#z;

        for (let i = 0; i < this.waterState.length; i++) {
            const w = this.waterState[i];

            if (w.rise > 0) {
                w.rise += dt * (0.45 + this.flow.xylem * 0.85);
                if (w.rise > 1) { this.waterState[i] = this.#spawnWater(false); continue; }
            } else {
                // Before osmosis is explained water only mills about in the
                // soil: the membrane is a wall until the idea arrives.
                const ceiling = gate ? 1 : 0.30;
                w.p = Math.min(w.p + dt * w.speed * (gate ? 1 : 0.4), ceiling);
                if (w.p >= 1) w.rise = 0.001;
            }

            const wob = Math.sin(elapsed * 1.6 + w.wobble);
            let x, y, scale;

            if (w.rise > 0) {
                x = this.#x(U.xylem);
                y = THREE.MathUtils.lerp(this.#y(w.v), this.#y(1.18), Ease.outQuad(w.rise));
                scale = 1 - w.rise * 0.25;
            } else {
                x = this.#x(this.#uAt(w.p)) + wob * this.W * 0.006 * (1 - w.p);
                y = this.#y(w.v) + wob * this.H * 0.03 * (1 - w.p * 0.7);
                // Squeezing through the membrane is the visible moment of
                // osmosis, so the droplet pinches exactly there.
                scale = (w.p > 0.34 && w.p < 0.50) ? 0.62 : 1;
            }

            this._v.set(x, y, z + w.z * this.D * 0.12);
            this._s.setScalar(scale);
            this._m.compose(this._v, this._q.identity(), this._s);
            this.water.setMatrixAt(i, this._m);
        }
        this.water.instanceMatrix.needsUpdate = true;
    }

    #updateIons(dt, elapsed) {
        const gate = this.flow.ions;
        const z = this.#z;
        this.ionPumpCooldown -= dt;

        for (let i = 0; i < this.ionState.length; i++) {
            const s = this.ionState[i];

            if (gate) {
                s.hold -= dt;
                if (s.hold <= 0) {
                    // One pumped hop inward, then a pause. Against the gradient,
                    // so it can never be mistaken for drifting.
                    s.p = Math.min(s.p + 0.14 + Math.random() * 0.05, 1);
                    s.hold = 0.45 + Math.random() * 0.5;
                    s.pumped = 1;
                    if (this.ionPumpCooldown <= 0 && Math.random() < 0.3) {
                        this.audio?.sfx('pump');
                        this.ionPumpCooldown = 1.2;
                    }
                }
                if (s.p >= 1) {
                    s.p = 0;
                    s.v = 0.12 + Math.random() * 0.76;
                }
            }

            s.pumped = Math.max(0, s.pumped - dt * 4);
            this._v.set(this.#x(this.#uAt(s.p * 0.92)), this.#y(s.v), z + s.z * this.D * 0.12);
            this._q.setFromAxisAngle(this._axis, elapsed * 1.3 + s.spin);
            this._s.setScalar((gate ? 1 : 0.8) * (1 + s.pumped * 0.4));
            this._m.compose(this._v, this._q, this._s);
            this.ions.setMatrixAt(i, this._m);
        }
        this._q.identity();
        this.ions.instanceMatrix.needsUpdate = true;
    }

    setQuality(level) {
        if (level !== 'low') return;
        this.water.count = Math.floor(WATER_COUNT * 0.45);
        this.ions.count = Math.floor(ION_COUNT * 0.6);
    }

    dispose() {
        for (const s of this.hotspots.values()) {
            this.interaction?.unregister(s.disc);
            s.dispose();
        }
        if (this.done) { this.interaction?.unregister(this.done.disc); this.done.dispose(); }
        this.caption?.dispose();
        this.scene.remove(this.group);
    }
}
