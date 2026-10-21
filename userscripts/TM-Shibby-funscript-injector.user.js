// ==UserScript==
// @name        TM Shibby Funscript Injector
// @description Fill a file's missing vibe/plug/stroker tracks from the funscripts/ directory on GitHub (Tampermonkey)
// @namespace   https://shibbydex.com/
// @version     4.0.1-2026-10-21
// @updateURL   https://raw.githubusercontent.com/blindio/haptic-data/main/userscripts/TM-Shibby-funscript-injector.user.js
// @downloadURL https://raw.githubusercontent.com/blindio/haptic-data/main/userscripts/TM-Shibby-funscript-injector.user.js
// @author      Thorson Little
// @match       https://shibbydex.com/file/*
// @run-at      document-start
// @grant       GM_xmlhttpRequest
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @connect     api.github.com
// ==/UserScript==

// The player reads #sd-player-data, whose queue[].file.haptics maps each device to a
// URL or null. We fill the nulls from a GitHub repo before the site parses it, so the
// site treats our tracks as if it had shipped them — and the visualizer, which reads
// the same element, graphs them for free.
//
// The tracks live in their own PUBLIC repo, not alongside this script. That is load
// bearing, not untidiness: the page fetches the URL itself, and nothing we can give it
// authenticates. raw.githubusercontent.com carries no session cookies, and a
// credentialed cross-origin fetch to github.com fails CORS — so a private repo is
// unreachable no matter what token we hold. Hence a separate public repo, with
// deliberately uninformative file names.
//
//     funscripts/<file-id>/<device>/<name>.funscript
//
// Any leaf name works, because we list the repo rather than guessing URLs: one tree
// API call gives every id, device and filename at once, cached, so most loads cost
// nothing and adding a track needs no change here.
//
// Losing the race is harmless here, unlike the plug injector: the worst case is the
// page behaving exactly as it does today.

