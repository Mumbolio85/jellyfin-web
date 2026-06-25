/**
 * Module that manages the playback of SyncPlay.
 * @module components/syncPlay/core/PlaybackCore
 */

import Events from '../../../utils/events.ts';
import { toBoolean, toFloat } from '../../../utils/string.ts';
import * as Helper from './Helper';
import { getSetting } from './Settings';

// The user-tunable knobs below (rate-controller gain, maximum speed adjustments, required buffer
// headroom and seek thresholds) live in the SyncPlay settings and are loaded in loadPreferences().
// The constants here are internal mechanics not worth exposing in the UI.

// Minimum milliseconds between sync-correction checks. Throttles the controller so it reacts
// to trends rather than to per-frame timeupdate noise.
const SYNC_CHECK_INTERVAL = 1500;

// --- Component 1: calibrated drift estimator ---
// Number of recent diff samples used for the rolling median that rejects currentTime granularity noise.
const DRIFT_MEDIAN_WINDOW = 5;

// --- Component 5: readiness-gated startup ---
// Consecutive throttled samples with monotonic, advancing playback required before correction starts.
const READINESS_STABLE_SAMPLES = 3;

// --- Component 4: transcode-aware, last-resort seek ---
// When seeking a transcoded stream, target this many seconds ahead to absorb the re-transcode delay.
const SEEK_TRANSCODE_LOOKAHEAD_SECONDS = 2;

/**
 * Class that manages the playback of SyncPlay.
 */
class PlaybackCore {
    constructor() {
        this.manager = null;
        this.timeSyncCore = null;

        this.syncEnabled = false;
        this.skipToSyncEnabled = false;
        this.playbackDiffMillis = 0; // Used for stats and remote time sync.
        this.syncAttempts = 0;
        this.lastSyncTime = new Date();

        this.playerIsBuffering = false;

        // Drift estimator and controller state (see resetSyncState).
        this.diffSamples = []; // Rolling window of raw diff samples (ms) for median smoothing.
        this.baselineOffsetMillis = null; // Calibrated constant offset O; null until correction starts.
        this.stableSampleCount = 0; // Consecutive monotonic samples observed while gating readiness.
        this.lastReadinessPositionTicks = null; // Previous position used for the monotonic readiness check.
        this.largeDriftSince = null; // Timestamp when drift first exceeded the seek threshold.
        this.currentPlaybackRate = 1.0; // Last applied playback rate, to avoid redundant player calls.

        this.lastCommand = null; // Last scheduled playback command, might not be the latest one.
        this.scheduledCommandTimeout = null;

        this.loadPreferences();
    }

    /**
     * Initializes the core.
     * @param {Manager} syncPlayManager The SyncPlay manager.
     */
    init(syncPlayManager) {
        this.manager = syncPlayManager;
        this.timeSyncCore = syncPlayManager.getTimeSyncCore();

        Events.on(this.manager, 'settings-update', () => {
            this.loadPreferences();
        });
    }

    /**
     * Loads preferences from saved settings.
     */
    loadPreferences() {
        // Drift (in milliseconds) tolerated before any correction kicks in (the controller deadband).
        this.syncTolerance = toFloat(getSetting('minDelaySpeedToSync'), 60.0);

        // Position difference (in milliseconds) at unpause above which playback seeks straight to
        // the correct position instead of letting the controller converge.
        this.minDelaySkipToSync = toFloat(getSetting('minDelaySkipToSync'), 400.0);

        // Whether the proportional speed (rate-trim) correction should be used.
        this.useSpeedToSync = toBoolean(getSetting('useSpeedToSync'), true);

        // Whether the last-resort seek correction should be used.
        this.useSkipToSync = toBoolean(getSetting('useSkipToSync'), true);

        // Whether sync correction during playback is active.
        this.enableSyncCorrection = toBoolean(getSetting('enableSyncCorrection'), true);

        // --- Proportional rate controller (Components 2 & 3) ---
        // Playback-rate change applied per second of drift: rate = 1 + strength * driftSeconds.
        this.syncCorrectionStrength = toFloat(getSetting('syncCorrectionStrength'), 0.05);

        // Maximum playback speed adjustment (percent) during direct play, where the buffer is not a
        // concern, so we may converge faster.
        this.maxPlaybackSpeedDirectPlay = toFloat(getSetting('maxPlaybackSpeedDirectPlay'), 10.0);

        // Maximum playback speed adjustment (percent) while transcoding. Kept gentle so we never
        // drain a near-realtime transcode buffer.
        this.maxPlaybackSpeedTranscode = toFloat(getSetting('maxPlaybackSpeedTranscode'), 5.0);

        // Forward buffer (in seconds) a transcoding stream must hold before correction may start and
        // before it is allowed to speed up. Prevents self-induced buffering.
        this.minBufferForSpeedUp = toFloat(getSetting('minBufferForSpeedUp'), 10.0);

        // --- Last-resort seek (Component 4) ---
        // Drift (in milliseconds) above which a hard seek is considered.
        this.seekDriftThreshold = toFloat(getSetting('seekDriftThreshold'), 10000.0);

        // Duration (in milliseconds) the drift must stay above the threshold before a seek fires.
        this.seekDriftSustain = toFloat(getSetting('seekDriftSustain'), 5000.0);
    }

