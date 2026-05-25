// @ts-check

/**
 * System-users convenience layer.
 *
 * Thin wrapper over `addressBook.listContacts(SYSTEM_BOOK_ID)` that
 * provides a userId → display-name index, a userId → photo-url index,
 * and a userId → primary-email index.
 * Used wherever a grant's `granted_by` UUID needs to be shown as a
 * human-readable name (owner tooltips, share dialogs, etc.), avatar
 * image (userVignette, user menu), or email (suggestion dropdowns).
 *
 * Falls back gracefully when the system address book is disabled
 * server-side (`OXICLOUD_EXPOSE_SYSTEM_USERS` not set): `isAvailable()`
 * returns false and `getDisplayName()` returns a shortened UUID.
 */

/** @import {ContactItem} from '../core/types.js' */

import { addressBook, SYSTEM_BOOK_ID } from './addressBook.js';

/** @type {Map<string, string> | null} userId → display name, built lazily */
let _index = null;

/** @type {Map<string, string | null> | null} userId → photo URL (or null), built lazily */
let _photoIndex = null;

/** @type {Map<string, string | null> | null} userId → primary email (or null), built lazily */
let _emailIndex = null;

/**
 * Derive the best human-readable name from a contact.
 * Priority: "First Last" → full_name → primary email → shortened id.
 * @param {ContactItem} c
 * @returns {string}
 */
function _nameFor(c) {
    const parts = /** @type {string[]} */ ([c.first_name, c.last_name].filter(Boolean));
    if (parts.length) return parts.join(' ');
    if (c.full_name) return c.full_name;
    const mail = c.email?.find((e) => e.is_primary)?.email ?? c.email?.[0]?.email;
    if (mail) return mail;
    return `${c.id.slice(0, 8)}…`;
}

/**
 * Ensure both indexes are built (idempotent).
 * After loading contacts from the system address book, the current user
 * (from localStorage) is injected so owner cells resolve correctly even
 * when the server-side address book does not include the logged-in user.
 * @returns {Promise<void>}
 */
async function _ensureIndex() {
    if (_index !== null) return;
    const contacts = await addressBook.listContacts(SYSTEM_BOOK_ID);
    _index = new Map(contacts.map((c) => [c.id, _nameFor(c)]));
    _photoIndex = new Map(contacts.map((c) => [c.id, c.photo_url ?? null]));
    _emailIndex = new Map(
        contacts.map((c) => {
            const primary = c.email?.find((e) => e.is_primary)?.email ?? c.email?.[0]?.email ?? null;
            return [c.id, primary];
        })
    );

    // Inject the current user if they are not already in the index
    try {
        const raw = localStorage.getItem('oxicloud_user');
        if (raw) {
            const u = /** @type {{id?:string, display_name?:string, username?:string, email?:string, image?:string|null}} */ (JSON.parse(raw));
            if (u?.id) {
                if (!_index.has(u.id)) {
                    const name = u.display_name || u.username || u.email || `${u.id.slice(0, 8)}…`;
                    _index.set(u.id, name);
                }
                if (!_photoIndex.has(u.id)) {
                    _photoIndex.set(u.id, u.image ?? null);
                }
                if (!_emailIndex.has(u.id)) {
                    _emailIndex.set(u.id, u.email ?? null);
                }
            }
        }
    } catch {
        // localStorage not available or JSON is invalid — silently skip
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start loading the system address book in the background.
 * Safe to call multiple times — subsequent calls are no-ops once loaded.
 */
function prefetch() {
    if (!addressBook.isSystemAvailable()) return;
    _ensureIndex(); // intentionally fire-and-forget
}

/**
 * Resolve a user UUID to a display name.
 * Awaits the first load if not yet cached; subsequent calls resolve instantly.
 *
 * @param {string} userId
 * @returns {Promise<string>}
 */
async function getDisplayName(userId) {
    await _ensureIndex();
    return _index?.get(userId) ?? `${userId.slice(0, 8)}…`;
}

/**
 * Resolve a user UUID to a photo URL (or null if none set).
 * Awaits the first load if not yet cached; subsequent calls resolve instantly.
 *
 * @param {string} userId
 * @returns {Promise<string | null>}
 */
async function getPhoto(userId) {
    await _ensureIndex();
    return _photoIndex?.get(userId) ?? null;
}

/**
 * Resolve a user UUID to their primary email address (or null if unknown).
 * Awaits the first load if not yet cached; subsequent calls resolve instantly.
 *
 * @param {string} userId
 * @returns {Promise<string | null>}
 */
async function getEmail(userId) {
    await _ensureIndex();
    return _emailIndex?.get(userId) ?? null;
}

/**
 * Force-refresh the current user's photo entry in the index from localStorage.
 * Call this after saving a new avatar on the profile page so that existing
 * vignettes can re-render without a full page reload.
 */
function refreshCurrentUserPhoto() {
    try {
        const raw = localStorage.getItem('oxicloud_user');
        if (!raw || !_photoIndex) return;
        const u = /** @type {{id?:string, image?:string|null}} */ (JSON.parse(raw));
        if (u?.id) {
            _photoIndex.set(u.id, u.image ?? null);
        }
    } catch {
        // ignore
    }
}

/**
 * Returns `false` only after a confirmed 404 from the server (feature
 * disabled).  Returns `true` when status is unknown or the book loaded OK.
 * @returns {boolean}
 */
function isAvailable() {
    return addressBook.isSystemAvailable();
}

export const systemUsers = { prefetch, getDisplayName, getPhoto, getEmail, refreshCurrentUserPhoto, isAvailable };
