/**
 * Frame-delta tween engine.
 *
 * Everything is driven by the seconds elapsed between rendered frames, never by
 * performance.now(). Wall-clock tweens drift against the XR compositor's
 * presentation times and show up as stutter in the headset.
 */

export const Ease = {
    linear: (t) => t,
    inQuad: (t) => t * t,
    outQuad: (t) => t * (2 - t),
    inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outBack: (t) => {
        const c1 = 1.70158, c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    outElastic: (t) => {
        if (t === 0 || t === 1) return t;
        const c4 = (2 * Math.PI) / 3;
        return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    },
    breathe: (t) => Math.sin(t * Math.PI)
};

export class Tweener {
    constructor() {
        this.items = [];
    }

    /**
     * @param {number} duration seconds
     * @param {(eased:number, raw:number)=>void} onUpdate
     * @param {(t:number)=>number} [ease]
     * @returns {Promise<void>} resolves on completion (or on clear())
     */
    add(duration, onUpdate, ease = Ease.linear) {
        return new Promise((resolve) => {
            this.items.push({
                t: 0,
                duration: Math.max(duration, 1e-4),
                onUpdate,
                ease,
                resolve
            });
        });
    }

    /** Convenience: a plain timed wait that is still frame-driven. */
    wait(seconds) {
        return this.add(seconds, () => {});
    }

    update(dt) {
        for (let i = this.items.length - 1; i >= 0; i--) {
            const tw = this.items[i];
            tw.t += dt;
            const raw = Math.min(tw.t / tw.duration, 1);
            if (tw.onUpdate) tw.onUpdate(tw.ease(raw), raw);
            if (raw >= 1) {
                this.items.splice(i, 1);
                tw.resolve();
            }
        }
    }

    /** Resolves everything pending so awaited sequences can never hang. */
    clear() {
        const pending = this.items;
        this.items = [];
        pending.forEach((tw) => tw.resolve());
    }
}
