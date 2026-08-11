import { Ease } from './tween.js';

/* ============================================================================
   The story
   ---------------------------------------------------------------------------
   Eight beats, in the order given in the brief. Each one is a single short
   sentence and one thing happening on screen, and the two are timed to land
   together — a child should be able to follow this with the sound off.

   Beat 3 is now the exception, on purpose. Water is the one input a child can
   be shown the *mechanism* of rather than just the fact of, so that beat opens
   into a cross-section they can point at and take as long as they like over.
   Everything before and after it stays a guided ride. The lesson always resolves
   on its own if nobody touches anything, so an unattended showing still reaches
   beat 4.

   Structural rules kept from the previous project:
     • every beat is named, logged and individually wrapped, so one failure
       cannot silently kill the rest of the story
     • a generation token means entering or leaving VR can never leave two
       stories running against each other
     • everything is awaited in sequence, so two narration lines can never
       overlap
   ========================================================================== */

const CAMERA_SHOTS = {
    /* Every shot below was checked against where the caption actually sits —
       world.js floats it at a fixed (0, 3.05, 0), with the finale line just
       under it at (0, 2.55, 0). That point does not move with the subject, so
       a shot that frames the action tightly can walk the caption straight out
       of view. Each entry here keeps the angle between the view direction and
       that fixed caption point under about 23° (the camera's vertical half-FOV
       is 27.5°), which is what "camera pulled back enough to show the whole
       beat, sentence included" cashes out to in practice. sun and roots needed
       the biggest change — both used to point 35°+ away from the caption.
       crossSection is checked the same way against the root lab's own caption,
       which travels with it rather than sitting at the world origin. */
    wide: { pos: [0, 1.8, 6.4], target: [0, 1.5, 0] },
    plant: { pos: [0.5, 1.75, 4.8], target: [0, 1.55, 0] },
    sun: { pos: [0, 2.05, 6.2], target: [-0.6, 2.75, -0.4] },
    roots: { pos: [0.3, 1.65, 4.6], target: [0, 1.5, 0.15] },
    crossSection: { pos: [0.05, 1.78, 3.95], target: [0.95, 1.35, 2.15] },
    air: { pos: [1.2, 2.0, 4.0], target: [0, 2.0, 0] },
    kitchen: { pos: [0, 1.95, 4.0], target: [0, 1.78, 1.7] },
    food: { pos: [0.9, 1.6, 4.3], target: [0, 1.5, 0] },
    oxygen: { pos: [1.0, 2.4, 4.4], target: [0, 2.6, 0] },
    finale: { pos: [0, 2.0, 7.4], target: [0, 1.9, 0] }
};

export class Story {
    constructor({ world, cameraDirector, audio, tweener, rootLab = null }) {
        this.world = world;
        this.camera = cameraDirector;
        this.audio = audio;
        this.tweener = tweener;
        this.rootLab = rootLab;

        this.generation = 0;
        this.running = false;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.run(++this.generation).catch((err) => console.error('[story]', err));
    }

    stop() {
        this.running = false;
        this.generation++;
        this.audio.stop();
        // A lesson left armed would keep listening for presses against a story
        // that no longer exists.
        this.rootLab?.hide().catch?.(() => {});
    }

    /** Restarts cleanly — used when entering or leaving the headset. */
    restart() {
        this.stop();
        this.world.fadeAll(0, 0.4);
        this.world.showKitchen(false, 0.4);
        setTimeout(() => this.start(), 500);
    }

