/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addMessagePreSendListener, MessageSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ContextMenuApi, FluxDispatcher, Menu, UserStore } from "@webpack/common";

const logger = new Logger("FakeStream");

// Voice op 5 SPEAKING bitmask.
const SpeakingFlags = {
    VOICE: 1 << 0,       // normal speaking (green ring)
    SOUNDSHARE: 1 << 1,  // context audio, no speaking indicator
    PRIORITY: 1 << 2,    // priority speaker (ducks others)
} as const;

// Discord RTC regions accepted in Op 18 "Create Stream" preferred_region.
const REGIONS = [
    "auto", "us-east", "us-west", "us-central", "us-south",
    "brazil", "rotterdam", "russia", "japan", "india",
    "singapore", "hongkong", "sydney", "southafrica",
] as const;

const settings = definePluginSettings({
    spoofResolution: {
        type: OptionType.STRING,
        description: "Fake resolution height (16:9 width auto-derived). '0' or empty = off. Try 420, 1080, 4320.",
        default: "420",
    },
    spoofFps: {
        type: OptionType.STRING,
        description: "Fake stream FPS shown in the badge. '0' or empty = off.",
        default: "420",
    },
    spoofSourceName: {
        type: OptionType.BOOLEAN,
        description: "Override the 'Go Live from X' attribution.",
        default: true,
    },
    sourceName: {
        type: OptionType.STRING,
        description: "Fake source app name shown under your stream.",
        default: "420",
    },
    forceRegion: {
        type: OptionType.BOOLEAN,
        description: "Force your stream onto a specific RTC region.",
        default: false,
    },
    region: {
        type: OptionType.SELECT,
        description: "Preferred RTC region when forcing is on.",
        options: REGIONS.map(r => ({ label: r, value: r, default: r === "auto" })),
    },
    forceNoPreview: {
        type: OptionType.BOOLEAN,
        description: "Tell Discord to never generate a preview thumbnail of your stream.",
        default: false,
    },

    // Voice state / speaking ------------------------------------------------
    spoofSpeaking: {
        type: OptionType.SELECT,
        description: "Force your voice Op 5 SPEAKING bit.",
        options: [
            { label: "Off (normal behavior)", value: "off", default: true },
            { label: "Always speaking (permanent green ring)", value: "voice" },
            { label: "Soundshare only (talk without green ring)", value: "soundshare" },
            { label: "Priority speaker (duck others)", value: "priority" },
        ],
        onChange: () => refreshSpeakingSpoof(),
    },
    downgradeDave: {
        type: OptionType.BOOLEAN,
        description: "Claim DAVE E2EE protocol v0 — drops the encryption lock icon for everyone on the call.",
        default: false,
    },

    // Message-level lies ----------------------------------------------------
    forceSilent: {
        type: OptionType.BOOLEAN,
        description: "Automatically send every message with SUPPRESS_NOTIFICATIONS (silent message).",
        default: false,
    },
    forceNoEmbeds: {
        type: OptionType.BOOLEAN,
        description: "Automatically send every message with SUPPRESS_EMBEDS (no link previews).",
        default: false,
    },
});

// ---- Badge spoof ---------------------------------------------------------
// spoofResolution is the height; width is derived as 16:9. fps is a plain
// integer. Empty / "0" = spoof off.

function parseInt0(val: string | undefined) {
    if (!val) return undefined;
    const v = parseInt(val);
    return isFinite(v) && v > 0 ? v : undefined;
}

function spoofRes() { return parseInt0(settings.store.spoofResolution); }
function spoofFpsNum() { return parseInt0(settings.store.spoofFps); }

// Replaces `maxResolution` on the outgoing stream parameter object with a
// fixed-tier {width, height} built from our height setting. Returns `real`
// untouched when spoof is off.
function spoofQuality(real: any) {
    const v = spoofRes();
    if (!v) return real;
    return { type: 1, width: Math.round(v * 16 / 9), height: v };
}

