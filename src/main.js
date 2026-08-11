import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

import { Tweener } from './tween.js';
import { whenFontsReady } from './labels.js';
import { AudioManager } from './audio.js';
import { World, VIEWER_SPOT } from './world.js';
import { CameraDirector } from './camera.js';
import { Story } from './story.js';
import { Environment } from './environment.js';
import { Interaction } from './interaction.js';
import { ExitControl } from './vrui.js';
import { RootLab } from './rootlab.js';

/* ============================================================================
   Bootstrap
   ---------------------------------------------------------------------------
   Everything that can cause head-locked judder on a Quest is decided here.
   The four causes, and what is done about each:

   1. Reference space. 'local-floor', never plain 'local'. With 'local' the
      origin sits wherever the head happened to be at session start, so the
      reported eye height collapses to near zero, the floor ends up at eye
      level, and ordinary head sway is exaggerated into the world shaking up
      and down. calibrateEyeHeight() is the safety net if the runtime only
      grants 'local'.

   2. Camera ownership. Nothing writes to camera.position or camera.rotation
      while a session is presenting — the headset pose owns that transform, and
      anything competing with it lands as jitter. The camera director checks
      xr.isPresenting and switches itself off.

   3. Frame pacing. Dropped frames get reprojected by the compositor, and
      reprojected frames swim vertically as you move your head. So: everything
      repeated is instanced, the shadow map is baked once, static props have
      matrixAutoUpdate off, all animation is frame-delta driven, and 72 Hz is
      requested explicitly. An adaptive fallback sheds detail if the average
      still falls short.

   4. Z-fighting. Ground surfaces are layered centimetres apart. Coplanar
      planes flicker, and the flicker tracks your head, which reads as shimmer.

   The forest terrain is the one thing that could undo point 3 on its own, so it
   loads before the first frame, receives shadow but never casts, and has its
   matrices frozen. If it fails to load the lesson still runs on the old ground.
   ========================================================================== */

const CONFIG = {
    xr: {
        referenceSpace: 'local-floor',
        preferredFrameRates: [72, 90],
        foveation: 0.6,
        framebufferScale: 1.0     // drop to 0.85 if any judder survives
    },
    quality: {
        adaptive: true,
        minFps: 62
    },
    audio: {
        // Master level for the whole mix. 1.0 is unity through the compressor;
        // push to 1.2 if the room is loud. The old build sat at 0.5.
        volume: 1.0
    },
    terrain: {
        enabled: true             // placement and culling live in environment.js
    }
};

class App {
    constructor() {
        this.tweener = new Tweener();
        this.elapsed = 0;
        this.fpsSamples = [];
        this.qualityReduced = false;
        this.started = false;

        this.initRenderer();
        this.initScene();
        this.initManagers();
        this.boot();
    }

    /* ------------------------------------------------------------ renderer */

    initRenderer() {
        this.renderer = new THREE.WebGLRenderer({
            antialias: true, alpha: false, powerPreference: 'high-performance'
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.08;

        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.shadowMap.autoUpdate = false;

        this.renderer.xr.enabled = true;
        this.renderer.xr.setReferenceSpaceType(CONFIG.xr.referenceSpace);
        this.renderer.xr.setFramebufferScaleFactor(CONFIG.xr.framebufferScale);
        this.renderer.xr.setFoveation(CONFIG.xr.foveation);

        document.body.appendChild(this.renderer.domElement);
        this.clock = new THREE.Clock();

        window.addEventListener('resize', () => this.onResize());
    }

    initScene() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x8fd0ee);

        this.rig = new THREE.Group();
        this.rig.name = 'rig';
        this.scene.add(this.rig);

        this.camera = new THREE.PerspectiveCamera(
            55, window.innerWidth / window.innerHeight, 0.1, 200
        );
        this.camera.position.set(0, 1.75, 6.4);
        this.rig.add(this.camera);
    }

    initManagers() {
        this.audio = new AudioManager({ volume: CONFIG.audio.volume });
        this.world = new World(this.scene, this.tweener);
        this.environment = new Environment(this.scene, { renderer: this.renderer });
        this.cameraDirector = new CameraDirector(this.camera, this.renderer, this.tweener);

        // One pointer system, shared by the exit control and every hotspot in
        // the root lab, so pressing anything works the same way everywhere.
        this.interaction = new Interaction(this.renderer, this.camera, this.scene);
        this.interaction.attachTo(this.rig);

        this.exitControl = new ExitControl({
            renderer: this.renderer,
            rig: this.rig,
            interaction: this.interaction,
            audio: this.audio
        });

        this.rootLab = new RootLab({
            scene: this.scene,
            tweener: this.tweener,
            audio: this.audio,
            interaction: this.interaction,
            billboards: this.world.billboards || null
        });

        this.story = new Story({
            world: this.world,
            cameraDirector: this.cameraDirector,
            audio: this.audio,
            tweener: this.tweener,
            rootLab: this.rootLab
        });

        this.renderer.xr.addEventListener('sessionstart', () => this.onSessionStart());
        this.renderer.xr.addEventListener('sessionend', () => this.onSessionEnd());
    }

