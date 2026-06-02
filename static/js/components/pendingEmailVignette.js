// @ts-check

/**
 * PendingEmailVignette — visual for an external invite *before* the
 * server has resolved (or lazily created) the recipient user.
 *
 * Used by the share modal's email-input UX:
 *   1. The user types an address in the search input.
 *   2. When the address matches no existing contact but parses as an
 *      email, the dropdown surfaces an "Invite by email" suggestion
 *      rendered with this vignette.
 *   3. Clicking the suggestion stages an email-typed chip that also
 *      uses this vignette.
 *   4. On Apply, the modal POSTs `subject.type=email` and reloads the
 *      grant list — at which point the resolved real userId takes
 *      over via the regular `createUserVignette`, which paints the
 *      same `fa-building-circle-xmark` badge (PR 11.2). Visual
 *      continuity is intentional: the chip's look doesn't change
 *      across the commit boundary.
 *
 * Reuses the userVignette CSS so size variants (xs/sm/md/list/lg/menu/xl),
 * colour palette, and the external-badge styling all apply unchanged.
 * The external badge here is FORCED visible — by definition an email
 * we don't recognise is going to mint an external user.
 */

import { _colorIndex, _initials } from './userVignette.js';

/** @typedef {'xs'|'sm'|'list'|'md'|'lg'|'menu'|'xl'} VignetteSize */

/**
 * Build a transient vignette seeded from an email address (no UUID yet).
 *
 * @param {string}       email
 * @param {VignetteSize} [size='sm']
 * @returns {HTMLElement}
 */
export function createPendingEmailVignette(email, size = 'sm') {
    const trimmed = email.trim();
    const colorIdx = _colorIndex(trimmed);

    const wrapper = document.createElement('span');
    wrapper.className = `user-vignette user-vignette--${size}`;

    const avatar = document.createElement('span');
    avatar.className = `user-vignette__avatar uv-color-${colorIdx}`;
    // Synthesize initials: local-part initial + domain initial when
    // possible, otherwise fall back to the first two chars.
    const [local, domain] = trimmed.split('@');
    const synthName = local && domain ? `${local[0]} ${domain[0]}` : trimmed.slice(0, 2);
    avatar.textContent = _initials(synthName);
    wrapper.appendChild(avatar);

    // The "name" for a pending invite is just the email itself — there
    // is no separate display name yet.
    const nameEl = document.createElement('span');
    nameEl.className = 'user-vignette__name';
    nameEl.textContent = trimmed;
    wrapper.appendChild(nameEl);

    // Forced external badge — this is the whole point of the component.
    // Lives as a sibling at the end of the wrapper (mirrors the
    // userVignette layout) so it stays visible regardless of avatar
    // content (initials today, possibly a photo in a future "saved
    // email contact" mode).
    const badge = document.createElement('i');
    badge.className = 'user-vignette__origin user-vignette__origin--external fa-solid fa-building-circle-xmark';
    badge.title = 'External invitation';
    badge.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(badge);

    return wrapper;
}
