// ==UserScript==
// @name        TM Shibby Funscript DL
// @description Download deduped funscripts from Shibbydex story variants (Tampermonkey)
// @namespace   https://shibbydex.com/
// @version     1.03.1-2026-10-21
// @updateURL   https://raw.githubusercontent.com/blindio/haptic-data/main/userscripts/TM-Shibby-funscript-dl.user.js
// @downloadURL https://raw.githubusercontent.com/blindio/haptic-data/main/userscripts/TM-Shibby-funscript-dl.user.js
// @author      Thorson Little
// @match       https://shibbydex.com/file/*
// @run-at      document-idle
// @grant       GM_xmlhttpRequest
// @grant       GM_download
// @connect     shibbydex.com
// @connect     assets.shibbydex.com
// @connect     cloudflarestorage.com
// ==/UserScript==

// Haptic URLs 302 to a presigned bucket on r2.cloudflarestorage.com, and
// Tampermonkey re-checks the redirect target against @connect ("Request was
// redirected to a not whitelisted URL"). A bare `*` does not satisfy that
// check, so that hop needs a domain entry of its own.

(function () {
    'use strict';

    // ------------------------------------------------------------------
    // NAMING_RULES — kept first: this is the most volatile part of the
    // file, edited far more often than anything below it.
    // ------------------------------------------------------------------
    const CUSTOM_FUNCTION_KEY = "CUSTOM";
    // Named so buildFileNameParts can recognize these specific rules (to
    // capture the title value, and to hold the variant-name/device values
    // aside) without a bare string literal duplicated between here and there.
    const TITLE_RULE_KEY = "customFileTitle";
    const VARIANT_NAME_RULE_KEY = "customVariantName";
    const DEVICE_RULE_KEY = "customDeviceCodes";
    const NAMING_RULES = [
        [CUSTOM_FUNCTION_KEY, TITLE_RULE_KEY],
        [CUSTOM_FUNCTION_KEY, VARIANT_NAME_RULE_KEY],
        [/long length/i, "long"],
        [/short length/i, "short"],
        ["loop", "loop"],
        [/trance induction/i, "induct"],
        [/hypnosis/i, "hyp"],
        [/hypnotic language/i, "hylg"],
        [/^(?!.*(?:hypnosis|hypnotic language))/i, "nh"],
        [/futa/i, "futa"],
        [/bi curious|bisexual|forced bi|seduced bi/i, "bi"],
        [/sissy|crossdressing|feminisation/i, "sis"],
        [/cock sucking|face fucking/i, "cs-ff"],
        [/joi/i, "joi"],
        [/joe/i, "joe"],
        [/creampie/i, "cp"],
        [/no orgasm/i, "noorg"],
        [/non erotic/i, "noero"],
        [CUSTOM_FUNCTION_KEY, "customOrgasmMaybe"],
        [/chastity caging|chastity caged/i, "ccg"],
        [/scarousal|threats/i, "hor"],
        [/tentacle/i, "tnt"],
        ["rape", "rape"],
        ["massage", "msg"],
        [/doctor|nurse/i, "med"],
        [/therap/i, "psy"],
        [CUSTOM_FUNCTION_KEY, "customAudienceCodes"],
        [CUSTOM_FUNCTION_KEY, DEVICE_RULE_KEY],
    ];

    // ------------------------------------------------------------------
    // Constants — Tier 1: fundamental (this script's own mechanism)
    // ------------------------------------------------------------------
    const PLAYER_TAG = "audio";
    const DATA_PREFIX = "data-";
    const FUNSCRIPT_EXT = "funscript";
    const RETRY_DELAY_SECS = 10;
    const MAX_RETRIES = 1;
    const HALT_ON_ERROR = true;
    const DEBUG_LOG_FUNSCRIPT_STRUCTURE = true;
    const TITLE_STOPWORDS = new Set(["a", "an", "the", "i", "in", "on", "of", "and", "or", "to", "for", "with"]);

    // ------------------------------------------------------------------
    // Constants — Tier 2: functional/semantic strings
    // ------------------------------------------------------------------
    const TITLE_BOILERPLATE = "- Shibbydex";
    const AUDIENCE_DETAILS_KEY = "Audience";
    const ORGASM_DETAILS_KEY = "Orgasm";
    // Shape of a valid audience code (e.g. "F4M", "FFF4M"), shared between
    // customAudienceCodes' own validation and candidateWordsForFunscript's
    // stripping of redundant audience-shaped tokens out of variant-name
    // candidate words.
    const AUDIENCE_CODE_PATTERN = /^(F+)4([A-Za-z]+)$/;
    // Toggle: drop audience-shaped tokens (e.g. "f4m") from variant-name
    // candidate words since they duplicate the dedicated audience segment
    // elsewhere in the filename. Stripping down to nothing is allowed (not
    // a fallback trigger) — see candidateWordsForFunscript.
    const STRIP_AUDIENCE_FROM_VARIANT_NAME = true;
    const TAGS_HEADING_TEXT = "Tags";
    const EXPECTED_DEVICE_ID_SUFFIX = "_button";
    // ---- Adding a new device ------------------------------------------
    // None of this is required for a new device to download. An unrecognized
    // data-* attribute is still fetched, and normalizeDeviceCode falls back to
    // the raw name, so an unmapped device already appears in filenames under
    // its own name (ownUnmappedDevices in computeOwnDeviceInfo, appended after
    // the mapped codes). Mapping one is purely to give it a short code and a
    // fixed position in the filename.
    //
    // To map one:
    //   1. Add its raw name below, spelled exactly as it appears both in the
    //      data-* attribute and in the "<name>_button" id on the page.
    //   2. Reuse an existing DEVICE_CODE_* if it is the same class of device
    //      -- butt and buttplug both map to bp, funscript and haptic both to
    //      vb -- or add a new code constant.
    //   3. Add the raw-name -> code entry to DEVICE_CODE_MAP.
    //   4. Add the code to DEVICE_CODE_ORDER at the position you want it to
    //      occupy in the filename. This step is not optional: a code that is
    //      mapped but absent from DEVICE_CODE_ORDER is filtered out in
    //      finalizeDeviceSegments and disappears from filenames entirely,
    //      because mapping it also removed it from the unmapped list.
    //   5. Leave DEVICE_CODE_UNIVERSAL alone unless the device is present on
    //      essentially every story -- see the note on it.
    //
    // If the site adds a data-* attribute that is not a funscript URL, it
    // belongs in NON_DEVICE_ATTRIBUTES instead; otherwise every page logs a
    // failed fetch for it.
    //
    // The visualizer userscript keeps its own, unrelated device list
    // (DEVICE_ORDER and isStrokeDevice there) and is not affected by changes
    // here -- it reads the same data-* attributes but classifies them itself.
    //
    // Raw device-name vocabulary, exactly as it appears in data-* attribute
    // names and expected-button id prefixes on the site.
    const DEVICE_NAME_BUTT = "butt";
    const DEVICE_NAME_BUTTPLUG = "buttplug";
    const DEVICE_NAME_FUNSCRIPT = "funscript";
    const DEVICE_NAME_HAPTIC = "haptic";
    const DEVICE_NAME_STROKER = "stroker";

    // Our own normalized output codes.
    const DEVICE_CODE_BUTTPLUG = "bp";
    const DEVICE_CODE_VIBE = "vb";
    const DEVICE_CODE_STROKER = "st";
    const DEVICE_CODE_MULTI_PREFIX = "mlt";
    // Stronger version of the "mlt" case: every universal device exists as a
    // separate, single-device funscript story-wide (no funscript combines
    // more than one), rather than just two of them — supersedes "mlt" when
    // it applies (see finalizeDeviceSegments).
    const DEVICE_CODE_ALL_SEPARATE_PREFIX = "alldev";

    const DEVICE_CODE_MAP = {
        [DEVICE_NAME_BUTT]: DEVICE_CODE_BUTTPLUG,
        [DEVICE_NAME_BUTTPLUG]: DEVICE_CODE_BUTTPLUG,
        [DEVICE_NAME_FUNSCRIPT]: DEVICE_CODE_VIBE,
        [DEVICE_NAME_HAPTIC]: DEVICE_CODE_VIBE,
        [DEVICE_NAME_STROKER]: DEVICE_CODE_STROKER,
    };

    // Order every mapped code appears in the filename. A mapped code missing
    // from this list is dropped from the filename, so every entry in
    // DEVICE_CODE_MAP needs a place here.
    const DEVICE_CODE_ORDER = [DEVICE_CODE_STROKER, DEVICE_CODE_VIBE, DEVICE_CODE_BUTTPLUG];

    // The subset "alldev" requires to be present before it applies. Kept
    // separate from DEVICE_CODE_ORDER because the two answer different
    // questions: order is about every device we can name, this is about the
    // ones common enough that their absence is meaningful. Adding a niche
    // device here would stop alldev firing on every story that predates it,
    // silently renaming existing downloads.
    const DEVICE_CODE_UNIVERSAL = [DEVICE_CODE_STROKER, DEVICE_CODE_VIBE, DEVICE_CODE_BUTTPLUG];

    // ------------------------------------------------------------------
    // Constants — Tier 3: raw CSS/structural selectors and literal markup values
    // ------------------------------------------------------------------
    const VARIANT_PICKER_SELECTOR = "div.d-flex.flex-wrap.justify-content-center.gap-1.mb-3";
    const DETAILS_LIST_SELECTOR = "section.detail dl.row";
    const TAGS_HEADING_CLASS = "shibbydex-font-accent";
    const EXPECTED_DEVICES_CONTAINER_SELECTOR = "div.d-flex.flex-wrap.justify-content-center.align-items-center.gap-1";
    const NON_DEVICE_ATTRIBUTES = ["play-count-route", "haptic-connection-url", "haptic-max-strength", "haptic-delay", "haptic-rate"];

    const RESERVED_WINDOWS_NAMES = new Set([
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]);

    // Green doubles as "idle, nothing run yet" and "ran clean" — both are
    // equally "nothing's wrong" states, so there's no separate neutral color.
    const HALT_FRAME_COLOR = "#d98880";
    const SKIP_FRAME_COLOR = "#a3a3a3";
    const OK_FRAME_COLOR = "#7fb69e";

    class RunHalted extends Error {}

    let anySkipped = false;

    // ------------------------------------------------------------------
    // Networking
    // ------------------------------------------------------------------
    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

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
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                log(`retrying fetch (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${url}`);
                await delay(RETRY_DELAY_SECS * 1000);
            }
            try {
                return await gmRequest(url);
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError;
    }

    // ------------------------------------------------------------------
    // Error handling
    // ------------------------------------------------------------------
    function reportError(message) {
        log(`ERROR: ${message}`);
        anySkipped = true;
        if (HALT_ON_ERROR) {
            throw new RunHalted(message);
        }
    }

    // ------------------------------------------------------------------
    // Title cleaning
    // ------------------------------------------------------------------
    function cleanTitle(rawTitle) {
        let t = (rawTitle || "").split(TITLE_BOILERPLATE).join("").trim();
        t = t.replace(/\s*:\s*/g, " - ");
        t = t.replace(/[<>"/\\|?*]/g, "");
        t = t.replace(/[\x00-\x1F]/g, "");
        t = t.trim();

        const dotIndex = t.indexOf(".");
        const nameOnly = (dotIndex === -1 ? t : t.slice(0, dotIndex)).toUpperCase();
        if (RESERVED_WINDOWS_NAMES.has(nameOnly)) {
            t = t + "_";
        }

        if (t.length > 200) t = t.slice(0, 200);
        return t;
    }

    function originAndPath(href) {
        const u = new URL(href);
        return u.origin + u.pathname;
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------
    const panel = document.createElement("div");
    panel.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#1e1e1e;color:#eee;padding:10px;border-radius:8px;font:12px/1.4 monospace;width:380px;box-shadow:0 2px 10px rgba(0,0,0,.6);border:3px solid " + OK_FRAME_COLOR + ";box-sizing:border-box;";

    const closeButton = document.createElement("button");
    closeButton.textContent = "✕";
    closeButton.title = "Close";
    closeButton.style.cssText = "position:absolute;top:4px;right:6px;background:none;border:none;color:#aaa;font-size:14px;cursor:pointer;line-height:1;padding:4px;";
    closeButton.addEventListener("click", () => panel.remove());
    panel.appendChild(closeButton);

    const titleLine = document.createElement("div");
    titleLine.style.cssText = "margin-bottom:8px;padding-right:20px;word-break:break-word;";
    panel.appendChild(titleLine);

    const goButton = document.createElement("button");
    goButton.textContent = "Go";
    goButton.style.cssText = "display:block;width:100%;padding:6px;margin-bottom:6px;border:1px solid #666;border-radius:4px;cursor:pointer;font-weight:bold;background:#333;color:#eee;";
    panel.appendChild(goButton);

    const logArea = document.createElement("textarea");
    logArea.readOnly = true;
    logArea.style.cssText = "width:100%;height:220px;box-sizing:border-box;font:11px/1.4 monospace;resize:vertical;";
    panel.appendChild(logArea);

    document.body.appendChild(panel);

    function log(message) {
        logArea.value += message + "\n\n";
        logArea.scrollTop = logArea.scrollHeight;
    }

    function setFrameColor(color) {
        panel.style.borderColor = color;
    }

    function refreshTitleLine() {
        titleLine.textContent = cleanTitle(document.title);
    }

    refreshTitleLine();

    // ------------------------------------------------------------------
    // Scraping a variant's page
    // ------------------------------------------------------------------
    function scrapeDetails(dom) {
        const details = {};
        const dl = dom.querySelector(DETAILS_LIST_SELECTOR);
        if (!dl) return details;
        let node = dl.firstElementChild;
        while (node) {
            if (node.tagName === "DT") {
                const dd = node.nextElementSibling;
                if (dd && dd.tagName === "DD") {
                    details[node.textContent.trim()] = dd.textContent.trim();
                    node = dd.nextElementSibling;
                    continue;
                }
            }
            node = node.nextElementSibling;
        }
        return details;
    }

    function scrapeExpectedDevices(dom) {
        const container = dom.querySelector(EXPECTED_DEVICES_CONTAINER_SELECTOR);
        if (!container) return [];
        return Array.from(container.querySelectorAll("a[id]"))
            .map((a) => a.id)
            .filter((id) => id.endsWith(EXPECTED_DEVICE_ID_SUFFIX))
            .map((id) => id.slice(0, id.length - EXPECTED_DEVICE_ID_SUFFIX.length));
    }

    function scrapeTags(dom) {
        const heading = Array.from(dom.querySelectorAll("h2")).find(
            (h) => h.textContent.trim() === TAGS_HEADING_TEXT && h.classList.contains(TAGS_HEADING_CLASS)
        );
        if (!heading) return [];
        const p = heading.nextElementSibling;
        if (!p || p.tagName !== "P") return [];
        return Array.from(p.querySelectorAll("a")).map((a) => a.textContent.trim());
    }

    // ------------------------------------------------------------------
    // Processing algorithm
    // ------------------------------------------------------------------
    function discoverVariantEntries() {
        const container = document.querySelector(VARIANT_PICKER_SELECTOR);
        const links = container ? Array.from(container.querySelectorAll(":scope > a")) : [];

        if (links.length > 0) {
            log(`variant picker: ${links.length} link(s) found`);
            const entries = links.map((a) => ({ name: a.textContent.trim(), url: a.href }));
            const seenNames = new Set();
            const result = [];
            for (const e of entries) {
                log(`variant found: ${e.name} -> ${e.url}`);
                if (seenNames.has(e.name)) {
                    reportError(`duplicate variant name "${e.name}" — dropping the later entry`);
                    continue;
                }
                seenNames.add(e.name);
                result.push(e);
            }
            return { entries: result, isSingleVariant: false };
        }

        log("no variant picker entries found — treating as single-variant story");
        return { entries: [{ name: null, url: location.href }], isSingleVariant: true };
    }

    function foldIn(storyPage, variant, device, data) {
        const serialized = JSON.stringify(data);
        let match = storyPage.funscripts.find((f) => JSON.stringify(f.data) === serialized);

        if (!match) {
            match = {
                data,
                variants: [variant],
                tags: new Set(variant.tags),
                audiences: new Set(variant.audiences),
                variantNames: [variant.name],
                variantTitleCounts: new Map([[variant.pageTitle, 1]]),
                funscriptDevices: new Set([device]),
            };
            storyPage.funscripts.push(match);
            log(`new funscript created: seeded from ${variant.name}/${device}`);
            return;
        }

        match.funscriptDevices.add(device);
        if (!match.variants.includes(variant)) {
            match.variants.push(variant);
            for (const t of variant.tags) match.tags.add(t);
            for (const a of variant.audiences) match.audiences.add(a);
            match.variantNames.push(variant.name);
            match.variantTitleCounts.set(variant.pageTitle, (match.variantTitleCounts.get(variant.pageTitle) || 0) + 1);
            log(`existing funscript matched: merged in ${variant.name}/${device}`);
        } else {
            log(`existing funscript matched: ${variant.name}/${device} adds a second device on an already-linked variant`);
        }
    }

    async function processVariantEntry(entry, isSingleVariant, storyPage) {
        log(`fetching variant ${entry.name ?? "(single)"}: ${entry.url}`);
        let response;
        try {
            response = await fetchWithRetry(entry.url);
        } catch (err) {
            reportError(`variant page fetch failed (${entry.url}): ${err.message}`);
            return;
        }

        const dom = new DOMParser().parseFromString(response.responseText, "text/html");
        const pageTitle = cleanTitle(dom.title);
        const details = scrapeDetails(dom);
        const audiences = [details[AUDIENCE_DETAILS_KEY]];

        if (!audiences[0]) {
            reportError(`missing/empty "${AUDIENCE_DETAILS_KEY}" details entry (${entry.url})`);
            return;
        }

        const name = isSingleVariant ? audiences[0] : entry.name;
        const expectedDevices = scrapeExpectedDevices(dom);
        const tags = scrapeTags(dom);

        log(`variant ${name} pageTitle: ${pageTitle}`);

        const variant = {
            name,
            pageTitle,
            audiences,
            url: entry.url,
            funscriptDevices: [],
            expectedDevices,
            details,
            tags,
        };

        const playerElements = dom.querySelectorAll(PLAYER_TAG);
        if (playerElements.length === 0) {
            log(`variant ${name}: no ${PLAYER_TAG} element found — normal for this variant, skipping`);
            // Still record the variant — it has real scraped expectedDevices
            // (button row is independent of the player element), and
            // finalizeDeviceSegments reads storyPage.variants directly for
            // the buttplug-fallback check. Dropping it here would silently
            // lose any expected-device buttons this page shows.
            storyPage.variants.push(variant);
            return;
        }
        if (playerElements.length > 1) {
            reportError(`variant ${name}: found ${playerElements.length} ${PLAYER_TAG} element(s), expected exactly 1`);
            return;
        }

        const playerEl = playerElements[0];
        log(playerEl.outerHTML);

        for (const attr of Array.from(playerEl.attributes)) {
            if (!attr.name.startsWith(DATA_PREFIX)) continue;
            const device = attr.name.slice(DATA_PREFIX.length);

            if (NON_DEVICE_ATTRIBUTES.includes(device)) {
                log(`${device}: known non-device attribute, skipped, no fetch attempted`);
                continue;
            }

            log(`${device} ${attr.name} = ${attr.value}`);

            if (!/^https?:\/\//i.test(attr.value)) {
                log(`${device}: not a URL, skipped`);
                continue;
            }

            let resolvedUrl;
            try {
                resolvedUrl = new URL(attr.value, entry.url).href;
            } catch (err) {
                log(`${device}: URL resolution failed, skipped`);
                continue;
            }

            let deviceResponse;
            try {
                deviceResponse = await fetchWithRetry(resolvedUrl);
            } catch (err) {
                reportError(`device fetch failed: ${name}/${device} (${resolvedUrl}): ${err.message}`);
                continue;
            }

            let data;
            try {
                data = JSON.parse(deviceResponse.responseText);
            } catch (err) {
                log(`${device}: response not valid JSON, skipped`);
                continue;
            }

            variant.funscriptDevices.push(device);
            log(`funscript captured: ${name}/${device}`);
            foldIn(storyPage, variant, device, data);
        }

        storyPage.variants.push(variant);
    }

    // ------------------------------------------------------------------
    // Naming and saving
    // ------------------------------------------------------------------
    function searchTags(joinedTags, regex, value) {
        return regex.test(joinedTags) ? value : undefined;
    }

    // Regex patterns can just use plain spaces between words — hyphens and
    // other punctuation in the source tags are normalized away here so they
    // never affect whether a pattern matches.
    function normalizeForTagMatching(text) {
        return text.replace(/[^a-z0-9\s]/gi, " ").replace(/\s+/g, " ");
    }

    // For rules where a plain string (not a RegExp) is used as the key: the
    // whole tag must equal that string, not merely contain it somewhere in
    // the joined-tags blob. Needed because the joined blob has no boundary
    // between adjacent tags, so a substring/anchor test there can't express
    // "this exact tag" — e.g. "^rape" against the blob would only ever check
    // whichever tag happens to be first, not every tag independently.
    function normalizeExactTag(text) {
        return normalizeForTagMatching(text).toLowerCase().trim();
    }

    function exactTagMatch(individualTags, target, value) {
        return individualTags.includes(normalizeExactTag(target)) ? value : undefined;
    }

    // -- customFileTitle: pick the best variantTitleCounts candidate --
    function jaccard(setA, setB) {
        if (setA.size === 0 && setB.size === 0) return 1;
        let intersectionSize = 0;
        for (const item of setA) {
            if (setB.has(item)) intersectionSize++;
        }
        const unionSize = setA.size + setB.size - intersectionSize;
        return intersectionSize / unionSize;
    }

    function stripBracketedContent(text) {
        return text.replace(/[(\[{][^)\]}]*[)\]}]/g, "");
    }

    function titleTokenSet(title) {
        let t = stripBracketedContent(title);
        t = t.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
        const words = t.split(" ").filter((w) => w && !TITLE_STOPWORDS.has(w));
        return new Set(words.map((w) => w.replace(/(es|s)$/i, "")));
    }

    // Tie-break: among equally-valid candidate strings, prefer the one most
    // similar (by token Jaccard) to the others, then shortest, then
    // alphabetical. Used only for page-title picking (customFileTitle) —
    // variant-name picking deliberately does NOT use this (see
    // candidateWordsForFunscript): title-picking wants to collapse
    // near-duplicates into one canonical form, but variant-name picking
    // wants to preserve whatever distinguishes candidates from each other,
    // which this tie-break's own bracket-stripping would throw away.
    function pickBestCandidate(candidates) {
        if (candidates.length === 1) return candidates[0];

        const tokenSets = new Map(candidates.map((c) => [c, titleTokenSet(c)]));
        const avgScores = new Map();
        for (const a of candidates) {
            let total = 0;
            for (const b of candidates) {
                if (a === b) continue;
                total += jaccard(tokenSets.get(a), tokenSets.get(b));
            }
            avgScores.set(a, total / (candidates.length - 1));
        }
        const maxAvg = Math.max(...avgScores.values());
        let winners = candidates.filter((c) => avgScores.get(c) === maxAvg);
        if (winners.length === 1) return winners[0];

        const minLength = Math.min(...winners.map((c) => c.length));
        winners = winners.filter((c) => c.length === minLength);
        if (winners.length === 1) return winners[0];

        winners.sort();
        return winners[0];
    }

    function customFileTitle(funscript) {
        const counts = funscript.variantTitleCounts;
        const maxCount = Math.max(...counts.values());
        const candidates = Array.from(counts.keys()).filter((title) => counts.get(title) === maxCount);
        return pickBestCandidate(candidates);
    }

    // -- variant-name candidate words: known common words get lowercased
    // and shortened before the holistic cross-group comparison in
    // assignVariantNameLabels decides the final label. --
    const VARIANT_NAME_REPLACEMENTS = [
        [/\bstandard\b/gi, "std"],
        // Any word starting with "alt" (alternate, alternative, alt, ...)
        // rather than one exact word — real site text doesn't consistently
        // use "alternative".
        [/\balt\w*/gi, "alt"],
    ];

    // Unlike title-picking, variant-name picking wants to preserve whatever
    // distinguishes one candidate from another rather than collapse it away
    // — a lone candidate's parenthetical content (e.g. "(sfx1)") can be the
    // entire signal. So this is the UNION of words across every one of this
    // funscript's own variant names (not a single "picked winner" — an
    // earlier version used pickBestCandidate here, which discards all but
    // one candidate before its words could ever be compared against a
    // colliding sibling, silently losing exactly the words that mattered).
    //
    // Returns this funscript's own candidate words (order preserved, audience
    // tokens optionally stripped) — NOT yet a final label. Two funscripts
    // that only collide with each other, in isolation, can't tell whether a
    // word like "standard" is genuinely distinguishing or just happens to be
    // shared by both — that comparison happens later, across the whole
    // collision group, in assignVariantNameLabels.
    function candidateWordsForFunscript(funscript) {
        const wordSet = new Set();
        for (const name of funscript.variantNames) {
            for (const w of normalizeForTagMatching(name).toLowerCase().trim().split(" ").filter(Boolean)) {
                wordSet.add(w);
            }
        }
        let words = Array.from(wordSet);
        if (STRIP_AUDIENCE_FROM_VARIANT_NAME) {
            // AUDIENCE_CODE_PATTERN requires an uppercase "F" (matching
            // customAudienceCodes' behavior against raw site data); words
            // here are already lowercased, so uppercase just for this check.
            words = words.filter((w) => !AUDIENCE_CODE_PATTERN.test(w.toUpperCase()));
        }
        return words;
    }

    // -- customAudienceCodes: dedupe + sort funscript.audiences --
    function customAudienceCodes(funscript) {
        const parsed = [];
        for (const rawCode of funscript.audiences) {
            // Real site data can suffix a descriptive parenthetical onto an
            // otherwise-legal audience code (e.g. "F4A (Cock)") — treated as
            // redundant/descriptive, same as audience-shaped tokens getting
            // stripped from variant-name labels elsewhere.
            const code = stripBracketedContent(rawCode).replace(/\s+/g, " ").trim();
            const match = AUDIENCE_CODE_PATTERN.exec(code);
            if (!match) {
                reportError(`malformed audience code "${rawCode}"`);
                continue;
            }
            parsed.push({ code, charRun: match[1], listener: match[2] });
        }

        const byListener = new Map();
        for (const entry of parsed) {
            const existing = byListener.get(entry.listener);
            if (!existing || entry.charRun.length > existing.charRun.length) {
                byListener.set(entry.listener, entry);
            }
        }

        const deduped = Array.from(byListener.values());
        deduped.sort((a, b) => {
            const lenDiff = b.charRun.length - a.charRun.length;
            if (lenDiff !== 0) return lenDiff;
            const aIsM = a.listener === "M";
            const bIsM = b.listener === "M";
            if (aIsM !== bIsM) return aIsM ? -1 : 1;
            return a.code.localeCompare(b.code);
        });

        return deduped.map((e) => e.code.toLowerCase()).join(".");
    }

    // -- device codes: per-funscript facts now (computeOwnDeviceInfo), the
    // story-wide picture later (finalizeDeviceSegments) --
    function normalizeDeviceCode(raw) {
        return DEVICE_CODE_MAP[raw] || raw;
    }

    // Everything about device codes that's knowable from a single funscript
    // in isolation: the per-variant integrity checks (does each linked
    // variant's own applied device set match its own expected-button set? —
    // genuinely local, no story-wide data needed), and this funscript's own
    // mapped/unmapped device codes. What ISN'T knowable in isolation —
    // buttplug fallback, "mlt"/"alldev" prefixes — needs every funscript in
    // the story at once, so that part is deferred to finalizeDeviceSegments.
    function computeOwnDeviceInfo(funscript) {
        for (const variant of funscript.variants) {
            const variantApplied = new Set(variant.funscriptDevices.map(normalizeDeviceCode));
            const variantExpected = new Set(variant.expectedDevices.map(normalizeDeviceCode));

            for (const code of variantApplied) {
                if (!variantExpected.has(code)) {
                    reportError(`variant "${variant.name}": funscript device "${code}" has no corresponding expected-device button`);
                }
            }
            for (const code of variantExpected) {
                if (code !== DEVICE_CODE_BUTTPLUG && !variantApplied.has(code)) {
                    reportError(`variant "${variant.name}": expected device "${code}" has no corresponding funscript`);
                }
            }
        }

        const mappedCodes = new Set();
        const unmapped = [];
        for (const device of funscript.funscriptDevices) {
            const mapped = DEVICE_CODE_MAP[device];
            if (mapped) {
                mappedCodes.add(mapped);
            } else {
                unmapped.push(device);
            }
        }
        return { mappedCodes, unmapped };
    }

    // Story-wide device pass: run once per story, after every funscript's
    // own device info (computeOwnDeviceInfo) has already been collected in
    // Pass 1 — mirrors assignVariantNameLabels' "collect first, decide once
    // you can see everyone" shape. Fills in part.deviceSegmentValue for
    // every part. `variants` is storyPage.variants directly (not derived
    // from `parts`/funscripts) because a variant that never produced any
    // funscript at all (e.g. every device fetch on it failed) still has
    // real expected-device buttons that must count toward allExpectedCodes
    // — that information doesn't exist anywhere in `parts`.
    function finalizeDeviceSegments(parts, variants) {
        const allAppliedCodes = new Set();
        for (const part of parts) {
            for (const code of part.ownMappedCodes) allAppliedCodes.add(code);
        }

        const allExpectedCodes = new Set();
        for (const variant of variants) {
            for (const device of variant.expectedDevices) allExpectedCodes.add(normalizeDeviceCode(device));
        }

        // "alldev": every universal device has at least one dedicated,
        // single-device funscript, and no funscript in the story combines
        // more than one — a stronger version of "mlt" (which only ever
        // looks at the vb/bp pair) that supersedes it when both would apply,
        // so sibling st/vb/bp funscripts get a consistent single prefix
        // instead of mlt showing up on two of them but not the third.
        //
        // Deliberately DEVICE_CODE_UNIVERSAL, not DEVICE_CODE_ORDER: a niche
        // device that only some stories carry must not be able to veto this.
        const allDevicesFullySeparate =
            parts.every((part) => part.ownMappedCodes.size <= 1) &&
            DEVICE_CODE_UNIVERSAL.every((code) => parts.some((part) => part.ownMappedCodes.has(code)));

        for (const part of parts) {
            const mappedCodes = new Set(part.ownMappedCodes);

            // Buttplug fallback: if "bp" is expected somewhere in the story
            // but no funscript anywhere is dedicated to it, and this
            // funscript is already the "vb" one, it also serves as "bp" —
            // functionally as if a separate data-buttplug attribute pointed
            // at this same JSON.
            if (allExpectedCodes.has(DEVICE_CODE_BUTTPLUG) && !allAppliedCodes.has(DEVICE_CODE_BUTTPLUG) && mappedCodes.has(DEVICE_CODE_VIBE)) {
                mappedCodes.add(DEVICE_CODE_BUTTPLUG);
            }

            const orderedMapped = [];
            if (allDevicesFullySeparate) {
                orderedMapped.push(DEVICE_CODE_ALL_SEPARATE_PREFIX);
            } else if (
                allAppliedCodes.has(DEVICE_CODE_VIBE) &&
                allAppliedCodes.has(DEVICE_CODE_BUTTPLUG) &&
                mappedCodes.has(DEVICE_CODE_VIBE) !== mappedCodes.has(DEVICE_CODE_BUTTPLUG)
            ) {
                orderedMapped.push(DEVICE_CODE_MULTI_PREFIX);
            }
            orderedMapped.push(...DEVICE_CODE_ORDER.filter((code) => mappedCodes.has(code)));

            const unmapped = part.ownUnmappedDevices.slice().sort();
            part.deviceSegmentValue = [...orderedMapped, ...unmapped].join(".");
        }
    }

    // -- customOrgasmMaybe: any linked variant's Orgasm detail is "maybe" --
    function customOrgasmMaybe(funscript) {
        return funscript.variants.some((v) => /maybe/i.test(v.details[ORGASM_DETAILS_KEY] || "")) ? "myborg" : undefined;
    }

    const customFunctions = {
        [TITLE_RULE_KEY]: customFileTitle,
        customAudienceCodes,
        customOrgasmMaybe,
    };

    function describeFunscript(funscript) {
        return {
            data: `<funscript JSON omitted, ${JSON.stringify(funscript.data).length} chars>`,
            variants: funscript.variants.map((v) => ({ name: v.name, pageTitle: v.pageTitle, audiences: v.audiences, url: v.url })),
            tags: Array.from(funscript.tags),
            audiences: Array.from(funscript.audiences),
            variantNames: funscript.variantNames,
            variantTitleCounts: Object.fromEntries(funscript.variantTitleCounts),
            funscriptDevices: Array.from(funscript.funscriptDevices),
        };
    }

    // The single, swappable place that turns a list of matched NAMING_RULES
    // segments into the actual filename body. Currently dot-separated
    // (e.g. "Title.hyp.fff4m.st.vb.bp"); could later become e.g. a
    // TagSpaces-style "Title[hyp fff4m st vb bp]" by changing only this
    // function — nothing about how segments are collected needs to change.
    function joinFileNameSegments(segments) {
        return segments.join(".");
    }

    // Runs NAMING_RULES exactly once per funscript. Two rules aren't fully
    // evaluated here — their final values depend on seeing every funscript
    // in the story at once, which a single funscript can't do in isolation:
    //   - variant-name: a disambiguating label can't be chosen without
    //     knowing what other funscripts in its collision group picked (see
    //     assignVariantNameLabels).
    //   - device codes: buttplug fallback and the "mlt"/"alldev" prefixes
    //     are inherently story-wide facts (see finalizeDeviceSegments).
    // For both, only the segment position they'd occupy is recorded now;
    // later passes compute and fill in the actual values.
    function buildFileNameParts(funscript, index) {
        if (DEBUG_LOG_FUNSCRIPT_STRUCTURE) {
            log(`funscript[${index}] structure:\n${JSON.stringify(describeFunscript(funscript), null, 2)}`);
        }

        const joinedTags = normalizeForTagMatching(Array.from(funscript.tags).join(" "));
        const individualTags = Array.from(funscript.tags).map(normalizeExactTag);

        const baseSegments = [];
        let variantSlotIndex = -1;
        let variantRuleIndex = -1;
        let deviceSlotIndex = -1;
        let deviceRuleIndex = -1;
        let ownMappedCodes = new Set();
        let ownUnmappedDevices = [];
        let titleValue;

        if (NAMING_RULES.length === 0) {
            log(`NAMING_RULES is empty — nothing to apply`);
        }

        NAMING_RULES.forEach(([key, value], ruleIndex) => {
            const label = key === CUSTOM_FUNCTION_KEY ? value : key;

            if (key === CUSTOM_FUNCTION_KEY && value === VARIANT_NAME_RULE_KEY) {
                variantSlotIndex = baseSegments.length;
                variantRuleIndex = ruleIndex;
                log(`NAMING_RULES[${ruleIndex}] (${label}): position recorded — label (if any) computed later, holistically, only if this funscript ends up in a collision group`);
                return;
            }

            if (key === CUSTOM_FUNCTION_KEY && value === DEVICE_RULE_KEY) {
                const ownDeviceInfo = computeOwnDeviceInfo(funscript);
                ownMappedCodes = ownDeviceInfo.mappedCodes;
                ownUnmappedDevices = ownDeviceInfo.unmapped;
                deviceSlotIndex = baseSegments.length;
                deviceRuleIndex = ruleIndex;
                log(`NAMING_RULES[${ruleIndex}] (${label}): own devices recorded (${Array.from(ownMappedCodes).join(",") || "none"}${ownUnmappedDevices.length ? "," + ownUnmappedDevices.join(",") : ""}) — final segment computed later, story-wide`);
                return;
            }

            let result;
            if (key === CUSTOM_FUNCTION_KEY) {
                result = customFunctions[value]?.(funscript);
            } else if (key instanceof RegExp) {
                result = searchTags(joinedTags, key, value);
            } else {
                result = exactTagMatch(individualTags, key, value);
            }

            if (result) {
                baseSegments.push(result);
                log(`NAMING_RULES[${ruleIndex}] (${label}): matched -> '${result}'`);
                if (key === CUSTOM_FUNCTION_KEY && value === TITLE_RULE_KEY) {
                    titleValue = result;
                }
            } else {
                log(`NAMING_RULES[${ruleIndex}] (${label}): no match, skipped`);
            }
        });

        return {
            funscript,
            index,
            baseSegments,
            variantSlotIndex,
            variantRuleIndex,
            variantSegmentValue: undefined,
            deviceSlotIndex,
            deviceRuleIndex,
            deviceSegmentValue: undefined,
            ownMappedCodes,
            ownUnmappedDevices,
            titleValue,
            // Comparison key for variant-name collision detection (see
            // markCollisions) — this funscript's own device signature,
            // order-independent. A separate, simpler concept from the final
            // rendered device segment (deviceSegmentValue): this is just
            // "what does this funscript itself apply," with no buttplug
            // fallback or mlt/alldev prefix reasoning involved.
            deviceKey: Array.from(ownMappedCodes).sort().join(","),
        };
    }

    // Holistic variant-name labeling for one collision group: a word is only
    // worth keeping in a funscript's label if it's NOT also present among
    // any other funscript's own candidate words in the same group — shared
    // words (e.g. both sides happening to pick "Standard") carry no
    // distinguishing information and are dropped, same as audience tokens.
    // Falls back to no label (undefined) if nothing is left, same as before
    // — still safe, since the mandatory final duplicate check in
    // nameAndSaveAll is what actually guarantees uniqueness, not this.
    function assignVariantNameLabels(group) {
        const ownWords = group.map((part) => (part.variantSlotIndex === -1 ? [] : candidateWordsForFunscript(part.funscript)));

        group.forEach((part, i) => {
            const siblingWords = new Set();
            ownWords.forEach((words, j) => {
                if (j === i) return;
                for (const w of words) siblingWords.add(w);
            });

            const exclusiveWords = ownWords[i].filter((w) => !siblingWords.has(w));
            if (exclusiveWords.length === 0) {
                log(`funscript[${part.index}]: no words exclusive to it within its collision group — no variant-name label`);
                return;
            }

            let label = exclusiveWords.join(" ");
            for (const [pattern, replacement] of VARIANT_NAME_REPLACEMENTS) {
                label = label.replace(pattern, replacement);
            }
            part.variantSegmentValue = label;
            log(`funscript[${part.index}]: variant-name label '${label}' (exclusive words within its collision group)`);
        });
    }

    // Two funscripts are candidates for the variant-name disambiguator only
    // when their picked title and applied device set both match exactly —
    // tags and audience are deliberately excluded (a missing-tags data quirk
    // on one variant was observed to mask a real collision when tags were
    // part of the comparison).
    function markCollisions(parts) {
        const groups = new Map();
        for (const part of parts) {
            const key = JSON.stringify([part.titleValue, part.deviceKey]);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(part);
        }
        for (const group of groups.values()) {
            if (group.length < 2) continue;
            log(`title+device match detected across ${group.length} funscript(s) (title="${group[0].titleValue}", devices="${group[0].deviceKey}") — considering variant-name disambiguation`);
            assignVariantNameLabels(group);
        }
    }

    // Splices every held-aside value (variant-name, device codes) back into
    // baseSegments at the position each would have occupied. Insertions are
    // applied in descending index order so that inserting one doesn't shift
    // the still-pending position of another — this keeps the result correct
    // regardless of which order the two rules happen to sit in NAMING_RULES,
    // rather than assuming device codes always comes after variant-name.
    function finalizeFileName(part) {
        const segments = part.baseSegments.slice();

        const insertions = [];
        if (part.variantSegmentValue) {
            insertions.push({ index: part.variantSlotIndex, ruleIndex: part.variantRuleIndex, value: part.variantSegmentValue });
        }
        if (part.deviceSegmentValue) {
            insertions.push({ index: part.deviceSlotIndex, ruleIndex: part.deviceRuleIndex, value: part.deviceSegmentValue });
        }
        // Descending by index so an earlier splice never shifts a
        // not-yet-applied position. When two slots capture the SAME index
        // (nothing else matched between them), that alone can't tell them
        // apart — tie-break by ruleIndex, also descending, so the LATER
        // NAMING_RULES entry gets spliced first and the EARLIER one ends up
        // positioned before it, matching their actual rule order.
        insertions.sort((a, b) => b.index - a.index || b.ruleIndex - a.ruleIndex);
        for (const { index, value } of insertions) {
            segments.splice(index, 0, value);
        }

        if (segments.length === 0) {
            // NAMING_RULES produced nothing — stub fallback so each funscript
            // still gets a distinguishable filename.
            segments.push(`funscript-${part.index + 1}`);
            log(`no NAMING_RULES segment produced anything — falling back to '${segments[0]}'`);
        }
        return `${joinFileNameSegments(segments)}.${FUNSCRIPT_EXT}`;
    }

    function saveFunscriptFile(fileName, data) {
        const blob = new Blob([JSON.stringify(data)], { type: "application/octet-stream" });
        const objectUrl = URL.createObjectURL(blob);
        GM_download({
            url: objectUrl,
            name: fileName,
            saveAs: true,
            onload: () => {
                log(`saved: ${fileName}`);
                URL.revokeObjectURL(objectUrl);
            },
            onerror: (err) => {
                log(`save FAILED: ${fileName} — ${JSON.stringify(err)}`);
                URL.revokeObjectURL(objectUrl);
            },
        });
    }

    function nameAndSaveAll(storyPage) {
        const parts = storyPage.funscripts.map((funscript, index) => buildFileNameParts(funscript, index));
        markCollisions(parts);
        finalizeDeviceSegments(parts, storyPage.variants);

        const finalized = parts.map((part) => ({ part, fileName: finalizeFileName(part) }));

        // Mandatory safety net (not optional): a funscript is allowed to have
        // no variant-name value at all, which only resolves a collision if
        // its sibling(s) diverge. Verify that actually happened for everyone
        // — case-insensitive, since Windows filenames don't distinguish case.
        const byLowerName = new Map();
        for (const { part, fileName } of finalized) {
            const lower = fileName.toLowerCase();
            if (!byLowerName.has(lower)) byLowerName.set(lower, []);
            byLowerName.get(lower).push(part);
        }
        for (const [lowerName, group] of byLowerName) {
            if (group.length > 1) {
                reportError(`${group.length} funscripts all resolved to the same filename "${lowerName}" — cannot disambiguate automatically (funscript index(es): ${group.map((p) => p.index).join(", ")})`);
            }
        }

        finalized.forEach(({ part, fileName }) => {
            log(`final filename: ${fileName}`);
            saveFunscriptFile(fileName, part.funscript.data);
        });
    }

    // ------------------------------------------------------------------
    // Top-level run
    // ------------------------------------------------------------------
    async function runProcessing() {
        const storyPage = { variants: [], funscripts: [] };
        const { entries, isSingleVariant } = discoverVariantEntries();

        for (const entry of entries) {
            await processVariantEntry(entry, isSingleVariant, storyPage);
        }

        const currentNorm = originAndPath(location.href);
        const foundCurrent = storyPage.variants.some((v) => originAndPath(v.url) === currentNorm);
        if (!foundCurrent) {
            log(`WARNING: current page URL not found among discovered variants`);
        }

        log(`processing complete: ${storyPage.variants.length} variant(s), ${storyPage.funscripts.length} unique funscript(s)`);

        nameAndSaveAll(storyPage);
    }

    // ------------------------------------------------------------------
    // Go button wiring
    // ------------------------------------------------------------------
    let running = false;

    goButton.addEventListener("click", async () => {
        if (running) return;
        running = true;
        goButton.disabled = true;

        logArea.value = "";
        refreshTitleLine();
        setFrameColor(OK_FRAME_COLOR);
        anySkipped = false;

        log(`=== RUN START: ${new Date().toISOString()} ===`);
        let halted = false;
        try {
            await runProcessing();
        } catch (err) {
            if (err instanceof RunHalted) {
                log(`RUN HALTED: ${err.message}`);
            } else {
                log(`UNEXPECTED ERROR: ${err.message}`);
                console.error(err);
            }
            halted = true;
        }
        log(`=== RUN END: ${new Date().toISOString()} ===`);

        setFrameColor(halted ? HALT_FRAME_COLOR : anySkipped ? SKIP_FRAME_COLOR : OK_FRAME_COLOR);
        running = false;
        goButton.disabled = false;
    });
})();