    /**
     * Called by player wrapper when playback starts.
     */
    onPlaybackStart(player, state) {
        Events.trigger(this.manager, 'playbackstart', [player, state]);
    }

    /**
     * Called by player wrapper when playback stops.
     */
    onPlaybackStop(stopInfo) {
        this.lastCommand = null;
        Events.trigger(this.manager, 'playbackstop', [stopInfo]);
    }

    /**
     * Called by player wrapper when playback unpauses.
     */
    onUnpause() {
        Events.trigger(this.manager, 'unpause');
    }

    /**
     * Called by player wrapper when playback pauses.
     */
    onPause() {
        Events.trigger(this.manager, 'pause');
    }

    /**
     * Called by player wrapper on playback progress.
     * @param {Object} event The time update event.
     * @param {Object} timeUpdateData The time update data.
     */
    onTimeUpdate(event, timeUpdateData) {
        this.syncPlaybackTime(timeUpdateData);
        Events.trigger(this.manager, 'timeupdate', [event, timeUpdateData]);
    }

    /**
     * Called by player wrapper when player is ready to play.
     */
    onReady() {
        this.playerIsBuffering = false;
        this.sendBufferingRequest(false);
        Events.trigger(this.manager, 'ready');
    }

    /**
     * Called by player wrapper when player is buffering.
     */
    onBuffering() {
        this.playerIsBuffering = true;
        this.sendBufferingRequest(true);
        Events.trigger(this.manager, 'buffering');
    }

    /**
     * Sends a buffering request to the server.
     * @param {boolean} isBuffering Whether this client is buffering or not.
     */
    async sendBufferingRequest(isBuffering = true) {
        const playerWrapper = this.manager.getPlayerWrapper();
        const currentPosition = (playerWrapper.currentTimeAsync ?
            await playerWrapper.currentTimeAsync() :
            playerWrapper.currentTime());
        const currentPositionTicks = Math.round(currentPosition * Helper.TicksPerMillisecond);
        const isPlaying = playerWrapper.isPlaying();

        const currentTime = new Date();
        const now = this.timeSyncCore.localDateToRemote(currentTime);
        const playlistItemId = this.manager.getQueueCore().getCurrentPlaylistItemId();

        const options = {
            When: now.toISOString(),
            PositionTicks: currentPositionTicks,
            IsPlaying: isPlaying,
            PlaylistItemId: playlistItemId
        };

        const apiClient = this.manager.getApiClient();
        if (isBuffering) {
            apiClient.requestSyncPlayBuffering(options);
        } else {
            apiClient.requestSyncPlayReady(options);
        }
    }

    /**
     * Gets playback buffering status.
     * @returns {boolean} _true_ if player is buffering, _false_ otherwise.
     */
    isBuffering() {
        return this.playerIsBuffering;
    }

