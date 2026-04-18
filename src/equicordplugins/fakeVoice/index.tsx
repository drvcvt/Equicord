/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { chooseFile } from "@utils/web";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { Button, CloudUploader, Constants, FluxDispatcher, MessageActions, PendingReplyStore, RestAPI, Select, SelectedChannelStore, showToast, SnowflakeUtils, TextArea, TextInput, Toasts, useState } from "@webpack/common";

type WaveformMode = "off" | "pattern" | "custom" | "text" | "random";
type DurationMode = "off" | "fixed" | "multiplier";
type PatternKind = "saw" | "sine" | "spikes" | "zigzag" | "full" | "zero" | "420";

interface SpoofOverrides {
    waveformMode?: WaveformMode;
    waveformPattern?: PatternKind;
    waveformText?: string;
    waveformCustom?: string;
    durationMode?: DurationMode;
    durationValue?: number;
}

const logger = new Logger("FakeVoice");

const WAVEFORM_LEN = 256;
const VOICE_MESSAGE_FLAG = 1 << 13;

const settings = definePluginSettings({
    waveformMode: {
        type: OptionType.SELECT,
        description: "How to fake your voice message waveform.",
        options: [
            { label: "Off", value: "off" },
            { label: "Pattern preset", value: "pattern", default: true },
            { label: "Custom bytes (comma-separated 0-255)", value: "custom" },
            { label: "Encode text (each char = ASCII height repeated)", value: "text" },
            { label: "Random noise", value: "random" },
        ],
    },
    waveformPattern: {
        type: OptionType.SELECT,
        description: "Preset waveform pattern.",
        options: [
            { label: "Sawtooth (ramps)", value: "saw" },
            { label: "Sine (smooth wave)", value: "sine" },
            { label: "Spikes (max/zero alternating)", value: "spikes" },
            { label: "Zigzag", value: "zigzag" },
            { label: "Full (all 255)", value: "full" },
            { label: "Zero (dead flat)", value: "zero" },
            { label: "420 signature", value: "420", default: true },
        ],
    },
    waveformText: {
        type: OptionType.STRING,
        description: "Text to encode when waveform mode is 'text'. Each character becomes a bar height.",
        default: "LMAO",
    },
    waveformCustom: {
        type: OptionType.STRING,
        description: "Custom waveform bytes (comma or space separated 0-255). Loops to fill 256 bars.",
        default: "0,64,128,192,255,192,128,64",
    },

    durationMode: {
        type: OptionType.SELECT,
        description: "How to fake your voice message duration display.",
        options: [
            { label: "Off", value: "off" },
            { label: "Fixed value (overrides real duration)", value: "fixed", default: true },
            { label: "Multiplier (multiplies real duration)", value: "multiplier" },
        ],
    },
    durationValue: {
        type: OptionType.NUMBER,
        description: "Duration value. For 'fixed' mode this is seconds (e.g. 3600 = 1h). For 'multiplier' this scales the real duration (e.g. 100 = 100x longer).",
        default: 3600,
    },

    instantStageSpeak: {
        type: OptionType.BOOLEAN,
        description: "When you press 'Request to speak' on a stage, auto-rewrite the timestamp to epoch so you become speaker instantly without moderator approval.",
        default: false,
    },
});

// ---- Waveform builders ---------------------------------------------------

function clampByte(n: number): number {
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 255) return 255;
    return Math.floor(n);
}

function tileTo256(values: number[]): Uint8Array {
    const out = new Uint8Array(WAVEFORM_LEN);
    if (values.length === 0) return out;
    for (let i = 0; i < WAVEFORM_LEN; i++) {
        out[i] = clampByte(values[i % values.length]);
    }
    return out;
}