function spoofFpsVal(real: number) {
    return spoofFpsNum() ?? real;
}

// Mutates the stream params array in place, setting both maxResolution and
// maxFrameRate on each entry — used by the sendVideo patch.
function patchStreamParams(params: any) {
    const res = spoofRes(), fps = spoofFpsNum();
    if (!res && !fps) return params;
    if (!Array.isArray(params)) return params;
    for (const p of params) {
        if (res && p.maxResolution) {
            p.maxResolution = { ...p.maxResolution, width: Math.round(res * 16 / 9), height: res };
        }
        if (fps) p.maxFrameRate = fps;
    }
    return params;
}

// Used by the self-view "stream is live at Xp" formatter — returns a resolution
// shape Discord's i18n formatter consumes.
function makeSelfResolution(settingValue: any) {
    const res = spoofRes();
    if (!res) return { height: settingValue ?? 1080, width: 0, type: 0 };
    return { height: res, width: Math.round(res * 16 / 9), type: 0 };
}

// Converts an internal resolution object back to a simple height number for the
// localized self-view string (also used when spoof is off as a safe fallback).
function getDisplayResolution(value: any): number {
    if (typeof value !== "object" || value == null) return 0;
    const h = value.height ?? 0, w = value.width ?? 0;
    return h > 0 && w > 0 ? Math.max(h, Math.round(w * 9 / 16)) : h;
}

function spoofedName(real: string): string {
    if (!settings.store.spoofSourceName) return real;
    const name = settings.store.sourceName;
    return name || real;
}

function forcedPreviewDisabled(real: boolean): boolean {
    return settings.store.forceNoPreview ? true : real;
}

function forcedRegion(real: string | null | undefined): string | null | undefined {
    if (!settings.store.forceRegion) return real;
    const r = settings.store.region;
    return r && r !== "auto" ? r : real;
}

function spoofSpeakingBits(real: number): number {
    switch (settings.store.spoofSpeaking) {
        case "voice":
            // Persistent green ring — force VOICE bit set even when client stops.
            return SpeakingFlags.VOICE;
        case "soundshare":
            // Silent talking — swap the VOICE bit for SOUNDSHARE. Sending
            // plain speaking=0 doesn't work: Discord's voice server has a
            // VAD fallback, so when RTP audio arrives it re-flags us as
            // speaking and peers still get the green ring. SOUNDSHARE
            // (bit 1) is the canonical "audio is flowing, don't render
            // speaking UI" signal (used by music bots, Go-Live audio).
            return real === 0 ? 0 : SpeakingFlags.SOUNDSHARE;
        case "priority":
            // Priority duck — only while actually speaking.
            return real === 0 ? 0 : SpeakingFlags.VOICE | SpeakingFlags.PRIORITY;
        default: return real;
    }
}

function downgradedDave(real: number): number {
    return settings.store.downgradeDave ? 0 : real;
}

let silentListener: MessageSendListener | undefined;

// Runtime WebSocket hook for the voice gateway. The Webpack patches for
// setSpeaking are fragile against minifier changes — hooking WebSocket.send
// directly lets us rewrite voice Op 5 payloads no matter how Discord built them.
// Voice gateway JSON frames look like `{"op":5,"d":{"speaking":N,"delay":0,"ssrc":X}}`.
// Main gateway never sends op:5 with a speaking field, so this is a safe filter.
let originalWsSend: typeof WebSocket.prototype.send | undefined;
let wsHooked = false;
let rewriteLogCount = 0;
let voiceWs: WebSocket | undefined;
let voiceSsrc = 1;

