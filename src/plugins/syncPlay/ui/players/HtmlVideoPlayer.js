/**
 * Module that manages the HtmlVideoPlayer for SyncPlay.
 * @module components/syncPlay/ui/players/HtmlVideoPlayer
 */

import NoActivePlayer from './NoActivePlayer';
import { playbackManager } from '../../../../components/playback/playbackmanager';
import * as Helper from '../../core/Helper';
import Events from '../../../../utils/events.ts';

/**
 * Class that manages the HtmlVideoPlayer for SyncPlay.
 */
class HtmlVideoPlayer extends NoActivePlayer {
    static type = 'htmlvideoplayer';

    constructor(player, syncPlayManager) {
        super(player, syncPlayManager);
        this.isPlayerActive = false;
        this.savedPlaybackRate = 1.0;
        this.minBufferingThresholdMillis = 3000;

        if (player.currentTimeAsync) {
            /**
             * Gets current playback position.
             * @returns {Promise<number>} The player position, in milliseconds.
             */
            this.currentTimeAsync = () => {
                return this.player.currentTimeAsync();
            };
        }
    }

    /**
     * Binds to the player's events. Overrides parent method.
     * @param {Object} player The player.
     */
    localBindToPlayer() {
        super.localBindToPlayer();

        const self = this;

        this._onPlaybackStart = (player, state) => {
            self.isPlayerActive = true;
            self.onPlaybackStart(player, state);
        };

        this._onPlaybackStop = (stopInfo) => {
            self.isPlayerActive = false;
            self.onPlaybackStop(stopInfo);
        };

        this._onUnpause = () => {
            self.onUnpause();
        };

        this._onPause = () => {
            self.onPause();
        };

        this._onTimeUpdate = (e) => {
            const currentTime = new Date();
            const currentPosition = self.player.currentTime();
            self.onTimeUpdate(e, {
                currentTime: currentTime,
                currentPosition: currentPosition
            });
        };

        this._onPlaying = () => {
            clearTimeout(self.notifyBuffering);
            self.onReady();
        };

        this._onWaiting = () => {
            clearTimeout(self.notifyBuffering);
            self.notifyBuffering = setTimeout(() => {
                self.onBuffering();
            }, self.minBufferingThresholdMillis);
        };

        Events.on(this.player, 'playbackstart', this._onPlaybackStart);
        Events.on(this.player, 'playbackstop', this._onPlaybackStop);
        Events.on(this.player, 'unpause', this._onUnpause);
        Events.on(this.player, 'pause', this._onPause);
        Events.on(this.player, 'timeupdate', this._onTimeUpdate);
        Events.on(this.player, 'playing', this._onPlaying);
        Events.on(this.player, 'waiting', this._onWaiting);

        this.savedPlaybackRate = this.player.getPlaybackRate();
    }

    /**
     * Removes the bindings from the player's events. Overrides parent method.
     */
    localUnbindFromPlayer() {
        super.localUnbindFromPlayer();

        Events.off(this.player, 'playbackstart', this._onPlaybackStart);
        Events.off(this.player, 'playbackstop', this._onPlaybackStop);
        Events.off(this.player, 'unpause', this._onUnpause);
        Events.off(this.player, 'pause', this._onPause);
        Events.off(this.player, 'timeupdate', this._onTimeUpdate);
        Events.off(this.player, 'playing', this._onPlaying);
        Events.off(this.player, 'waiting', this._onWaiting);

        this.player.setPlaybackRate(this.savedPlaybackRate);
    }

    /**
     * Called when changes are made to the play queue.
     */
    onQueueUpdate() {
        // TODO: find a more generic event? Tests show that this is working for now.
        Events.trigger(this.player, 'playlistitemadd');
    }

    /**
     * Gets player status.
     * @returns {boolean} Whether the player has some media loaded.
     */
    isPlaybackActive() {
        return this.isPlayerActive;
    }

    /**
     * Gets playback status.
     * @returns {boolean} Whether the playback is unpaused.
     */
    isPlaying() {
        return !this.player.paused();
    }

    /**
     * Gets playback position.
     * @returns {number} The player position, in milliseconds.
     */
    currentTime() {
        return this.player.currentTime();
    }

    /**
     * Checks if player has playback rate support.
     * @returns {boolean} _true _ if playback rate is supported, false otherwise.
     */
    hasPlaybackRate() {
        return true;
    }

    /**
     * Sets the playback rate, if supported.
     * @param {number} value The playback rate.
     */
    setPlaybackRate(value) {
        this.player.setPlaybackRate(value);
    }

    /**
     * Gets the playback rate.
     * @returns {number} The playback rate.
     */
    getPlaybackRate() {
        return this.player.getPlaybackRate();
    }

    /**
     * Checks if the current media is being transcoded by the server. Overrides parent method.
     * @returns {boolean} _true_ if the stream is transcoding, _false_ otherwise or when unknown.
     */
    isTranscoding() {
        if (!this.player) {
            return false;
        }

        try {
            return playbackManager.playMethod(this.player) === 'Transcode';
        } catch {
            return false;
        }
    }

    /**
     * Gets the buffered time ranges of the player. Overrides parent method.
     *
     * playbackManager.getBufferedRanges() reports ranges in absolute media ticks (the transcoding
     * offset is baked in), but currentTime() — and therefore every position SyncPlay works with — is
     * segment-relative (no offset). When transcoding starts at a non-zero position (a resume, or after
     * a SkipToSync seek), that mismatch would push the playhead outside every reported range, making
     * the forward-buffer calculation read 0 and silently disable buffer-aware correction. Re-base the
     * ranges into the currentTime() coordinate so the buffer math is consistent regardless of offset.
     * @returns {Array} The buffered ranges as `{ start, end }` objects in ticks. Empty when unknown.
     */
    getBufferedRanges() {
        if (!this.player) {
            return [];
        }

        const ranges = playbackManager.getBufferedRanges(this.player);

        // Derive the transcoding offset using only public APIs: getCurrentTicks() returns the
        // absolute position (segment-relative time + offset), currentTime() the segment-relative one.
        let offsetTicks = 0;
        try {
            const currentTimeMillis = this.player.currentTime();
            if (typeof currentTimeMillis === 'number') {
                offsetTicks = playbackManager.getCurrentTicks(this.player)
                    - currentTimeMillis * Helper.TicksPerMillisecond;
            }
        } catch {
            offsetTicks = 0;
        }

        if (!offsetTicks) {
            return ranges;
        }

        return ranges.map((range) => ({
            start: range.start - offsetTicks,
            end: range.end - offsetTicks
        }));
    }
}

export default HtmlVideoPlayer;