    /**
     * Applies a command and checks the playback state if a duplicate command is received.
     * @param {Object} command The playback command.
     */
    async applyCommand(command) {
        // Check if duplicate.
        if (this.lastCommand
            && this.lastCommand.When.getTime() === command.When.getTime()
            && this.lastCommand.PositionTicks === command.PositionTicks
            && this.lastCommand.Command === command.Command
            && this.lastCommand.PlaylistItemId === command.PlaylistItemId
        ) {
            // Duplicate command found, check playback state and correct if needed.
            console.debug('SyncPlay applyCommand: duplicate command received!', command);

            // Determine if past command or future one.
            const currentTime = new Date();
            const whenLocal = this.timeSyncCore.remoteDateToLocal(command.When);
            if (whenLocal > currentTime) {
                // Command should be already scheduled, not much we can do.
                // TODO: should re-apply or just drop?
                console.debug('SyncPlay applyCommand: command already scheduled.', command);
                return;
            } else {
                // Check if playback state matches requested command.
                const playerWrapper = this.manager.getPlayerWrapper();
                const currentPositionTicks = Math.round((playerWrapper.currentTimeAsync ?
                    await playerWrapper.currentTimeAsync() :
                    playerWrapper.currentTime()) * Helper.TicksPerMillisecond);
                const isPlaying = playerWrapper.isPlaying();

                switch (command.Command) {
                    case 'Unpause':
                        // Check playback state only, as position ticks will be corrected by sync.
                        if (!isPlaying) {
                            this.scheduleUnpause(command.When, command.PositionTicks);
                        }
                        break;
                    case 'Pause':
                        // FIXME: check range instead of fixed value for ticks.
                        if (isPlaying || currentPositionTicks !== command.PositionTicks) {
                            this.schedulePause(command.When, command.PositionTicks);
                        }
                        break;
                    case 'Stop':
                        if (isPlaying) {
                            this.scheduleStop(command.When);
                        }
                        break;
                    case 'Seek':
                        // During seek, playback is paused.
                        // FIXME: check range instead of fixed value for ticks.
                        if (isPlaying || currentPositionTicks !== command.PositionTicks) {
                            // Account for player imperfections, we got half a second of tollerance we can play with
                            // (the server tollerates a range of values when client reports that is ready).
                            const rangeWidth = 100; // In milliseconds.
                            // eslint-disable-next-line sonarjs/pseudo-random
                            const randomOffsetTicks = Math.round((Math.random() - 0.5) * rangeWidth) * Helper.TicksPerMillisecond;
                            this.scheduleSeek(command.When, command.PositionTicks + randomOffsetTicks);
                            console.debug('SyncPlay applyCommand: adding random offset to force seek:', randomOffsetTicks, command);
                        } else {
                            // All done, I guess?
                            this.sendBufferingRequest(false);
                        }
                        break;
                    default:
                        console.error('SyncPlay applyCommand: command is not recognised:', command);
                        break;
                }

                // All done.
                return;
            }
        }

        // Applying command.
        this.lastCommand = command;

        // Ignore if remote player has local SyncPlay manager.
        if (this.manager.isRemote()) {
            return;
        }

        switch (command.Command) {
            case 'Unpause':
                this.scheduleUnpause(command.When, command.PositionTicks);
                break;
            case 'Pause':
                this.schedulePause(command.When, command.PositionTicks);
                break;
            case 'Stop':
                this.scheduleStop(command.When);
                break;
            case 'Seek':
                this.scheduleSeek(command.When, command.PositionTicks);
                break;
            default:
                console.error('SyncPlay applyCommand: command is not recognised:', command);
                break;
        }
    }

