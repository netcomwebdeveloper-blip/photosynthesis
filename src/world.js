import * as THREE from 'three';
import { TextLabel, BillboardSet, DISPLAY_FONT } from './labels.js';

/* ============================================================================
   The world
   ---------------------------------------------------------------------------
   A storybook meadow: one plant in a raised bed whose front is cut away so the
   roots are visible without digging a hole the child has to look into. Bright
   sky, drifting clouds, soft grass.

   Five particle systems carry the whole explanation, and each has its own
   colour that never appears anywhere else in the scene:
     sunlight  gold      water  blue      carbon dioxide  grey-violet
     food      amber     oxygen mint

   Because the colours are unique, a child can follow what goes in and what
   comes out purely by watching — which is the point.

   Performance rules that keep a standalone headset at frame rate (dropped
   frames are what a Quest turns into head-locked judder):
     • repeated geometry is instanced, never duplicated as separate meshes
     • the shadow map is baked once, not re-rendered every frame
     • static props have matrixAutoUpdate switched off
     • surfaces are never coplanar — z-fighting shimmers as the head moves
   ========================================================================== */

const Y_AXIS = new THREE.Vector3(0, 1, 0);

export const PALETTE = {
    sunlight: 0xffd166,
    water: 0x4fc3f7,
    co2: 0x9aa7c7,
    food: 0xf6b352,
    oxygen: 0x5fe0c8,

    leafTop: 0x7cc05a,
    leafDeep: 0x2f7d43,
    leafShade: 0x14472a,
    vein: 0x0d2f1c,
    stem: 0x4a8f42,
    soil: 0x5a3d28,
    soilDeep: 0x33210f,
    root: 0xe4d3ae,
    grass: 0x57a75e,
    petal: 0xffc8e0
};

/** Where the viewer stands in VR, and where the flat camera comes to rest. */
export const VIEWER_SPOT = new THREE.Vector3(0, 1.6, 3.6);

/** The working heart of the leaf — where sunlight, water and CO₂ meet. */
export const LEAF_DOCK = new THREE.Vector3(0, 2.0, 0.3);

/** Where the magnified "tiny kitchen" leaf floats when the story zooms in. */
export const KITCHEN_SPOT = new THREE.Vector3(0, 1.65, 1.7);

export class World {
    constructor(scene, tweener) {
        this.scene = scene;
        this.tweener = tweener;
        this.billboards = new BillboardSet();
        this.quality = 'high';

        // Flow strengths, 0..1, raised and lowered by the story.
        this.flow = { light: 0, water: 0, co2: 0, food: 0, oxygen: 0 };

        this._v = new THREE.Vector3();
        this._m = new THREE.Matrix4();
        this._q = new THREE.Quaternion();
        this._s = new THREE.Vector3(1, 1, 1);
    }

    build() {
        this.buildSky();
        this.buildClouds();
        this.buildSun();
        this.buildMeadow();
        this.buildSoilBed();
        this.buildPlant();
        this.buildLightRays();
        this.buildWaterDrops();
        this.buildCO2();
        this.buildFood();
        this.buildOxygen();
        this.buildKitchen();
        this.buildCaption();
    }

    /* --------------------------------------------------------------- sky */