    async run(generation) {
        const alive = () => this.running && this.generation === generation;

        const beat = async (name, fn) => {
            if (!alive()) return false;
            console.log(`[story] ${name}`);
            try {
                await fn();
            } catch (err) {
                console.error(`[story] beat "${name}" failed, continuing:`, err);
            }
            return alive();
        };

        do {
            await this.reset();

            /* 1 ── Meet the plant ------------------------------------------ */
            if (!await beat('1 meet the plant', async () => {
                await this.camera.moveTo({ ...CAMERA_SHOTS.wide, seconds: 0.01 });
                await this.hold(0.8);
                await this.line('Meet our plant!', 'meet');
                this.camera.moveTo({ ...CAMERA_SHOTS.plant, seconds: 4.5 });
                await this.hold(2.4);
            })) break;

            /* 2 ── Sunlight ------------------------------------------------ */
            if (!await beat('2 sunlight', async () => {
                this.camera.moveTo({ ...CAMERA_SHOTS.sun, seconds: 3.4 });
                this.world.fade('light', 1, 1.6);
                await this.line('Plants need sunlight for energy.', 'sun');
                await this.hold(2.0);
            })) break;

            /* 3 ── Water: the interactive beat -----------------------------
               The one place the viewer takes over. The cutaway rises out of the
               soil beside the plant — it comes to them, nobody's head is moved,
               which is the same rule the close-up in beat 5 follows. */
            if (!await beat('3 water', async () => {
                this.camera.moveTo({ ...CAMERA_SHOTS.roots, seconds: 3.4 });
                this.world.fade('water', 1, 1.6);
                await this.line('Roots drink water from the soil.', 'water');
                await this.hold(1.2);
            })) break;

            if (!await beat('3b inside a root', async () => {
                if (!this.rootLab) return;
                this.camera.moveTo({ ...CAMERA_SHOTS.crossSection, seconds: 3.0 });
                await this.rootLab.show();
                await this.line('Let us look inside a root.', 'root-open');
                await this.rootLab.runLesson({ timeoutSeconds: 110 });
                await this.rootLab.hide();
                this.camera.moveTo({ ...CAMERA_SHOTS.roots, seconds: 2.0 });
                await this.hold(0.8);
            })) break;

            /* 4 ── Carbon dioxide ------------------------------------------ */
            if (!await beat('4 carbon dioxide', async () => {
                this.camera.moveTo({ ...CAMERA_SHOTS.air, seconds: 3.4 });
                this.world.fade('co2', 1, 1.6);
                await this.line('Leaves take in carbon dioxide from the air.', 'co2');
                await this.hold(2.4);
            })) break;

            /* 5 ── The leaf: a tiny kitchen --------------------------------
               The close-up. On a flat screen the camera pushes in; in VR the
               leaf comes to the viewer instead. Same staging, no head moved. */
            if (!await beat('5 tiny kitchen', async () => {
                this.camera.moveTo({ ...CAMERA_SHOTS.kitchen, seconds: 3.2 });
                await this.world.showKitchen(true, 1.6);
                await this.line('The leaf is like a tiny kitchen!', 'kitchen');
                await this.world.glowLeaf(2.4, 1.0);
                await this.hold(1.2);
            })) break;

            /* 6 ── Plant food ---------------------------------------------- */
            if (!await beat('6 plant food', async () => {
                this.world.fade('food', 1, 1.4);
                await this.line('The plant makes its own food!', 'food');
                this.audio.sfx('release');
                await this.world.glowLeaf(2.0, 1.3);
                await this.world.showKitchen(false, 1.2);
                this.camera.moveTo({ ...CAMERA_SHOTS.food, seconds: 3.0 });
                await this.hold(2.0);
            })) break;

            /* 7 ── Oxygen -------------------------------------------------- */
            if (!await beat('7 oxygen', async () => {
                this.camera.moveTo({ ...CAMERA_SHOTS.oxygen, seconds: 3.2 });
                this.world.fade('oxygen', 1, 1.6);
                await this.line('The plant releases oxygen.', 'oxygen');
                await this.hold(2.6);
            })) break;

            /* 8 ── Final reveal -------------------------------------------- */
            if (!await beat('8 final reveal', async () => {
                this.camera.moveTo({ ...CAMERA_SHOTS.finale, seconds: 4.2 });
                await this.world.fadeAll(1, 1.6);   // everything at once
                await this.line(
                    'Sunlight + Water + Carbon Dioxide → Food + Oxygen',
                    'equation'
                );
                await this.hold(2.4);

                await this.world.say('Plants make their own food!', 'finale');
                await this.audio.narrate('finale', 'Plants make their own food!');
                await this.hold(1.2);

                await this.world.say('This is called PHOTOSYNTHESIS', 'finale');
                this.audio.sfx('chime');
                await this.audio.narrate('name', 'This amazing process is called photosynthesis.');
                await this.hold(3.4);
            })) break;

            if (!await beat('pause before replay', () => this.hold(2.0))) break;
        } while (alive());

        if (this.generation === generation) this.running = false;
    }

    /** Clears the stage back to the opening state. */
    async reset() {
        await Promise.all([
            this.world.fadeAll(0, 0.8),
            this.world.say('', 'caption'),
            this.world.say('', 'finale'),
            this.world.showKitchen(false, 0.6),
            this.rootLab ? this.rootLab.hide() : Promise.resolve()
        ]);
    }

    /**
     * One line: the words appear and are spoken, and the beat waits for both.
     * Narration has a single channel, so lines can never talk over each other.
     */
    async line(text, key) {
        await this.world.say(text, 'caption');
        const finished = await this.audio.narrate(key, text);
        if (!finished) await this.audio.idle();
    }

    /** Frame-driven wait, so it stays in step with the XR presentation clock. */
    hold(seconds) {
        return this.tweener.add(seconds, () => {}, Ease.linear);
    }
}
