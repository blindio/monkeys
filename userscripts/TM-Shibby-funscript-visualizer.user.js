// ==UserScript==
// @name        TM Shibby Funscript Visualizer
// @description Render heatmap-style waveform graphs for a Shibbydex page's funscripts (Tampermonkey)
// @namespace   https://shibbydex.com/
// @version     4.2.3-2026-10-22
// @updateURL   https://raw.githubusercontent.com/blindio/monkeys/main/userscripts/TM-Shibby-funscript-visualizer.user.js
// @downloadURL https://raw.githubusercontent.com/blindio/monkeys/main/userscripts/TM-Shibby-funscript-visualizer.user.js
// @author      Thorson Little
// @match       https://shibbydex.com/file/*
// @run-at      document-idle
// @grant       GM_xmlhttpRequest
// @connect     shibbydex.com
// @connect     assets.shibbydex.com
// @connect     cloudflarestorage.com
// @connect     raw.githubusercontent.com
// ==/UserScript==

// Deliberately narrower than its two siblings, which match the whole site: a
// panel of graphs only means something for one file, and on a playlist it never
// appeared anyway — the data element is not there yet when this runs at
// document-idle. Widen it only alongside a reason for the panel to follow a
// playlist, not to make the three scripts look consistent.

// Haptic URLs 302 to a presigned bucket on r2.cloudflarestorage.com, and
// Tampermonkey re-checks the redirect target against @connect ("Request was
// redirected to a not whitelisted URL"). A bare `*` does not satisfy that
// check, so that hop needs a domain entry of its own.
//
// raw.githubusercontent.com is there for tracks the funscript injector adds: it
// rewrites the player data, so some rows point at GitHub rather than shibbydex.
// Without that entry those fetches are blocked, and on a file whose haptics are
// entirely injected that leaves no rows at all and no panel.

// Vibe and plug channels always use 1000*|dp|/dt — every implementation surveyed
// computes them identically, so there is nothing to choose. Only the stroker has
// real alternatives (launchcontrol's motor curve, the Handy's mm/s), selectable
// beneath its own graph. Colors default to a perceptual ramp rather than the
// funscript standard, which is not monotone in lightness; see PALETTES.