function buildPattern(kind: string): Uint8Array {
    const out = new Uint8Array(WAVEFORM_LEN);
    switch (kind) {
        case "sine":
            for (let i = 0; i < WAVEFORM_LEN; i++) {
                out[i] = Math.round(127 + 127 * Math.sin(i / 8));
            }
            return out;
        case "spikes":
            for (let i = 0; i < WAVEFORM_LEN; i++) out[i] = i % 2 === 0 ? 255 : 0;
            return out;
        case "zigzag":
            for (let i = 0; i < WAVEFORM_LEN; i++) out[i] = (i % 32) < 16 ? (i % 16) * 16 : 255 - (i % 16) * 16;
            return out;
        case "full":
            out.fill(255);
            return out;
        case "zero":
            out.fill(0);
            return out;
        case "420": {
            // "420" in a crude 5-bar-per-char silhouette, repeated.
            const glyphs: number[] = [];
            const push = (...xs: number[]) => glyphs.push(...xs);
            // "4"
            push(255, 0, 255, 255, 255);
            push(0);
            // "2"
            push(255, 255, 0, 255, 255);
            push(0);
            // "0"
            push(255, 255, 255, 255, 255);
            push(0, 0);
            return tileTo256(glyphs);
        }
        case "saw":
        default:
            for (let i = 0; i < WAVEFORM_LEN; i++) out[i] = (i * 8) % 256;
            return out;
    }
}

function buildFromText(text: string): Uint8Array {
    if (!text) return new Uint8Array(WAVEFORM_LEN);
    const values: number[] = [];
    for (const ch of text) {
        const code = ch.charCodeAt(0) & 0xff;
        // repeat each char's code 4 times to make it visible as a plateau
        values.push(code, code, code, code, 0);
    }
    return tileTo256(values);
}

function buildCustom(raw: string): Uint8Array {
    const parts = raw.split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
    return tileTo256(parts.map(clampByte));
}

function buildRandom(): Uint8Array {
    const out = new Uint8Array(WAVEFORM_LEN);
    for (let i = 0; i < WAVEFORM_LEN; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
}

function bytesToBase64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

function spoofWaveform(ov?: SpoofOverrides): string | null {
    const mode = (ov?.waveformMode ?? settings.store.waveformMode) as WaveformMode;
    switch (mode) {
        case "pattern": return bytesToBase64(buildPattern((ov?.waveformPattern ?? settings.store.waveformPattern) as PatternKind));
        case "text": return bytesToBase64(buildFromText(ov?.waveformText ?? settings.store.waveformText ?? ""));
        case "custom": return bytesToBase64(buildCustom(ov?.waveformCustom ?? settings.store.waveformCustom ?? ""));
        case "random": return bytesToBase64(buildRandom());
        default: return null;
    }
}

function spoofDuration(real: number, ov?: SpoofOverrides): number | null {
    const mode = (ov?.durationMode ?? settings.store.durationMode) as DurationMode;
    const val = ov?.durationValue ?? settings.store.durationValue;
    if (mode === "fixed") return val;
    if (mode === "multiplier") return real * val;
    return null;
}

// ---- Send flow -----------------------------------------------------------

async function decodeDuration(blob: Blob): Promise<number> {
    try {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const buf = await blob.arrayBuffer();
        const audio = await ctx.decodeAudioData(buf);
        ctx.close?.();
        return audio.duration || 1;
    } catch {
        return 1;
    }
}

// Minimal bogus "audio" payload — the filename is .ogg so Discord treats it as audio,
// but the bytes don't decode, so Discord's client cannot compute a real duration and
// falls back to the metadata `duration_secs` we ship. That lets us lie arbitrarily.
function makeBogusAudioFile(): File {
    // 48 random bytes with an OggS-ish header so the CDN doesn't reject outright.
    const bytes = new Uint8Array(48);
    bytes[0] = 0x4f; bytes[1] = 0x67; bytes[2] = 0x67; bytes[3] = 0x53; // "OggS"
    for (let i = 4; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return new File([bytes], "voice-message.ogg", { type: "audio/ogg; codecs=opus" });
}

async function sendCustomVoiceMessage(fileOrNull: File | null, overrides?: SpoofOverrides) {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) {
        showToast("No channel selected", Toasts.Type.FAILURE);
        return;
    }

    const reply = PendingReplyStore.getPendingReply(channelId);
    if (reply) FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });

    let renamed: File;
    let realDuration: number;

    if (fileOrNull) {
        realDuration = await decodeDuration(fileOrNull);
        const blob = new Blob([await fileOrNull.arrayBuffer()], { type: "audio/ogg; codecs=opus" });
        renamed = new File([blob], "voice-message.ogg", { type: "audio/ogg; codecs=opus" });
    } else {
        // Bogus-audio path: no real file, client cannot decode, metadata duration wins.
        realDuration = 1;
        renamed = makeBogusAudioFile();
    }

    const upload = new CloudUploader({
        file: renamed,
        isThumbnail: false,
        platform: CloudUploadPlatform.WEB,
    }, channelId);

    upload.on("complete", () => {
        const wf = spoofWaveform(overrides) ?? bytesToBase64(buildPattern("saw"));
        const dur = spoofDuration(realDuration, overrides) ?? realDuration;

        RestAPI.post({
            url: Constants.Endpoints.MESSAGES(channelId),
            body: {
                flags: VOICE_MESSAGE_FLAG,
                channel_id: channelId,
                content: "",
                nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                sticker_ids: [],
                type: 0,
                attachments: [{
                    id: "0",
                    filename: upload.filename,
                    uploaded_filename: upload.uploadedFilename,
                    waveform: wf,
                    duration_secs: dur,
                }],
                message_reference: reply ? MessageActions.getSendMessageOptionsForReply(reply)?.messageReference : null,
            },
        });
    });
    upload.on("error", () => showToast("Voice message upload failed", Toasts.Type.FAILURE));
    upload.upload();
}