function installWsHook() {
    if (wsHooked) return;
    originalWsSend = WebSocket.prototype.send;
    const orig = originalWsSend;
    WebSocket.prototype.send = function (this: WebSocket, data: any) {
        try {
            if (
                typeof data === "string"
                && data.length < 256
                && data.charCodeAt(0) === 123 /* { */
                && data.includes('"speaking"')
                && data.includes('"op":5')
            ) {
                const parsed = JSON.parse(data);
                if (parsed && parsed.op === 5 && parsed.d && typeof parsed.d.speaking === "number") {
                    voiceWs = this;
                    if (typeof parsed.d.ssrc === "number" && parsed.d.ssrc) voiceSsrc = parsed.d.ssrc;
                    const mode = settings.store.spoofSpeaking;
                    if (mode !== "off") {
                        const before = parsed.d.speaking;
                        parsed.d.speaking = spoofSpeakingBits(parsed.d.speaking);
                        // Log first ~10 rewrites so you can verify in devtools
                        // that the hook is firing and what it's rewriting to.
                        if (rewriteLogCount < 10) {
                            rewriteLogCount++;
                            logger.info(`op:5 rewrite [${mode}] ${before} -> ${parsed.d.speaking} ssrc=${voiceSsrc}`);
                        }
                        data = JSON.stringify(parsed);
                    } else if (rewriteLogCount < 10) {
                        rewriteLogCount++;
                        logger.info(`op:5 seen (spoof off) speaking=${parsed.d.speaking} ssrc=${voiceSsrc}`);
                    }
                }
            }
        } catch {
            // JSON.parse failed or similar — pass through unmodified
        }
        return orig.call(this, data);
    };
    wsHooked = true;
}

// Synthesize an op:5 frame to the captured voice gateway so the server picks up
// a mode change immediately instead of holding the previous spoofed state until
// the user talks again.
function flushVoiceSpeaking(value: number) {
    if (!voiceWs || voiceWs.readyState !== WebSocket.OPEN || !originalWsSend) return;
    try {
        const frame = JSON.stringify({ op: 5, d: { speaking: value, delay: 0, ssrc: voiceSsrc } });
        originalWsSend.call(voiceWs, frame);
    } catch (e) {
        logger.error("flush voice speaking failed", e);
    }
}

function uninstallWsHook() {
    if (wsHooked && originalWsSend) {
        WebSocket.prototype.send = originalWsSend;
    }
    wsHooked = false;
    originalWsSend = undefined;
    voiceWs = undefined;
    rewriteLogCount = 0;
}

// Local green ring suppression. The WebSocket hook only rewrites outgoing op:5
// so other clients don't see our ring. Our own ring is rendered from Discord's
// internal SPEAKING flux dispatch, triggered by mic activity detection in the
// voice engine. FluxDispatcher.addInterceptor runs before handlers and returning
// true cancels the action — so in "soundshare" mode we drop SPEAKING events
// carrying our own user id.
let speakingInterceptorInstalled = false;
let speakingInterceptorActive = false;
let interceptorLogCount = 0;

function installSpeakingInterceptor() {
    speakingInterceptorActive = true;
    if (speakingInterceptorInstalled) return;
    try {
        (FluxDispatcher as any).addInterceptor((action: any) => {
            if (!speakingInterceptorActive) return false;
            try {
                if (action?.type !== "SPEAKING") return false;
                const mode = settings.store.spoofSpeaking;
                if (mode !== "soundshare") return false;
                const me = UserStore.getCurrentUser();
                if (!me || action.userId !== me.id) return false;
                if (interceptorLogCount < 10) {
                    interceptorLogCount++;
                    logger.info(`blocked local SPEAKING dispatch flags=${action.speakingFlags}`);
                }
                return true;
            } catch {
                return false;
            }
        });
        speakingInterceptorInstalled = true;
    } catch (e) {
        logger.error("failed to install speaking interceptor", e);
    }
}

function uninstallSpeakingInterceptor() {
    // Discord's FluxDispatcher doesn't expose removeInterceptor, so we flip a
    // flag and the registered function becomes a no-op.
    speakingInterceptorActive = false;
    interceptorLogCount = 0;
}

