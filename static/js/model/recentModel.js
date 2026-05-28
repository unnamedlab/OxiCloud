// @ts-check

/**
 * OxiCloud – Recent resources model.
 *
 * Thin fetch wrapper for `GET /api/recent/resources` (cursor-paginated).
 * The old `GET /api/recent` endpoint is kept for backward compat — this
 * module only handles the new endpoint.
 */

/** @import {FileItem, FolderItem, ResourceTypeEnum} from '../core/types.js' */

/**
 * @typedef {Object} RecentResourceItem
 * @property {ResourceTypeEnum}    resource_type  - 'file' | 'folder'
 * @property {string}              accessed_at    - ISO-8601 timestamp
 * @property {FileItem|FolderItem} resource       - Full resource details
 */

/**
 * @typedef {Object} RecentResourcesResponse
 * @property {RecentResourceItem[]}  items
 * @property {string|undefined}      [next_cursor]
 */

/**
 * Fetch one page of the current user's recently accessed resources.
 *
 * @param {{
 *   cursor?:        string,
 *   orderBy?:       string,
 *   limit?:         number,
 *   reverse?:       boolean,
 *   resourceTypes?: ResourceTypeEnum[],
 * }} [opts]
 * @returns {Promise<RecentResourcesResponse>}
 */
async function fetchRecentPage({ cursor, orderBy = 'accessed_at', limit = 50, reverse = false, resourceTypes } = {}) {
    const params = new URLSearchParams({ order_by: orderBy, limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    if (reverse) params.set('reverse', 'true');
    if (resourceTypes?.length) params.set('resource_types', resourceTypes.join(','));

    const res = await fetch(`/api/recent/resources?${params}`, {
        credentials: 'same-origin',
        cache: 'no-store'
    });

    if (!res.ok) {
        const err = /** @type {any} */ (new Error(`GET /api/recent/resources failed: ${res.status}`));
        err.status = res.status;
        throw err;
    }

    return /** @type {Promise<RecentResourcesResponse>} */ (res.json());
}

export { fetchRecentPage };