    buildSky() {
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 0, 256);
        grad.addColorStop(0.00, '#3d8fd6');
        grad.addColorStop(0.42, '#8fd0ee');
        grad.addColorStop(0.74, '#d9f0f8');
        grad.addColorStop(1.00, '#fdf3d6');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 8, 256);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;

        const sky = new THREE.Mesh(
            new THREE.SphereGeometry(90, 24, 16),
            new THREE.MeshBasicMaterial({
                map: texture, side: THREE.BackSide, fog: false, toneMapped: false
            })
        );
        sky.frustumCulled = false;
        this.freeze(sky);
        this.scene.add(sky);

        this.scene.fog = new THREE.FogExp2(0xd4ecf5, 0.0075);
    }

    /** Puffy clouds: 9 clouds of 5 blobs each, one instanced draw call. */
    buildClouds() {
        const perCloud = 5;
        const cloudCount = 9;
        const total = perCloud * cloudCount;

        const clouds = new THREE.InstancedMesh(
            new THREE.IcosahedronGeometry(1, 1),
            new THREE.MeshStandardMaterial({
                color: 0xffffff, roughness: 1, flatShading: true,
                emissive: 0xcfe4f5, emissiveIntensity: 0.25
            }),
            total
        );
        clouds.frustumCulled = false;

        this.cloudState = [];
        let i = 0;
        for (let c = 0; c < cloudCount; c++) {
            const angle = (c / cloudCount) * Math.PI * 2 + Math.random() * 0.4;
            const radius = 22 + Math.random() * 20;
            const base = new THREE.Vector3(
                Math.cos(angle) * radius,
                11 + Math.random() * 7,
                Math.sin(angle) * radius
            );
            const drift = 0.06 + Math.random() * 0.07;
            for (let b = 0; b < perCloud; b++) {
                this.cloudState.push({
                    base,
                    offset: new THREE.Vector3(
                        (b - perCloud / 2) * 1.5 + (Math.random() - 0.5),
                        (Math.random() - 0.5) * 0.9,
                        (Math.random() - 0.5) * 1.6
                    ),
                    size: 1.3 + Math.random() * 1.5,
                    drift,
                    index: i++
                });
            }
        }
        this.clouds = clouds;
        this.scene.add(clouds);
    }

    buildSun() {
        this.sunLight = new THREE.DirectionalLight(0xfff3d4, 2.5);
        this.sunLight.position.set(-6.5, 10.5, -5.5);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.mapSize.set(1024, 1024);
        this.sunLight.shadow.camera.near = 1;
        this.sunLight.shadow.camera.far = 34;
        // Tight frustum — only the plant and its bed need real shadows, and a
        // smaller box means far more usable resolution per texel.
        this.sunLight.shadow.camera.left = -6;
        this.sunLight.shadow.camera.right = 6;
        this.sunLight.shadow.camera.top = 6;
        this.sunLight.shadow.camera.bottom = -6;
        this.sunLight.shadow.bias = -0.0004;
        this.sunLight.shadow.normalBias = 0.02;
        this.scene.add(this.sunLight);

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
        this.scene.add(new THREE.HemisphereLight(0xdff1ff, PALETTE.leafDeep, 0.8));

        this.sun = new THREE.Group();
        this.sun.position.set(-6.5, 10.5, -5.5);

        const core = new THREE.Mesh(
            new THREE.SphereGeometry(1.25, 20, 16),
            new THREE.MeshBasicMaterial({ color: 0xfff6dd, fog: false, toneMapped: false })
        );
        this.sun.add(core);

        this.sunHalo = new THREE.Mesh(
            new THREE.SphereGeometry(2.3, 20, 16),
            new THREE.MeshBasicMaterial({
                color: PALETTE.sunlight, transparent: true, opacity: 0.3,
                side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false
            })
        );
        this.sun.add(this.sunHalo);

        // A friendly ring of rays, so it reads as a picture-book sun.
        const rayMat = new THREE.MeshBasicMaterial({
            color: PALETTE.sunlight, transparent: true, opacity: 0.55,
            side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false
        });
        const rays = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.34, 1.5), rayMat, 12);
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            this._q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
            this._m.compose(
                new THREE.Vector3(Math.cos(a + Math.PI / 2) * 2.6, Math.sin(a + Math.PI / 2) * 2.6, 0),
                this._q, this._s.setScalar(1)
            );
            rays.setMatrixAt(i, this._m);
        }
        rays.instanceMatrix.needsUpdate = true;
        this.sunRays = rays;
        this.sun.add(rays);

        this.scene.add(this.sun);
    }

    /* ------------------------------------------------------------- meadow */

    buildMeadow() {
        // Layered 4 cm apart so nothing is coplanar.
        const field = new THREE.Mesh(
            new THREE.CircleGeometry(80, 48),
            new THREE.MeshStandardMaterial({ color: 0x4a9a55, roughness: 1 })
        );
        field.rotation.x = -Math.PI / 2;
        field.position.y = -0.08;
        field.receiveShadow = true;
        this.freeze(field);
        this.scene.add(field);

        const clearing = new THREE.Mesh(
            new THREE.CircleGeometry(7.5, 40),
            new THREE.MeshStandardMaterial({ color: 0x74b063, roughness: 0.96 })
        );
        clearing.rotation.x = -Math.PI / 2;
        clearing.position.y = -0.04;
        clearing.receiveShadow = true;
        this.freeze(clearing);
        this.scene.add(clearing);

        // Grass blades and flowers, two instanced draw calls for ~700 objects.
        const blade = new THREE.ConeGeometry(0.036, 0.44, 3);
        blade.translate(0, 0.22, 0);
        const grass = new THREE.InstancedMesh(
            blade,
            new THREE.MeshStandardMaterial({ color: PALETTE.grass, roughness: 0.95, flatShading: true }),
            620
        );
        for (let i = 0; i < 620; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = 2.2 + Math.pow(Math.random(), 0.55) * 11;
            const s = 0.6 + Math.random() * 0.95;
            this._q.setFromAxisAngle(Y_AXIS, Math.random() * Math.PI);
            this._m.compose(
                new THREE.Vector3(Math.cos(a) * r, -0.05, Math.sin(a) * r),
                this._q, new THREE.Vector3(s, s * (0.7 + Math.random() * 0.9), s)
            );
            grass.setMatrixAt(i, this._m);
        }
        grass.instanceMatrix.needsUpdate = true;
        this.scene.add(grass);

        const flowers = new THREE.InstancedMesh(
            new THREE.DodecahedronGeometry(0.075, 0),
            new THREE.MeshStandardMaterial({ color: PALETTE.petal, roughness: 0.6, emissive: 0x3a1220 }),
            50
        );
        for (let i = 0; i < 50; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = 2.6 + Math.random() * 8;
            this._m.compose(
                new THREE.Vector3(Math.cos(a) * r, 0.2, Math.sin(a) * r),
                this._q.identity(), this._s.setScalar(0.7 + Math.random() * 0.7)
            );
            flowers.setMatrixAt(i, this._m);
        }
        flowers.instanceMatrix.needsUpdate = true;
        this.scene.add(flowers);
    }

    /**
     * A raised bed with its front quarter cut away. The roots are simply there
     * to be seen, at a comfortable height — no hole in the ground for a child
     * to peer down into, and no glass panel to explain.
     */
    buildSoilBed() {
        const bed = new THREE.Group();
        this.bedHeight = 0.86;

        // Back shell only: theta from PI/2 to 3PI/2 is the -Z half, which
        // leaves the side facing the viewer open.
        const shell = new THREE.Mesh(
            new THREE.CylinderGeometry(1.25, 1.25, this.bedHeight, 28, 1, true, Math.PI / 2, Math.PI),
            new THREE.MeshStandardMaterial({
                color: PALETTE.soilDeep, roughness: 1, side: THREE.DoubleSide
            })
        );
        shell.position.y = this.bedHeight / 2;
        shell.receiveShadow = true;
        bed.add(shell);

        // The flat cut faces, left and right of the opening.
        const faceMat = new THREE.MeshStandardMaterial({ color: PALETTE.soilDeep, roughness: 1 });
        [-1, 1].forEach((side) => {
            const face = new THREE.Mesh(new THREE.PlaneGeometry(1.25, this.bedHeight), faceMat);
            face.position.set(side * 0.625, this.bedHeight / 2, 0);
            face.rotation.y = Math.PI / 2;
            bed.add(face);
        });

        const floor = new THREE.Mesh(
            new THREE.CircleGeometry(1.25, 28, Math.PI / 2, Math.PI),
            faceMat
        );
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = 0.012;
        bed.add(floor);

        // Soil surface, sitting just under the rim.
        const top = new THREE.Mesh(
            new THREE.CircleGeometry(1.24, 28, Math.PI / 2, Math.PI),
            new THREE.MeshStandardMaterial({ color: PALETTE.soil, roughness: 1 })
        );
        top.rotation.x = -Math.PI / 2;
        top.position.y = this.bedHeight - 0.03;
        top.receiveShadow = true;
        bed.add(top);

        // Wooden rim, so the cutaway looks deliberate rather than broken.
        const rimMat = new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.85 });
        const rim = new THREE.Mesh(
            new THREE.TorusGeometry(1.27, 0.07, 8, 32),
            rimMat
        );
        rim.rotation.x = Math.PI / 2;
        rim.position.y = this.bedHeight;
        rim.castShadow = true;
        bed.add(rim);

        this.freeze(bed, true);
        this.scene.add(bed);

        this.buildRoots();
    }

    /** Taproot plus laterals, hanging in the open front of the bed. */
    buildRoots() {
        const roots = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color: PALETTE.root, roughness: 0.85 });
        const top = this.bedHeight - 0.04;

        const tap = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.015, top - 0.1, 6), mat);
        tap.position.set(0, 0.1 + (top - 0.1) / 2, 0);
        roots.add(tap);

        this.rootTips = [];
        for (let i = 0; i < 8; i++) {
            const a = -Math.PI / 2 + (i / 7) * Math.PI;   // spread across the open front
            const h = top - 0.18 - (i % 3) * 0.17;
            const len = 0.42 + Math.random() * 0.3;
            const lateral = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.006, len, 5), mat);

            const dir = new THREE.Vector3(Math.sin(a), -0.55, Math.cos(a) * 0.75).normalize();
            const mid = dir.clone().multiplyScalar(len / 2);
            lateral.position.set(mid.x, h + mid.y, mid.z);
            lateral.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
            roots.add(lateral);

            this.rootTips.push(dir.clone().multiplyScalar(len).add(new THREE.Vector3(0, h, 0)));
        }

        this.freeze(roots, true);
        this.scene.add(roots);
        this.stemBase = new THREE.Vector3(0, top, 0);
    }

    /* -------------------------------------------------------------- plant */

    buildPlant() {
        const base = this.bedHeight - 0.04;
        this.plant = new THREE.Group();

        this.stemCurve = new THREE.CatmullRomCurve3([
            new THREE.Vector3(0, base, 0),
            new THREE.Vector3(0.07, base + 0.4, 0.03),
            new THREE.Vector3(-0.05, base + 0.75, 0.02),
            new THREE.Vector3(0.04, base + 1.0, 0.06),
            new THREE.Vector3(0, base + 1.2, 0.1)
        ]);

        // A real stem is thick at the soil and thin at the growing tip. A
        // constant-radius tube reads as a green pipe, which was most of why the
        // old plant looked artificial.
        const stem = new THREE.Mesh(
            this.makeTaperedTube(this.stemCurve, 0.075, 0.022, 48, 10),
            new THREE.MeshStandardMaterial({
                color: PALETTE.stem, roughness: 0.72,
                emissive: PALETTE.leafShade, emissiveIntensity: 0.12
            })
        );
        stem.castShadow = true;
        this.plant.add(stem);

        // Leaves spiral up the stem at roughly the golden angle, which is what
        // real alternate phyllotaxis does — it stops any two leaves shading
        // each other, and it is why a plant never looks laid out on a grid.
        const GOLDEN = 2.39996;
        const specs = [
            { t: 0.16, scale: 0.60, elevation: -0.16 },
            { t: 0.29, scale: 0.64, elevation: -0.10 },
            { t: 0.42, scale: 0.58, elevation: -0.04 },
            { t: 0.55, scale: 0.52, elevation: 0.04 },
            { t: 0.67, scale: 0.45, elevation: 0.12 },
            { t: 0.78, scale: 0.38, elevation: 0.20 },
            { t: 0.87, scale: 0.30, elevation: 0.30 }
        ];

        const outward = new THREE.Vector3();
        const upAxis = new THREE.Vector3(0, 1, 0);

        this.sideLeaves = specs.map((spec, i) => {
            const leaf = this.makeLeaf(1.05, PALETTE.leafDeep, { pivot: 'base' });

            const at = this.stemCurve.getPointAt(spec.t);
            const azimuth = i * GOLDEN;
            outward.set(
                Math.sin(azimuth) * Math.cos(spec.elevation),
                Math.sin(spec.elevation),
                Math.cos(azimuth) * Math.cos(spec.elevation)
            ).normalize();

            // Start the petiole just outside the stem surface rather than
            // inside it, or the leaf appears to grow out of thin air.
            const stemRadius = THREE.MathUtils.lerp(0.075, 0.022, spec.t);
            leaf.position.copy(at).addScaledVector(outward, stemRadius * 0.8);

            leaf.quaternion.setFromUnitVectors(upAxis, outward);
            leaf.scale.setScalar(spec.scale);

            leaf.userData.phase = Math.random() * Math.PI * 2;
            // update() nudges rotation.x for the breathing motion, so rest has
            // to be whatever euler the quaternion above produced.
            leaf.userData.restX = leaf.rotation.x;

            this.plant.add(leaf);
            return leaf;
        });

        // A young leaf still furled at the growing tip.
        const bud = new THREE.Mesh(
            new THREE.ConeGeometry(0.045, 0.22, 7, 1, true),
            new THREE.MeshStandardMaterial({
                color: PALETTE.leafTop, roughness: 0.55, side: THREE.DoubleSide,
                emissive: PALETTE.leafShade, emissiveIntensity: 0.25
            })
        );
        bud.position.copy(this.stemCurve.getPointAt(0.99)).add(new THREE.Vector3(0, 0.09, 0));
        bud.rotation.set(0.2, 0, 0.1);
        bud.castShadow = true;
        this.plant.add(bud);

        // The hero leaf. Pivot stays at the blade centre so its placement and
        // the light disc below keep their existing alignment.
        this.mainLeaf = this.makeLeaf(1.25, PALETTE.leafTop, { pivot: 'center' });
        this.mainLeaf.position.set(0, LEAF_DOCK.y - 0.05, 0.12);
        this.mainLeaf.rotation.set(-1.05, 0, 0);
        this.mainLeaf.scale.setScalar(0.98);
        this.plant.add(this.mainLeaf);

        this.scene.add(this.plant);

        // A soft disc of light on the hero leaf: the place things go into.
        this.dockMaterial = new THREE.MeshBasicMaterial({
            color: PALETTE.sunlight, transparent: true, opacity: 0.1,
            side: THREE.DoubleSide, depthWrite: false, toneMapped: false
        });
        this.dock = new THREE.Mesh(new THREE.CircleGeometry(0.44, 32), this.dockMaterial);
        this.dock.position.copy(LEAF_DOCK);
        this.dock.rotation.x = -1.05;
        this.scene.add(this.dock);
    }

    /**
     * A leaf: petiole plus a curved blade.
     *
     * The blade is a parametric grid rather than an extruded outline. Extruding
     * gives a flat sheet whose only vertices sit on the silhouette, so it can't
     * curve — and a dead flat leaf is what reads as plastic. A grid can cup
     * along the midrib, curl at the edges and droop toward the tip, which is
     * most of what makes a leaf look alive.
     *
     * @param {'base'|'center'} pivot where the group origin sits
     */
    makeLeaf(length, color, { pivot = 'base' } = {}) {
        const group = new THREE.Group();
        const petioleLength = length * 0.16;

        const blade = new THREE.Mesh(
            this.makeBladeGeometry(length),
            new THREE.MeshStandardMaterial({
                color,
                map: this.leafTexture(),
                roughness: 0.52,
                metalness: 0.0,
                side: THREE.DoubleSide,
                emissive: PALETTE.leafShade,
                emissiveIntensity: 0.16
            })
        );
        blade.position.y = petioleLength;
        blade.castShadow = true;
        group.add(blade);

        const petiole = new THREE.Mesh(
            new THREE.CylinderGeometry(length * 0.016, length * 0.026, petioleLength, 6),
            new THREE.MeshStandardMaterial({ color: PALETTE.stem, roughness: 0.8 })
        );
        petiole.position.y = petioleLength / 2;
        group.add(petiole);

        if (pivot === 'center') {
            const shift = -(petioleLength + length / 2);
            group.children.forEach((child) => { child.position.y += shift; });
        }

        group.userData.blade = blade;
        return group;
    }

    /**
     * The blade surface. `t` runs base (0) to tip (1) along local +Y, `s` runs
     * across the width from -1 to 1.
     */
    makeBladeGeometry(length, rows = 26, cols = 15) {
        const positions = [];
        const uvs = [];
        const indices = [];

        // Half-width profile: widest below the middle, drawn out to a point at
        // the tip, with a gentle scallop along the edge.
        const halfWidth = (t) =>
            0.30 * length
            * Math.sin(Math.pow(t, 0.62) * Math.PI)
            * (1 - Math.pow(t, 8))
            * (1 + 0.05 * Math.sin(t * Math.PI * 9));

        for (let r = 0; r <= rows; r++) {
            const t = r / rows;
            const w = halfWidth(t);
            // A leaf is never perfectly straight or symmetric.
            const lean = length * 0.035 * Math.sin(t * Math.PI);

            for (let c = 0; c <= cols; c++) {
                const s = (c / cols) * 2 - 1;
                const edge = Math.abs(s);
                const asym = s > 0 ? 1.0 : 0.94;

                const x = s * w * asym + lean;
                const y = t * length;
                const z = length * (
                    0.048 * (1 - edge) * (1 - edge)          // ridge along the midrib
                    - 0.105 * edge * edge * (0.35 + 0.65 * t) // edges curl, more near the tip
                    - 0.17 * Math.pow(t, 2.4)                 // the whole blade droops
                );

                positions.push(x, y, z);
                uvs.push(0.5 + s * 0.5, t);
            }
        }

        const stride = cols + 1;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const a = r * stride + c;
                const b = a + stride;
                indices.push(a, b, a + 1, b, b + 1, a + 1);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setIndex(indices);
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.computeVertexNormals();
        return geometry;
    }

    /**
     * Veins, drawn once and shared by every leaf.
     *
     * Modelling veins as cylinders looked like green wires taped to a sheet.
     * Painting them costs one texture and gives the branching detail that
     * actually reads as a leaf. Values are kept light so the material colour
     * can tint the same texture for different leaves.
     */
    leafTexture() {
        if (this._leafTexture) return this._leafTexture;

        const W = 384, H = 768;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');

        // Base: paler toward the tip and toward the edges, as chlorophyll thins.
        const base = ctx.createLinearGradient(0, H, 0, 0);
        base.addColorStop(0.0, '#b9d69a');
        base.addColorStop(0.55, '#d3e6b4');
        base.addColorStop(1.0, '#e6f0cc');
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, W, H);

        const sides = ctx.createLinearGradient(0, 0, W, 0);
        sides.addColorStop(0.0, 'rgba(120,160,95,0.35)');
        sides.addColorStop(0.5, 'rgba(255,255,255,0)');
        sides.addColorStop(1.0, 'rgba(120,160,95,0.35)');
        ctx.fillStyle = sides;
        ctx.fillRect(0, 0, W, H);

        // Mottling, so the surface is not a flat wash.
        for (let i = 0; i < 26; i++) {
            const x = Math.random() * W;
            const y = Math.random() * H;
            const r = 18 + Math.random() * 46;
            const blob = ctx.createRadialGradient(x, y, 0, x, y, r);
            const light = Math.random() > 0.5;
            blob.addColorStop(0, light ? 'rgba(240,248,214,0.30)' : 'rgba(122,158,92,0.22)');
            blob.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = blob;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
        }

        const mid = W / 2;
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(96,132,74,0.62)';

        // Secondary veins: leave the midrib at a shallow angle and curve toward
        // the tip, shorter and steeper as they get higher up the blade.
        for (let i = 0; i < 13; i++) {
            const v = 0.06 + (i / 12) * 0.86;
            const y = H - v * H;
            const reach = (1 - Math.pow(v, 1.7)) * (W * 0.44);
            const rise = H * 0.075 * (1 - v * 0.4);

            for (const dir of [-1, 1]) {
                ctx.beginPath();
                ctx.moveTo(mid, y);
                ctx.quadraticCurveTo(
                    mid + dir * reach * 0.55, y - rise * 0.5,
                    mid + dir * reach, y - rise
                );
                ctx.lineWidth = 3.2 * (1 - v * 0.55);
                ctx.stroke();

                // Tertiary cross-links between neighbouring veins.
                ctx.save();
                ctx.strokeStyle = 'rgba(105,140,82,0.26)';
                ctx.lineWidth = 1.1;
                for (let k = 1; k <= 3; k++) {
                    const f = k / 4;
                    ctx.beginPath();
                    ctx.moveTo(mid + dir * reach * f, y - rise * f * 0.7);
                    ctx.lineTo(mid + dir * reach * (f + 0.16), y - rise * f * 0.7 - H * 0.045);
                    ctx.stroke();
                }
                ctx.restore();
            }
        }

        // Midrib last, so it sits on top of everything it feeds.
        const rib = ctx.createLinearGradient(0, H, 0, 0);
        rib.addColorStop(0, 'rgba(88,124,66,0.9)');
        rib.addColorStop(1, 'rgba(120,158,92,0.35)');
        ctx.strokeStyle = rib;
        ctx.beginPath();
        ctx.moveTo(mid, H);
        ctx.lineTo(mid, 0);
        ctx.lineWidth = 7;
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255,255,255,0.34)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mid - 2.6, H);
        ctx.lineTo(mid - 2.6, 0);
        ctx.stroke();

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 8;
        texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
        this._leafTexture = texture;
        return texture;
    }

    /** A tube along a curve whose radius shrinks from r0 at the start to r1. */
    makeTaperedTube(curve, r0, r1, tubularSegments = 48, radialSegments = 10) {
        const frames = curve.computeFrenetFrames(tubularSegments, false);
        const positions = [], normals = [], uvs = [], indices = [];
        const P = new THREE.Vector3();

        for (let i = 0; i <= tubularSegments; i++) {
            const u = i / tubularSegments;
            curve.getPointAt(u, P);
            const N = frames.normals[i];
            const B = frames.binormals[i];
            const r = THREE.MathUtils.lerp(r0, r1, u);

            for (let j = 0; j <= radialSegments; j++) {
                const v = (j / radialSegments) * Math.PI * 2;
                const sin = Math.sin(v), cos = -Math.cos(v);
                const nx = cos * N.x + sin * B.x;
                const ny = cos * N.y + sin * B.y;
                const nz = cos * N.z + sin * B.z;
                normals.push(nx, ny, nz);
                positions.push(P.x + r * nx, P.y + r * ny, P.z + r * nz);
                uvs.push(u, j / radialSegments);
            }
        }

        const stride = radialSegments + 1;
        for (let i = 1; i <= tubularSegments; i++) {
            for (let j = 1; j <= radialSegments; j++) {
                const a = stride * (i - 1) + (j - 1);
                const b = stride * i + (j - 1);
                const c = stride * i + j;
                const d = stride * (i - 1) + j;
                indices.push(a, b, d, b, c, d);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setIndex(indices);
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        return geometry;
    }

    /* ---------------------------------------------------------- particles */

    /** Sunlight: warm motes streaming from the sun down into the leaves. */
    buildLightRays() {
        const count = 46;
        this.lightMat = new THREE.MeshBasicMaterial({
            color: PALETTE.sunlight, transparent: true, opacity: 0,
            depthWrite: false, blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide, fog: false, toneMapped: false
        });
        this.lightMesh = new THREE.InstancedMesh(
            new THREE.PlaneGeometry(0.08, 0.26), this.lightMat, count
        );
        this.lightMesh.frustumCulled = false;
        this.scene.add(this.lightMesh);

        this.lightState = Array.from({ length: count }, () => ({
            t: Math.random(),
            speed: 0.17 + Math.random() * 0.14,
            spread: new THREE.Vector3(
                (Math.random() - 0.5) * 2.4,
                (Math.random() - 0.5) * 1.0,
                (Math.random() - 0.5) * 2.4
            )
        }));
    }

    /**
     * Water: soil → root tip → up the stem → leaf. Three stages per drop, so
     * the journey reads as one continuous path rather than a loop of blobs.
     */
    buildWaterDrops() {
        const count = 30;
        this.waterMat = new THREE.MeshBasicMaterial({
            color: PALETTE.water, transparent: true, opacity: 0, toneMapped: false
        });
        this.waterMesh = new THREE.InstancedMesh(
            new THREE.SphereGeometry(0.042, 8, 6), this.waterMat, count
        );
        this.waterMesh.frustumCulled = false;
        this.scene.add(this.waterMesh);

        this.waterState = Array.from({ length: count }, (_, i) => this.makeDrop(i / count));
    }

    makeDrop(startT = 0) {
        const tip = this.rootTips[Math.floor(Math.random() * this.rootTips.length)];
        return {
            t: startT,
            speed: 0.16 + Math.random() * 0.07,
            soilStart: tip.clone().add(new THREE.Vector3(
                (Math.random() - 0.5) * 0.5, -0.15 - Math.random() * 0.25, (Math.random() - 0.5) * 0.4
            )),
            tip: tip.clone()
        };
    }

    /** Carbon dioxide: drifts in from the sides and sinks into the leaf. */
    buildCO2() {
        const count = 24;
        this.co2Mat = new THREE.MeshStandardMaterial({
            color: PALETTE.co2, transparent: true, opacity: 0,
            roughness: 0.5, emissive: 0x2a3350, emissiveIntensity: 0.4
        });
        this.co2Mesh = new THREE.InstancedMesh(
            new THREE.SphereGeometry(0.055, 8, 6), this.co2Mat, count
        );
        this.co2Mesh.frustumCulled = false;
        this.scene.add(this.co2Mesh);

        this.co2State = Array.from({ length: count }, (_, i) => ({
            t: i / count,
            speed: 0.13 + Math.random() * 0.08,
            from: new THREE.Vector3(
                (Math.random() < 0.5 ? -1 : 1) * (2.6 + Math.random() * 2.2),
                1.4 + Math.random() * 1.8,
                (Math.random() - 0.5) * 4
            ),
            wobble: Math.random() * Math.PI * 2
        }));
    }

    /** Food: amber sparks that appear inside the leaf and run down the stem. */
    buildFood() {
        const count = 26;
        this.foodMat = new THREE.MeshStandardMaterial({
            color: PALETTE.food, transparent: true, opacity: 0,
            roughness: 0.3, emissive: 0x6a4408, emissiveIntensity: 0.8
        });
        this.foodMesh = new THREE.InstancedMesh(
            new THREE.OctahedronGeometry(0.055, 0), this.foodMat, count
        );
        this.foodMesh.frustumCulled = false;
        this.scene.add(this.foodMesh);

        this.foodState = Array.from({ length: count }, (_, i) => ({
            t: i / count,
            speed: 0.15 + Math.random() * 0.07,
            swirl: Math.random() * Math.PI * 2
        }));
    }

    /** Oxygen: mint bubbles leaving the leaf and rising away. */
    buildOxygen() {
        const count = 34;
        this.oxygenMat = new THREE.MeshStandardMaterial({
            color: PALETTE.oxygen, transparent: true, opacity: 0,
            roughness: 0.25, emissive: 0x0d3b33, emissiveIntensity: 0.7
        });
        this.oxygenMesh = new THREE.InstancedMesh(
            new THREE.SphereGeometry(0.06, 8, 6), this.oxygenMat, count
        );
        this.oxygenMesh.frustumCulled = false;
        this.scene.add(this.oxygenMesh);

        this.oxygenState = Array.from({ length: count }, (_, i) => ({
            t: i / count,
            speed: 0.11 + Math.random() * 0.07,
            drift: new THREE.Vector3(
                (Math.random() - 0.5) * 0.9, 1, (Math.random() - 0.5) * 0.9
            ).normalize(),
            wobble: Math.random() * Math.PI * 2
        }));
    }

    /* ------------------------------------------------------- tiny kitchen */

    /**
     * A magnified slice of leaf that floats up between the plant and the
     * viewer. This is how the story "zooms in" without moving anyone: in VR the
     * subject comes to you, which is comfortable, while a moving camera is not.
     */
    buildKitchen() {
        this.kitchen = new THREE.Group();
        this.kitchen.position.copy(KITCHEN_SPOT);
        this.kitchen.scale.setScalar(0.001);
        this.kitchen.visible = false;

        const slab = new THREE.Mesh(
            new THREE.BoxGeometry(1.5, 0.62, 0.3),
            new THREE.MeshStandardMaterial({
                color: PALETTE.leafTop, roughness: 0.55,
                emissive: PALETTE.leafShade, emissiveIntensity: 0.25
            })
        );
        slab.castShadow = true;
        this.kitchen.add(slab);

        const skin = new THREE.Mesh(
            new THREE.BoxGeometry(1.52, 0.1, 0.32),
            new THREE.MeshStandardMaterial({ color: PALETTE.leafDeep, roughness: 0.7 })
        );
        skin.position.y = 0.31;
        this.kitchen.add(skin);

        // Chloroplasts — the little green pots doing the cooking.
        const chloro = new THREE.InstancedMesh(
            new THREE.SphereGeometry(0.052, 10, 8),
            new THREE.MeshStandardMaterial({
                color: 0x3fbf6a, roughness: 0.4,
                emissive: 0x1c6b38, emissiveIntensity: 0.75
            }),
            22
        );
        this.chloroState = [];
        for (let i = 0; i < 22; i++) {
            const p = new THREE.Vector3(
                (Math.random() - 0.5) * 1.28,
                (Math.random() - 0.5) * 0.36,
                0.16
            );
            this.chloroState.push({ home: p, phase: Math.random() * Math.PI * 2 });
        }
        this.chloroplasts = chloro;
        this.kitchen.add(chloro);

        // Two tiny pores on the underside, where the air gets in.
        const poreMat = new THREE.MeshStandardMaterial({ color: 0x0b2718, roughness: 0.9 });
        const poreGeo = new THREE.SphereGeometry(0.045, 8, 6);
        [-0.42, 0.42].forEach((x) => {
            const pore = new THREE.Mesh(poreGeo, poreMat);
            pore.scale.set(1.7, 0.55, 1);
            pore.position.set(x, -0.31, 0.1);
            this.kitchen.add(pore);
        });

        this.scene.add(this.kitchen);
    }

    async showKitchen(show, seconds = 1.4) {
        if (!this.tweener) return;
        if (show) this.kitchen.visible = true;
        const from = show ? 0.001 : this.kitchen.scale.x;
        const to = show ? 1 : 0.001;
        await this.tweener.add(seconds, (p) => {
            this.kitchen.scale.setScalar(from + (to - from) * p);
        });
        if (!show) this.kitchen.visible = false;
    }

    /* ---------------------------------------------------------- the words */

    buildCaption() {
        // One caption, floating above the plant, billboarded so it is readable
        // from anywhere. Glyphs on transparent canvas — no card, no plate.
        this.caption = new TextLabel({
            text: '', worldWidth: 4.6, canvasWidth: 1280,
            fontSize: 96, font: DISPLAY_FONT, weight: 800,
            color: '#fffaf0', outline: 'rgba(8, 40, 24, 0.95)', outlineWidth: 15,
            lines: 2
        });
        this.caption.mesh.position.set(0, 3.05, 0);
        this.caption.setOpacity(0);
        this.scene.add(this.caption.mesh);
        this.billboards.add(this.caption.mesh);

        this.finale = new TextLabel({
            text: '', worldWidth: 5.4, canvasWidth: 1280,
            fontSize: 84, font: DISPLAY_FONT, weight: 800,
            color: '#ffd166', outline: 'rgba(8, 40, 24, 0.95)', outlineWidth: 14,
            lines: 2
        });
        this.finale.mesh.position.set(0, 2.55, 0);
        this.finale.setOpacity(0);
        this.scene.add(this.finale.mesh);
        this.billboards.add(this.finale.mesh);
    }

    /** Crossfades the caption to new words. */
    async say(text, label = 'caption') {
        const target = label === 'finale' ? this.finale : this.caption;
        if (!this.tweener) { target.setText(text); return; }

        if (target.material.opacity > 0.02) {
            const from = target.material.opacity;
            await this.tweener.add(0.35, (p) => target.setOpacity(from * (1 - p)));
        }
        target.setText(text);
        if (!text) return;
        await this.tweener.add(0.5, (p) => target.setOpacity(p));
    }

    /* -------------------------------------------------------- story hooks */

    /** Fades a particle flow in or out. */
    fade(key, to, seconds = 1.4) {
        if (!this.tweener) { this.flow[key] = to; return Promise.resolve(); }
        const from = this.flow[key];
        if (Math.abs(from - to) < 0.01) return Promise.resolve();
        return this.tweener.add(seconds, (p) => {
            this.flow[key] = from + (to - from) * p;
        });
    }

    fadeAll(to, seconds = 1.2) {
        return Promise.all(Object.keys(this.flow).map((k) => this.fade(k, to, seconds)));
    }

    /** The leaf glowing while it works. */
    async glowLeaf(seconds = 2.4, strength = 1.1) {
        if (!this.tweener) return;
        const blades = [this.mainLeaf.userData.blade, ...this.sideLeaves.map((l) => l.userData.blade)];
        await this.tweener.add(seconds, (p) => {
            const glow = Math.sin(p * Math.PI);
            blades.forEach((b) => { if (b) b.material.emissiveIntensity = 0.18 + glow * strength; });
        });
        blades.forEach((b) => { if (b) b.material.emissiveIntensity = 0.18; });
    }

    /* -------------------------------------------------------------- update */

    update(dt, elapsed, camera) {
        const F = this.flow;

        // Clouds drift.
        if (this.clouds) {
            for (const c of this.cloudState) {
                const angle = elapsed * c.drift * 0.02;
                const cos = Math.cos(angle), sin = Math.sin(angle);
                this._v.set(
                    c.base.x * cos - c.base.z * sin + c.offset.x,
                    c.base.y + c.offset.y + Math.sin(elapsed * 0.2 + c.index) * 0.25,
                    c.base.x * sin + c.base.z * cos + c.offset.z
                );
                this._m.compose(this._v, this._q.identity(), this._s.setScalar(c.size));
                this.clouds.setMatrixAt(c.index, this._m);
            }
            this.clouds.instanceMatrix.needsUpdate = true;
        }

        if (this.sunRays) this.sunRays.rotation.z += dt * 0.06;
        if (this.sunHalo) {
            this.sunHalo.scale.setScalar(1 + Math.sin(elapsed * 0.9) * 0.035);
        }

        this.updateLight(dt, elapsed, F.light);
        this.updateWater(dt, F.water);
        this.updateCO2(dt, elapsed, F.co2);
        this.updateFood(dt, elapsed, F.food);
        this.updateOxygen(dt, elapsed, F.oxygen);

        // Chloroplasts jiggle inside the kitchen.
        if (this.kitchen?.visible && this.chloroplasts) {
            for (let i = 0; i < this.chloroState.length; i++) {
                const c = this.chloroState[i];
                this._v.copy(c.home);
                this._v.x += Math.sin(elapsed * 1.4 + c.phase) * 0.035;
                this._v.y += Math.cos(elapsed * 1.1 + c.phase) * 0.03;
                this._m.compose(this._v, this._q.identity(),
                    this._s.setScalar(0.9 + Math.sin(elapsed * 2 + c.phase) * 0.12));
                this.chloroplasts.setMatrixAt(i, this._m);
            }
            this.chloroplasts.instanceMatrix.needsUpdate = true;
        }

        // Gentle plant movement. Nothing spins on its own axis — a rotating
        // leaf turns edge-on, and a rotating label becomes unreadable.
        for (const leaf of this.sideLeaves || []) {
            leaf.rotation.x = leaf.userData.restX + Math.sin(elapsed * 0.85 + leaf.userData.phase) * 0.07;
        }
        if (this.mainLeaf) {
            this.mainLeaf.position.y = LEAF_DOCK.y - 0.05 + Math.sin(elapsed * 0.75) * 0.016;
        }
        this.dockMaterial.opacity = 0.06 + F.light * 0.32;

        this.billboards.update(camera);
    }

    updateLight(dt, elapsed, strength) {
        this.lightMat.opacity = strength * 0.95;
        if (strength < 0.01 || this.quality === 'low') return;

        const from = this.sun.position;
        for (let i = 0; i < this.lightState.length; i++) {
            const p = this.lightState[i];
            p.t += p.speed * dt;
            if (p.t > 1) p.t -= 1;
            const arc = Math.sin(p.t * Math.PI);
            this._v.set(
                from.x + (LEAF_DOCK.x - from.x) * p.t + p.spread.x * arc,
                from.y + (LEAF_DOCK.y - from.y) * p.t + p.spread.y * arc,
                from.z + (LEAF_DOCK.z - from.z) * p.t + p.spread.z * arc
            );
            this._q.setFromAxisAngle(Y_AXIS, elapsed * 0.7 + i);
            this._m.compose(this._v, this._q, this._s.setScalar(0.4 + arc * 0.95));
            this.lightMesh.setMatrixAt(i, this._m);
        }
        this.lightMesh.instanceMatrix.needsUpdate = true;
    }

    updateWater(dt, strength) {
        this.waterMat.opacity = strength * 0.95;
        if (strength < 0.01) return;

        for (let i = 0; i < this.waterState.length; i++) {
            const d = this.waterState[i];
            d.t += d.speed * dt;
            if (d.t > 1) d.t -= 1;

            // 0.00–0.28 soil → root tip, 0.28–0.42 tip → stem base, 0.42–1 up.
            if (d.t < 0.28) {
                this._v.lerpVectors(d.soilStart, d.tip, d.t / 0.28);
            } else if (d.t < 0.42) {
                this._v.lerpVectors(d.tip, this.stemBase, (d.t - 0.28) / 0.14);
            } else {
                this.stemCurve.getPointAt(Math.min((d.t - 0.42) / 0.58, 0.999), this._v);
            }
            this._m.compose(this._v, this._q.identity(),
                this._s.setScalar(0.75 + Math.sin(d.t * Math.PI) * 0.45));
            this.waterMesh.setMatrixAt(i, this._m);
        }
        this.waterMesh.instanceMatrix.needsUpdate = true;
    }

    updateCO2(dt, elapsed, strength) {
        this.co2Mat.opacity = strength * 0.85;
        if (strength < 0.01) return;

        for (let i = 0; i < this.co2State.length; i++) {
            const c = this.co2State[i];
            c.t += c.speed * dt;
            if (c.t > 1) c.t -= 1;
            this._v.lerpVectors(c.from, LEAF_DOCK, c.t);
            this._v.y += Math.sin(elapsed * 1.4 + c.wobble) * 0.16 * (1 - c.t);
            this._v.x += Math.cos(elapsed * 1.1 + c.wobble) * 0.12 * (1 - c.t);
            this._m.compose(this._v, this._q.identity(),
                this._s.setScalar(0.55 + (1 - c.t) * 0.6));
            this.co2Mesh.setMatrixAt(i, this._m);
        }
        this.co2Mesh.instanceMatrix.needsUpdate = true;
    }

    updateFood(dt, elapsed, strength) {
        this.foodMat.opacity = strength * 0.95;
        if (strength < 0.01) return;

        for (let i = 0; i < this.foodState.length; i++) {
            const f = this.foodState[i];
            f.t += f.speed * dt;
            if (f.t > 1) f.t -= 1;

            if (f.t < 0.3) {
                // Swirling into being inside the leaf.
                const a = f.swirl + f.t * 12;
                const r = 0.32 * (1 - f.t / 0.3) + 0.06;
                this._v.set(
                    LEAF_DOCK.x + Math.cos(a) * r,
                    LEAF_DOCK.y + Math.sin(a) * r * 0.5,
                    LEAF_DOCK.z + Math.sin(a) * r * 0.4
                );
            } else {
                // Then down the stem, to feed the rest of the plant.
                const t = (f.t - 0.3) / 0.7;
                this.stemCurve.getPointAt(Math.max(0.99 - t * 0.97, 0.005), this._v);
            }
            this._q.setFromAxisAngle(Y_AXIS, elapsed * 2 + i);
            this._m.compose(this._v, this._q,
                this._s.setScalar(0.7 + Math.sin(f.t * Math.PI) * 0.5));
            this.foodMesh.setMatrixAt(i, this._m);
        }
        this.foodMesh.instanceMatrix.needsUpdate = true;
    }

    updateOxygen(dt, elapsed, strength) {
        this.oxygenMat.opacity = strength * 0.9;
        if (strength < 0.01) return;

        for (let i = 0; i < this.oxygenState.length; i++) {
            const o = this.oxygenState[i];
            o.t += o.speed * dt;
            if (o.t > 1) o.t -= 1;
            this._v.copy(LEAF_DOCK).addScaledVector(o.drift, o.t * 4.5);
            this._v.x += Math.sin(elapsed * 1.6 + o.wobble) * 0.18 * o.t;
            this._v.z += Math.cos(elapsed * 1.3 + o.wobble) * 0.18 * o.t;
            this._m.compose(this._v, this._q.identity(),
                this._s.setScalar(0.5 + o.t * 0.9));
            this.oxygenMesh.setMatrixAt(i, this._m);
        }
        this.oxygenMesh.instanceMatrix.needsUpdate = true;
    }

    setQuality(level) {
        this.quality = level;
        if (level === 'low') {
            if (this.lightMesh) this.lightMesh.visible = false;
            if (this.clouds) this.clouds.count = Math.floor(this.cloudState.length / 2);
            if (this.scene.fog) this.scene.fog.density = 0.004;
        }
    }

    /** Static object → stop recomputing its matrix every frame. */
    freeze(obj, deep = false) {
        obj.updateMatrix();
        obj.matrixAutoUpdate = false;
        if (deep) obj.traverse((c) => { c.updateMatrix(); c.matrixAutoUpdate = false; });
    }
}