// Local-UI speaking spoof. The WebSocket rewrite only affects what OTHER users
// see. Your own green ring is driven by Flux "SPEAKING" dispatches in your
// client. We periodically re-dispatch for the current user so your avatar shows
// the spoofed state locally as well.
let localSpeakingTimer: number | undefined;
let currentSsrc = 1;

function startLocalSpeakingDispatch() {
    if (localSpeakingTimer != null) return;
    const tick = () => {
        const mode = settings.store.spoofSpeaking;
        if (mode === "off") return;
        try {
            const user = UserStore.getCurrentUser();
            if (!user) return;
            FluxDispatcher.dispatch({
                type: "SPEAKING",
                userId: user.id,
                context: "default",
                speakingFlags: spoofSpeakingBits(0),
                ssrc: currentSsrc,
            } as any);
        } catch (e) {
            logger.error("local speaking dispatch failed", e);
        }
    };
    // Discord's speaking UI times out around ~1s of no refresh, so 500ms keeps
    // the ring steady.
    localSpeakingTimer = window.setInterval(tick, 500);
}

function refreshSpeakingSpoof() {
    const mode = settings.store.spoofSpeaking;

    // Push a fresh op:5 so the voice gateway reflects the new mode instantly.
    // For "voice" we pin to the VOICE bit; every other mode starts clean at 0
    // and lets real talk frames trigger the per-mode rewrite (or a no-op for "off").
    flushVoiceSpeaking(mode === "voice" ? SpeakingFlags.VOICE : 0);

    // Only modes that want a persistent local green ring need the 500ms tick.
    if (mode === "voice" || mode === "priority") {
        startLocalSpeakingDispatch();
    } else {
        stopLocalSpeakingDispatch();
    }
}

function stopLocalSpeakingDispatch() {
    if (localSpeakingTimer != null) {
        clearInterval(localSpeakingTimer);
        localSpeakingTimer = undefined;
    }
    // Clear the spoofed state so the UI returns to normal.
    try {
        const user = UserStore.getCurrentUser();
        if (user) {
            FluxDispatcher.dispatch({
                type: "SPEAKING",
                userId: user.id,
                context: "default",
                speakingFlags: 0,
                ssrc: currentSsrc,
            } as any);
        }
    } catch { /* ignore */ }
}

