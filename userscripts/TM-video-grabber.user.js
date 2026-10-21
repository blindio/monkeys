// ==UserScript==
// @name        TM Video Grabber
// @description Step through a page's video elements and download each under its title attribute
// @version     1.0.1-2026-10-21
// @updateURL   https://raw.githubusercontent.com/blindio/haptic-data/main/userscripts/TM-video-grabber.user.js
// @downloadURL https://raw.githubusercontent.com/blindio/haptic-data/main/userscripts/TM-video-grabber.user.js
// @author      Thorson Little
// @match       *://*/*
// @grant       none
// ==/UserScript==

(function () {
    "use strict";

    // .src is the resolved absolute URL, so relative paths need no handling.
    const videos = [...document.querySelectorAll("video")]
        .map((el) => ({ el, url: el.querySelector("source")?.src || el.src, name: el.title }))
        .filter((v) => v.url);
    if (!videos.length) return;

    const panel = document.body.appendChild(document.createElement("div"));
    panel.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;background:#1e1e1e;color:#ddd;" +
        "font:12px system-ui,sans-serif;padding:8px 10px;border-radius:6px;box-shadow:0 2px 10px #000a;max-width:300px";
    panel.innerHTML = "<span style='float:right;margin:-2px 0 0 8px;cursor:pointer;color:#888'>✕</span>" +
        "<div style='word-break:break-all'></div>" +
        "<div style='display:flex;gap:6px;margin-top:6px'>" +
        "<button>Download</button><button>Prev</button><button>Next</button></div>";

    const [close, label, row] = panel.children;
    const [download, prev, next] = row.querySelectorAll("button");
    for (const button of row.children) {
        button.style.cssText = "flex:1;background:#333;color:#ddd;border:1px solid #444;" +
            "border-radius:4px;padding:4px;font:12px system-ui,sans-serif;cursor:pointer";
    }

    close.onclick = () => panel.remove();

    let index = 0;
    const tried = new Set();

    // Green until this video has been asked for, red once it has. Tracks the
    // click, not the outcome — nothing here observes whether a download
    // actually finished, so red means "requested", not "saved".
    const paint = () => { download.style.background = tried.has(index) ? "#8b2f2f" : "#2e7d32"; };

    function show() {
        label.textContent = `${index + 1}/${videos.length} — ${videos[index].name}`;
        paint();
        videos[index].el.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    download.onclick = () => {
        Object.assign(document.createElement("a"), {
            href: videos[index].url,
            download: videos[index].name,
        }).click();
        tried.add(index);
        paint();
    };
    prev.onclick = () => { index = (index - 1 + videos.length) % videos.length; show(); };
    next.onclick = () => { index = (index + 1) % videos.length; show(); };

    show();
})();