(function () {
    'use strict';

    const REPO = 'blindio/haptic-data';
    const BRANCH = 'main';
    const ROOT = 'funscripts';

    const LISTING_TTL_MS = 10 * 60 * 1000; // refresh at most every 10 min
    const CACHE_KEY = 'funscript-listing';

    const SHOW_BADGE = true; // on-page status, since a phone has no console
    const BADGE_HIDE_MS = { live: 6000, idle: 4000, action: 15000 };

    const PLAYER_DATA_SELECTOR = 'script#sd-player-data';

    // id -> device -> raw URL, resolved from the repo listing.
    let index = null;
    let listingReady = null;
    let injected = null;

    function rawUrl(path) {
        const encoded = path.split('/').map(encodeURIComponent).join('/');
        return `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${encoded}`;
    }

    function gmFetch(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                onload: (r) => (r.status >= 200 && r.status < 300
                    ? resolve(r.responseText)
                    : reject(new Error(`HTTP ${r.status}`))),
                onerror: (r) => reject(new Error((r && (r.details || r.error)) || 'network error')),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    // funscripts/<id>/<device>/<name>.funscript -> index[id][device] = raw URL.
    // Anything that does not fit that shape is ignored rather than guessed at.
    function indexFromTree(tree) {
        const result = {};
        for (const node of tree) {
            if (node.type !== 'blob') continue;

            const parts = node.path.split('/');
            if (parts.length !== 4 || parts[0] !== ROOT) continue;
            if (!/\.funscript$/i.test(parts[3])) continue;

            const [, id, device] = parts;
            if (!result[id]) result[id] = {};
            // First wins, so a stray second file in a device directory cannot
            // silently flip which one is used from load to load.
            if (!result[id][device]) result[id][device] = rawUrl(node.path);
        }
        return result;
    }

    async function loadListing(force) {
        const cached = GM_getValue(CACHE_KEY, null);
        if (!force && cached && Date.now() - cached.fetchedAt < LISTING_TTL_MS) {
            return cached.index;
        }

        try {
            const body = await gmFetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`);
            const parsed = JSON.parse(body);
            if (parsed.truncated) {
                console.warn('funscript injector: the repo listing was truncated by GitHub; some scripts may be invisible');
            }
            const fresh = indexFromTree(parsed.tree || []);
            GM_setValue(CACHE_KEY, { fetchedAt: Date.now(), index: fresh });
            return fresh;
        } catch (e) {
            if (cached) {
                console.warn(`funscript injector: listing refresh failed (${e.message}); using the cached one`);
                return cached.index;
            }
            throw e;
        }
    }

    // Fills nulls and absent devices alike — both mean "this file has no track for
    // that device". Existing URLs are never replaced.
    function fillHaptics(file) {
        const available = index && index[file.id];
        if (!available) return [];

        if (!file.haptics) file.haptics = {};
        const added = [];
        for (const [device, url] of Object.entries(available)) {
            if (file.haptics[device]) continue;
            file.haptics[device] = url;
            added.push(device);
        }
        return added;
    }

    function injectInto(el) {
        if (injected) return;

        let data;
        try {
            data = JSON.parse(el.textContent);
        } catch (e) {
            console.warn(`funscript injector: ${PLAYER_DATA_SELECTOR} is not valid JSON (${e.message})`);
            setStatus('action', `error · player data unreadable`);
            return;
        }

        const queue = Array.isArray(data.queue) ? data.queue : [];
        const added = [];
        for (const entry of queue) {
            if (entry && entry.file) added.push(...fillHaptics(entry.file));
        }

        if (added.length === 0) {
            setStatus('idle', 'nothing to add for this file');
            return;
        }

        injected = added;
        el.textContent = JSON.stringify(data);
        console.info(`funscript injector: added ${added.join(', ')}`);
        setStatus('live', `added ${added.join(', ')}`);

        if (document.readyState !== 'loading') {
            console.warn('funscript injector: the page had already finished parsing — if the tracks do not appear, the player read the data before we rewrote it');
        }
    }

    // The element does not exist at document-start. The site's reader is a lazily
    // imported module, so catching the insertion leaves plenty of slack.
    function whenPlayerData(fn) {
        const existing = document.querySelector(PLAYER_DATA_SELECTOR);
        if (existing) {
            fn(existing);
            return;
        }

        const observer = new MutationObserver(() => {
            const el = document.querySelector(PLAYER_DATA_SELECTOR);
            if (!el) return;
            observer.disconnect();
            fn(el);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ---- status badge -------------------------------------------------------
    // live = tracks added; idle = nothing to add; action = something failed.

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
            idle: { fg: '#8a8a8a', border: '#3a3a3a' },
            action: { fg: '#d9a441', border: '#6b5320' },
        }[status.level];

        if (!badgeEl) {
            badgeEl = document.createElement('div');
            document.body.appendChild(badgeEl);
        }

        badgeEl.textContent = `funscript injector · ${status.text}`;
        badgeEl.style.cssText = [
            'position:fixed', 'left:8px', 'bottom:36px', 'z-index:2147483647',
            'max-width:calc(100vw - 16px)', 'box-sizing:border-box',
            'padding:6px 9px', 'border-radius:4px', 'background:rgba(20,20,20,0.94)',
            `border:1px solid ${palette.border}`, `color:${palette.fg}`,
            'font:11px/1.35 monospace',
            // Taps must pass through, and it sits above the plug injector's badge.
            'pointer-events:none', 'user-select:none',
        ].join(';') + ';';

        clearTimeout(badgeTimer);
        badgeTimer = setTimeout(() => {
            if (badgeEl) badgeEl.remove();
            badgeEl = null;
        }, BADGE_HIDE_MS[status.level]);
    }

    // ---- startup ------------------------------------------------------------

    // Firefox can run document-start before <html> exists; Chrome does not.
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

    // Registered before anything that can fail, so the badge still reports it.
    document.addEventListener('DOMContentLoaded', renderBadge);

    listingReady = loadListing(false).then(
        (fresh) => { index = fresh; },
        (e) => {
            console.warn(`funscript injector: could not list ${REPO} (${e.message})`);
            setStatus('action', `error · ${e.message}`);
        }
    );

    whenRootExists(() => {
        whenPlayerData((el) => {
            listingReady.then(() => {
                if (index) injectInto(el);
            });
        });
    });

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Refresh funscript listing', () => {
            loadListing(true).then(
                (fresh) => {
                    index = fresh;
                    const count = Object.keys(fresh).length;
                    console.info(`funscript injector: listing refreshed — ${count} file(s) with scripts. Reload to apply.`);
                    setStatus('idle', `listing refreshed · ${count} file(s) · reload to apply`);
                },
                (e) => setStatus('action', `refresh failed · ${e.message}`)
            );
        });
    }
})();
