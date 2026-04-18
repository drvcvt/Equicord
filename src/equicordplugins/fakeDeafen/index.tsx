/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import fakeStream, { FakeStreamDockButton } from "@equicordplugins/fakeStream";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { ContextMenuApi, Menu, VoiceActions } from "@webpack/common";

// Voice state `flags` bitfield — undocumented, consent bits for Clips/recording.
const VoiceFlags = {
    CLIP_ENABLED: 1 << 0,
    ALLOW_VOICE_RECORDING: 1 << 1,
    ALLOW_ANY_VIEWER_CLIPS: 1 << 2,
} as const;

const settings = definePluginSettings({
    fakeDeafen: {
        type: OptionType.BOOLEAN,
        description: "Report yourself as deafened while you can still hear.",
        default: false,
    },
    fakeMute: {
        type: OptionType.BOOLEAN,
        description: "Report yourself as muted while your mic is still live.",
        default: false,
    },
    fakeVideo: {
        type: OptionType.BOOLEAN,
        description: "Report yourself as having camera on while it's off.",
        default: false,
    },
    denyVoiceRecording: {
        type: OptionType.BOOLEAN,
        description: "Strip your audio from any voice clip others try to record of this VC.",
        default: false,
        onChange: () => flushVoiceState(() => VoiceActions.toggleSelfMute()),
    },
    denyViewerClips: {
        type: OptionType.BOOLEAN,
        description: "Prevent stream viewers (not in VC) from clipping you.",
        default: false,
        onChange: () => flushVoiceState(() => VoiceActions.toggleSelfMute()),
    },
    hideClipsUI: {
        type: OptionType.BOOLEAN,
        description: "Tell Discord the Clips feature is disabled on your client.",
        default: false,
        onChange: () => flushVoiceState(() => VoiceActions.toggleSelfMute()),
    },
});

function override(kind: "mute" | "deaf" | "video", real: boolean): boolean {
    if (kind === "mute" && settings.store.fakeMute) return true;
    if (kind === "deaf" && settings.store.fakeDeafen) return true;
    if (kind === "video" && settings.store.fakeVideo) return true;
    return real;
}

function overrideFlags(real: number): number {
    let out = real;
    if (settings.store.hideClipsUI) out &= ~VoiceFlags.CLIP_ENABLED;
    if (settings.store.denyVoiceRecording) out &= ~VoiceFlags.ALLOW_VOICE_RECORDING;
    if (settings.store.denyViewerClips) out &= ~VoiceFlags.ALLOW_ANY_VIEWER_CLIPS;
    return out;
}

// Double-toggle forces a fresh VOICE_STATE_UPDATE to flush to the gateway
// so Discord picks up our patched value. The local state ends up unchanged.
function flushVoiceState(toggle: () => void) {
    toggle();
    toggle();
}