(function () {
    'use strict';

    const PLAYER_DATA_SELECTOR = "script#sd-player-data";
    const DEVICE_ORDER = ["vibe", "plug", "stroker"];
    const RETRY_DELAY_SECS = 10;
    const MAX_ATTEMPTS = 2;

    const BASE_PIXELS_PER_SECOND = 15;
    const MAX_ROW_WIDTH_PX = 520;
    const MIN_ROW_WIDTH_PX = 40;
    const ROW_HEIGHT_PX = 64;
    // The floor at which the resize fit stops shrinking rows and lets
    // rowsContainer scroll instead. Three devices in phone landscape overflow
    // whatever this is set to, so shrinking past a readable height does not
    // avoid the scroll — it just buys squashed graphs and the scroll. 40 is
    // about where a speed trace still reads; below that the fit was spending
    // legibility for nothing.
    const MIN_ROW_HEIGHT_PX = 40;
    const ROW_GAP_PX = 8;

    const CANVAS_BG = "#141414";
    const TIMELINE_HEIGHT_PX = 20;
    const AXIS_WIDTH_PX = 28;
    const AXIS_COLOR = "#666";
    const LABEL_COLOR = "#aaa";
    // Amber rather than red: a channel switched off in the player's haptic
    // settings is a fact about playback, not an error in the script we drew.
    const LABEL_OFF_COLOR = "#d9a441";

    // The playhead is white on a black halo rather than a colour, because every
    // palette uses most of the spectrum for data — there is no hue left that
    // could not be mistaken for a reading. Contrast and the halo distinguish it
    // instead of hue.
    const AUDIO_SELECTOR = "audio";
    const PLAYHEAD_WIDTH_PX = 2;
    const PLAYHEAD_COLOR = "#fff";
    const PLAYHEAD_WARN_MS = 5000;

    // Font/size constants to avoid magic numbers scattered through draw functions
    const AXIS_LABEL_FONT = "9px monospace";
    const AXIS_LABEL_Y_CLAMP_TOP = 8;
    const AXIS_LABEL_Y_CLAMP_BOTTOM_OFFSET = 2;
    const TIMELINE_LABEL_FONT = "10px monospace";
    const TIMELINE_LABEL_Y = 14;
    const TIMELINE_TICK_HEIGHT = 4;
    const TOOLTIP_FONT = "11px monospace";
    const LABEL_FONT = "11px monospace";

    // Two properties matter here and they pull in different directions.
    //
    // Discriminability: how much perceptual distance the ramp covers, which is
    // what lets you tell two speeds apart. Measured as OKLab path length, the
    // funscript standard (Lucifie's, which beta.funscript.io uses) scores 234
    // against Inferno's 111 — a rainbow spends hue *and* lightness, so it
    // discriminates about twice as well as any single-hue perceptual ramp.
    // On its own terms it is the best ramp here, not a broken one.
    //
    // Peak visibility: the standard's one real cost. Its tail turns down into
    // mediumpurple then dark indigo, so the top stop sits at OKLab dE 19 from
    // this near-black canvas versus Inferno's 79 — the fastest moments render
    // as the dimmest marks on the chart.
    //
    // Keeping the familiar black->blue->green->gold->crimson arc and replacing
    // only that tail with magenta->white wins on both counts at once: path 247
    // (up from 234), minimum adjacent gap 28.6 (up from 26.3), and top-vs-canvas
    // 81 (up from 19). That is the default. The unmodified standard is kept for
    // exact parity with beta.funscript.io, and the perceptual ramps for when
    // readable ordering matters more than discrimination — they trade about
    // half the discriminability for lightness that rises monotonically.
    //
    // All ramps leave their darkest stop nearly invisible on the background,
    // which is deliberate: speed 0 draws no bar at all, so that end of the ramp
    // is absent data rather than unreadable data.
    const PALETTES = {
        funscriptBright: {
            label: "Funscript (bright peak)",
            title: "The community palette's familiar arc, with its dark purple tail replaced by magenta->white so peak intensity is the brightest mark rather than the dimmest. Discriminates slightly better than the original.",
            stops: [[0, 0, 0], [30, 144, 255], [34, 139, 34], [255, 215, 0], [220, 20, 60], [255, 0, 255], [255, 255, 255]],
        },
        inferno: {
            label: "Inferno",
            title: "Perceptual heat ramp: black -> purple -> crimson -> orange -> yellow. Monotone lightness, so faster always reads brighter.",
            stops: [[0, 0, 4], [50, 10, 94], [120, 28, 109], [187, 55, 84], [237, 105, 37], [251, 182, 26], [252, 255, 164]],
        },
        plasma: {
            label: "Plasma",
            title: "Perceptual ramp starting at deep blue: blue -> magenta -> orange -> yellow. Monotone lightness.",
            stops: [[13, 8, 135], [92, 1, 166], [156, 23, 158], [204, 71, 120], [237, 121, 83], [253, 180, 47], [240, 249, 33]],
        },
        magma: {
            label: "Magma",
            title: "Softer sibling of Inferno; tightest hue spread of the perceptual ramps. Monotone lightness.",
            stops: [[0, 0, 4], [44, 17, 95], [114, 31, 129], [183, 55, 121], [240, 96, 93], [254, 175, 119], [252, 253, 191]],
        },
        turbo: {
            label: "Turbo",
            title: "Blue -> green -> yellow -> red. Ends on red, but red is mid-lightness so the top of this ramp is darker than its middle.",
            stops: [[48, 18, 59], [65, 102, 224], [54, 171, 249], [26, 228, 182], [164, 252, 60], [253, 165, 49], [122, 4, 3]],
        },
        viridis: {
            label: "Viridis",
            title: "Colorblind-safe perceptual ramp: purple -> blue -> green -> yellow. Monotone lightness, no red.",
            stops: [[68, 1, 84], [68, 57, 131], [49, 104, 142], [33, 145, 140], [53, 183, 121], [144, 215, 67], [253, 231, 37]],
        },
        lucifie: {
            label: "Funscript standard",
            title: "Lucifie's community palette, exactly as beta.funscript.io draws it. Not monotone in lightness: peak intensity renders darker than mid intensity.",
            stops: [[0, 0, 0], [30, 144, 255], [34, 139, 34], [255, 215, 0], [220, 20, 60], [147, 112, 219], [37, 22, 122]],
        },
    };
    const DEFAULT_PALETTE = "funscriptBright";

    // Every implementation surveyed computes non-stroker channels the same
    // way, so there is nothing to choose there: vibe and plug are always
    // 1000*|dp|/dt, which is what funscript-utils' getSpeed returns and what
    // beta.funscript.io applies to every track. Only the stroker has genuine
    // alternatives, because only a linear actuator makes dp mean travel.
    const VIBE_MULTIPLIER = 1000;
    const VIBE_SPEED_MAX = 600;
    const LAUNCH_SPEED_MIN = 20;
    const LAUNCH_SPEED_MAX = 80;
    const HANDY_STROKE_MM = 96;
    const HANDY_SPEED_MIN = 32;
    const HANDY_SPEED_MAX = 400;

    function isStrokeDevice(device) {
        return device === "stroker";
    }

    // Helper to compute speed between two actions
    const computeSegmentSpeed = (prev, curr, multiplier) => {
        if (!prev || !curr) return 0;
        const dt = Math.abs(curr.at - prev.at);
        return dt > 0 ? (multiplier * Math.abs(curr.pos - prev.pos)) / dt : 0;
    };

    const vibeSegmentSpeed = (prev, curr) => computeSegmentSpeed(prev, curr, VIBE_MULTIPLIER);

    // funjack/launchcontrol's "Magic Launch Formula" — an inverse power curve
    // fitted to the Launch's motor rather than a distance/time ratio, clamped
    // to the band the firmware tolerates. Zero distance would divide by zero.
    const launchSegmentSpeed = (prev, curr) => {
        if (!prev || !curr) return 0;
        const dt = Math.abs(curr.at - prev.at);
        const dist = Math.abs(curr.pos - prev.pos);
        if (dt <= 0 || dist <= 0) return 0;
        const raw = 25000 * Math.pow((dt * 90) / dist, -1.05);
        return Math.min(LAUNCH_SPEED_MAX, Math.max(LAUNCH_SPEED_MIN, raw));
    };

    // The Handy works in real units: map 0-100 onto millimetres of actual
    // travel, then divide by seconds. Unclamped this is ~960*|dp|/dt, so the
    // clamp is what really distinguishes it from the vibe formula.
    const handySegmentSpeed = (prev, curr) => {
        if (!prev || !curr) return 0;
        const dt = Math.abs(curr.at - prev.at);
        const dist = Math.abs(curr.pos - prev.pos);
        if (dt <= 0 || dist <= 0) return 0;
        const mmPerSec = ((dist / 100) * HANDY_STROKE_MM) / (dt / 1000);
        return Math.min(HANDY_SPEED_MAX, Math.max(HANDY_SPEED_MIN, mmPerSec));
    };

    const VIBE_MODEL = { max: VIBE_SPEED_MAX, segment: vibeSegmentSpeed, unit: "" };

    // Each model carries its own UI text so the stroker radio is built from
    // this table and can't drift out of sync with it.
    const STROKER_MODELS = {
        vibe: {
            label: "Same as vibe/plug",
            title: "Draw the stroker exactly like every other row — 1000*|dp|/dt, uncapped. This is what beta.funscript.io does, since it makes no vibe/stroker distinction.",
            max: VIBE_SPEED_MAX,
            segment: vibeSegmentSpeed,
            unit: "",
        },
        launch: {
            label: "funjack/launchcontrol",
            title: "Magic Launch Formula — 25000*(dt*90/|dp|)^-1.05, clamped 20-80. An empirically fitted motor-response curve, the only non-linear model here.",
            max: LAUNCH_SPEED_MAX,
            segment: launchSegmentSpeed,
            unit: "",
        },
        handy: {
            label: "The Handy",
            title: "Physical travel — (|dp|/100 * 96mm) / seconds, clamped 32-400 mm/s.",
            max: HANDY_SPEED_MAX,
            segment: handySegmentSpeed,
            unit: " mm/s",
        },
    };
    const DEFAULT_STROKER_MODEL = "vibe";

    function modelFor(device, strokerModel) {
        return isStrokeDevice(device) ? strokerModel : VIBE_MODEL;
    }

    // Rolling window (their `colorSmoothing`) averaging each column's color
    // with its predecessors, so transitions read as gradients not pixel noise.
    const COLOR_SMOOTHING = 5;

    function gmRequest(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response);
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                // A blocked @connect arrives here, not as an HTTP status, and its
                // reason lives in `error`/`details` — worth keeping, since "network
                // error" alone is indistinguishable from the host being down.
                onerror: (response) => {
                    const detail = response && (response.details || response.error);
                    reject(new Error(detail ? `network error: ${detail}` : "network error"));
                },
                ontimeout: () => reject(new Error("timeout")),
            });
        });
    }

    async function fetchWithRetry(url) {
        let lastError;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_SECS * 1000));
            }
            try {
                return await gmRequest(url);
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError;
    }

    // The site ships the player a JSON bootstrap blob rather than data-*
    // attributes on <audio>: queue[].file.haptics maps device -> URL, with
    // null for a channel this file has no script for.
    //
    // hapticSettings.channels is a playback switch, not a statement about what
    // exists, so it never filters a row out — a script that ships is a script
    // worth graphing. It rides along as `enabled` purely so the row can say so,
    // since "this file has a plug track you aren't feeling" is the interesting
    // case and is otherwise invisible. An absent channels map means enabled.
    function collectDeviceUrls() {
        const el = document.querySelector(PLAYER_DATA_SELECTOR);
        if (!el) return [];

        let parsed;
        try {
            parsed = JSON.parse(el.textContent);
        } catch (err) {
            console.warn(`funscript visualizer: ${PLAYER_DATA_SELECTOR} is not valid JSON: ${err.message}`);
            return [];
        }

        // A file page queues exactly one entry, but take the first that
        // actually carries haptics rather than depending on that.
        const queue = Array.isArray(parsed && parsed.queue) ? parsed.queue : [];
        const haptics = queue
            .map((item) => item && item.file && item.file.haptics)
            .find((h) => h && Object.values(h).some(Boolean));
        if (!haptics) return [];

        const settings = parsed && parsed.hapticSettings;
        const channels = (settings && settings.channels) || {};

        const result = [];
        for (const [device, value] of Object.entries(haptics)) {
            if (typeof value !== "string" || !/^https?:\/\//i.test(value)) continue;

            let url;
            try {
                url = new URL(value, location.href).href;
            } catch (err) {
                continue;
            }
            result.push({ device, url, enabled: channels[device] !== false });
        }
        return result;
    }

    async function fetchFunscripts(deviceUrls) {
        const settled = await Promise.all(deviceUrls.map(async ({ device, url, enabled }) => {
            let response;
            try {
                response = await fetchWithRetry(url);
            } catch (err) {
                console.warn(`funscript visualizer: fetch failed for ${device} (${url}): ${err.message}`);
                return null;
            }
            try {
                return { device, url, enabled, data: normalizeFunscript(JSON.parse(response.responseText)) };
            } catch (err) {
                console.warn(`funscript visualizer: invalid JSON for ${device} (${url})`);
                return null;
            }
        }));
        return settled.filter(Boolean);
    }

    // Funscripts ship unsorted; we sort and clamp before using
    function normalizeFunscript(data) {
        if (!Array.isArray(data.actions)) throw new Error("Invalid funscript: missing actions array");
        const actions = data.actions;
        data.actions = actions
            .map((a) => ({
                at: Math.max(0, Math.round(a.at)),
                pos: Math.max(0, Math.min(100, Math.round(a.pos))),
            }))
            .sort((a, b) => a.at - b.at);
        return data;
    }

    function getRank(device) {
        const i = DEVICE_ORDER.indexOf(device);
        return i === -1 ? DEVICE_ORDER.length : i;
    }

    function sortForDisplay(entries) {
        return entries.slice().sort((a, b) => getRank(a.device) - getRank(b.device));
    }

    function computeDuration(data) {
        const actions = data.actions;
        return actions.length ? actions[actions.length - 1].at : 0;
    }

    function computeLongestMs(entries) {
        return Math.max(...entries.map((e) => computeDuration(e.data)), 1);
    }

    // A single fast transition is enough to pin the axis several times above
    // everything else, leaving the real content squashed along the bottom. So
    // the ceiling is a high percentile rather than the maximum: outliers still
    // render, clamped to the top of the scale, but they no longer set it.
    const CEILING_PERCENTILE = 0.98;

    // Sorting every segment on each rerender would be wasteful — resize alone
    // fires this repeatedly — and both the actions and the models are immutable
    // for the panel's lifetime, so the result is cached per entry per model.
    const ceilingCache = new WeakMap();
    function rowSpeedCeiling(entry, model) {
        let byModel = ceilingCache.get(entry);
        if (!byModel) {
            byModel = new Map();
            ceilingCache.set(entry, byModel);
        }
        if (byModel.has(model)) return byModel.get(model);

        const actions = entry.data.actions;
        const speeds = [];
        for (let i = 1; i < actions.length; i++) {
            speeds.push(model.segment(actions[i - 1], actions[i]));
        }
        let ceiling = 0;
        if (speeds.length > 0) {
            speeds.sort((a, b) => a - b);
            ceiling = speeds[Math.min(speeds.length - 1, Math.floor(CEILING_PERCENTILE * (speeds.length - 1)))];
        }
        byModel.set(model, ceiling);
        return ceiling;
    }

    // entry -> the ceiling its axis and color scale should use. The vibe and
    // plug rows are all on one formula so they always share a ceiling and stay
    // comparable.
    // The stroker can be on a model with an incomparable range (the Launch's
    // 20-80, the Handy's mm/s), where a shared ceiling would squash it flat,
    // so by default it gets its own. The floor keeps a quiet script from
    // collapsing onto a near-zero axis.
    function computeSpeedMaxes(entries, strokerModel, strokerSharesAxis) {
        // Sharing is only meaningful when the stroker is on the vibe formula.
        // Under any other model its numbers are a different quantity — the
        // Handy's mm/s, the Launch's 20-80 — so a common ceiling would label
        // the row in units it isn't drawn in.
        strokerSharesAxis = strokerSharesAxis && strokerModel.segment === VIBE_MODEL.segment;
        const rows = entries.map((entry) => {
            const model = modelFor(entry.device, strokerModel);
            return { entry, model, peak: rowSpeedCeiling(entry, model) };
        });
        const maxes = new Map();
        for (const row of rows) {
            const pool = strokerSharesAxis
                ? rows
                : rows.filter((r) => isStrokeDevice(r.entry.device) === isStrokeDevice(row.entry.device));
            const peak = Math.max(...pool.map((r) => r.peak));
            maxes.set(row.entry, Math.max(peak, row.model.max * 0.1));
        }
        return maxes;
    }

    function computeSharedScale(entries) {
        return Math.min(BASE_PIXELS_PER_SECOND / 1000, MAX_ROW_WIDTH_PX / computeLongestMs(entries));
    }

    function computeAverageSpeed(data, speedOf) {
        const actions = data.actions;
        if (actions.length < 2) return 0;
        let total = 0;
        for (let i = 1; i < actions.length; i++) {
            total += speedOf(actions[i - 1], actions[i]);
        }
        return total / (actions.length - 1);
    }

    function valuesAtTime(actions, atMs, speedOf) {
        if (!actions.length) return { pos: 0, speed: 0 };
        if (atMs <= actions[0].at) return { pos: actions[0].pos, speed: 0 };
        if (atMs >= actions[actions.length - 1].at) return { pos: actions[actions.length - 1].pos, speed: 0 };

        let lo = 0;
        let hi = actions.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (actions[mid].at <= atMs) lo = mid;
            else hi = mid;
        }
        const prev = actions[lo];
        const curr = actions[hi];
        const t = curr.at === prev.at ? 0 : (atMs - prev.at) / (curr.at - prev.at);
        return {
            pos: Math.round(prev.pos + t * (curr.pos - prev.pos)),
            speed: speedOf(prev, curr),
        };
    }

    function clamp01(t) {
        return Math.max(0, Math.min(1, t));
    }

    function lerpStops(a, b, t) {
        return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);
    }

    // Their `Y`: fixed-width buckets offset by half a bucket so each stop
    // sits centered rather than left-aligned, saturating at the last stop.
    // Bucket width is derived from the model's ceiling, which reproduces
    // their exact 120-unit buckets at the reference ceiling of 600 while
    // spreading the same stops correctly over the stroker model's 0..100.
    function speedColor(speed, max, stops) {
        if (speed <= 0) return stops[0];
        if (speed > max) return stops[stops.length - 1];
        const bucketWidth = max / (stops.length - 2);
        const shifted = speed + bucketWidth / 2;
        const idx = Math.floor(shifted / bucketWidth);
        const t = clamp01((shifted - idx * bucketWidth) / bucketWidth);
        return lerpStops(stops[idx], stops[idx + 1], t);
    }

    // Same palette, but swept linearly across [0,1] for quantities that are
    // bounded rather than open-ended (i.e. position). Skips the black stop:
    // bars here are filled rectangles on a near-black canvas, so a black bar
    // would read as a gap, whereas black works fine for their thin line on
    // pure black.
    function paletteColor(t, stops) {
        const ramp = stops.slice(1);
        const scaled = clamp01(t) * (ramp.length - 1);
        const idx = Math.min(ramp.length - 2, Math.floor(scaled));
        return lerpStops(ramp[idx], ramp[idx + 1], scaled - idx);
    }

    function rgb(color) {
        return `rgb(${Math.round(color[0])},${Math.round(color[1])},${Math.round(color[2])})`;
    }

    // Normalizes value into [0,1] over [0,max], linear or logarithmic.
    function normalize(value, max, useLog) {
        if (useLog) {
            const logMax = Math.log1p(max);
            return logMax > 0 ? clamp01(Math.log1p(Math.max(0, value)) / logMax) : 0;
        }
        return max > 0 ? clamp01(value / max) : 0;
    }

    // Per-row Y-axis (0/half/top labels) — a separate small canvas rather
    // than drawn onto the main one, since it needs to sit to the left of,
    // not inside, the time-aligned graph.
    function buildAxisCanvas(topValue, rowHeight) {
        const canvas = document.createElement("canvas");
        canvas.width = AXIS_WIDTH_PX;
        canvas.height = rowHeight;

        const ctx = canvas.getContext("2d");
        ctx.fillStyle = CANVAS_BG;
        ctx.fillRect(0, 0, AXIS_WIDTH_PX, rowHeight);
        ctx.fillStyle = LABEL_COLOR;
        ctx.font = AXIS_LABEL_FONT;
        ctx.textAlign = "right";

        [0, topValue / 2, topValue].forEach((value) => {
            const y = rowHeight - (value / topValue) * rowHeight;
            const clampedY = Math.max(AXIS_LABEL_Y_CLAMP_TOP, Math.min(rowHeight - AXIS_LABEL_Y_CLAMP_BOTTOM_OFFSET, y));
            ctx.fillText(String(Math.round(value)), AXIS_WIDTH_PX - 3, clampedY);
        });

        return canvas;
    }

    function bucketByPixel(actions, pixelsPerMs, speedOf) {
        const buckets = new Map();
        for (let i = 0; i < actions.length; i++) {
            const x = Math.floor(actions[i].at * pixelsPerMs);
            let bucket = buckets.get(x);
            if (!bucket) {
                bucket = { minPos: actions[i].pos, maxPos: actions[i].pos, speedSum: 0, speedCount: 0 };
                buckets.set(x, bucket);
            } else {
                bucket.minPos = Math.min(bucket.minPos, actions[i].pos);
                bucket.maxPos = Math.max(bucket.maxPos, actions[i].pos);
            }
            if (i > 0) {
                bucket.speedSum += speedOf(actions[i - 1], actions[i]);
                bucket.speedCount++;
            }
        }
        return buckets;
    }

    function buildColumns(actions, pixelsPerMs, width, speedOf) {
        const buckets = bucketByPixel(actions, pixelsPerMs, speedOf);
        const columns = [];
        for (let x = 0; x < width; x++) {
            const bucket = buckets.get(x);
            if (bucket) {
                columns.push({
                    minPos: bucket.minPos,
                    maxPos: bucket.maxPos,
                    speed: bucket.speedCount > 0 ? bucket.speedSum / bucket.speedCount : 0,
                });
            } else {
                const { pos, speed } = valuesAtTime(actions, x / pixelsPerMs, speedOf);
                columns.push({ minPos: pos, maxPos: pos, speed });
            }
        }
        return columns;
    }

    function prepareCanvas(canvas, data, pixelsPerMs, rowHeight) {
        const width = Math.max(MIN_ROW_WIDTH_PX, Math.round(computeDuration(data) * pixelsPerMs));
        canvas.width = width;
        canvas.height = rowHeight;

        const ctx = canvas.getContext("2d");
        ctx.fillStyle = CANVAS_BG;
        ctx.fillRect(0, 0, width, rowHeight);
        return { ctx, width };
    }

    // Position over time, colored by speed — a reproduction of
    // beta.funscript.io's renderer, including their rolling color smoothing.
    // No log toggle: the color scale is a fixed absolute lookup.
    function drawPositionCanvas(canvas, data, pixelsPerMs, view, rowHeight) {
        const { ctx, width } = prepareCanvas(canvas, data, pixelsPerMs, rowHeight);
        const actions = data.actions;
        if (actions.length === 0) return [];

        const columns = buildColumns(actions, pixelsPerMs, width, view.speedOf);
        const smoothing = [];
        let smoothIdx = 0;
        const bounds = [];

        for (let x = 0; x < width; x++) {
            const color = speedColor(columns[x].speed, view.speedMax, view.stops);
            if (smoothing.length < COLOR_SMOOTHING) {
                smoothing.push(color);
            } else {
                smoothing[smoothIdx] = color;
                smoothIdx = (smoothIdx + 1) % COLOR_SMOOTHING;
            }
            const avg = smoothing
                .reduce((acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]], [0, 0, 0])
                .map((v) => v / smoothing.length);

            const { minPos, maxPos } = columns[x];
            const yTop = rowHeight - (maxPos / 100) * rowHeight;
            const barHeight = Math.max(1, (maxPos - minPos) / 100 * rowHeight);
            ctx.fillStyle = rgb(avg);
            ctx.fillRect(x, yTop, 1, barHeight);
            bounds.push({ yTop, yBottom: yTop + barHeight });
        }
        return bounds;
    }

    // Speed over time, colored by position — the complement of the view
    // above, on the active model's absolute scale that every row shares.
    function drawSpeedCanvas(canvas, data, pixelsPerMs, view, rowHeight) {
        const { ctx, width } = prepareCanvas(canvas, data, pixelsPerMs, rowHeight);
        const actions = data.actions;
        if (actions.length === 0) return [];

        const columns = buildColumns(actions, pixelsPerMs, width, view.speedOf);
        const bounds = [];

        for (let x = 0; x < width; x++) {
            const { minPos, maxPos, speed } = columns[x];
            const barHeight = Math.max(1, normalize(speed, view.speedMax, view.useLog) * rowHeight);
            ctx.fillStyle = rgb(paletteColor((minPos + maxPos) / 2 / 100, view.stops));
            ctx.fillRect(x, rowHeight - barHeight, 1, barHeight);
            bounds.push({ yTop: rowHeight - barHeight, yBottom: rowHeight });
        }
        return bounds;
    }

    // One tooltip shared by every row and re-render, repositioned and updated
    // on whichever canvas is hovered. Not appended here — the panel and this
    // tooltip share the same max z-index, so at equal z-index DOM order
    // decides paint order; appended after the panel so it paints on top.
    function buildTooltip() {
        const tooltip = document.createElement("div");
        tooltip.style.cssText = `position:fixed;z-index:2147483647;background:#000;color:#eee;font:${TOOLTIP_FONT};padding:3px 6px;border-radius:4px;pointer-events:none;display:none;`;
        return tooltip;
    }

    // bounds is the per-column array from drawFunscriptCanvas — the tooltip
    // only shows when the cursor is within that column's drawn bar, not over
    // the blank canvas above or below a short one.
    function attachTooltip(canvas, data, pixelsPerMs, tooltip, bounds, speedOf) {
        canvas.addEventListener("mousemove", (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const col = bounds[Math.floor(x)];
            if (!col || y < col.yTop || y > col.yBottom) {
                tooltip.style.display = "none";
                return;
            }
            const atMs = x / pixelsPerMs;
            const { pos, speed } = valuesAtTime(data.actions, atMs, speedOf);
            tooltip.textContent = `${formatTime(atMs / 1000)} — pos ${pos} — spd ${Math.round(speed)}`;
            tooltip.style.left = `${e.clientX + 12}px`;
            tooltip.style.top = `${e.clientY + 12}px`;
            tooltip.style.display = "block";
        });
        canvas.addEventListener("mouseleave", () => {
            tooltip.style.display = "none";
        });
    }

    // `view` carries what the active toggles imply: which graph to draw, the
    // log setting, the active palette, and the selected stroker model. The
    // model itself is resolved per row, since it applies to one device only.
    function buildRow(entry, pixelsPerMs, view, tooltip, rowHeight) {
        // No margin — spacing comes from the container's flex gap, so that the
        // row's measured height is exactly label + graph and the resize math
        // can derive per-row overhead from it.
        const row = document.createElement("div");
        row.style.cssText = "flex:0 0 auto;";

        const model = modelFor(entry.device, view.strokerModel);
        const rowView = { ...view, speedOf: model.segment, speedMax: view.speedMaxes.get(entry) };

        // A channel switched off in the player's haptic settings still gets a
        // full row — the script exists and is worth reading — but the label
        // goes amber and says so, since nothing else on the page reveals that
        // this track is shipping and silent.
        const channelOff = entry.enabled === false;
        const label = document.createElement("div");
        const durationSec = computeDuration(entry.data) / 1000;
        const avgSpeed = Math.round(computeAverageSpeed(entry.data, rowView.speedOf));
        label.textContent = `${entry.device} — ${formatTime(durationSec)} — avg ${avgSpeed}${model.unit}${channelOff ? " — channel off" : ""}`;
        label.style.cssText = `color:${channelOff ? LABEL_OFF_COLOR : LABEL_COLOR};font:11px monospace;margin-bottom:2px;`;
        if (channelOff) {
            label.title = `This file ships a ${entry.device} script, but the ${entry.device} channel is switched off in the player's haptic settings, so none of it reaches a device. Graphed anyway.`;
        }
        row.appendChild(label);

        const canvas = document.createElement("canvas");
        const bounds = (rowView.mode === "speed"
            ? drawSpeedCanvas(canvas, entry.data, pixelsPerMs, rowView, rowHeight)
            : drawPositionCanvas(canvas, entry.data, pixelsPerMs, rowView, rowHeight));
        canvas.style.cssText = "display:block;";
        attachTooltip(canvas, entry.data, pixelsPerMs, tooltip, bounds, rowView.speedOf);

        const graphRow = document.createElement("div");
        graphRow.style.cssText = "display:flex;align-items:flex-start;";
        graphRow.appendChild(buildAxisCanvas(view.mode === "speed" ? rowView.speedMax : 100, rowHeight));
        graphRow.appendChild(canvas);
        row.appendChild(graphRow);

        // The stroker controls affect only this channel, so they sit under
        // this channel's graph rather than in the panel-wide controls — which
        // also means they simply never appear on pages without a stroker. The
        // elements are owned by buildPanel and moved here on each render, so
        // their state and listeners survive the rebuild.
        if (view.strokerControls && isStrokeDevice(entry.device)) {
            row.appendChild(view.strokerControls);
        }

        return row;
    }

    // replaceChildren rather than innerHTML: the stroker row's formula toggle
    // is a long-lived element owned by buildPanel, and detaching it this way
    // leaves the object (and its listener and checked state) intact for
    // buildRow to re-mount.
    function renderRows(container, entries, pixelsPerMs, view, tooltip, rowHeight) {
        container.replaceChildren();
        for (const entry of entries) {
            container.appendChild(buildRow(entry, pixelsPerMs, view, tooltip, rowHeight));
        }
    }

    // Picks a "nice" tick interval so the timeline gets roughly 6 labeled
    // ticks regardless of how long the widest row is.
    function pickTickIntervalSec(totalSec) {
        const niceSteps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
        return niceSteps.find((step) => step >= totalSec / 6) || niceSteps[niceSteps.length - 1];
    }

    function formatTime(sec) {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
        return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
    }

    // One shared timeline at the bottom of the panel, spanning the widest
    // (longest-duration) row, using the same pixelsPerMs scale as every row.
    function buildTimeline(pixelsPerMs, longestMs) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(MIN_ROW_WIDTH_PX, Math.round(longestMs * pixelsPerMs));
        canvas.height = TIMELINE_HEIGHT_PX;

        const ctx = canvas.getContext("2d");
        ctx.fillStyle = CANVAS_BG;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = AXIS_COLOR;
        ctx.fillStyle = LABEL_COLOR;
        ctx.font = TIMELINE_LABEL_FONT;

        const totalSec = longestMs / 1000;
        const tickIntervalSec = pickTickIntervalSec(totalSec);
        const numTicks = Math.ceil(totalSec / tickIntervalSec);
        for (let i = 0; i <= numTicks; i++) {
            const sec = i * tickIntervalSec;
            if (sec > totalSec + 0.001) break;
            const x = sec * 1000 * pixelsPerMs;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, TIMELINE_TICK_HEIGHT);
            ctx.stroke();
            ctx.fillText(formatTime(sec), Math.min(x + 2, canvas.width - 30), TIMELINE_LABEL_Y);
        }

        canvas.style.cssText = "display:block;margin-top:4px;";
        return canvas;
    }

    function buildPanel(entries, pixelsPerMs) {
        const css = {
            // The max-* pair is what keeps the panel reachable on a phone. Without
            // it the panel is sized purely by its content, so several devices push
            // it past the bottom of the screen — and because it is fixed-position
            // with overflow:hidden, the rows and controls down there cannot be
            // scrolled to by any means. Capping it to the viewport hands the
            // overflow to rowsContainer, which is the one flexible child and
            // already scrolls.
            //
            // dvh/dvw are repeated after the vh/vw pair rather than replacing it:
            // mobile browsers resolve vh against the *large* viewport, the one
            // that assumes the address bar has scrolled away, which is exactly the
            // overflow being fixed here. Older engines drop the dynamic units as
            // invalid and keep the first declaration.
            panel: "position:fixed;top:16px;right:16px;z-index:2147483647;background:#1e1e1e;padding:10px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.6);box-sizing:border-box;min-width:240px;min-height:160px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);max-width:calc(100dvw - 32px);max-height:calc(100dvh - 32px);resize:both;overflow:hidden;display:flex;flex-direction:column;",
            header: "flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:move;margin:-10px -10px 8px;padding:6px 8px;background:#141414;border-radius:8px 8px 0 0;border-bottom:1px solid #333;user-select:none;",
            flexAuto: "flex:0 0 auto;",
            // position:relative so the playhead can be absolutely placed over
            // the rows; being in this box also means it scrolls with them.
            rowsContainer: `position:relative;flex:1 1 auto;min-height:0;overflow:auto;scrollbar-gutter:stable;display:flex;flex-direction:column;gap:${ROW_GAP_PX}px;`,
            modeRow: "flex:0 0 auto;display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;color:#aaa;font:11px monospace;margin:8px 0 2px;",
            rowPrefix: "color:#666;",
            optLabel: "cursor:pointer;",
        };

        const panel = document.createElement("div");
        panel.style.cssText = css.panel;

        const header = document.createElement("div");
        header.style.cssText = css.header;
        const title = document.createElement("span");
        title.textContent = "⠿ Funscript Visualizer";
        title.style.cssText = "color:#aaa;font:11px monospace;";
        header.appendChild(title);

        const closeButton = document.createElement("button");
        closeButton.textContent = "✕";
        closeButton.title = "Close";
        closeButton.style.cssText = "background:none;border:none;color:#aaa;font-size:14px;cursor:pointer;line-height:1;padding:0 2px;";
        header.appendChild(closeButton);
        panel.appendChild(header);

        let dragOffsetX = 0;
        let dragOffsetY = 0;
        const onDragMove = (e) => {
            panel.style.left = `${e.clientX - dragOffsetX}px`;
            panel.style.top = `${e.clientY - dragOffsetY}px`;
            panel.style.right = "auto";
        };
        const onDragEnd = () => {
            document.removeEventListener("mousemove", onDragMove);
            document.removeEventListener("mouseup", onDragEnd);
        };
        header.addEventListener("mousedown", (e) => {
            if (e.target === closeButton) return;
            const rect = panel.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            document.addEventListener("mousemove", onDragMove);
            document.addEventListener("mouseup", onDragEnd);
            e.preventDefault();
        });

        // options: [{ key, label, title }]. onChange fires with the newly
        // selected key, and the row is appended to the panel in call order.
        const makeRadioRow = (prefix, name, options, defaultKey, onChange) => {
            const row = document.createElement("div");
            row.style.cssText = css.modeRow;
            const prefixSpan = document.createElement("span");
            prefixSpan.textContent = prefix;
            prefixSpan.style.cssText = css.rowPrefix;
            row.appendChild(prefixSpan);

            for (const { key, label, title } of options) {
                const optLabel = document.createElement("label");
                optLabel.style.cssText = css.optLabel;
                if (title) optLabel.title = title;
                const radio = document.createElement("input");
                radio.type = "radio";
                radio.name = name;
                radio.value = key;
                radio.checked = key === defaultKey;
                radio.style.cssText = "vertical-align:middle;margin-right:3px;";
                radio.addEventListener("change", () => {
                    if (radio.checked) onChange(key);
                });
                optLabel.appendChild(radio);
                optLabel.appendChild(document.createTextNode(label));
                row.appendChild(optLabel);
            }
            panel.appendChild(row);
            return row;
        };

        let mode = "position";
        let currentPaletteKey = DEFAULT_PALETTE;
        let currentStrokerKey = DEFAULT_STROKER_MODEL;

        makeRadioRow("View:", "vizMode", [
            { key: "position", label: "Position", title: "Position on the Y axis, colored by intensity" },
            { key: "speed", label: "Intensity", title: "Intensity on the Y axis, colored by position" },
        ], mode, (key) => {
            mode = key;
            scaleControl.optLabel.style.display = mode === "speed" ? "block" : "none";
            rerender();
        });

        const paletteRow = document.createElement("div");
        paletteRow.style.cssText = css.modeRow;
        const palettePrefix = document.createElement("span");
        palettePrefix.textContent = "Colors:";
        palettePrefix.style.cssText = css.rowPrefix;
        paletteRow.appendChild(palettePrefix);

        const paletteSelect = document.createElement("select");
        paletteSelect.style.cssText = "background:#141414;color:#aaa;border:1px solid #333;border-radius:3px;font:11px monospace;padding:1px 2px;cursor:pointer;";
        for (const [key, { label, title }] of Object.entries(PALETTES)) {
            const option = document.createElement("option");
            option.value = key;
            option.textContent = label;
            option.title = title;
            paletteSelect.appendChild(option);
        }
        paletteSelect.value = currentPaletteKey;
        paletteSelect.title = PALETTES[currentPaletteKey].title;
        paletteSelect.addEventListener("change", () => {
            currentPaletteKey = paletteSelect.value;
            paletteSelect.title = PALETTES[currentPaletteKey].title;
            rerender();
        });
        paletteRow.appendChild(paletteSelect);
        panel.appendChild(paletteRow);

        const makeCheckbox = (text, title, checked) => {
            const optLabel = document.createElement("label");
            optLabel.style.cssText = "flex:0 0 auto;display:block;color:#aaa;font:11px monospace;margin:0 0 4px;cursor:pointer;";
            optLabel.title = title;
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = Boolean(checked);
            checkbox.style.cssText = "vertical-align:middle;margin-right:4px;";
            const textNode = document.createTextNode(text);
            optLabel.appendChild(checkbox);
            optLabel.appendChild(textNode);
            return { optLabel, checkbox, textNode };
        };

        // Stroker-only controls. The Launch and Handy models describe a linear
        // actuator's travel, so they only mean anything on this one channel;
        // "Same as vibe" puts it back on the uniform formula, which is exactly
        // what beta.funscript.io does (it makes no vibe/stroker distinction).
        //
        // Not appended to the panel — buildRow mounts this block beneath the
        // stroker row, so it appears next to the data it governs and is absent
        // entirely on pages with no stroker channel.
        const strokerControls = document.createElement("div");
        strokerControls.style.cssText = `margin:3px 0 0 ${AXIS_WIDTH_PX}px;`;

        const strokerModelRow = document.createElement("div");
        strokerModelRow.style.cssText = "display:flex;flex-wrap:wrap;gap:2px 10px;align-items:center;color:#888;font:10px monospace;";
        for (const [key, { label, title }] of Object.entries(STROKER_MODELS)) {
            const optLabel = document.createElement("label");
            optLabel.style.cssText = "cursor:pointer;";
            optLabel.title = title;
            const radio = document.createElement("input");
            radio.type = "radio";
            radio.name = "strokerModel";
            radio.value = key;
            radio.checked = key === currentStrokerKey;
            radio.style.cssText = "vertical-align:middle;margin-right:3px;";
            radio.addEventListener("change", () => {
                if (!radio.checked) return;
                currentStrokerKey = key;
                syncShareAxisEnabled();
                rerender();
            });
            optLabel.appendChild(radio);
            optLabel.appendChild(document.createTextNode(label));
            strokerModelRow.appendChild(optLabel);
        }
        strokerControls.appendChild(strokerModelRow);

        const shareAxisControl = makeCheckbox("stroker shares the vibe/plug axis", "Put the stroker on the same ceiling as the vibe/plug rows. Off by default, since a model with its own range (the Launch's 20-80, the Handy's mm/s) would be squashed flat by that scale.");
        strokerControls.appendChild(shareAxisControl.optLabel);

        // Only the vibe model puts the stroker in the same units as the other
        // rows, so under the Launch or Handy models a shared ceiling would
        // label this row in a quantity it isn't drawn in. Disable rather than
        // silently ignore it, so the control never reads as on-but-inert.
        const syncShareAxisEnabled = () => {
            const shareable = STROKER_MODELS[currentStrokerKey].segment === VIBE_MODEL.segment;
            shareAxisControl.checkbox.disabled = !shareable;
            shareAxisControl.optLabel.style.cssText = `display:block;color:${shareable ? "#888" : "#555"};font:10px monospace;margin:2px 0 0;cursor:${shareable ? "pointer" : "not-allowed"};`;
            shareAxisControl.optLabel.title = shareable
                ? "Put the stroker on the same ceiling as the vibe/plug rows."
                : `Unavailable: ${STROKER_MODELS[currentStrokerKey].label} measures a different quantity than the vibe/plug rows, so a shared ceiling would label this row in units it isn't drawn in.`;
        };
        syncShareAxisEnabled();

        // Log scale only applies to speed mode, where speed drives bar height
        // (a spatial scale worth compressing); in position mode speed is only
        // a color lookup on a fixed absolute scale, so the toggle is hidden.
        const scaleControl = makeCheckbox("Log scale", "Compress the speed axis logarithmically");
        scaleControl.optLabel.style.display = "none";
        scaleControl.optLabel.style.marginBottom = "8px";
        panel.appendChild(scaleControl.optLabel);

        const tooltip = buildTooltip();

        const rowsContainer = document.createElement("div");
        rowsContainer.style.cssText = css.rowsContainer;
        panel.appendChild(rowsContainer);

        const timelineRow = document.createElement("div");
        timelineRow.style.cssText = `${css.flexAuto}display:flex;align-items:flex-start;`;
        const spacer = document.createElement("div");
        spacer.style.cssText = `width:${AXIS_WIDTH_PX}px;flex-shrink:0;`;
        timelineRow.appendChild(spacer);
        panel.appendChild(timelineRow);

        const longestMs = computeLongestMs(entries);
        let currentPixelsPerMs = pixelsPerMs;
        let currentRowHeight = ROW_HEIGHT_PX;

        // One bar for every row: they all share pixelsPerMs, so a single x is
        // the same instant on each. Past the end of a short track there is no
        // canvas and it simply crosses the empty space, which is correct —
        // that track really has stopped while the audio plays on.
        const playhead = document.createElement("div");
        playhead.style.cssText = [
            "position:absolute", "top:0", "left:0",
            `width:${PLAYHEAD_WIDTH_PX}px`,
            `background:${PLAYHEAD_COLOR}`,
            "box-shadow:0 0 0 1px rgba(0,0,0,.85)",
            // Must never intercept the hover the tooltip depends on.
            "pointer-events:none",
            "display:none",
        ].join(";") + ";";

        // renderRows calls replaceChildren, so the playhead is re-added after
        // every render and resized to the new content height. Collapsed first,
        // because measuring the container while the bar still holds its old
        // height would measure the bar — and the height could then only
        // ratchet upward, never follow rows that got shorter.
        const mountPlayhead = () => {
            playhead.style.height = "0px";
            rowsContainer.appendChild(playhead);
            playhead.style.height = `${rowsContainer.scrollHeight}px`;
        };

        timelineRow.appendChild(buildTimeline(currentPixelsPerMs, longestMs));
        const rerender = () => {
            const strokerModel = STROKER_MODELS[currentStrokerKey];
            const view = {
                mode,
                useLog: scaleControl.checkbox.checked,
                stops: PALETTES[currentPaletteKey].stops,
                strokerModel,
                strokerControls,
                speedMaxes: computeSpeedMaxes(entries, strokerModel, shareAxisControl.checkbox.checked),
            };
            renderRows(rowsContainer, entries, currentPixelsPerMs, view, tooltip, currentRowHeight);
            timelineRow.replaceChild(buildTimeline(currentPixelsPerMs, longestMs), timelineRow.lastChild);
            mountPlayhead();
        };

        scaleControl.checkbox.addEventListener("change", rerender);
        shareAxisControl.checkbox.addEventListener("change", rerender);
        rerender();

        // The <audio> element is looked up each frame rather than bound once,
        // because the playlist can replace it and polling one property is
        // cheaper than tracking that. Reading it every frame also means play,
        // pause, seek and track change need no events of their own. The DOM is
        // only written when the bar actually moves a pixel, so a paused player
        // costs a property read and nothing else.
        let audioEl = null;
        let lastX = null;
        let playheadFrame = null;
        let everFoundAudio = false;

        // A hidden bar and a broken bar look identical, so say which it is.
        setTimeout(() => {
            if (!everFoundAudio && panel.isConnected) {
                console.warn(`funscript visualizer: no <${AUDIO_SELECTOR}> element found, so the playhead stays hidden — the player may not use one`);
            }
        }, PLAYHEAD_WARN_MS);

        const followAudio = () => {
            playheadFrame = requestAnimationFrame(followAudio);

            if (!audioEl || !audioEl.isConnected) audioEl = document.querySelector(AUDIO_SELECTOR);
            if (audioEl) everFoundAudio = true;
            if (!audioEl || !Number.isFinite(audioEl.currentTime)) {
                if (lastX !== null) {
                    playhead.style.display = "none";
                    lastX = null;
                }
                return;
            }

            const x = Math.round(AXIS_WIDTH_PX + audioEl.currentTime * 1000 * currentPixelsPerMs);
            if (x === lastX) return;
            if (lastX === null) playhead.style.display = "block";
            lastX = x;
            playhead.style.transform = `translateX(${x}px)`;
        };
        followAudio();

        // Dragging the native resize handle changes the panel's box size; this
        // refits pixelsPerMs to the new width (so the time axis zooms) and
        // rowHeight to the new height (so each row's value axis stretches),
        // instead of just gaining scrollbars around unchanged canvases.
        //
        // Both readings come from rowsContainer's client box, which the flex
        // layout makes exactly "what's left over for rows" in every state:
        // auto-sized, it equals the rows' own content, so the math is a no-op;
        // resized, it equals the space the user gave it.
        //
        // Every height here is read fractionally, via getBoundingClientRect
        // rather than offsetHeight/clientHeight, because those two are integers
        // and a row is not: the 11px monospace label is ~12.4px tall on Android
        // Firefox. Rounding the row height once per row and the container
        // height once over the whole container leaves a residual that the row
        // count divides into, and it lands on the .5 boundary readily enough
        // that Math.round adds a pixel — which resizes the panel, re-runs this,
        // and ratchets the box taller every frame until it fills the screen.
        // A single row was immune (its two roundings are the same rounding), so
        // this only appeared on pages with more than one device.
        //
        // Keeping the fractions makes the auto-sized case cancel exactly, which
        // is the property the no-op above depends on. Flooring instead of
        // rounding also stops the growth, but then the residual is always shed
        // downward and the rows collapse to MIN_ROW_HEIGHT_PX — the same bug
        // pointing the other way.
        //
        // Thresholds are in pixels, not in pixelsPerMs — pixelsPerMs is ~1e-4,
        // so an epsilon on *it* of 1e-9 is ~0.006px and would let sub-pixel
        // jitter retrigger a rerender from inside the observer callback.
        let resizeRaf = null;
        const resizeObserver = new ResizeObserver(() => {
            if (resizeRaf !== null) return;
            resizeRaf = requestAnimationFrame(() => {
                resizeRaf = null;
                if (!panel.isConnected) return;

                const availableWidth = Math.max(MIN_ROW_WIDTH_PX, rowsContainer.clientWidth - AXIS_WIDTH_PX);

                let nextRowHeight = currentRowHeight;
                // The playhead lives in this container but is not a row: it is
                // absolutely positioned and as tall as all of them together.
                // Counting it would subtract its height as row chrome and
                // divide by one row too many, driving every row to the floor.
                const rows = Array.prototype.filter.call(rowsContainer.children, (el) => el !== playhead);
                if (rows.length > 0) {
                    // getBoundingClientRect gives the border box; clientHeight is
                    // that minus a horizontal scrollbar. rowsContainer has no
                    // border, so their difference is exactly the scrollbar, and
                    // subtracting it keeps clientHeight's meaning without
                    // inheriting its rounding. It is 0 wherever scrollbars
                    // overlay the content, Android included.
                    const scrollbarHeight = rowsContainer.offsetHeight - rowsContainer.clientHeight;
                    let totalChrome = 0;
                    for (const row of rows) totalChrome += row.getBoundingClientRect().height - currentRowHeight;
                    const totalGaps = Math.max(0, rows.length - 1) * ROW_GAP_PX;
                    const usable = rowsContainer.getBoundingClientRect().height - scrollbarHeight - totalGaps - totalChrome;
                    nextRowHeight = Math.max(MIN_ROW_HEIGHT_PX, Math.round(usable / rows.length));
                }

                const currentWidth = Math.round(currentPixelsPerMs * longestMs);
                const widthChanged = Math.abs(availableWidth - currentWidth) >= 1;
                const heightChanged = Math.abs(nextRowHeight - currentRowHeight) >= 1;
                if (!widthChanged && !heightChanged) return;

                currentPixelsPerMs = availableWidth / longestMs;
                currentRowHeight = nextRowHeight;
                rerender();
            });
        });
        resizeObserver.observe(panel);

        // Close tears down everything the panel put outside itself: the
        // observer, the drag listeners on document (still attached if closed
        // mid-drag), and the tooltip, which lives on document.body rather than
        // inside the panel and would otherwise be orphaned there — visible, if
        // it happened to be showing.
        closeButton.addEventListener("click", () => {
            resizeObserver.disconnect();
            cancelAnimationFrame(playheadFrame);
            onDragEnd();
            tooltip.remove();
            panel.remove();
        });

        document.body.appendChild(panel);
        document.body.appendChild(tooltip);

        // Measured again now the panel is in the document. The first render
        // runs while it is still detached, where every box measures zero — so
        // the bar was sized 0px tall and stayed invisible however correctly it
        // was positioned.
        mountPlayhead();
    }

    async function run() {
        const deviceUrls = collectDeviceUrls();
        if (deviceUrls.length === 0) return;

        const entries = sortForDisplay(await fetchFunscripts(deviceUrls));
        if (entries.length === 0) return;

        buildPanel(entries, computeSharedScale(entries));
    }

    run();
})();