    /**
     * Schedules a resume playback on the player at the specified clock time.
     * @param {Date} playAtTime The server's UTC time at which to resume playback.
     * @param {number} positionTicks The PositionTicks from where to resume.
     */
    async scheduleUnpause(playAtTime, positionTicks) {
        this.clearScheduledCommand();
        const currentTime = new Date();
        const playAtTimeLocal = this.timeSyncCore.remoteDateToLocal(playAtTime);

        const playerWrapper = this.manager.getPlayerWrapper();
        const currentPositionTicks = (playerWrapper.currentTimeAsync ?
            await playerWrapper.currentTimeAsync() :
            playerWrapper.currentTime()) * Helper.TicksPerMillisecond;

        // Correction is no longer enabled on a fixed timer. It is gated on measured readiness
        // (playback advancing steadily and, when transcoding, a healthy buffer) inside
        // syncPlaybackTime, which also captures the calibrated baseline offset at that moment.
        if (playAtTimeLocal > currentTime) {
            const playTimeout = playAtTimeLocal - currentTime;

            // Seek only if delay is noticeable.
            if ((currentPositionTicks - positionTicks) > this.minDelaySkipToSync * Helper.TicksPerMillisecond) {
                this.localSeek(positionTicks);
            }

            this.scheduledCommandTimeout = setTimeout(() => {
                this.localUnpause();
                Events.trigger(this.manager, 'notify-osd', ['unpause']);
            }, playTimeout);

            console.debug('Scheduled unpause in', playTimeout / 1000.0, 'seconds.');
        } else {
            // Group playback already started.
            const serverPositionTicks = this.estimateCurrentTicks(positionTicks, playAtTime);
            Helper.waitForEventOnce(this.manager, 'unpause').then(() => {
                this.localSeek(serverPositionTicks);
            });
            this.localUnpause();
            setTimeout(() => {
                Events.trigger(this.manager, 'notify-osd', ['unpause']);
            }, 100);

            console.debug(`SyncPlay scheduleUnpause: unpause now from ${serverPositionTicks} (was at ${currentPositionTicks}).`);
        }
    }

    /**
     * Schedules a pause playback on the player at the specified clock time.
     * @param {Date} pauseAtTime The server's UTC time at which to pause playback.
     * @param {number} positionTicks The PositionTicks where player will be paused.
     */
    schedulePause(pauseAtTime, positionTicks) {
        this.clearScheduledCommand();
        const currentTime = new Date();
        const pauseAtTimeLocal = this.timeSyncCore.remoteDateToLocal(pauseAtTime);

        const callback = () => {
            Helper.waitForEventOnce(this.manager, 'pause', Helper.WaitForPlayerEventTimeout).then(() => {
                this.localSeek(positionTicks);
            }).catch(() => {
                // Player was already paused, seeking.
                this.localSeek(positionTicks);
            });
            this.localPause();
        };

        if (pauseAtTimeLocal > currentTime) {
            const pauseTimeout = pauseAtTimeLocal - currentTime;
            this.scheduledCommandTimeout = setTimeout(callback, pauseTimeout);

            console.debug('Scheduled pause in', pauseTimeout / 1000.0, 'seconds.');
        } else {
            callback();
            console.debug('SyncPlay schedulePause: now.');
        }
    }

    /**
     * Schedules a stop playback on the player at the specified clock time.
     * @param {Date} stopAtTime The server's UTC time at which to stop playback.
     */
    scheduleStop(stopAtTime) {
        this.clearScheduledCommand();
        const currentTime = new Date();
        const stopAtTimeLocal = this.timeSyncCore.remoteDateToLocal(stopAtTime);

        const callback = () => {
            this.localStop();
        };

        if (stopAtTimeLocal > currentTime) {
            const stopTimeout = stopAtTimeLocal - currentTime;
            this.scheduledCommandTimeout = setTimeout(callback, stopTimeout);

            console.debug('Scheduled stop in', stopTimeout / 1000.0, 'seconds.');
        } else {
            callback();
            console.debug('SyncPlay scheduleStop: now.');
        }
    }

    /**
     * Schedules a seek playback on the player at the specified clock time.
     * @param {Date} seekAtTime The server's UTC time at which to seek playback.
     * @param {number} positionTicks The PositionTicks where player will be seeked.
     */
    scheduleSeek(seekAtTime, positionTicks) {
        this.clearScheduledCommand();
        const currentTime = new Date();
        const seekAtTimeLocal = this.timeSyncCore.remoteDateToLocal(seekAtTime);

        const callback = () => {
            this.localUnpause();
            this.localSeek(positionTicks);

            Helper.waitForEventOnce(this.manager, 'ready', Helper.WaitForEventDefaultTimeout).then(() => {
                this.localPause();
                this.sendBufferingRequest(false);
            }).catch((error) => {
                console.error(`Timed out while waiting for 'ready' event! Seeking to ${positionTicks}.`, error);
                this.localSeek(positionTicks);
            });
        };

        if (seekAtTimeLocal > currentTime) {
            const seekTimeout = seekAtTimeLocal - currentTime;
            this.scheduledCommandTimeout = setTimeout(callback, seekTimeout);

            console.debug('Scheduled seek in', seekTimeout / 1000.0, 'seconds.');
        } else {
            callback();
            console.debug('SyncPlay scheduleSeek: now.');
        }
    }

