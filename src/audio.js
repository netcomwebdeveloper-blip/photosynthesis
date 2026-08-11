/**
 * Audio.
 *
 * Narration has exactly one channel: starting a line always stops the previous
 * one, so two voices can never talk over each other.
 *
 * ---------------------------------------------------------------------------
 * LOUDNESS
 * ---------------------------------------------------------------------------
 * The old build was quiet for three separate reasons, all of them stacking:
 *
 *   1. The master gain sat at 0.5, so everything lost 6 dB before it started.
 *   2. Effect presets were authored at 0.09–0.22, which after the master gain
 *      landed at 0.045–0.11. Barely audible over a headset's own fan.
 *   3. Narration never touched WebAudio at all. Clips played straight out of an
 *      <audio> element and speech went to the OS synthesiser, so the master
 *      gain that everything was supposedly balanced against did nothing to
 *      either of them.
 *
 * Now there is a real bus:
 *
 *      clips ─┐
 *             ├─ narration (1.0) ─┐
 *      sfx ───────── sfx (0.7) ───┴─ master ─ compressor ─ limiter ─ out
 *
 * The compressor is what actually makes this *sound* loud rather than just
 * measure loud: narration peaks get held down so the makeup gain can lift the
 * whole line, which is how a voice stays intelligible over ambience. The
 * limiter after it is a safety catch so a stacked chime can never clip.
 *
 * Speech synthesis is the one thing that cannot be routed — the browser owns
 * that output path. It is set to volume 1.0 and a slightly slower rate, but if
 * you need narration genuinely loud, register mp3s via registerClip(); those go
 * through the bus and get the full chain.
 */

const WORDS_PER_SECOND = 2.6;

/** Clips are lifted before the bus — recordings are usually mastered quiet. */
const CLIP_MAKEUP = 2.4;

export class AudioManager {
    constructor({ preferSpeech = true, voiceHint = 'en', volume = 1.0 } = {}) {
        this.clips = new Map();
        this.clipNodes = new WeakMap();   // createMediaElementSource is once-per-element
        this.preferSpeech = preferSpeech;
        this.voiceHint = voiceHint;
        this.volume = volume;

        this.ctx = null;
        this.master = null;
        this.narrationBus = null;
        this.sfxBus = null;

        this.token = 0;
        this.busy = false;
        this.muted = false;
        this.currentAudio = null;
    }

    /** Must be called from a user gesture (the title card / Enter VR button). */
    unlock() {
        if (!this.ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            this.ctx = new Ctx();
            this.#buildGraph();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        try { window.speechSynthesis?.getVoices(); } catch (_) {}
    }

    #buildGraph() {
        const ctx = this.ctx;

        // Catches the last 2 dB so a chime landing on top of a line cannot clip.
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -2;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.1;
        limiter.connect(ctx.destination);

        // The one that makes speech carry: evens out the line so makeup gain
        // can lift the whole thing rather than just its loudest syllable.
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -20;
        comp.knee.value = 12;
        comp.ratio.value = 3.5;
        comp.attack.value = 0.006;
        comp.release.value = 0.22;
        comp.connect(limiter);

        this.master = ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(comp);

        this.narrationBus = ctx.createGain();
        this.narrationBus.gain.value = 1.0;
        this.narrationBus.connect(this.master);

        // Effects sit under the voice on purpose — they punctuate, they don't
        // compete. This is the ratio that used to be missing entirely.
        this.sfxBus = ctx.createGain();
        this.sfxBus.gain.value = 0.7;
        this.sfxBus.connect(this.master);
    }

    /** 0–1.5. Above 1 is fine; the limiter is there for exactly that. */
    setVolume(value) {
        this.volume = Math.max(0, Math.min(1.5, value));
        if (this.master && !this.muted) {
            this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
        }
    }

    registerClip(key, url) {
        const audio = new Audio(url);
        audio.preload = 'auto';
        audio.crossOrigin = 'anonymous';
        audio.volume = 1.0;
        this.clips.set(key, audio);
    }

    setMuted(muted) {
        this.muted = muted;
        if (this.master) this.master.gain.value = muted ? 0 : this.volume;
        if (muted) this.stop();
    }

    stop() {
        this.token++;
        this.busy = false;
        if (this.currentAudio) {
            try { this.currentAudio.pause(); this.currentAudio.currentTime = 0; } catch (_) {}
            this.currentAudio = null;
        }
        try { window.speechSynthesis?.cancel(); } catch (_) {}
    }

