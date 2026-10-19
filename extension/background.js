const CDN = "https://static3.songsterr.com/production-main/static3/latest/";

// Settings live in local storage so they survive browser restarts.
// everyTab: the user's choice on the settings page (off keeps the original
// one-tab behaviour). classicOn: the last popup switch position, used only
// while everyTab is on.
const DEFAULTS = { everyTab: false, classicOn: false };

async function settings() {
    return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

async function tabRules(tabId) {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    return rules.filter(rule => rule.condition.tabIds?.includes(tabId));
}

let pendingChange = Promise.resolve();

function queue(work) {
    // Session rule IDs are shared by all tabs. Serialize the read/replace
    // transaction so two changes cannot allocate the same IDs.
    const change = pendingChange.then(work);
    pendingChange = change.catch(() => {});
    return change;
}

function changeTab(tabId, enable) {
    return queue(() => applyTabState(tabId, enable));
}

function assertSongUrl(href) {
    const url = new URL(href);
    if (url.origin !== "https://www.songsterr.com") {
        throw new Error("Open a Songsterr song before enabling Classic.");
    }
    if (!url.pathname.startsWith("/a/wsa/")) {
        throw new Error("Start Classic on a song page, not an account or payment page.");
    }
}

async function installRules(tabId) {
    const owned = await tabRules(tabId);
    const removeRuleIds = owned.map(rule => rule.id);
    const assets = await (await fetch(chrome.runtime.getURL("asset-list.json"))).json();
    const allRules = await chrome.declarativeNetRequest.getSessionRules();
    let id = Math.max(0, ...allRules.map(rule => rule.id)) + 1;
    const addRules = [];
    const redirect = (condition, path, priority = 1) => addRules.push({
        id: id++, priority,
        action: { type: "redirect", redirect: { extensionPath: path } },
        condition: { ...condition, tabIds: [tabId] },
    });

    redirect({regexFilter: "^https://static3\\.songsterr\\.com/production-main/static3/latest/appClient-[A-Za-z0-9_-]+\\.js$", resourceTypes: ["script"]}, "/bootstrap.mjs", 10);
    redirect({regexFilter: "^https://static3\\.songsterr\\.com/production-main/static3/latest/appClient-[A-Za-z0-9_-]+\\.css$", resourceTypes: ["stylesheet"]}, "/vendor/appClient-442d1888c9.css", 10);
    redirect({regexFilter: "^https://static3\\.songsterr\\.com/production-main/static3/latest/common-[A-Za-z0-9_-]+\\.css$", resourceTypes: ["stylesheet"]}, "/vendor/common-7b4ff45b27.css", 10);
    for (const name of assets) {
        for (const base of [CDN, "https://www.songsterr.com/static3/latest/"]) {
            redirect({urlFilter: "|" + base + name + "|"}, "/vendor/" + name, 20);
        }
    }

    const media = await (await fetch(chrome.runtime.getURL("media-assets.json"))).json();
    for (const path of media) {
        const name = path.split("/").pop();
        for (const origin of ["https://www.songsterr.com", "https://static3.songsterr.com/production-main"]) {
            redirect({urlFilter: "|" + origin + path + "|"}, "/media/" + name, 5);
        }
    }

    // Classic changes frontend assets, never blocks API writes. Removing the
    // tab's old rules also clears preview blocks left by a 0.2.x installation.
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2876f9" });
    await chrome.action.setBadgeText({ tabId, text: "ON" });
}

async function applyTabState(tabId, enable) {
    if (!enable) {
        const removeRuleIds = (await tabRules(tabId)).map(rule => rule.id);
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
        await chrome.action.setBadgeText({ tabId, text: "" });
        await chrome.tabs.reload(tabId, { bypassCache: true });
        return;
    }
    assertSongUrl((await chrome.tabs.get(tabId)).url);
    await installRules(tabId);
    await chrome.tabs.reload(tabId, { bypassCache: true });
}

// "Keep Classic on in new tabs": when a song page starts loading in any tab,
// give that tab its rules before the page requests its scripts. Like the
// popup, this only starts Classic on song pages; a Classic tab may still
// browse elsewhere on Songsterr afterwards.
const committed = new Set();
const autoPending = new Map();
const SONG_PAGES = { url: [{ hostEquals: "www.songsterr.com", pathPrefix: "/a/wsa/" }] };

async function autoEnable(tabId, url) {
    const { everyTab, classicOn } = await settings();
    if (!everyTab || !classicOn) return;
    assertSongUrl(url);
    await queue(async () => {
        if ((await tabRules(tabId)).length > 0) return;
        await installRules(tabId);
        // If the page already committed before the rules existed, some of the
        // current frontend may have loaded. Reload once so the tab is clean.
        if (committed.has(tabId)) await chrome.tabs.reload(tabId, { bypassCache: true });
    });
}

chrome.webNavigation.onBeforeNavigate.addListener(details => {
    if (details.frameId !== 0 || details.tabId < 0) return;
    committed.delete(details.tabId);
    const work = autoEnable(details.tabId, details.url).catch(error => console.error("Classic auto-enable:", error));
    autoPending.set(details.tabId, work);
    work.finally(() => { if (autoPending.get(details.tabId) === work) autoPending.delete(details.tabId); });
}, SONG_PAGES);

chrome.webNavigation.onCommitted.addListener(details => {
    if (details.frameId === 0) committed.add(details.tabId);
}, SONG_PAGES);

async function setEveryTab(everyTab) {
    // Carry the current state over: if Classic is already on in some tab when
    // the setting is switched on, keep it on for new tabs too.
    const anyOn = (await chrome.declarativeNetRequest.getSessionRules())
        .some(rule => rule.action.type === "redirect" && rule.condition.tabIds?.length);
    await chrome.storage.local.set({ everyTab, classicOn: everyTab && anyOn });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
    (async () => {
        if (message.action === "status") {
            // Content scripts may query only their own tab; popup messages carry its ID.
            const tabId = sender.tab?.id ?? message.tabId;
            // Let this tab's auto-enable finish so the Firefox loader sees it.
            await autoPending.get(tabId);
            const rules = await tabRules(tabId);
            return { enabled: rules.length > 0, legacyPreview: rules.some(rule => rule.action.type === "block") };
        }
        if (message.action === "getSettings") return settings();
        if (message.action === "setEveryTab") {
            await setEveryTab(Boolean(message.everyTab));
            return settings();
        }
        if (message.action !== "enable" && message.action !== "disable") {
            throw new Error("Unknown Classic action");
        }
        const enable = message.action === "enable";
        await changeTab(message.tabId, enable);
        if ((await settings()).everyTab) await chrome.storage.local.set({ classicOn: enable });
        return { enabled: enable, legacyPreview: false };
    })().then(respond).catch(error => respond({ error: error.message }));
    return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
    committed.delete(tabId);
    autoPending.delete(tabId);
    const rules = await tabRules(tabId);
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(rule => rule.id) });
});
