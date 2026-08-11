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
 * master gain sat at 0.5, effect presets were authored too low, and narration
 * never touched WebAudio at all — clips played straight out of an <audio>
 * element and speech went to the OS synthesiser, so the master gain that
 * everything was supposedly balanced against did nothing to either.
 *
 * There is now a real bus:
 *
 *      track / clips ─┐
 *                      ├─ narration (1.0) ─┐
 *      sfx ─────────────── sfx (0.7) ──────┴─ master ─ compressor ─ limiter ─ out
 *
 * The compressor is what actually makes this *sound* loud rather than just
 * measure loud. The limiter after it is a safety catch so a stacked chime can
 * never clip.
 *
 * ---------------------------------------------------------------------------
 * ONE RECORDED FILE, MANY LINES
 * ---------------------------------------------------------------------------
 * registerNarrationTrack(url, NARRATION_ORDER) loads a single mp3 containing
 * every line of narration recorded back-to-back, with a pause of silence
 * between each one, and automatically slices it into per-line segments by
 * detecting those silences. NARRATION_ORDER below is the fixed order the
 * lines must be recorded in — see NARRATION_SCRIPT.md for the exact words.
 *
 * The slicing happens once, at load, against the *recorded* order. Playback
 * order can differ from that — the root lab lets a child press the four ideas
 * in any order — because narrate(key, ...) looks the key up in a manifest
 * built from that one-time pass, not from playback position.
 *
 * If the file is missing, fails to load, or the browser lacks decodeAudioData,
 * every line quietly falls back to speech synthesis. Nothing else changes.
 */

const WORDS_PER_SECOND = 2.6;

/** Clips/track are lifted before the bus — recordings are usually mastered quiet. */
const CLIP_MAKEUP = 2.4;
const TRACK_MAKEUP = 1.6;

/**
 * The fixed recording order for the single narration mp3. Say these fifteen
 * lines in exactly this order, in one continuous take, with a clear pause of
 * silence between each — the code finds the boundaries itself. The literal
 * words are in NARRATION_SCRIPT.md; this array only has to match its order.
 */
