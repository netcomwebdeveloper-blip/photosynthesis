import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

import { Tweener } from './tween.js';
import { whenFontsReady } from './labels.js';
import { AudioManager } from './audio.js';
import { World, VIEWER_SPOT } from './world.js';
import { CameraDirector } from './camera.js';
import { Story } from './story.js';

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
        // The set is static, so the shadow map is baked rather than re-rendered
        // 72 times a second.
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

        // The rig exists purely so the headset has something to stand on. It is
        // placed once and then left alone — no travel, no spin, no snap turns.
        // A viewer who wants to move can simply walk; roomscale tracking does
        // the rest, and nothing in software ever moves them.
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
        this.audio = new AudioManager();
        this.world = new World(this.scene, this.tweener);
        this.cameraDirector = new CameraDirector(this.camera, this.renderer, this.tweener);
        this.story = new Story({
            world: this.world,
            cameraDirector: this.cameraDirector,
            audio: this.audio,
            tweener: this.tweener
        });

        this.renderer.xr.addEventListener('sessionstart', () => this.onSessionStart());
        this.renderer.xr.addEventListener('sessionend', () => this.onSessionEnd());
    }

    async boot() {
        // Canvas text silently falls back to a default face if the webfont has
        // not loaded, and every label texture is baked exactly once.
        await whenFontsReady();

        this.world.build();
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

        // Place the rig once. Never the camera — writing to camera.position
        // during a session fights the headset pose and shows up as jitter.
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

        // Start the story over so nobody enters halfway through a beat.
        if (this.started) this.story.restart();
        else { this.started = true; document.getElementById('title-card')?.classList.add('is-gone'); this.story.start(); }
    }

    onSessionEnd() {
        this.rig.position.set(0, 0, 0);
        this.rig.rotation.set(0, 0, 0);
        this.cameraDirector.resync();
        this.story.restart();
    }

    /**
     * Safety net: if the runtime only granted a 'local' reference space, the
     * reported eye height is near zero and the whole world looks wrong. Lift
     * the rig once rather than leaving the viewer standing on the floor.
     */
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

    /** Sheds detail if the headset cannot hold frame rate. */
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
            this.renderer.shadowMap.enabled = false;
            this.renderer.xr.setFoveation(1.0);
        }
    }

    render() {
        const dt = Math.min(this.clock.getDelta(), 0.1);
        this.elapsed += dt;

        this.tweener.update(dt);
        this.world.update(dt, this.elapsed, this.camera);
        this.cameraDirector.update(dt);   // no-op while presenting

        this.monitorPerformance(dt);
        this.renderer.render(this.scene, this.camera);
    }
}

new App();