    /**
     * Clears the current scheduled command.
     */
    clearScheduledCommand() {
        clearTimeout(this.scheduledCommandTimeout);

        this.syncEnabled = false;
        this.skipToSyncEnabled = false;
        this.resetSyncState();

        const playerWrapper = this.manager.getPlayerWrapper();
        if (playerWrapper.hasPlaybackRate()) {
            playerWrapper.setPlaybackRate(1.0);
        }

        this.manager.clearSyncIcon();
    }

    /**
     * Resets the drift estimator, readiness gating and rate-controller state so that the next
     * unpause re-calibrates from scratch.
     */
    resetSyncState() {
        this.diffSamples = [];
        this.baselineOffsetMillis = null;
        this.stableSampleCount = 0;
        this.lastReadinessPositionTicks = null;
        this.largeDriftSince = null;
        this.currentPlaybackRate = 1.0;
    }

    /**
     * Pushes a raw diff sample into the rolling window and returns the median, rejecting the
     * granularity noise of the player's reported position (Component 1).
     * @param {number} rawDiffMillis The latest raw diff, in milliseconds.
     * @returns {number} The smoothed (median) diff, in milliseconds.
     */
    getSmoothedDiff(rawDiffMillis) {
        this.diffSamples.push(rawDiffMillis);
        if (this.diffSamples.length > DRIFT_MEDIAN_WINDOW) {
            this.diffSamples.shift();
        }

        const sorted = [...this.diffSamples].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    }

    /**
     * Computes the forward buffer headroom from the given position (Component 3).
     * @param {number} positionTicks The current position, in ticks.
     * @returns {number} The forward headroom in seconds, or 0 when unknown.
     */
    getForwardBufferSeconds(positionTicks) {
        const ranges = this.manager.getPlayerWrapper().getBufferedRanges();
        for (const range of ranges) {
            if (positionTicks >= range.start && positionTicks <= range.end) {
                return (range.end - positionTicks) / Helper.TicksPerMillisecond / 1000.0;
            }
        }

        return 0;
    }

    /**
     * Applies a playback rate to the player only when it differs from the last applied value.
     * @param {number} rate The desired playback rate.
     */
    applyPlaybackRate(rate) {
        const playerWrapper = this.manager.getPlayerWrapper();
        if (!playerWrapper.hasPlaybackRate()) {
            return;
        }

        if (Math.abs(rate - this.currentPlaybackRate) < 0.001) {
            return;
        }

        this.currentPlaybackRate = rate;
        playerWrapper.setPlaybackRate(rate);
    }

    /**
     * Unpauses the local player.
     */
    localUnpause() {
        // Ignore command when no player is active.
        if (!this.manager.isPlaybackActive()) {
            console.debug('SyncPlay localUnpause: no active player!');
            return;
        }

        const playerWrapper = this.manager.getPlayerWrapper();
        return playerWrapper.localUnpause();
    }

    /**
     * Pauses the local player.
     */
    localPause() {
        // Ignore command when no player is active.
        if (!this.manager.isPlaybackActive()) {
            console.debug('SyncPlay localPause: no active player!');
            return;
        }

        const playerWrapper = this.manager.getPlayerWrapper();
        return playerWrapper.localPause();
    }

    /**
     * Seeks the local player.
     */
    localSeek(positionTicks) {
        // Ignore command when no player is active.
        if (!this.manager.isPlaybackActive()) {
            console.debug('SyncPlay localSeek: no active player!');
            return;
        }

        const playerWrapper = this.manager.getPlayerWrapper();
        return playerWrapper.localSeek(positionTicks);
    }

    /**
     * Stops the local player.
     */
    localStop() {
        // Ignore command when no player is active.
        if (!this.manager.isPlaybackActive()) {
            console.debug('SyncPlay localStop: no active player!');
            return;
        }

        const playerWrapper = this.manager.getPlayerWrapper();
        return playerWrapper.localStop();
    }