export const NARRATION_ORDER = [
    'meet', 'sun', 'water', 'root-open',
    'root-hair', 'root-osmosis', 'root-ions', 'root-xylem',
    'co2', 'kitchen', 'food', 'oxygen',
    'equation', 'finale', 'name'
];

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

        this.trackBuffer = null;      // decoded AudioBuffer for the one mp3
        this.trackManifest = null;    // { key: { start, duration } }
        this.currentSource = null;    // the AudioBufferSourceNode currently playing

        this.token = 0;
        this.busy = false;
        this.muted = false;
        this.currentAudio = null;
    }

    /** Must be called from a user gesture (the title card / Enter VR button). */
    unlock() {
        this.#ensureContext();
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        try { window.speechSynthesis?.getVoices(); } catch (_) {}
    }

    /**
     * Creates the context and mix graph if they do not exist yet. Safe to call
     * before any user gesture — constructing nodes and decoding audio do not
     * need one, only actually producing sound through the destination does,
     * and that is what unlock() resumes once the gesture arrives.
     */
    #ensureContext() {
        if (this.ctx) return this.ctx;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        this.ctx = new Ctx();
        this.#buildGraph();
        return this.ctx;
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

    /* -------------------------------------------------------- one mp3 file */

    /**
     * Loads one recording containing every line back-to-back and slices it by
     * silence. Never throws — on any failure it logs a warning and every line
     * falls back to speech synthesis, so it is safe to call unconditionally
     * at boot without wrapping it in try/catch.
     *
     * @param {string} url               e.g. './assets/narration.mp3'
     * @param {string[]} keysInOrder     NARRATION_ORDER — must match the order
     *                                   the lines were actually recorded in
     * @param {object} [opts]
     * @param {number} [opts.threshold=0.025]        RMS level counted as speech
     * @param {number} [opts.minSilenceSeconds=0.35] gap that splits two lines
     * @param {number} [opts.minSegmentSeconds=0.15] shorter blips are discarded
     * @param {number} [opts.padSeconds=0.06]        edge padding kept per line
     * @returns {Promise<boolean>} whether the track loaded and is in use
     */
    async registerNarrationTrack(url, keysInOrder, opts = {}) {
        const ctx = this.#ensureContext();
        if (!ctx) { console.warn('[audio] WebAudio unavailable, using speech synthesis'); return false; }

        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
            const bytes = await res.arrayBuffer();
            const buffer = await ctx.decodeAudioData(bytes);

            const segments = this.#detectSegments(buffer, opts);
            const n = Math.min(segments.length, keysInOrder.length);
            const manifest = {};
            for (let i = 0; i < n; i++) manifest[keysInOrder[i]] = segments[i];

            this.trackBuffer = buffer;
            this.trackManifest = manifest;

            if (segments.length !== keysInOrder.length) {
                console.warn(
                    `[audio] narration track: expected ${keysInOrder.length} lines, ` +
                    `detected ${segments.length} — check the pause between lines in the ` +
                    `recording (aim for 1–2 s of quiet). Lines beyond the shorter count ` +
                    `will use speech synthesis instead. Call audio.describeNarrationTrack() ` +
                    `in the console to see exactly what was found.`
                );
            } else {
                console.log(`[audio] narration track ready — ${n} lines mapped from ${url}`);
            }
            return true;
        } catch (err) {
            console.warn('[audio] narration track unavailable, using speech synthesis fallback:', err);
            this.trackBuffer = null;
            this.trackManifest = null;
            return false;
        }
    }

    /** Console helper: prints what got detected, for tuning the recording. */
    describeNarrationTrack() {
        if (!this.trackManifest) { console.log('[audio] no narration track loaded'); return; }
        for (const [key, seg] of Object.entries(this.trackManifest)) {
            console.log(`  ${key.padEnd(14)} ${seg.start.toFixed(2)}s  +${seg.duration.toFixed(2)}s`);
        }
    }

    /**
     * Silence-based segmentation. Mixes all channels down, computes RMS over
     * 20 ms frames, and splits wherever the gap between spoken frames exceeds
     * minSilenceSeconds. This runs once at load, entirely on the CPU — a
     * typical two-minute recording takes a few milliseconds.
     */
    #detectSegments(buffer, {
        threshold = 0.025,
        minSilenceSeconds = 0.35,
        minSegmentSeconds = 0.15,
        padSeconds = 0.06
    } = {}) {
        const sr = buffer.sampleRate;
        const channels = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

        const frameSeconds = 0.02;
        const frameLen = Math.max(1, Math.round(sr * frameSeconds));
        const frameCount = Math.ceil(buffer.length / frameLen);
        const rms = new Float32Array(frameCount);

        for (let f = 0; f < frameCount; f++) {
            const start = f * frameLen;
            const end = Math.min(buffer.length, start + frameLen);
            let sum = 0;
            for (let i = start; i < end; i++) {
                let s = 0;
                for (const ch of channels) s += ch[i];
                s /= channels.length;
                sum += s * s;
            }
            rms[f] = end > start ? Math.sqrt(sum / (end - start)) : 0;
        }

        const minSilenceFrames = Math.round(minSilenceSeconds / frameSeconds);
        const runs = [];
        let segStart = -1, lastActive = -1;

        for (let f = 0; f < frameCount; f++) {
            if (rms[f] > threshold) {
                if (segStart === -1) segStart = f;
                lastActive = f;
            } else if (segStart !== -1 && (f - lastActive) > minSilenceFrames) {
                runs.push([segStart, lastActive]);
                segStart = -1;
            }
        }
        if (segStart !== -1) runs.push([segStart, lastActive]);

        const out = [];
        for (const [a, b] of runs) {
            const start = Math.max(0, a * frameSeconds - padSeconds);
            const end = Math.min(buffer.duration, (b + 1) * frameSeconds + padSeconds);
            const duration = end - start;
            if (duration >= minSegmentSeconds) out.push({ start, duration });
        }
        return out;
    }

    /** Manually register a separate mp3 for one line, instead of the shared track. */
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
        if (this.currentSource) {
            try { this.currentSource.stop(); } catch (_) {}
            this.currentSource = null;
        }
        if (this.currentAudio) {
            try { this.currentAudio.pause(); this.currentAudio.currentTime = 0; } catch (_) {}
            this.currentAudio = null;
        }
        try { window.speechSynthesis?.cancel(); } catch (_) {}
    }

    /**
     * Speaks a line and resolves when it finishes. Tries, in order: the shared
     * recording, a manually registered clip, browser speech, or a timed
     * silence — whichever is available for this key.
     * @returns {Promise<boolean>} false if superseded by a newer line.
     */
    async narrate(key, text) {
        this.stop();
        const mine = ++this.token;
        this.busy = true;

        const fallbackSeconds = Math.max(2.5, (String(text).split(/\s+/).length) / WORDS_PER_SECOND);

        if (this.muted) {
            await this.#sleep(fallbackSeconds * 1000);
        } else if (this.trackManifest?.[key]) {
            await this.#playFromTrack(this.trackManifest[key]);
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

    /** Plays one slice of the shared recording through the narration bus. */
    #playFromTrack(seg) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(guard);
                resolve();
            };

            const src = this.ctx.createBufferSource();
            src.buffer = this.trackBuffer;
            const boost = this.ctx.createGain();
            boost.gain.value = TRACK_MAKEUP;
            src.connect(boost).connect(this.narrationBus);
            src.onended = finish;

            this.currentSource = src;
            try {
                src.start(0, seg.start, seg.duration);
            } catch (_) {
                finish();
            }
            const guard = setTimeout(finish, seg.duration * 1000 + 800);
        });
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
                utterance.volume = 1.0;
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
