/**
 * Request trust fence for this plugin's HTTP surface.
 *
 * The plugin registers a prefix *below* the kernel's `/api`, and webServer
 * dispatch is longest-prefix-wins, so these routes run before the connection
 * service's own admission check and would otherwise answer any loopback
 * caller. Two layers, tried in order:
 *
 * 1. the composition's own `connection` service when present — the exact
 *    admission decision the kernel applies to its `/api` routes (trust fence
 *    plus browser-auth cookie), so the plugin is never weaker than the app;
 * 2. a structural replica for compositions without that service: loopback host
 *    only, no cross-site fetches, and an `Origin`/`Referer` matching `Host`.
 *
 * The pattern and wording follow the installed, officially-supported
 * `dsh-our-free-model` bundle, which solved the same boundary in this process.
 *
 * @module src/trust
 */

/** Hostnames a same-machine caller can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/** Split a Host/Origin/Referer value into {scheme, hostname, port}, defaulting the port. */
function authorityOf(value, defaultScheme) {
	if (typeof value !== 'string' || value.trim() === '') return null
	let url
	try {
		url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
	} catch {
		return null
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
	const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
	return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

/**
 * Decide one request without the connection service: DNS-rebinding defence via
 * the Host header, cross-site fetch refusal, and an Origin/Referer authority match.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {number|undefined} HTTP status to reject with, or undefined to proceed.
 */
export function structuralRejection(req) {
	const host = authorityOf(req.headers.host, 'http')
	if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403
	const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
	if (site === 'cross-site') return 403
	for (const header of ['origin', 'referer']) {
		const raw = req.headers[header]
		if (typeof raw !== 'string' || raw.trim() === '') continue
		const authority = authorityOf(raw.trim())
		if (authority === null) return 403
		if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) return 403
	}
	return undefined
}

/**
 * Decide one request. Returns an HTTP status to reject with, or `undefined`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object|undefined} connection - the harness `connection` service, when mounted.
 * @returns {number|undefined}
 */
export function rejectionFor(req, connection) {
	if (connection && typeof connection.admit === 'function') {
		try {
			const admission = connection.admit(req)
			if (admission && typeof admission === 'object' && 'rejection' in admission) return admission.rejection
			return undefined
		} catch {
			/* A throwing connection service is a composition bug; use the replica fence. */
		}
	}
	return structuralRejection(req)
}