    /**
     * Speaks a line and resolves when it finishes.
     * @returns {Promise<boolean>} false if superseded by a newer line.
     */
    async narrate(key, text) {
        this.stop();
        const mine = ++this.token;
        this.busy = true;

        const fallbackSeconds = Math.max(2.5, (String(text).split(/\s+/).length) / WORDS_PER_SECOND);

        if (this.muted) {
            await this.#sleep(fallbackSeconds * 1000);
        } else if (this.clips.has(key)) {
            await this.#playClip(this.clips.get(key), fallbackSeconds);
        } else if (this.preferSpeech && window.speechSynthesis) {
            await this.#speak(text, fallbackSeconds);
        } else {
            await this.#sleep(fallbackSeconds * 1000);
        }

        if (mine !== this.token) return false;
        this.busy = false;
        return true;
    }

    /** Waits until whatever is currently speaking has finished. */
    async idle() {
        while (this.busy) await this.#sleep(120);
    }

    /** Routes an <audio> element into the narration bus so it gets the chain. */
    #route(audio) {
        if (!this.ctx || !this.narrationBus) return;
        if (this.clipNodes.has(audio)) return;
        try {
            const src = this.ctx.createMediaElementSource(audio);
            const boost = this.ctx.createGain();
            boost.gain.value = CLIP_MAKEUP;
            src.connect(boost).connect(this.narrationBus);
            this.clipNodes.set(audio, boost);
        } catch (_) {
            // Cross-origin without CORS headers, or already routed: the element
            // still plays, just at its own level. Not worth failing a beat over.
        }
    }

    #playClip(audio, fallbackSeconds) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                audio.removeEventListener('ended', finish);
                clearTimeout(guard);
                resolve();
            };
            audio.addEventListener('ended', finish);
            this.currentAudio = audio;
            this.#route(audio);
            try {
                audio.currentTime = 0;
                audio.volume = 1.0;
                const p = audio.play();
                if (p?.catch) p.catch(() => finish());
            } catch (_) {
                finish();
            }
            const known = Number.isFinite(audio.duration) && audio.duration > 0
                ? audio.duration : fallbackSeconds;
            const guard = setTimeout(finish, known * 1000 + 1500);
        });
    }

    #speak(text, fallbackSeconds) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(guard);
                resolve();
            };
            try {
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.rate = 0.92;
                utterance.pitch = 1.0;
                utterance.volume = 1.0;   // was never set; some engines default low
                const voices = window.speechSynthesis.getVoices() || [];
                const match = voices.find((v) => v.lang?.toLowerCase().startsWith(this.voiceHint));
                if (match) utterance.voice = match;
                utterance.onend = finish;
                utterance.onerror = finish;
                window.speechSynthesis.speak(utterance);
            } catch (_) {
                finish();
            }
            const guard = setTimeout(finish, fallbackSeconds * 1000 + 4000);
        });
    }

    #sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    /* ------------------------------------------------------------ effects */

    sfx(name) {
        if (!this.ctx || this.muted || !this.sfxBus) return;

        // Roughly doubled from the old values. These now land on a bus that is
        // itself at 0.7 under a master of 1.0, so the audible result is about
        // four times what it used to be.
        const presets = {
            absorb:  { freqs: [392, 587],             dur: 0.28, type: 'sine',     gain: 0.55 },
            reject:  { freqs: [220, 165],             dur: 0.24, type: 'triangle', gain: 0.45 },
            release: { freqs: [523, 784, 1046],       dur: 0.50, type: 'sine',     gain: 0.50 },
            click:   { freqs: [660],                  dur: 0.09, type: 'square',   gain: 0.30 },
            chime:   { freqs: [523, 659, 784, 1047],  dur: 0.90, type: 'sine',     gain: 0.42 },
            drip:    { freqs: [880, 1320],            dur: 0.18, type: 'sine',     gain: 0.38 },
            pump:    { freqs: [147, 196, 294],        dur: 0.34, type: 'triangle', gain: 0.42 },
            rise:    { freqs: [330, 440, 554, 659],   dur: 0.70, type: 'sine',     gain: 0.38 }
        };
        const preset = presets[name] || presets.click;
        const now = this.ctx.currentTime;

        preset.freqs.forEach((freq, i) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const start = now + i * (preset.dur / preset.freqs.length) * 0.6;

            osc.type = preset.type;
            osc.frequency.setValueAtTime(freq, start);
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(preset.gain, start + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + preset.dur);

            osc.connect(gain).connect(this.sfxBus);
            osc.start(start);
            osc.stop(start + preset.dur + 0.05);
        });
    }
}