    async boot() {
        // Canvas text silently falls back to a default face if the webfont has
        // not loaded, and every label texture is baked exactly once.
        await whenFontsReady();

        this.world.build();

        // Terrain and cross-section both go in before the first frame. Loading
        // a mesh this size mid-session drops frames, and dropped frames get
        // reprojected, and reprojected frames swim.
        if (CONFIG.terrain.enabled) {
            const ok = await this.environment.load();
            // The terrain becomes the ground, so the flat meadow discs and the
            // grass scattered across them are hidden. Leaving them would give
            // coplanar flicker on the discs and grass floating over uneven
            // ground, and the forest brings its own undergrowth anyway.
            if (ok) this.world.setGroundVisible?.(false);
        }
        await this.rootLab.build();

        this.refreshShadows();

        const slot = document.getElementById('vr-slot');
        if (slot && navigator.xr) {
            const button = VRButton.createButton(this.renderer, {
                optionalFeatures: ['local-floor', 'bounded-floor', 'layers']
            });
            button.addEventListener('click', () => this.audio.unlock());
            slot.appendChild(button);
        }

        this.renderer.setAnimationLoop(() => this.render());
        this.armTitleCard();
    }

    /**
     * The title card is also the audio gesture — browsers will not speak until
     * the page has been touched. If nobody touches it, the story still starts
     * after a moment, just silently.
     */
    armTitleCard() {
        const card = document.getElementById('title-card');
        const begin = (withSound) => {
            if (this.started) return;
            this.started = true;
            if (withSound) this.audio.unlock();
            card?.classList.add('is-gone');
            this.story.start();
        };

        card?.addEventListener('click', () => begin(true), { once: true });
        window.addEventListener('keydown', () => begin(true), { once: true });
        setTimeout(() => begin(false), 9000);
    }

    /** Static set → bake the shadow map for a couple of frames, then stop. */
    refreshShadows() {
        this.renderer.shadowMap.needsUpdate = true;
        setTimeout(() => { this.renderer.shadowMap.needsUpdate = true; }, 300);
    }

    /* ------------------------------------------------------------- session */

    onSessionStart() {
        this.audio.unlock();

        this.rig.position.set(VIEWER_SPOT.x, 0, VIEWER_SPOT.z);
        this.rig.rotation.set(0, 0, 0);

        const session = this.renderer.xr.getSession();
        if (session) {
            const rates = session.supportedFrameRates || [];
            const pick = CONFIG.xr.preferredFrameRates.find((r) => rates.includes(r));
            if (pick && session.updateTargetFrameRate) {
                session.updateTargetFrameRate(pick).catch(() => {});
            }
        }

        this.refreshShadows();
        setTimeout(() => this.calibrateEyeHeight(), 1200);

        if (this.started) this.story.restart();
        else { this.started = true; document.getElementById('title-card')?.classList.add('is-gone'); this.story.start(); }
    }

    onSessionEnd() {
        this.rig.position.set(0, 0, 0);
        this.rig.rotation.set(0, 0, 0);
        this.cameraDirector.resync();
        this.story.restart();
    }

    calibrateEyeHeight() {
        if (!this.renderer.xr.isPresenting) return;
        const eye = this.camera.position.y;
        if (eye < 0.6) {
            console.warn('[xr] floor-relative space unavailable, applying 1.6 m offset');
            this.rig.position.y += 1.6 - eye;
        }
    }

    /* ---------------------------------------------------------------- loop */

    onResize() {
        if (this.renderer.xr.isPresenting) return;
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    monitorPerformance(dt) {
        if (!CONFIG.quality.adaptive || this.qualityReduced) return;
        if (!this.renderer.xr.isPresenting || dt <= 0) return;

        this.fpsSamples.push(1 / dt);
        if (this.fpsSamples.length < 240) return;

        const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
        this.fpsSamples.length = 0;

        if (avg < CONFIG.quality.minFps) {
            this.qualityReduced = true;
            console.warn(`[perf] ${avg.toFixed(1)} fps — shedding detail`);
            this.world.setQuality('low');
            this.environment.setQuality('low');
            this.rootLab.setQuality('low');
            this.renderer.shadowMap.enabled = false;
            this.renderer.xr.setFoveation(1.0);
        }
    }

    render() {
        const dt = Math.min(this.clock.getDelta(), 0.1);
        this.elapsed += dt;

        this.tweener.update(dt);
        this.world.update(dt, this.elapsed, this.camera);
        this.rootLab.update(dt, this.elapsed);
        this.interaction.update();
        this.exitControl.update(dt);
        this.cameraDirector.update(dt);   // no-op while presenting

        this.monitorPerformance(dt);
        this.renderer.render(this.scene, this.camera);
    }
}

new App();