function FakeDeafenIcon({ className }: { className?: string; }) {
    return (
        <svg className={className} width="20" height="20" viewBox="0 0 32 24" fill="currentColor">
            <mask id="vc-fakedeafen-mask">
                <rect fill="white" width="24" height="24" />
                <rect fill="black" x="9.75" y="-2" width="4.5" height="28" rx="2.25" transform="rotate(45 12 12)" />
            </mask>
            <path
                mask="url(#vc-fakedeafen-mask)"
                d="M12 3a9 9 0 0 0-8.95 10h1.87a5 5 0 0 1 4.1 2.13l1.37 1.97a3.1 3.1 0 0 1-.17 3.78 2.85 2.85 0 0 1-3.55.74 11 11 0 1 1 10.66 0c-1.27.71-2.73.23-3.55-.74a3.1 3.1 0 0 1-.17-3.78l1.38-1.97a5 5 0 0 1 4.1-2.13h1.86A9 9 0 0 0 12 3Z"
            />
            <line x1="21" y1="3" x2="3" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            {/* inline dropdown chevron */}
            <path d="M26 10 l3 3 l3 -3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function FakeDeafenMenu({ onClose }: { onClose: () => void; }) {
    const s = settings.use([
        "fakeDeafen", "fakeMute", "fakeVideo",
        "denyVoiceRecording", "denyViewerClips", "hideClipsUI",
    ]);

    const flushMute = () => flushVoiceState(() => VoiceActions.toggleSelfMute());
    const flushDeaf = () => flushVoiceState(() => VoiceActions.toggleSelfDeaf());

    return (
        <Menu.Menu
            navId="vc-fakedeafen-menu"
            onClose={onClose}
        >
            <Menu.MenuGroup label="Fake voice state">
                <Menu.MenuCheckboxItem
                    id="vc-fd-deafen"
                    label="Fake deafen"
                    checked={s.fakeDeafen}
                    action={() => {
                        settings.store.fakeDeafen = !s.fakeDeafen;
                        flushDeaf();
                    }}
                />
                <Menu.MenuCheckboxItem
                    id="vc-fd-mute"
                    label="Fake mute"
                    checked={s.fakeMute}
                    action={() => {
                        settings.store.fakeMute = !s.fakeMute;
                        flushMute();
                    }}
                />
                <Menu.MenuCheckboxItem
                    id="vc-fd-video"
                    label="Fake camera"
                    checked={s.fakeVideo}
                    action={() => {
                        settings.store.fakeVideo = !s.fakeVideo;
                    }}
                />
            </Menu.MenuGroup>
            <Menu.MenuGroup label="Clip privacy">
                <Menu.MenuCheckboxItem
                    id="vc-fd-no-recording"
                    label="Deny voice recording"
                    checked={s.denyVoiceRecording}
                    action={() => {
                        settings.store.denyVoiceRecording = !s.denyVoiceRecording;
                    }}
                />
                <Menu.MenuCheckboxItem
                    id="vc-fd-no-viewer-clips"
                    label="Deny viewer clips"
                    checked={s.denyViewerClips}
                    action={() => {
                        settings.store.denyViewerClips = !s.denyViewerClips;
                    }}
                />
                <Menu.MenuCheckboxItem
                    id="vc-fd-hide-clips-ui"
                    label="Hide clips UI"
                    checked={s.hideClipsUI}
                    action={() => {
                        settings.store.hideClipsUI = !s.hideClipsUI;
                    }}
                />
            </Menu.MenuGroup>
        </Menu.Menu>
    );
}

function FakeDeafenDockButton() {
    const s = settings.use([
        "fakeDeafen", "fakeMute", "fakeVideo",
        "denyVoiceRecording", "denyViewerClips", "hideClipsUI",
    ]);
    const active = s.fakeDeafen || s.fakeMute || s.fakeVideo
        || s.denyVoiceRecording || s.denyViewerClips || s.hideClipsUI;

    const openMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        ContextMenuApi.openContextMenu(e, () => <FakeDeafenMenu onClose={ContextMenuApi.closeContextMenu} />);
    };

    return (
        <div
            role="button"
            title={active ? "Fake state active — click for options, shift+click toggles deafen" : "Fake deafen options (shift+click toggles deafen)"}
            onClick={e => {
                if (e.shiftKey) {
                    settings.store.fakeDeafen = !s.fakeDeafen;
                    flushVoiceState(() => VoiceActions.toggleSelfDeaf());
                } else {
                    openMenu(e);
                }
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
                color: s.fakeDeafen ? "var(--status-danger)" : active ? "var(--status-warning)" : "var(--interactive-normal)",
                background: active ? "var(--background-mod-faint)" : "transparent",
            }}
        >
            <FakeDeafenIcon />
        </div>
    );
}

function FakeDockRow() {
    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 8px",
                borderBottom: "1px solid var(--background-modifier-accent)",
                background: "var(--background-secondary-alt)",
            }}
        >
            <FakeDeafenDockButton />
            {isPluginEnabled(fakeStream.name) && <FakeStreamDockButton />}
        </div>
    );
}

function AccountPanelWrapper({ VencordOriginal, ...props }: { VencordOriginal: any; [k: string]: any; }) {
    return (
        <>
            <ErrorBoundary noop>
                <FakeDockRow />
            </ErrorBoundary>
            <VencordOriginal {...props} />
        </>
    );
}

