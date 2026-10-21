// ==UserScript==
// @name        TM Shibby Plug Injector
// @description Route extra devices to the plug or stroker channel by patching Shibbydex's channel classifier in flight (Tampermonkey)
// @namespace   https://shibbydex.com/
// @version     4.0.3-2026-10-21
// @updateURL   https://raw.githubusercontent.com/blindio/haptic-data/main/userscripts/TM-Shibby-plug-injector.user.js
// @downloadURL https://raw.githubusercontent.com/blindio/haptic-data/main/userscripts/TM-Shibby-plug-injector.user.js
// @author      Thorson Little
// @match       https://shibbydex.com/file/*
// @run-at      document-start
// @grant       GM_getValue
// @grant       GM_setValue
// ==/UserScript==

// The site classifies devices in /build/assets/channels-<hash>.js. That chunk has no
// <script> tag of its own — it is only ever imported — so there is nothing to
// intercept. We override it by URL with an import map pointing at a patched copy.
//
// Two constraints, both learned by getting them wrong:
//
//   * The map must be in place before the first module resolution, and a
//     modulepreload link resolves the moment the parser sees it — sooner than any
//     observer can fire. Hence document-start and a synchronous fetch.
//   * The chunk's URL is not in the server HTML (its importer is lazily loaded), so
//     it cannot be looked up that early. We learn it from what the page fetches and
//     remember it. The load that learns it runs unpatched; the next one patches.

