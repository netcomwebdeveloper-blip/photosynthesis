/**
 * Audio.
 *
 * Narration has exactly one channel: starting a line always stops the previous
 * one, so two voices can never talk over each other — whether the line came
 * from the guided tour or from someone pressing a button mid-sentence.
 *
 * Three sources, tried in order:
 *   1. An mp3 registered via registerClip() — drop your own recordings in.
 *   2. Browser speech synthesis, so the lesson is fully narrated with zero
 *      audio assets.
 *   3. A timed silence matching the caption length, if neither is available.
 *
 * Sound effects are generated with WebAudio rather than shipped as files, which
 * keeps the project asset-free and avoids a load hitch mid-session.
 */

const WORDS_PER_SECOND = 2.6;

export class AudioManager {
    constructor({ preferSpeech = true, voiceHint = 'en' } = {}) {
        this.clips = new Map();
        this.preferSpeech = preferSpeech;
        this.voiceHint = voiceHint;
        this.ctx = null;
        this.master = null;
        this.token = 0;
        this.busy = false;
        this.muted = false;
        this.currentAudio = null;
    }

    /** Must be called from a user gesture (the Enter VR / Play button). */
    unlock() {
        if (!this.ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            this.ctx = new Ctx();
            this.master = this.ctx.createGain();
            this.master.gain.value = 0.5;
            this.master.connect(this.ctx.destination);
        }
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        // Priming speech synthesis inside the gesture avoids the first line
        // being swallowed on some browsers.
        try { window.speechSynthesis?.getVoices(); } catch (_) {}
    }

    registerClip(key, url) {
        const audio = new Audio(url);
        audio.preload = 'auto';
        this.clips.set(key, audio);
    }

    setMuted(muted) {
        this.muted = muted;
        if (this.master) this.master.gain.value = muted ? 0 : 0.5;
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
            try {
                audio.currentTime = 0;
                const p = audio.play();
                // Autoplay policy rejects this as a promise; an unhandled
                // rejection here could otherwise break the step that follows.
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
                utterance.rate = 0.95;
                utterance.pitch = 1.0;
                const voices = window.speechSynthesis.getVoices() || [];
                const match = voices.find((v) => v.lang?.toLowerCase().startsWith(this.voiceHint));
                if (match) utterance.voice = match;
                utterance.onend = finish;
                utterance.onerror = finish;
                window.speechSynthesis.speak(utterance);
            } catch (_) {
                finish();
            }
            // Speech synthesis can drop onend entirely on some platforms.
            const guard = setTimeout(finish, fallbackSeconds * 1000 + 4000);
        });
    }

    #sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    /* ------------------------------------------------------------ effects */

    sfx(name) {
        if (!this.ctx || this.muted) return;
        const presets = {
            absorb: { freqs: [392, 587], dur: 0.28, type: 'sine', gain: 0.22 },
            reject: { freqs: [220, 165], dur: 0.24, type: 'triangle', gain: 0.18 },
            release: { freqs: [523, 784, 1046], dur: 0.5, type: 'sine', gain: 0.2 },
            click: { freqs: [660], dur: 0.09, type: 'square', gain: 0.1 },
            chime: { freqs: [523, 659, 784, 1047], dur: 0.9, type: 'sine', gain: 0.16 }
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

            osc.connect(gain).connect(this.master);
            osc.start(start);
            osc.stop(start + preset.dur + 0.05);
        });
    }
}