// ---- Chat bar button + modal --------------------------------------------

function FakeVoiceIcon({ width = 20, height = 20 }: { width?: number; height?: number; }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 1 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v1a7 7 0 0 1-14 0v-1a1 1 0 1 0-2 0v1a9 9 0 0 0 8 8.94V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.06A9 9 0 0 0 21 11v-1a1 1 0 1 0-2 0Z" />
            <circle cx="20" cy="6" r="3" fill="var(--status-warning)" />
        </svg>
    );
}

const WAVEFORM_MODES: Array<{ value: WaveformMode; label: string; }> = [
    { value: "off", label: "Off (real audio waveform)" },
    { value: "pattern", label: "Pattern preset" },
    { value: "text", label: "Text → ASCII heights" },
    { value: "custom", label: "Custom bytes" },
    { value: "random", label: "Random noise" },
];
const PATTERN_OPTIONS: Array<{ value: PatternKind; label: string; }> = [
    { value: "saw", label: "Sawtooth" },
    { value: "sine", label: "Sine" },
    { value: "spikes", label: "Spikes" },
    { value: "zigzag", label: "Zigzag" },
    { value: "full", label: "Full (255)" },
    { value: "zero", label: "Zero (flat)" },
    { value: "420", label: "420 signature" },
];
const DURATION_MODES: Array<{ value: DurationMode; label: string; }> = [
    { value: "off", label: "Off (real duration)" },
    { value: "fixed", label: "Fixed seconds" },
    { value: "multiplier", label: "Multiplier × real" },
];