function FakeStreamIcon({ className }: { className?: string; }) {
    return (
        <svg className={className} width="20" height="20" viewBox="0 0 32 24" fill="currentColor">
            <path d="M2 5a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-4v2h2a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2h2v-2H5a3 3 0 0 1-3-3V5Z" />
            <path fill="var(--background-base-lowest)" d="M9.5 7.5v7l6-3.5-6-3.5Z" />
            {/* inline dropdown chevron */}
            <path d="M26 10 l3 3 l3 -3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function FakeStreamMenu({ onClose }: { onClose: () => void; }) {
    const s = settings.use([
        "spoofResolution", "spoofFps", "spoofSourceName",
        "forceRegion", "region", "forceNoPreview",
        "spoofSpeaking", "downgradeDave",
        "forceSilent", "forceNoEmbeds",
    ]);

    const regionItems: Array<readonly [string, string]> = REGIONS.map(r => [r, r] as const);
    const res = parseInt0(s.spoofResolution);
    const fps = parseInt0(s.spoofFps);
    const badgeLabel = (res || fps)
        ? `Badge spoof (${res ?? "—"}p @ ${fps ?? "—"}fps)`
        : "Badge spoof (OFF — set values in settings)";

    return (
        <Menu.Menu navId="vc-fakestream-menu" onClose={onClose}>
            <Menu.MenuGroup label={badgeLabel}>
                <Menu.MenuItem
                    id="vc-fs-res-pick"
                    label={`Resolution height: ${s.spoofResolution || "off"}`}
                >
                    {["0", "420", "720", "1080", "1440", "2160", "4320"].map(v => (
                        <Menu.MenuRadioItem
                            key={v}
                            id={`vc-fs-res-${v}`}
                            label={v === "0" ? "Off" : `${v}p`}
                            group="vc-fs-res"
                            checked={s.spoofResolution === v}
                            action={() => { settings.store.spoofResolution = v; }}
                        />
                    ))}
                </Menu.MenuItem>
                <Menu.MenuItem
                    id="vc-fs-fps-pick"
                    label={`FPS: ${s.spoofFps || "off"}`}
                >
                    {["0", "30", "60", "120", "165", "240", "420"].map(v => (
                        <Menu.MenuRadioItem
                            key={v}
                            id={`vc-fs-fps-${v}`}
                            label={v === "0" ? "Off" : v}
                            group="vc-fs-fps"
                            checked={s.spoofFps === v}
                            action={() => { settings.store.spoofFps = v; }}
                        />
                    ))}
                </Menu.MenuItem>
                <Menu.MenuCheckboxItem
                    id="vc-fs-source-name"
                    label={`Spoof source name ("${settings.store.sourceName}")`}
                    checked={s.spoofSourceName}
                    action={() => { settings.store.spoofSourceName = !s.spoofSourceName; }}
                />
                <Menu.MenuCheckboxItem
                    id="vc-fs-no-preview"
                    label="Force no preview thumbnail"
                    checked={s.forceNoPreview}
                    action={() => { settings.store.forceNoPreview = !s.forceNoPreview; }}
                />
            </Menu.MenuGroup>

            <Menu.MenuGroup label="Region">
                <Menu.MenuCheckboxItem
                    id="vc-fs-force-region"
                    label={`Force region (${s.region ?? "auto"})`}
                    checked={s.forceRegion}
                    action={() => { settings.store.forceRegion = !s.forceRegion; }}
                />
                <Menu.MenuItem id="vc-fs-region-pick" label="Pick region">
                    {regionItems.map(([value, label]) => (
                        <Menu.MenuRadioItem
                            key={value}
                            id={`vc-fs-region-${value}`}
                            label={label}
                            group="vc-fs-region"
                            checked={s.region === value}
                            action={() => { settings.store.region = value; }}
                        />
                    ))}
                </Menu.MenuItem>
            </Menu.MenuGroup>

            <Menu.MenuGroup label="Voice">
                <Menu.MenuItem id="vc-fs-speaking" label={`Speaking bit: ${s.spoofSpeaking}`}>
                    {([
                        ["off", "Off (normal)"],
                        ["voice", "Always speaking"],
                        ["soundshare", "Soundshare only (silent talk)"],
                        ["priority", "Priority speaker"],
                    ] as const).map(([value, label]) => (
                        <Menu.MenuRadioItem
                            key={value}
                            id={`vc-fs-speaking-${value}`}
                            label={label}
                            group="vc-fs-speaking"
                            checked={s.spoofSpeaking === value}
                            action={() => { settings.store.spoofSpeaking = value; }}
                        />
                    ))}
                </Menu.MenuItem>
                <Menu.MenuCheckboxItem
                    id="vc-fs-dave"
                    label="Downgrade DAVE E2EE (drops lock icon)"
                    checked={s.downgradeDave}
                    action={() => { settings.store.downgradeDave = !s.downgradeDave; }}
                />
            </Menu.MenuGroup>

            <Menu.MenuGroup label="Messages">
                <Menu.MenuCheckboxItem
                    id="vc-fs-silent"
                    label="All messages silent"
                    checked={s.forceSilent}
                    action={() => { settings.store.forceSilent = !s.forceSilent; }}
                />
                <Menu.MenuCheckboxItem
                    id="vc-fs-no-embeds"
                    label="Suppress embeds on all messages"
                    checked={s.forceNoEmbeds}
                    action={() => { settings.store.forceNoEmbeds = !s.forceNoEmbeds; }}
                />
            </Menu.MenuGroup>
        </Menu.Menu>
    );
}

export function FakeStreamDockButton() {
    const s = settings.use([
        "spoofResolution", "spoofFps", "spoofSourceName", "forceRegion", "forceNoPreview",
        "spoofSpeaking", "downgradeDave", "forceSilent", "forceNoEmbeds",
    ]);
    const badgeActive = !!parseInt0(s.spoofResolution) || !!parseInt0(s.spoofFps);
    const active = badgeActive || s.spoofSourceName || s.forceRegion || s.forceNoPreview
        || s.spoofSpeaking !== "off" || s.downgradeDave || s.forceSilent || s.forceNoEmbeds;

    const openMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        ContextMenuApi.openContextMenu(e, () => <FakeStreamMenu onClose={ContextMenuApi.closeContextMenu} />);
    };

    const toggleBadge = () => {
        if (badgeActive) {
            settings.store.spoofResolution = "0";
            settings.store.spoofFps = "0";
        } else {
            settings.store.spoofResolution = "420";
            settings.store.spoofFps = "420";
        }
    };

    return (
        <div
            role="button"
            title={active ? "FakeStream active — click for options, shift+click toggles badge" : "FakeStream options (shift+click toggles badge)"}
            onClick={e => {
                if (e.shiftKey) toggleBadge();
                else openMenu(e);
            }}
            onContextMenu={openMenu}
            style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 32,
                height: 24,
                borderRadius: 4,
                cursor: "pointer",
                color: active ? "var(--status-warning)" : "var(--interactive-normal)",
                background: active ? "var(--background-mod-faint)" : "transparent",
            }}
        >
            <FakeStreamIcon />
        </div>
    );
}