(function () {
    'use strict';

    // Lowercase substrings, not device names: the classifier tests them against
    // `${name} ${typeHint}`.toLowerCase(), so "gravity" catches "Lovense Gravity".
    const PLUG_KEYWORDS = ["gravity", "mission", "spinel", "jordan", "nexus revo", "iker"];
    const STROKER_KEYWORDS = [];

    const DEBUG = true;      // also record the merged lists in <head>
    const SHOW_BADGE = true; // on-page status, since a phone has no console
    const BADGE_HIDE_MS = { live: 5000, armed: 8000, action: 15000 };

    // The patched module sets this on <html> as it runs. Only our copy can set it,
    // so it proves the patch is live — the map and the meta tags only show intent.
    const LIVE_MARKER_ATTR = "data-plug-injector-live";

    const CHANNELS_URL_RE = /\/build\/assets\/channels-[A-Za-z0-9_-]+\.js/;
    const CACHE_KEY = "channels-chunk-url";

    // Anchor on the site's own keywords: the array identifiers are minified and
    // change every build.
    const PLUG_ANCHOR = "hush";
    const STROKER_ANCHOR = "solace";

    const patchSummary = {};
    let installedUrl = null;

    // Firefox can run document-start before <html> exists; Chrome does not. Anything
    // touching documentElement has to wait for it, and this still lands long before
    // the parser reaches any <link>, since nothing has been emitted yet.
    function whenRootExists(fn) {
        if (document.documentElement) {
            fn();
            return;
        }
        const timer = setInterval(() => {
            if (!document.documentElement) return;
            clearInterval(timer);
            fn();
        }, 0);
    }

    // A throw here used to take the badge down with it, leaving no sign of what
    // happened on a phone.
    function safely(what, fn) {
        try {
            fn();
        } catch (e) {
            console.warn(`plug injector: ${what} failed — ${e.message}`);
            setStatus('action', `error · ${e.message}`);
        }
    }

    // Synchronous so it finishes before the parser reaches the first preload link.
    function fetchSync(url) {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.send();
        if (xhr.status < 200 || xhr.status >= 300) throw new Error(`HTTP ${xhr.status}`);
        return xhr.responseText;
    }

    // Appends to the array literal containing `anchor`, keeping the site's entries.
    // Leaves the code alone and says so if the anchor is missing — a silent no-op
    // here would look exactly like success.
    function appendKeywords(code, anchor, extras, what) {
        if (extras.length === 0) return code;

        const re = new RegExp(`\\[[^\\[\\]]*?["']${anchor}["'][^\\[\\]]*?\\]`);
        const found = code.match(re);
        if (!found) {
            console.warn(`plug injector: no ${what} list in the chunk (no array containing "${anchor}") — leaving it unpatched`);
            return code;
        }

        const existing = [];
        const strRe = /(["'])(.*?)\1/g;
        let m;
        while ((m = strRe.exec(found[0])) !== null) existing.push(m[2]);

        const merged = existing.slice();
        for (const keyword of extras) {
            if (!merged.includes(keyword)) merged.push(keyword);
        }

        patchSummary[what] = merged;
        // Function replacement: a `$` in a keyword would read as a substitution.
        return code.replace(re, () => `[${merged.map((s) => JSON.stringify(s)).join(",")}]`);
    }

    function patchChunk(code) {
        let patched = appendKeywords(code, PLUG_ANCHOR, PLUG_KEYWORDS, "plug");
        patched = appendKeywords(patched, STROKER_ANCHOR, STROKER_KEYWORDS, "stroker");

        // Only if something was appended: an unrecognized chunk must not claim to be live.
        if (Object.keys(patchSummary).length > 0) {
            const added = [...PLUG_KEYWORDS, ...STROKER_KEYWORDS].join(', ');
            patched += `\ntry{document.documentElement.setAttribute(${JSON.stringify(LIVE_MARKER_ATTR)},${JSON.stringify(added)})}catch(e){}\n`;
        }
        return patched;
    }

    // Cache only — nothing else is knowable this early. A miss is normal on a first
    // visit or after a deploy; watchForChunk fixes it for next time.
    function loadChunk() {
        const cached = GM_getValue(CACHE_KEY, null);
        if (!cached) return null;
        try {
            return { url: cached, code: fetchSync(cached) };
        } catch (e) {
            console.info(`plug injector: the remembered chunk is gone (${e.message}) — site rebuilt, relearning it this load`);
            return null;
        }
    }

    function installImportMap(originalUrl, patchedCode) {
        // data: rather than blob:. A blob URL created in the userscript sandbox
        // belongs to a different principal than the page in Firefox, so the page
        // is refused when it tries to load it — Chrome does not draw that line.
        // data: has no principal to mismatch, and the chunk is tiny.
        const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(patchedCode)}`;
        const map = document.createElement('script');
        map.type = 'importmap';
        map.textContent = JSON.stringify({ imports: { [originalUrl]: moduleUrl } });

        const head = document.head || document.getElementsByTagName('head')[0];
        if (head) head.insertBefore(map, head.firstChild);
        else document.documentElement.appendChild(map);
    }

    // live = the patched module ran; armed = installed, nothing imported it yet;
    // action = unpatched, needs a reload or failed.
    let status = { level: 'action', text: 'did not run' };
    let badgeEl = null;
    let badgeTimer = null;

    function setStatus(level, text) {
        status = { level, text };
        renderBadge();
    }

    function renderBadge() {
        if (!SHOW_BADGE || !document.body) return;

        const palette = {
            live: { fg: '#7fd17f', border: '#2f5f2f' },
            armed: { fg: '#8ab4d9', border: '#2f4a5f' },
            action: { fg: '#d9a441', border: '#6b5320' },
        }[status.level];

        if (!badgeEl) {
            badgeEl = document.createElement('div');
            document.body.appendChild(badgeEl);
        }

        badgeEl.textContent = `plug injector · ${status.text}`;
        badgeEl.style.cssText = [
            'position:fixed', 'left:8px', 'bottom:8px', 'z-index:2147483647',
            'max-width:calc(100vw - 16px)', 'box-sizing:border-box',
            'padding:6px 9px', 'border-radius:4px', 'background:rgba(20,20,20,0.94)',
            `border:1px solid ${palette.border}`, `color:${palette.fg}`,
            'font:11px/1.35 monospace',
            // Taps must pass through: the badge once covered the device list.
            'pointer-events:none', 'user-select:none',
        ].join(';') + ';';

        clearTimeout(badgeTimer);
        badgeTimer = setTimeout(dismissBadge, BADGE_HIDE_MS[status.level]);
    }

    function dismissBadge() {
        if (badgeEl) badgeEl.remove();
        badgeEl = null;
    }

    function watchForLiveMarker() {
        const check = () => {
            const added = document.documentElement.getAttribute(LIVE_MARKER_ATTR);
            if (added === null) return false;
            setStatus('live', `live · +${added}`);
            return true;
        };
        if (check()) return;

        new MutationObserver((records, observer) => {
            if (check()) observer.disconnect();
        }).observe(document.documentElement, { attributes: true, attributeFilter: [LIVE_MARKER_ATTR] });
    }

    function install() {
        const chunk = loadChunk();
        if (!chunk) {
            console.info('plug injector: no chunk URL remembered yet — this load runs unpatched while we learn it');
            setStatus('action', 'unpatched · learning, reload to apply');
            return;
        }

        try {
            installImportMap(chunk.url, patchChunk(chunk.code));
        } catch (e) {
            console.warn(`plug injector: could not install the patched chunk (${e.message}) — the page will run unpatched`);
            setStatus('action', `unpatched · ${e.message}`);
            return;
        }

        installedUrl = chunk.url;
        GM_setValue(CACHE_KEY, chunk.url);

        if (Object.keys(patchSummary).length === 0) {
            setStatus('action', `unpatched · no "${PLUG_ANCHOR}" list in the chunk`);
        } else {
            setStatus('armed', 'armed · waiting for the page to load it');
        }
    }

    // Deferred to DOMContentLoaded only because <head> may not exist at document-start.
    function publishSummary() {
        if (!DEBUG || !installedUrl) return;
        const head = document.head || document.getElementsByTagName('head')[0];
        if (!head) return;

        const write = (name, value) => {
            let meta = head.querySelector(`meta[name="plug-injector-${name}"]`);
            if (!meta) {
                meta = document.createElement('meta');
                meta.name = `plug-injector-${name}`;
                head.appendChild(meta);
            }
            meta.content = JSON.stringify(value);
        };

        try {
            write('chunk', installedUrl);
            for (const [what, merged] of Object.entries(patchSummary)) write(what, merged);
        } catch (e) {}
    }

    // Learns the URL from what the page actually fetches. Resource Timing sees the
    // load however it was triggered, and keeps watching — the import can happen long
    // after load. Seeing nothing means success: a live map resolves to the blob, so
    // channels-*.js is never fetched.
    function watchForChunk() {
        let handled = false;

        const seen = (rawUrl) => {
            if (handled || !rawUrl || !CHANNELS_URL_RE.test(rawUrl)) return;

            let absolute;
            try {
                absolute = new URL(rawUrl, location.href).href;
            } catch (e) {
                return;
            }
            if (absolute === installedUrl) return;

            handled = true;
            GM_setValue(CACHE_KEY, absolute);

            if (installedUrl) {
                console.warn(`plug injector: page loaded ${absolute}, we patched ${installedUrl} — site rebuilt. Cache updated; reload to patch.`);
                setStatus('action', 'unpatched · site rebuilt, reload to apply');
            } else {
                console.warn(`plug injector: learned the channels chunk (${absolute}). This load is unpatched; reload to apply it.`);
                setStatus('action', 'unpatched · learned it, reload to apply');
            }
        };

        try {
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) seen(entry.name);
            }).observe({ type: 'resource', buffered: true });
        } catch (e) {
            console.warn(`plug injector: resource timing unavailable (${e.message}) — falling back to a DOM sweep`);
            const sweep = () => {
                const el = document.querySelector('link[href*="/channels-"], script[src*="/channels-"]');
                if (el) seen(el.getAttribute('href') || el.getAttribute('src'));
            };
            document.addEventListener('DOMContentLoaded', sweep);
            window.addEventListener('load', sweep);
        }
    }

    // Registered before anything that can fail, so the badge still gets drawn and
    // can report the failure. No <body> to draw into at document-start.
    document.addEventListener('DOMContentLoaded', () => {
        publishSummary();
        renderBadge();
    });

    whenRootExists(() => {
        safely('install', install);
        safely('live marker watch', watchForLiveMarker);
    });
    safely('chunk watch', watchForChunk);
})();