    /**
     * Estimates current value for ticks given a past state.
     * @param {number} ticks The value of the ticks.
     * @param {Date} when The point in time for the value of the ticks.
     * @param {Date} currentTime The current time, optional.
     */
    estimateCurrentTicks(ticks, when, currentTime = new Date()) {
        const remoteTime = this.timeSyncCore.localDateToRemote(currentTime);
        return ticks + (remoteTime.getTime() - when.getTime()) * Helper.TicksPerMillisecond;
    }

    /**
     * Attempts to sync playback time with estimated server time (or selected device for time sync).
     *
     * The corrector is designed to behave well when the local stream is being transcoded, where the
     * reported position carries a constant offset (e.g. ffmpeg's `-noaccurate_seek`) that must be
     * tolerated rather than chased. It works in stages:
     *  - Component 1: a rolling median rejects position noise and a calibrated baseline offset is
     *    captured so only genuine *drift* (the rate of change) is acted upon, never the constant offset.
     *  - Component 5: correction is gated on measured readiness (playback advancing + healthy buffer),
     *    not on a fixed timer.
     *  - Components 2 & 3: a continuous, clamped, buffer-aware proportional controller trims the
     *    playback rate to converge — and refuses to speed up a transcoding stream without buffer
     *    headroom, so it never drains the buffer into a stall.
     *  - Component 4: a hard seek is a last resort, used only for large drift sustained over time, and
     *    targets slightly ahead when transcoding to absorb the re-transcode delay.
     * @param {Object} timeUpdateData The time update data that contains the current time as date and the current position in milliseconds.
     */
    syncPlaybackTime(timeUpdateData) {
        // Ignore sync when no player is active.
        if (!this.manager.isPlaybackActive()) {
            console.debug('SyncPlay syncPlaybackTime: no active player!');
            return;
        }

        // Attempt to sync only when media is playing.
        const { lastCommand } = this;

        if (!lastCommand || lastCommand.Command !== 'Unpause' || this.isBuffering()) return;

        // Avoid spoilers by making sure that command item matches current playlist item.
        // This check is needed when switching from one item to another.
        const queueCore = this.manager.getQueueCore();
        const currentPlaylistItem = queueCore.getCurrentPlaylistItemId();
        if (lastCommand.PlaylistItemId !== currentPlaylistItem) return;

        const { currentTime, currentPosition } = timeUpdateData;

        // Get current PositionTicks.
        const currentPositionTicks = currentPosition * Helper.TicksPerMillisecond;

        // Estimate PositionTicks on server.
        const serverPositionTicks = this.estimateCurrentTicks(lastCommand.PositionTicks, lastCommand.When, currentTime);

        // Raw distance from estimated server position. This mixes a constant transcoding offset
        // (which must NOT be corrected) with real drift and noise — they are separated below.
        const rawDiffMillis = (serverPositionTicks - currentPositionTicks) / Helper.TicksPerMillisecond;

        // Notify update for playback sync. Stats and remote time sync use the raw diff.
        this.playbackDiffMillis = rawDiffMillis;
        Events.trigger(this.manager, 'playback-diff', [this.playbackDiffMillis]);

        // Avoid overloading the browser.
        const elapsed = currentTime - this.lastSyncTime;
        if (elapsed < SYNC_CHECK_INTERVAL) return;

        this.lastSyncTime = currentTime;

        if (!this.enableSyncCorrection) return;

        const playerWrapper = this.manager.getPlayerWrapper();
        const isTranscoding = playerWrapper.isTranscoding();

        // Component 1: reject the player's position granularity noise with a short rolling median.
        const smoothedDiffMillis = this.getSmoothedDiff(rawDiffMillis);

        // Component 5: readiness-gated startup. Wait until playback is advancing steadily and, when
        // transcoding, the forward buffer is healthy. The smoothed diff at that point becomes the
        // tolerated baseline offset O, so the constant transcoding offset is never "corrected".
        if (!this.syncEnabled) {
            const advancing = this.lastReadinessPositionTicks !== null
                && currentPositionTicks > this.lastReadinessPositionTicks;
            this.stableSampleCount = advancing ? this.stableSampleCount + 1 : 0;
            this.lastReadinessPositionTicks = currentPositionTicks;

            const bufferHealthy = !isTranscoding
                || this.getForwardBufferSeconds(currentPositionTicks) >= this.minBufferForSpeedUp;

            if (this.stableSampleCount >= READINESS_STABLE_SAMPLES && bufferHealthy) {
                this.baselineOffsetMillis = smoothedDiffMillis;
                this.syncEnabled = true;
                this.skipToSyncEnabled = true;
                console.debug('SyncPlay ready; calibrated baseline offset (ms):', this.baselineOffsetMillis);
            }
            return;
        }

        // Component 1: act on drift (rate of change), not on the constant offset.
        const driftMillis = smoothedDiffMillis - this.baselineOffsetMillis;
        const absDriftMillis = Math.abs(driftMillis);

        // Deadband: within tolerance, hold normal speed and consider playback synced.
        if (absDriftMillis < this.syncTolerance) {
            this.largeDriftSince = null;
            this.applyPlaybackRate(1.0);
            this.manager.clearSyncIcon();
            if (this.syncAttempts > 0) {
                console.debug('Playback has been synced after', this.syncAttempts, 'attempts.');
                this.syncAttempts = 0;
            }
            return;
        }

        // Component 4: a hard seek is the last resort — only for large drift that persists over
        // several samples, since each seek spawns a new transcode job and buffering.
        if (absDriftMillis >= this.seekDriftThreshold) {
            if (this.largeDriftSince === null) {
                this.largeDriftSince = currentTime;
            }
            const sustainedMillis = currentTime - this.largeDriftSince;
            if (this.useSkipToSync && this.skipToSyncEnabled && sustainedMillis >= this.seekDriftSustain) {
                // Target slightly ahead when transcoding to absorb the re-transcode delay.
                const lookaheadTicks = isTranscoding ?
                    SEEK_TRANSCODE_LOOKAHEAD_SECONDS * 1000 * Helper.TicksPerMillisecond :
                    0;
                const seekTargetTicks = serverPositionTicks + lookaheadTicks;

                this.applyPlaybackRate(1.0);
                this.localSeek(seekTargetTicks);
                this.syncAttempts++;
                this.manager.showSyncIcon(`SkipToSync (${this.syncAttempts})`);

                // Re-gate: re-calibrate readiness and baseline once the stream settles after the seek.
                this.syncEnabled = false;
                this.skipToSyncEnabled = false;
                this.resetSyncState();

                console.log('SyncPlay SkipToSync', seekTargetTicks);
                return;
            }
            // Not sustained yet — keep trimming with the rate controller while we wait it out.
        } else {
            this.largeDriftSince = null;
        }

        // Components 2 & 3: continuous, buffer-aware proportional rate trim.
        if (playerWrapper.hasPlaybackRate() && this.useSpeedToSync) {
            // Widen the clamp for direct play (no buffer concern); stay gentle while transcoding.
            // The maximum speed adjustments are stored as percentages, so convert to a 0-1 fraction.
            const trim = (isTranscoding ? this.maxPlaybackSpeedTranscode : this.maxPlaybackSpeedDirectPlay) / 100.0;
            let rate = 1 + this.syncCorrectionStrength * (driftMillis / 1000.0);
            rate = Math.min(1 + trim, Math.max(1 - trim, rate));

            // Component 3: never speed up a transcoding stream without forward buffer headroom.
            // Slowing down (rate < 1) is always safe. A starved client flags itself as the
            // bottleneck instead of draining its buffer into a stall.
            if (rate > 1 && isTranscoding
                && this.getForwardBufferSeconds(currentPositionTicks) < this.minBufferForSpeedUp) {
                rate = 1.0;
                this.manager.showSyncIcon('Buffering (bottleneck)');
            } else {
                this.manager.showSyncIcon(`SpeedToSync (x${rate.toFixed(3)})`);
            }

            this.applyPlaybackRate(rate);
            this.syncAttempts++;
            console.log('SyncPlay rate trim', rate.toFixed(3), 'drift(ms)', driftMillis.toFixed(0));
        }
    }
}

export default PlaybackCore;
