/*
 * Equicord plugin — Aegis Rich Presence
 *
 * Mirrors the currently playing track in Aegis as a Discord activity in the
 * style of Spotify: cover art + song title + artist + progress bar. No
 * "Aegis" branding leaks into Discord — the visible activity name is fully
 * configurable and defaults to "Music".
 *
 * Data source: Aegis exposes a localhost endpoint at
 *   http://127.0.0.1:38793/now
 * which returns the current snapshot as JSON (or null when nothing plays).
 * The plugin polls on a user-configurable interval and dispatches
 * LOCAL_ACTIVITY_UPDATE when the signature actually changes.
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { UserAreaButton, UserAreaRenderProps } from "@api/UserArea";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Activity, ActivityAssets } from "@vencord/discord-types";
import { ActivityFlags, ActivityStatusDisplayType, ActivityType } from "@vencord/discord-types/enums";
import { ApplicationAssetUtils, AuthenticationStore, FluxDispatcher, PresenceStore } from "@webpack/common";

const ENDPOINT = "http://127.0.0.1:38793/now";
const SOCKET_ID = "AegisRichPresence";
const logger = new Logger("AegisRichPresence");

interface AegisSnapshot {
    title: string;
    artist: string;
    album: string;
    artworkUrl: string | null;
    durationMs: number;
    positionMs: number;
    paused: boolean;
    provider: string;
    trackUrl: string | null;
    updatedAtMs: number;
}

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Publish Aegis playback to Discord",
        default: true,
    },
    applicationName: {
        type: OptionType.STRING,
        description: "Shown as the app label on the activity card. Leave 'Music' for a Spotify-style feel.",
        default: "Music",
    },
    applicationId: {
        type: OptionType.STRING,
        description:
            "Discord application ID — only needed for cover art. Without it, song title + artist + progress bar still work. " +
            "Create one at https://discord.com/developers/applications.",
        default: "",
    },
    activityType: {
        type: OptionType.SELECT,
        description: "How the activity is labeled in the member list",
        options: [
            { label: "Listening to …  (Spotify-style)", value: ActivityType.LISTENING, default: true },
            { label: "Playing …", value: ActivityType.PLAYING },
        ],
    },
    showCoverArt: {
        type: OptionType.BOOLEAN,
        description: "Show artwork (requires applicationId)",
        default: true,
    },
    showProgressBar: {
        type: OptionType.BOOLEAN,
        description: "Show progress bar with start/end timestamps",
        default: true,
    },
    hideWhenPaused: {
        type: OptionType.BOOLEAN,
        description: "Clear the presence while playback is paused",
        default: false,
    },
    hideWithOtherListening: {
        type: OptionType.BOOLEAN,
        description: "Stay silent if Spotify (or another LISTENING activity) is already broadcasting",
        default: true,
    },
    skipSpotifySource: {
        type: OptionType.BOOLEAN,
        description:
            "Skip Spotify tracks entirely — Discord's native Spotify integration handles those. " +
            "Without this, the two LISTENING activities fight over the same slot and the card flickers. " +
            "Disable only if you DON'T have Spotify connected to your Discord account.",
        default: true,
    },
    refreshIntervalSec: {
        type: OptionType.SLIDER,
        description: "How often to poll Aegis (seconds)",
        markers: [1, 2, 3, 5, 10, 15],
        default: 3,
        restartNeeded: true,
    },
});

let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastActivityCleared = true;

// Identity of the currently-dispatched activity. Anything outside this
// (title / artist / paused / duration / album / artwork) coming from Aegis
// causes a redispatch. Plain position drift does NOT — once we've given
// Discord a {start, end} the client interpolates the progress bar itself
// and any further dispatch would just make the card flicker.
let dispatchedIdentity: string | null = null;
let dispatchedStart: number | null = null;

// If Aegis reports a position that's more than this many ms away from what
// the client would interpolate given the last start, treat it as a seek and
// re-dispatch with fresh timestamps.
const SEEK_DRIFT_MS = 4000;

// Consecutive failed / empty fetches tolerated before the activity is
// cleared. A single empty reply from Aegis can happen during track
// transitions or a tiny HTTP hiccup; clearing on it would make the Discord
// card vanish for a poll interval and then pop back — the exact "flicker"
// behavior we're trying to avoid. Three strikes at the default 3 s poll
// means the card only disappears if Aegis has been quiet for ~9 s.
const MISS_GRACE_COUNT = 3;
let missedFetches = 0;

function dispatchActivity(activity: Activity | null) {
    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity,
        socketId: SOCKET_ID,
    });
    lastActivityCleared = activity == null;
}

async function fetchSnapshot(): Promise<AegisSnapshot | null> {
    try {
        const res = await fetch(ENDPOINT, { cache: "no-store" });
        if (!res.ok) return null;
        const json = await res.json();
        if (!json || typeof json !== "object") return null;
        if (!json.title && !json.artist) return null;
        return json as AegisSnapshot;
    } catch {
        // Aegis not running or endpoint unreachable — treat as "nothing".
        return null;
    }
}

async function resolveAsset(appId: string, url: string): Promise<string | undefined> {
    try {
        const ids = await ApplicationAssetUtils.fetchAssetIds(appId, [url]);
        return ids?.[0];
    } catch (err) {
        logger.warn("asset fetch failed", err);
        return undefined;
    }
}

function spotifyOrSimilarPlaying(): boolean {
    try {
        const selfId = AuthenticationStore?.getId?.();
        if (!selfId) return false;
        const activities = PresenceStore?.getActivities?.(selfId) ?? [];
        return activities.some((a: any) =>
            a?.type === ActivityType.LISTENING && a?.socketId !== SOCKET_ID,
        );
    } catch {
        return false;
    }
}

function resetDispatched() {
    dispatchedIdentity = null;
    dispatchedStart = null;
}

function softClear() {
    // Clears the activity, but only once the grace window has elapsed.
    // Used for every "there's nothing to show" code path so a single bad
    // poll doesn't wipe the card.
    missedFetches++;
    if (missedFetches < MISS_GRACE_COUNT) return;
    if (!lastActivityCleared) dispatchActivity(null);
    resetDispatched();
}

async function updatePresence() {
    if (!settings.store.enabled) {
        // User-initiated disable — clear immediately, no grace.
        if (!lastActivityCleared) dispatchActivity(null);
        resetDispatched();
        missedFetches = 0;
        return;
    }

    if (settings.store.hideWithOtherListening && spotifyOrSimilarPlaying()) {
        softClear();
        return;
    }

    const snap = await fetchSnapshot();
    if (!snap) {
        softClear();
        return;
    }

    // Discord has native Spotify integration. When Aegis plays a Spotify
    // source, the Spotify backend pushes a LISTENING activity to Discord
    // through the official connection, and we must NOT dispatch a second one
    // — there is only one "Listening to…" slot in the user card, and two
    // competing dispatchers produce exactly the flickering behavior users
    // see. For non-Spotify sources (Local, SoundCloud) we have the slot to
    // ourselves.
    if (settings.store.skipSpotifySource && snap.provider === "Spotify") {
        softClear();
        return;
    }

    if (snap.paused && settings.store.hideWhenPaused) {
        softClear();
        return;
    }

    // Successful fetch with playable data — reset the miss counter.
    missedFetches = 0;

    // Identity captures everything Discord renders statically on the card.
    // Position is intentionally excluded — once a track is dispatched with
    // {start, end} timestamps the Discord client ticks the progress bar
    // on its own. Re-dispatching the same activity just causes the card to
    // flicker on every poll.
    const identity = [
        snap.title,
        snap.artist,
        snap.album,
        snap.paused ? "P" : "R",
        snap.durationMs,
        snap.artworkUrl ?? "",
    ].join("|");

    let seekDetected = false;
    if (
        identity === dispatchedIdentity &&
        !snap.paused &&
        dispatchedStart !== null
    ) {
        const clientExpectedPos = Date.now() - dispatchedStart;
        if (Math.abs(clientExpectedPos - snap.positionMs) > SEEK_DRIFT_MS) {
            seekDetected = true;
        }
    }

    if (identity === dispatchedIdentity && !seekDetected) return;

    const appId = settings.store.applicationId.trim();

    const assets: ActivityAssets = {};
    if (appId && settings.store.showCoverArt && snap.artworkUrl) {
        const largeId = await resolveAsset(appId, snap.artworkUrl);
        if (largeId) {
            assets.large_image = largeId;
            if (snap.album) assets.large_text = snap.album;
        }
    }

    let timestamps: Activity["timestamps"];
    if (settings.store.showProgressBar && !snap.paused && snap.durationMs > 0) {
        const start = Date.now() - snap.positionMs;
        timestamps = { start, end: start + snap.durationMs };
        dispatchedStart = start;
    } else {
        dispatchedStart = null;
    }

    dispatchedIdentity = identity;

    const activity: Activity = {
        ...(appId ? { application_id: appId } : {}),
        name: settings.store.applicationName || "Music",
        type: settings.store.activityType as ActivityType,
        details: snap.title || "Unknown",
        state: snap.artist || undefined,
        status_display_type: ActivityStatusDisplayType.DETAILS,
        assets,
        timestamps,
        flags: ActivityFlags.INSTANCE,
    };

    logger.info("dispatch", {
        reason: seekDetected ? "seek" : "identity-change",
        title: snap.title,
        paused: snap.paused,
    });
    dispatchActivity(activity);
}

// ── User-panel toggle button ────────────────────────────────────────────
// A small music-note button next to Mute/Deafen that flips the `enabled`
// setting. When off, the note has a red strike-through so the state is
// obvious at a glance. The button is wired in via the UserArea API.

function AegisIcon({ className }: { className?: string; }) {
    const { enabled } = settings.use(["enabled"]);
    return (
        <svg className={className} width="20" height="20" viewBox="0 0 24 24">
            <path
                fill={enabled ? "currentColor" : "var(--status-danger)"}
                mask={enabled ? void 0 : "url(#aegisRpcMask)"}
                d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z"
            />
            {!enabled && <>
                <path fill="var(--status-danger)" d="M22.7 2.7a1 1 0 0 0-1.4-1.4l-20 20a1 1 0 1 0 1.4 1.4Z" />
                <mask id="aegisRpcMask">
                    <rect fill="white" x="0" y="0" width="24" height="24" />
                    <path fill="black" d="M23.27 4.73 19.27 .73 -.27 20.27 3.73 24.27Z" />
                </mask>
            </>}
        </svg>
    );
}

function AegisToggleButton({ iconForeground, hideTooltips, nameplate }: UserAreaRenderProps) {
    const { enabled } = settings.use(["enabled"]);
    return (
        <UserAreaButton
            tooltipText={hideTooltips ? void 0 : enabled ? "Disable Aegis Rich Presence" : "Enable Aegis Rich Presence"}
            icon={<AegisIcon className={iconForeground} />}
            role="switch"
            aria-checked={enabled}
            redGlow={!enabled}
            plated={nameplate != null}
            onClick={() => {
                settings.store.enabled = !settings.store.enabled;
                void updatePresence();
            }}
        />
    );
}

export default definePlugin({
    name: "AegisRichPresence",
    description: "Discord Rich Presence for the Aegis music player — Spotify-style card with cover art, song name, artist, and progress bar.",
    authors: [EquicordDevs.Matti],
    dependencies: ["UserAreaAPI", "CommandsAPI"],

    settings,

    userAreaButton: {
        icon: AegisIcon,
        render: AegisToggleButton,
    },

    // `/aegis-rpc` fallback for builds where the UserArea patch doesn't
    // target the current Discord layout — lets the user toggle from anywhere.
    commands: [
        {
            name: "aegis-rpc",
            description: "Toggle the Aegis Discord Rich Presence on/off (or check status).",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "state",
                    description: "Explicit state (omit to flip)",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: [
                        { name: "on", value: "on", label: "on" },
                        { name: "off", value: "off", label: "off" },
                        { name: "status", value: "status", label: "status" },
                    ],
                },
            ],
            execute: (opts, ctx) => {
                const explicit = findOption<string>(opts, "state");
                const current = settings.store.enabled;
                let next = current;
                if (explicit === "on") next = true;
                else if (explicit === "off") next = false;
                else if (explicit !== "status") next = !current;

                if (next !== current) {
                    settings.store.enabled = next;
                    void updatePresence();
                }

                sendBotMessage(ctx.channel.id, {
                    content: `Aegis Rich Presence is now **${next ? "on" : "off"}**.`,
                });
            },
        },
    ],

    start() {
        logger.info("plugin started — user panel button registered, /aegis-rpc command live");
        // Fire once immediately so there's no 3s "blank" gap on Discord start.
        void updatePresence();
        const intervalMs = Math.max(1, settings.store.refreshIntervalSec) * 1000;
        pollTimer = setInterval(() => { void updatePresence(); }, intervalMs);
    },

    stop() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = undefined;
        }
        dispatchActivity(null);
        resetDispatched();
    },
});
