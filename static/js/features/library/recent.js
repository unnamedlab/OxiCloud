// @ts-check

/**
 * OxiCloud - Recent Files Module (server-authoritative)
 *
 * Records file-access events via POST /api/recent/{type}/{id} and exposes
 * `clearRecentFiles()` for the clear-all action.
 *
 * Display is now handled by `recentView.js` using the cursor-paginated
 * `GET /api/recent/resources` endpoint.
 */

import { getCsrfHeaders } from '../../core/csrf.js';

/** @import {ItemTypeEnum} from '../../core/types.js' */

const recent = {
    // ───────────────────── helpers ─────────────────────

    _authHeaders() {
        return { ...getCsrfHeaders() };
    },

    // ───────────────────── lifecycle ─────────────────────

    /**
     * Initialise the module. Called once from app.js on startup.
     */
    init() {
        this.setupEventListeners();
    },

    /**
     * Listen for file-accessed events dispatched by ui.js and forward
     * them to the backend.
     */
    setupEventListeners() {
        document.addEventListener('file-accessed', (event) => {
            const e = /** @type {CustomEvent} */ (event);
            if (e.detail?.file) {
                const file = e.detail.file;
                const itemType = file.item_type || 'file';
                this._recordAccess(file.id, itemType);
            }
        });
    },

    /**
     * Record an access event on the server.
     * @param {string} itemId
     * @param {ItemTypeEnum} itemType
     */
    async _recordAccess(itemId, itemType) {
        try {
            await fetch(`/api/recent/${itemType}/${itemId}`, {
                method: 'POST',
                headers: this._authHeaders()
            });
        } catch (err) {
            console.warn('Failed to record recent access:', err);
        }
    },

    // ───────────────────── public API ─────────────────────

    /**
     * Clear all recent items (delegates to the server).
     */
    async clearRecentFiles() {
        try {
            await fetch('/api/recent/clear', {
                method: 'DELETE',
                headers: this._authHeaders()
            });
        } catch (err) {
            console.error('Error clearing recent files:', err);
        }
    }
};

export { recent };