export default definePlugin({
    name: "FakeStream",
    description: "Lie to Discord (and everyone watching) about your screenshare: badge resolution, framerate, source app, region.",
    authors: [EquicordDevs.Matti],
    settings,

    dependencies: ["MessageEventsAPI"],

    patchStreamParams,
    spoofQuality,
    spoofFpsVal,
    makeSelfResolution,
    getDisplayResolution,
    spoofedName,
    forcedPreviewDisabled,
    forcedRegion,
    spoofSpeakingBits,
    downgradedDave,

    // Exposed for other plugins to render the dock button without a hard import.
    DockButton: FakeStreamDockButton,

    start() {
        silentListener = (_chanId, msg) => {
            if (settings.store.forceSilent && !msg.content.startsWith("@silent ")) {
                msg.content = "@silent " + msg.content;
            }
            if (settings.store.forceNoEmbeds) {
                // Wrap bare URLs in angle brackets — Discord's built-in way to suppress embeds.
                msg.content = msg.content.replace(/(?<![<(])(https?:\/\/\S+?)(?=[\s)]|$)/g, "<$1>");
            }
        };
        addMessagePreSendListener(silentListener);
        installWsHook();
        installSpeakingInterceptor();
        refreshSpeakingSpoof();
    },

    stop() {
        if (silentListener) removeMessagePreSendListener(silentListener);
        silentListener = undefined;
        // Clear any stuck spoofed state on the voice gateway before we drop the hook.
        flushVoiceSpeaking(0);
        uninstallWsHook();
        uninstallSpeakingInterceptor();
        stopLocalSpeakingDispatch();
    },

    patches: [
        // Viewer-facing badge — patches the outgoing sendVideo call so every
        // peer sees our fake resolution + framerate on Op 12 VIDEO metadata.
        {
            find: "VideoSourceQualityChanged,this.guildId",
            replacement: [
                {
                    match: /this\.sendVideo\((\i)\?\?0,(\i)\?\?0,(\i)\?\?0,(\i)\)/,
                    replace: "this.sendVideo($1??0,$2??0,$3??0,$self.patchStreamParams($4))",
                },
                {
                    match: /(\i)\.maxResolution,(\i)\.maxFrameRate,this\.context\)/,
                    replace: "$self.spoofQuality($1.maxResolution),$self.spoofFpsVal($2.maxFrameRate),this.context)",
                },
            ],
        },
        // Self-view — the "your stream is live at Xp" display in your own UI.
        {
            find: "#{intl::XjXqzh::raw}):h.intl.formatToPlainString(h.t#{intl::TEOC0I::raw}",
            replacement: {
                match: /maxFrameRate:(\i)\.fps,maxResolution:\{height:(\i)\.resolution.{0,50}\}/,
                replace: "maxFrameRate:$self.spoofFpsVal($1.fps),maxResolution:$self.makeSelfResolution($2.resolution)",
            },
        },
        // Resolution number rendered in localized self-display strings.
        {
            find: "intl.formatToPlainString(h.t#{intl::TEOC0I::raw},{resolution:",
            replacement: {
                match: /resolution:(\i)\.height/,
                replace: "resolution:$self.getDisplayResolution($1)",
            },
        },
        // Voice WebSocket Op 5 SPEAKING — force-replace the outgoing speaking
        // bitmask at the entry of VoiceConnection.setSpeaking, or at the payload
        // build site. Minifiers differ across Discord builds, so we ship several
        // match variants; at least one should hit.
        //
        // Variant A: class method definition on VoiceConnection (contains this.ssrc).
        {
            find: "this.ssrc",
            replacement: {
                match: /(setSpeaking\(([\w$]+)[^{)]*\)\{)/,
                replace: "$1$2=$self.spoofSpeakingBits($2);",
            },
            noWarn: true,
        },
        // Variant B: prototype assignment form.
        {
            find: ".prototype.setSpeaking=",
            replacement: {
                match: /(\.prototype\.setSpeaking=function\(([\w$]+)[^{)]*\)\{)/,
                replace: "$1$2=$self.spoofSpeakingBits($2);",
            },
            noWarn: true,
        },
        // Variant C: inline {op:5,d:{speaking:...}} payload build.
        {
            find: "op:5,d:{speaking:",
            replacement: {
                match: /(op:5,d:\{speaking:)([\w$]+)/,
                replace: "$1$self.spoofSpeakingBits($2)",
            },
            noWarn: true,
        },
        // Variant D: sendPayload(5,{speaking:...}) / sendOp(5,{speaking:...}) form.
        {
            find: "{speaking:",
            replacement: {
                match: /(send(?:Payload|Op)\(5,\{speaking:)([\w$]+)/,
                replace: "$1$self.spoofSpeakingBits($2)",
            },
            noWarn: true,
        },
        // DAVE protocol downgrade — claim v0 in voice Op 0 Identify.
        {
            find: "max_dave_protocol_version",
            replacement: {
                match: /max_dave_protocol_version:(\i)/,
                replace: "max_dave_protocol_version:$self.downgradedDave($1)",
            },
            noWarn: true,
        },

        // Field-level interception of the STREAM_START action object construction.
        // Each replacement hits an individual key — if Discord inlines/spreads a
        // field so it doesn't appear literally, that one patch no-ops but the
        // others still apply.
        {
            find: 'type:"STREAM_START"',
            replacement: [
                {
                    match: /sourceName:([^,}]+)/,
                    replace: "sourceName:$self.spoofedName($1)",
                },
                {
                    match: /audioSourceId:([^,}]+)/,
                    replace: "audioSourceId:$self.spoofedName($1)",
                },
                {
                    match: /previewDisabled:([^,}]+)/,
                    replace: "previewDisabled:$self.forcedPreviewDisabled($1)",
                },
                {
                    match: /preferredRegion:([^,}]+)/,
                    replace: "preferredRegion:$self.forcedRegion($1)",
                },
            ],
            noWarn: true,
        },
    ],
});