function formatDurationHint(secs: number): string {
    if (!Number.isFinite(secs) || secs < 0) return "?";
    const s = Math.floor(secs);
    const mm = Math.floor(s / 60);
    const ss = (s % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
}

function SectionLabel({ children }: { children: React.ReactNode; }) {
    return <BaseText style={{ fontSize: "0.8rem", fontWeight: 600, opacity: 0.6, textTransform: "uppercase", letterSpacing: 0.5 }}>{children}</BaseText>;
}

function PickAndSendModal({ modalProps }: { modalProps: ModalProps; }) {
    const [file, setFile] = useState<File | null>(null);
    const [sending, setSending] = useState(false);

    // Modal-local overrides, seeded from plugin settings.
    const [wfMode, setWfMode] = useState<WaveformMode>(settings.store.waveformMode as WaveformMode);
    const [wfPattern, setWfPattern] = useState<PatternKind>(settings.store.waveformPattern as PatternKind);
    const [wfText, setWfText] = useState<string>(settings.store.waveformText ?? "");
    const [wfCustom, setWfCustom] = useState<string>(settings.store.waveformCustom ?? "");
    const [durMode, setDurMode] = useState<DurationMode>(settings.store.durationMode as DurationMode);
    const [durValue, setDurValue] = useState<string>(String(settings.store.durationValue ?? 0));

    const pick = async () => {
        const picked = await chooseFile("audio/*");
        if (picked) setFile(picked);
    };

    const overrides = (): SpoofOverrides => ({
        waveformMode: wfMode,
        waveformPattern: wfPattern,
        waveformText: wfText,
        waveformCustom: wfCustom,
        durationMode: durMode,
        durationValue: Number(durValue) || 0,
    });

    const doSend = async (input: File | null) => {
        setSending(true);
        try {
            await sendCustomVoiceMessage(input, overrides());
            showToast("Voice message sent", Toasts.Type.SUCCESS);
            modalProps.onClose();
        } catch (e) {
            logger.error("send failed", e);
            showToast(`Send failed: ${(e as Error)?.message ?? e}`, Toasts.Type.FAILURE);
        } finally {
            setSending(false);
        }
    };

    const durNum = Number(durValue) || 0;
    const durPreview = durMode === "fixed"
        ? `Will display as ${formatDurationHint(durNum)} (${durNum}s)`
        : durMode === "multiplier"
            ? `Real duration × ${durNum}`
            : "Real duration";

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <BaseText style={{ fontSize: "1.15rem", fontWeight: 600 }}>Send voice message (FakeVoice)</BaseText>
            </ModalHeader>
            <ModalContent style={{ padding: "16px 0" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

                    {/* Audio source */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <SectionLabel>Audio</SectionLabel>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <Button onClick={pick} color={Button.Colors.PRIMARY}>
                                {file ? "Change file" : "Pick audio file"}
                            </Button>
                            <BaseText style={{ opacity: 0.85, fontSize: "0.9rem", wordBreak: "break-all" }}>
                                {file ? file.name : "no file"}
                            </BaseText>
                        </div>
                    </div>

                    {/* Waveform */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <SectionLabel>Waveform</SectionLabel>
                        <Select
                            options={WAVEFORM_MODES}
                            isSelected={(v: WaveformMode) => v === wfMode}
                            serialize={(v: WaveformMode) => v}
                            select={(v: WaveformMode) => setWfMode(v)}
                        />
                        {wfMode === "pattern" && (
                            <Select
                                options={PATTERN_OPTIONS}
                                isSelected={(v: PatternKind) => v === wfPattern}
                                serialize={(v: PatternKind) => v}
                                select={(v: PatternKind) => setWfPattern(v)}
                            />
                        )}
                        {wfMode === "text" && (
                            <TextInput
                                value={wfText}
                                placeholder="Text to encode (each char → ASCII bar height)"
                                onChange={setWfText}
                            />
                        )}
                        {wfMode === "custom" && (
                            <TextArea
                                value={wfCustom}
                                placeholder="Comma or space separated bytes 0-255, e.g. 0,64,128,192,255,192,128,64"
                                onChange={setWfCustom}
                                rows={3}
                            />
                        )}
                    </div>

                    {/* Duration */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <SectionLabel>Duration</SectionLabel>
                        <Select
                            options={DURATION_MODES}
                            isSelected={(v: DurationMode) => v === durMode}
                            serialize={(v: DurationMode) => v}
                            select={(v: DurationMode) => setDurMode(v)}
                        />
                        {(durMode === "fixed" || durMode === "multiplier") && (
                            <>
                                <TextInput
                                    value={durValue}
                                    placeholder={durMode === "fixed" ? "Seconds (e.g. 420, 25200)" : "Multiplier (e.g. 100)"}
                                    onChange={setDurValue}
                                />
                                <BaseText style={{ fontSize: "0.78rem", opacity: 0.6 }}>
                                    {durPreview}
                                </BaseText>
                                {durMode === "fixed" && (
                                    <BaseText style={{ fontSize: "0.72rem", opacity: 0.5 }}>
                                        Discord formats as MM:SS. To display "420:00" use 25200. To display "69:00" use 4140.
                                    </BaseText>
                                )}
                            </>
                        )}
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 4, background: "var(--background-mod-faint)", padding: 10, borderRadius: 6 }}>
                        <BaseText style={{ fontSize: "0.8rem", opacity: 0.75 }}>
                            <b>Send file</b> — plays correctly, but Discord's client may recompute waveform/duration from the real audio.
                        </BaseText>
                        <BaseText style={{ fontSize: "0.8rem", opacity: 0.75 }}>
                            <b>Send bogus</b> — tiny undecodable payload. Play button breaks, but the client trusts our fake metadata.
                        </BaseText>
                    </div>
                </div>
            </ModalContent>
            <ModalFooter>
                <div style={{ display: "flex", width: "100%", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                    <Button onClick={modalProps.onClose} look={Button.Looks.LINK} color={Button.Colors.PRIMARY}>
                        Cancel
                    </Button>
                    <Button
                        onClick={() => doSend(null)}
                        disabled={sending}
                        color={Button.Colors.RED}
                        look={Button.Looks.OUTLINED}
                    >
                        {sending ? "…" : "Send bogus"}
                    </Button>
                    <Button
                        onClick={() => doSend(file)}
                        disabled={!file || sending}
                        color={Button.Colors.BRAND}
                    >
                        {sending ? "Sending…" : "Send file"}
                    </Button>
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}

const FakeVoiceChatBarButton: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat) return null;
    return (
        <ChatBarButton
            tooltip="Send voice message from file (FakeVoice)"
            onClick={() => openModal(mp => <PickAndSendModal modalProps={mp} />)}
        >
            <FakeVoiceIcon />
        </ChatBarButton>
    );
};

// ---- RestAPI monkey-patching --------------------------------------------

// We no longer wrap RestAPI.post — spoofs are applied directly in sendCustomVoiceMessage,
// which keeps FakeVoice from touching every outgoing message and risking collateral damage.

let originalPatch: typeof RestAPI.patch | undefined;
let patchWrapped = false;

function wrapPatch() {
    if (patchWrapped) return;
    originalPatch = RestAPI.patch;
    const wrapped = ((opts: any) => {
        try {
            if (
                settings.store.instantStageSpeak
                && typeof opts?.url === "string"
                && opts.url.includes("/voice-states/@me")
                && opts?.body
                && "request_to_speak_timestamp" in opts.body
                && opts.body.request_to_speak_timestamp
            ) {
                opts.body.request_to_speak_timestamp = new Date(0).toISOString();
            }
        } catch (e) {
            logger.error("stage speak intercept failed", e);
        }
        return originalPatch!.call(RestAPI, opts);
    }) as typeof RestAPI.patch;
    RestAPI.patch = wrapped;
    patchWrapped = true;
}

// ---- Plugin --------------------------------------------------------------

export default definePlugin({
    name: "FakeVoice",
    description: "Fake voice message waveform + duration, send voice messages from audio files on your PC, force-become stage speaker without moderator approval.",
    authors: [EquicordDevs.Matti],
    settings,

    chatBarButton: {
        icon: FakeVoiceIcon,
        render: FakeVoiceChatBarButton,
    },

    start() {
        wrapPatch();
    },

    stop() {
        if (originalPatch && patchWrapped) {
            RestAPI.patch = originalPatch;
            patchWrapped = false;
        }
        originalPatch = undefined;
    },

    commands: [
        {
            name: "stage-speaker",
            description: "Force yourself to speaker in the current stage channel (past-timestamp trick).",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "guild",
                    description: "Guild ID (defaults to current)",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                },
            ],
            execute: async (_args, ctx) => {
                const guildId = ctx.guild?.id ?? SelectedChannelStore.getVoiceChannelId();
                if (!guildId) {
                    sendBotMessage(ctx.channel.id, { content: "Not in a guild/stage channel." });
                    return;
                }
                try {
                    await RestAPI.patch({
                        url: `/guilds/${ctx.guild!.id}/voice-states/@me`,
                        body: { request_to_speak_timestamp: new Date(0).toISOString() },
                    });
                    Toasts.show({
                        id: Toasts.genId(),
                        message: "Forced speaker via past RTS timestamp",
                        type: Toasts.Type.SUCCESS,
                    });
                } catch (e) {
                    sendBotMessage(ctx.channel.id, { content: `Failed: ${(e as Error)?.message ?? e}` });
                }
            },
        },
        {
            name: "waveform-preview",
            description: "Show the currently-configured waveform bytes (debug).",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [],
            execute: (_args, ctx) => {
                const wf = spoofWaveform();
                sendBotMessage(ctx.channel.id, {
                    content: wf == null
                        ? "Waveform spoof is OFF."
                        : `Waveform (base64, ${wf.length} chars):\n\`${wf}\``,
                });
            },
        },
    ],
});