export default definePlugin({
    name: "FakeDeafen",
    description: "Lie to Discord about your mute, deafen, and camera state.",
    authors: [EquicordDevs.Matti],
    settings,

    override,
    overrideFlags,
    AccountPanelWrapper,

    patches: [
        {
            find: ".DISPLAY_NAME_STYLES_COACHMARK)",
            replacement: {
                // Match either the raw AccountPanel identifier or an already-wrapped
                // component from another plugin (e.g. musicControls). Wrap it so we
                // can render our dock row above the account panel.
                match: /(?<=\i\.jsxs?\)\()([^,]+),\{(?=[^}]*?userTag:\i,occluded:)/,
                replace: "$self.AccountPanelWrapper,{VencordOriginal:$1,",
            },
        },
        // Voice state op:4 payload builder. The method name
        // `voiceStateUpdate(` is the anchor — it's specific enough to hit
        // exactly one module. We split into one replacement per field so
        // a broken capture on one field doesn't nuke the others, and use
        // `[^,}]+` instead of Vencord's `\i` macro — `\i` only matches a
        // bare identifier, but Discord's minifier inlines expressions here
        // (`!0`, ternaries, `n.mute`) which `\i` refuses to capture.
        //
        // `flags:` runs before `self_video:` because our rewrite inserts
        // a comma inside `$self.override(...)` which would break the
        // `self_video:[^,}]+,\s*flags:` anchor afterwards.
        {
            find: "}voiceStateUpdate(",
            replacement: [
                { match: /(self_video:[^,}]+,\s*flags:)([^,}]+)/, replace: "$1$self.overrideFlags($2)" },
                { match: /self_mute:([^,}]+)/, replace: "self_mute:$self.override('mute',$1)" },
                { match: /self_deaf:([^,}]+)/, replace: "self_deaf:$self.override('deaf',$1)" },
                { match: /self_video:([^,}]+)/, replace: "self_video:$self.override('video',$1)" },
            ],
        },
    ],

    commands: [
        {
            name: "fake-deafen",
            description: "Toggle fake deafen/mute/video states.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "deafen",
                    description: "Report yourself as deafened.",
                    type: ApplicationCommandOptionType.BOOLEAN,
                    required: false,
                },
                {
                    name: "mute",
                    description: "Report yourself as muted.",
                    type: ApplicationCommandOptionType.BOOLEAN,
                    required: false,
                },
                {
                    name: "video",
                    description: "Report yourself as having camera on.",
                    type: ApplicationCommandOptionType.BOOLEAN,
                    required: false,
                },
            ],
            execute: (args, ctx) => {
                const changes: string[] = [];

                const deaf = findOption<boolean>(args, "deafen");
                if (typeof deaf === "boolean" && deaf !== settings.store.fakeDeafen) {
                    settings.store.fakeDeafen = deaf;
                    flushVoiceState(() => VoiceActions.toggleSelfDeaf());
                    changes.push(`fake deafen: ${deaf ? "on" : "off"}`);
                }

                const mute = findOption<boolean>(args, "mute");
                if (typeof mute === "boolean" && mute !== settings.store.fakeMute) {
                    settings.store.fakeMute = mute;
                    flushVoiceState(() => VoiceActions.toggleSelfMute());
                    changes.push(`fake mute: ${mute ? "on" : "off"}`);
                }

                const video = findOption<boolean>(args, "video");
                if (typeof video === "boolean" && video !== settings.store.fakeVideo) {
                    settings.store.fakeVideo = video;
                    // No direct "toggle camera" action without being in a voice channel —
                    // the patch takes effect on the next voice state update the client sends.
                    changes.push(`fake video: ${video ? "on" : "off"}`);
                }

                sendBotMessage(ctx.channel.id, {
                    content: changes.length
                        ? `Updated: ${changes.join(", ")}`
                        : `Current: deafen=${settings.store.fakeDeafen}, mute=${settings.store.fakeMute}, video=${settings.store.fakeVideo}`,
                });
            },
        },
    ],
});
